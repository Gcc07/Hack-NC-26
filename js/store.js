/* Meadow — data store.
 *
 * All app data lives in one JSON document in localStorage, so several browser tabs
 * behave like several people using the same server: a write in one tab fires a
 * `storage` event in the others, which re-render live (chat, presence, claims).
 * The shapes mirror the draft data model in the README; swap this module for a
 * real API client (Flask + Supabase) without touching the views.
 */
(function () {
  const M = window.Meadow;
  const KEY = 'meadow:v1';
  const listeners = new Set();
  let cache = null;

  const empty = () => ({
    users: {},
    friendships: [], // [{a, b}]
    orgs: {},
    events: {},
    messages: [], // {id, channel, userId, text, ts, source, payload}
    flares: {},
    guestbook: [], // {id, eventId, userId, text, ts}
  });

  function load() {
    try {
      cache = JSON.parse(localStorage.getItem(KEY)) || empty();
    } catch {
      cache = empty();
    }
    const base = empty();
    for (const k of Object.keys(base)) if (!(k in cache)) cache[k] = base[k];
    return cache;
  }

  let pending = false;
  function emit() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      listeners.forEach((fn) => fn());
    });
  }

  M.store = {
    get() {
      return cache || load();
    },
    /** Mutate state. Pass {silent:true} to skip re-rendering this tab. */
    update(fn, opts) {
      load();
      const result = fn(cache);
      try {
        localStorage.setItem(KEY, JSON.stringify(cache));
      } catch (e) {
        M.toast('Storage is full — could not save. Try removing old data.');
      }
      if (!opts || !opts.silent) emit();
      return result;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    reset() {
      localStorage.removeItem(KEY);
      cache = null;
      emit();
    },
  };

  window.addEventListener('storage', (e) => {
    if (e.key === KEY || e.key === null) {
      cache = null;
      emit();
    }
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
