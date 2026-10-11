/* Meadow — shared Flask state with optimistic UI and revision-checked saves. */
(function () {
  const M = window.Meadow;
  const listeners = new Set();
  // Must match backend.repository.RESOURCES — Flask rejects PUT /api/state otherwise.
  const RESOURCES = ['users', 'friendships', 'orgs', 'events', 'messages', 'flares', 'guestbook'];
  const empty = () => ({ users: {}, friendships: [], orgs: {}, events: {}, messages: [], flares: {}, guestbook: [] });
  let cache = empty();
  let revision = 0;
  let instance = '';
  let loaded = false;
  let dirty = false;
  let saving = false;
  let polling = false;
  let edits = 0;
  let timer;
  let error = '';
  let pending = false;
  let pollTimer = null;

  function serverState(state) {
    const out = {};
    for (const key of RESOURCES) out[key] = state[key];
    return out;
  }

  function mergeClientOnly(prev, next) {
    // polls / surveys / imessage live only in the browser (meadow bridge), not in Flask state.
    for (const key of ['polls', 'surveys', 'imessage']) {
      if (prev[key] != null) next[key] = prev[key];
    }
    return next;
  }

  function emit() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      listeners.forEach(fn => fn());
    });
  }

  function status() {
    const el = document.getElementById('connection-status');
    if (!el) return;
    el.hidden = !M.auth.account;
    el.replaceChildren(document.createTextNode(error || (!loaded ? 'Connecting…' : dirty || saving ? 'Saving…' : 'Connected to Meadow')));
    el.className = 'connection-status' + (error ? ' error' : '');
    if (error) {
      const button = document.createElement('button');
      button.textContent = 'Retry';
      button.className = 'btn small';
      button.onclick = () => M.store.retry();
      el.append(' ', button);
    }
  }

  async function request(options) {
    const response = await fetch('/api/state', { cache: 'no-store', signal: AbortSignal.timeout(10000), ...options });
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 401) M.auth.expired();
      const e = new Error(data.error?.message || 'Could not reach Meadow.');
      e.status = response.status;
      throw e;
    }
    return data;
  }

  let restoring = false;
  function accept(data) {
    cache = mergeClientOnly(cache, data.state);
    revision = data.revision;
    instance = data.instance;
    loaded = true;
    // Someone reset the shared data: the server recreates our profile on /me.
    const account = M.auth.account;
    if (account && !cache.users[account.userId] && !restoring) {
      restoring = true;
      M.auth.check().then(() => { restoring = false; refresh(); });
    }
  }

  async function refresh() {
    if (saving || dirty || polling || !M.auth.account) return;
    polling = true;
    const startedEdits = edits;
    const startedRevision = revision;
    try {
      const data = await request();
      // An edit may have happened while the GET was in flight.
      if (dirty || saving || edits !== startedEdits || revision !== startedRevision) return;
      const changed = !loaded || data.revision !== revision || data.instance !== instance;
      accept(data);
      error = '';
      if (changed) emit();
    } catch (e) {
      error = e.status === 401 ? '' : 'Cannot reach Flask. Start python app.py, then retry.';
    } finally {
      polling = false;
      status();
    }
  }

  async function save() {
    if (saving || !dirty || !loaded) return;
    saving = true;
    const sentEdits = edits;
    status();
    try {
      const data = await request({ method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: serverState(cache), revision, instance }) });
      revision = data.revision;
      instance = data.instance;
      error = '';
      if (sentEdits === edits) {
        dirty = false;
        accept(data);
        emit();
      }
    } catch (e) {
      if (e.status === 401) {
        dirty = false;
      } else if (e.status === 409) {
        // Do not overwrite another browser's changes or resurrect data after restart.
        dirty = false;
        loaded = false;
        cache = empty();
        error = 'Another tab changed the data. Reloading; please repeat your last action.';
        M.toast(error);
        emit();
      } else {
        error = 'Changes are not saved. Check Flask and click Retry.';
      }
    } finally {
      saving = false;
      status();
      if (!loaded) await refresh();
      else if (dirty && !error) timer = setTimeout(save, 0);
    }
  }

  M.store = {
    get: () => cache,
    ready: () => loaded,
    async init() {
      await refresh();
      if (!pollTimer) pollTimer = setInterval(() => { if (!document.hidden && !error) refresh(); }, 1500);
    },
    /** Forget everything from the previous account (sign-out or expiry). */
    clear() {
      clearTimeout(timer);
      cache = empty();
      loaded = dirty = false;
      edits++;
      error = '';
      status();
    },
    update(fn, opts) {
      if (!loaded) throw new Error('Wait for Meadow to connect before editing.');
      if (error) throw new Error('Changes are not saved. Click Retry before editing.');
      // A thrown action must not partially mutate the shared cache.
      const next = structuredClone(cache);
      const result = fn(next);
      cache = next;
      dirty = true;
      edits++;
      clearTimeout(timer);
      timer = setTimeout(save, 50);
      status();
      if (!opts || !opts.silent) emit();
      return result;
    },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    reset() { this.update(s => { for (const [key, value] of Object.entries(empty())) s[key] = value; }); },
    retry() { error = ''; return dirty ? save() : refresh(); },
    async flush() {
      clearTimeout(timer);
      await save();
      while (saving || (dirty && !error)) await new Promise(resolve => setTimeout(resolve, 20));
      if (error) throw new Error(error);
    },
  };
  window.addEventListener('beforeunload', e => {
    if (dirty || saving) { e.preventDefault(); e.returnValue = ''; }
  });

  /* ---------- auth: server sessions (HttpOnly cookie, 3-hour expiry) ---------- */
  async function authCall(path, method, body) {
    const response = await fetch('/api/auth/' + path, {
      method: method || 'GET', cache: 'no-store', signal: AbortSignal.timeout(15000),
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await response.json(); } catch { /* empty body */ }
    if (!response.ok) {
      const e = new Error(data.error?.message || 'Could not reach Meadow.');
      e.status = response.status;
      e.code = data.error?.code;
      throw e;
    }
    return data;
  }

  let expiryTimer;
  M.auth = {
    account: null,
    checked: false,
    googleEnabled: false,
    notice: '',
    signedIn(account) {
      M.auth.account = account;
      clearTimeout(expiryTimer);
      // Session cookies stop working 3 hours after login; return to the sign-in page then.
      if (account) expiryTimer = setTimeout(() => M.auth.expired(), Math.max(0, account.expiresAt - Date.now()) + 1000);
    },
    async check() {
      try {
        const [config, me] = await Promise.allSettled([authCall('config'), authCall('me')]);
        if (config.status === 'fulfilled') M.auth.googleEnabled = !!config.value.google;
        M.auth.signedIn(me.status === 'fulfilled' ? me.value.account : null);
      } finally {
        M.auth.checked = true;
        status();
      }
      return M.auth.account;
    },
    async login(username, password) {
      M.auth.signedIn((await authCall('login', 'POST', { username, password })).account);
      M.auth.notice = '';
    },
    async signup(name, username, password) {
      M.auth.signedIn((await authCall('signup', 'POST', { name, username, password })).account);
      M.auth.notice = '';
    },
    async logout() {
      try { await M.store.flush(); } catch { /* sign out anyway */ }
      try { await authCall('logout', 'POST'); } catch { /* cookie is cleared server-side when reachable */ }
      M.auth.reset('');
    },
    async deleteAccount() {
      await authCall('account', 'DELETE');
      M.auth.reset('Your account was deleted.');
    },
    expired() {
      if (M.auth.account) M.auth.reset('Your session expired. Please sign in again.');
    },
    reset(notice) {
      M.auth.signedIn(null);
      M.auth.notice = notice;
      if (M.ui) M.ui.loginMode = 'signin';
      M.session.actAs(null);
      M.store.clear();
      if (location.hash) history.replaceState(null, '', location.pathname);
      emit();
    },
    syncCalendar: () => authCall('google/calendar/sync', 'POST'),
    disconnectCalendar: () => authCall('google/calendar/disconnect', 'POST'),
  };

  /* ---------- who this tab acts as: the signed-in profile, or (demo only) a demo cast member ---------- */
  M.session = {
    get() {
      const account = M.auth.account;
      if (!account) return null;
      const override = sessionStorage.getItem('meadow:actAs');
      const demo = override && cache.users[override];
      return demo && demo.demo ? override : account.userId;
    },
    actAs: (id) => (id ? sessionStorage.setItem('meadow:actAs', id) : sessionStorage.removeItem('meadow:actAs')),
  };

  M.me = () => {
    const id = M.session.get();
    return id ? cache.users[id] || null : null;
  };

  /* ---------- permissions ---------- */
  M.ORG_ROLES = ['President', 'Vice President', 'Treasurer', 'Events Chair', 'Secretary', 'Member'];
  M.isOfficer = (org, userId) => {
    const m = org && org.members[userId];
    return !!m && m.role !== 'Member';
  };
  M.myOrgs = (userId) =>
    Object.values(M.store.get().orgs)
      .filter((o) => o.members[userId])
      .sort((a, b) => a.createdAt - b.createdAt);

  /* ---------- presence ---------- */
  M.presenceOf = (user) => {
    if (!user) return 'offline';
    if (user.placeholder) return 'offline';
    const live = Date.now() - (user.lastSeen || 0) < 50000;
    // Demo cast members are not really signed in anywhere, so they keep a scripted presence.
    if (!live) return user.demo && user.demoPresence ? user.demoPresence : 'offline';
    return user.presence === 'away' ? 'away' : 'online';
  };
})();
