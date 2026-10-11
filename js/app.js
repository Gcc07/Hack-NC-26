/* Meadow — app shell: routing, render loop, modals, login. */
(function () {
  const M = window.Meadow;
  const { h } = M;
  const S = () => M.store.get();

  M.ui = {
    route: { name: 'home' },
    channel: null,
    evFilter: 'upcoming',
    heatWeek: 0,
    sched: null,
    chatSticky: true,
    toastedJoin: false,
  };

  /* ------------------------------------------------------------------ routing */
  M.go = (hash) => {
    if (location.hash === hash) M.render();
    else location.hash = hash;
  };

  function parseHash() {
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
    const r = { name: 'home' };
    if (parts[0] === 'o' && parts[1]) {
      r.name = 'org';
      r.orgId = parts[1];
      r.tab = parts[2] || 'chat';
      r.id = parts[3] || null;
    } else if (parts[0] === 'me') r.name = 'me';
    else if (parts[0] === 'join' && parts[1]) {
      r.name = 'join';
      r.code = parts[1];
    } else if (parts[0] === 'as' && parts[1]) {
      r.name = 'as';
      r.userId = parts[1];
    }
    M.ui.route = r;
  }

  function handleSpecialRoutes() {
    const r = M.ui.route;
    if (r.name === 'as') {
      // Only demo cast members can be borrowed; real people are behind their own logins.
      const u = S().users[r.userId];
      if (u && u.demo) {
        M.session.actAs(r.userId);
        M.store.update((s) => (s.users[r.userId].lastSeen = Date.now()), { silent: true });
      }
      location.replace('#/');
      return true;
    }
    if (r.name === 'join') {
      const me = M.me();
      if (!me) {
        sessionStorage.setItem('meadow:pendingJoin', r.code);
        return false;
      }
      try {
        const orgId = M.act.joinOrg(me.id, r.code);
        M.toast('Joined the org!');
        location.replace('#/o/' + orgId + '/chat');
      } catch (e) {
        M.toast(e.message);
        location.replace('#/');
      }
      return true;
    }
    return false;
  }

  /* ------------------------------------------------------------------ render with UI-state preservation */
  function capture(root) {
    const snap = { values: {}, focus: null, scroll: {} };
    root.querySelectorAll('[data-keep]').forEach((el) => (snap.values[el.dataset.keep] = el.value));
    const a = document.activeElement;
    if (a && a.dataset && a.dataset.keep && root.contains(a)) {
      snap.focus = { key: a.dataset.keep, s: a.selectionStart, e: a.selectionEnd };
    }
    root.querySelectorAll('[data-scroll]').forEach((el) => {
      snap.scroll[el.dataset.scroll] = {
        top: el.scrollTop,
        stick: el.scrollHeight - el.scrollTop - el.clientHeight < 60,
      };
    });
    return snap;
  }

  function restore(root, snap, reset) {
    root.querySelectorAll('[data-keep]').forEach((el) => {
      if (snap && el.dataset.keep in snap.values && !el.dataset.fresh) el.value = snap.values[el.dataset.keep];
    });
    root.querySelectorAll('[data-scroll]').forEach((el) => {
      const sv = snap && snap.scroll[el.dataset.scroll];
      if (el.dataset.scroll.startsWith('chat') && (!sv || sv.stick || reset)) el.scrollTop = el.scrollHeight;
      else if (sv && !reset) el.scrollTop = sv.top;
    });
    if (snap && snap.focus) {
      const el = root.querySelector(`[data-keep="${snap.focus.key}"]`);
      if (el) {
        el.focus({ preventScroll: true });
        try {
          el.setSelectionRange(snap.focus.s, snap.focus.e);
        } catch {
          /* not a text input */
        }
      }
    }
  }

  let lastRouteKey = '';
  M.render = function () {
    const root = document.getElementById('app');
    const routeKey = JSON.stringify(M.ui.route) + (M.ui.channel || '');
    const reset = routeKey !== lastRouteKey;
    lastRouteKey = routeKey;
    const snap = capture(root);
    root.replaceChildren(buildApp());
    restore(root, reset ? { values: {}, focus: null, scroll: {} } : snap, reset);
  };

  /* ------------------------------------------------------------------ modal */
  M.modal = function (title, build, opts) {
    const root = document.getElementById('modal-root');
    const prevFocus = document.activeElement;
    const close = () => {
      overlay.remove();
      if (prevFocus && prevFocus.focus) prevFocus.focus();
    };
    const body = h('div', { class: 'modal-body' });
    const overlay = h(
      'div',
      { class: 'overlay', onClick: (e) => e.target === overlay && close(), onKeydown: (e) => e.key === 'Escape' && close() },
      h(
        'div',
        { class: 'modal glass ' + ((opts && opts.cls) || ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        h('div', { class: 'modal-title' }, h('span', null, title), h('button', { class: 'x-btn', 'aria-label': 'Close', onClick: close }, '×')),
        body
      )
    );
    body.append(build(close));
    root.append(overlay);
    const first = overlay.querySelector('input,select,textarea,button:not(.x-btn)');
    if (first) first.focus();
    return close;
  };

  M.confirm = (text, yes) => {
    M.modal('Please confirm', (close) =>
      h('div', null, h('p', null, text), h('div', { class: 'row end' }, h('button', { class: 'btn', onClick: close }, 'Cancel'), h('button', { class: 'btn primary', onClick: () => (close(), yes()) }, 'Continue')))
    );
  };

  M.safe = (fn) => {
    try {
      return fn();
    } catch (e) {
      M.toast(e.message || String(e));
    }
  };

  /* ------------------------------------------------------------------ shell */
  function buildApp() {
    const connecting = (text) => h('div', { class: 'login' },
      h('div', { class: 'login-card glass' }, h('h1', null, 'Connecting to Meadow…'), h('p', null, text)));
    if (!M.auth.checked) return connecting('Checking your sign-in…');
    if (!M.auth.account) return M.views.login();
    if (!M.store.ready()) return connecting('Your shared data will appear when Flask is connected.');
    const me = M.me();
    if (!me) return connecting('Setting up your profile…');
    const r = M.ui.route;
    const orgs = M.myOrgs(me.id);
    let org = r.orgId && S().orgs[r.orgId];
    if (r.name === 'org' && (!org || !org.members[me.id])) org = null;
    if (r.name === 'org' && !org) {
      setTimeout(() => M.go('#/'), 0);
    }

    const main =
      r.name === 'me'
        ? M.views.me()
        : r.name === 'org' && org
        ? M.views.orgWindow(org)
        : M.views.home(orgs);

    return h(
      'div',
      { class: 'desk' },
      M.views.titlebar(me, org),
      h(
        'div',
        { class: 'layout' },
        M.views.rail(orgs, org, r),
        h('main', { class: 'window glass', id: 'main' }, main),
        M.views.buddies(me, org)
      ),
      M.views.footer()
    );
  }

  /* ------------------------------------------------------------------ Google (optional, server-side OAuth) */
  const AUTH_ERRORS = {
    google_denied: 'Google sign-in was cancelled.',
    google_failed: 'Google sign-in failed. Please try again.',
    google_state: 'That Google sign-in link expired. Please try again.',
    google_unverified: 'Your Google account email is not verified.',
    google_linked_elsewhere: 'That Google account is already linked to another Meadow account.',
    google_not_configured: 'Google sign-in is not set up on this server.',
    session_expired: 'Your session expired. Please sign in again.',
  };
  M.google = {
    configured: () => M.auth.googleEnabled,
    // Full-page redirects: the server runs the OAuth code flow and keeps all Google tokens.
    signIn: () => location.assign('/api/auth/google/start'),
    link: () => location.assign('/api/auth/google/start?link=1'),
    async sync() {
      const { count } = await M.auth.syncCalendar();
      await M.store.flush().catch(() => {});
      return count;
    },
  };

  /** Show (once) an error the Google callback put in the URL, then remove it. */
  let linkedGoogle = false;
  function takeAuthError() {
    const params = new URLSearchParams(location.search);
    const code = params.get('auth_error');
    linkedGoogle = params.get('linked') === 'google';
    if (code) M.auth.notice = AUTH_ERRORS[code] || 'Sign-in failed. Please try again.';
    if (code || linkedGoogle) history.replaceState(null, '', location.pathname + location.hash);
  }

  async function afterLogin() {
    M.render();
    await M.store.init();
    if (M.store.ready()) M.safe(M.act.heartbeat);
    const pending = sessionStorage.getItem('meadow:pendingJoin');
    if (pending) {
      sessionStorage.removeItem('meadow:pendingJoin');
      location.hash = '#/join/' + pending;
      return;
    }
    if (!location.hash || /^#\/(join|as)/.test(location.hash)) location.hash = '#/';
    parseHash();
    M.render();
  }
  M.afterLogin = afterLogin;

  /* ------------------------------------------------------------------ boot */
  function onRoute() {
    parseHash();
    if (!M.auth.account && M.ui.route.name === 'join') sessionStorage.setItem('meadow:pendingJoin', M.ui.route.code);
    if (!M.auth.account || !M.store.ready()) { M.render(); return; }
    if (handleSpecialRoutes()) return;
    M.render();
  }

  window.addEventListener('hashchange', onRoute);
  M.store.subscribe(() => {
    parseHash();
    M.render();
  });

  document.addEventListener('DOMContentLoaded', async () => {
    takeAuthError();
    M.render();
    await M.auth.check();
    if (M.auth.account) {
      await M.store.init();
      if (M.auth.notice) M.toast(M.auth.notice);
      if (linkedGoogle) M.toast('Google Calendar connected');
      M.auth.notice = '';
      // An invite opened before a Google sign-in redirect survives in this tab's sessionStorage.
      const pendingJoin = sessionStorage.getItem('meadow:pendingJoin');
      if (pendingJoin) {
        sessionStorage.removeItem('meadow:pendingJoin');
        location.replace('#/join/' + pendingJoin);
      }
    }
    onRoute();
    if (M.store.ready()) M.safe(M.act.heartbeat);
    setInterval(() => { if (M.auth.account && M.store.ready()) M.safe(M.act.heartbeat); }, 20000);
    setInterval(() => {
      if (!document.hidden) M.render();
    }, 45000);
    // Escape closes the topmost modal.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const m = document.querySelectorAll('#modal-root .overlay');
        if (m.length) m[m.length - 1].remove();
      }
    });
  });
})();
