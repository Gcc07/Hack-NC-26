/* Meadow — shared Flask state with optimistic UI and revision-checked saves. */
(function () {
  const M = window.Meadow;
  const listeners = new Set();
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
      const e = new Error(data.error?.message || 'Could not reach Meadow.');
      e.status = response.status;
      throw e;
    }
    return data;
  }

  function accept(data) {
    cache = data.state;
    revision = data.revision;
    instance = data.instance;
    loaded = true;
    if (M.session.get() && !cache.users[M.session.get()]) M.session.set(null);
  }

  async function refresh() {
    if (saving || dirty || polling) return;
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
      error = 'Cannot reach Flask. Start python app.py, then retry.';
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
        body: JSON.stringify({ state: cache, revision, instance }) });
      revision = data.revision;
      instance = data.instance;
      error = '';
      if (sentEdits === edits) {
        dirty = false;
        accept(data);
        emit();
      }
    } catch (e) {
      if (e.status === 409) {
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
      setInterval(() => { if (!document.hidden && !error) refresh(); }, 1500);
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

  /* ---------- session: per-tab so two tabs can be two different people ---------- */
  M.session = {
    get: () => sessionStorage.getItem('meadow:me'),
    set: (id) => (id ? sessionStorage.setItem('meadow:me', id) : sessionStorage.removeItem('meadow:me')),
  };

  M.me = () => {
    const id = M.session.get();
    return id ? M.store.get().users[id] || null : null;
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
