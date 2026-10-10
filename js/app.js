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
      if (S().users[r.userId]) {
        M.session.set(r.userId);
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
    if (!M.store.ready()) return h('div', { class: 'login' },
      h('div', { class: 'login-card glass' }, h('h1', null, 'Connecting to Meadow…'),
        h('p', null, 'Your shared data will appear when Flask is connected.')));
    const me = M.me();
    if (!me) return M.views.login();
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

  /* ------------------------------------------------------------------ Google (optional) */
  M.google = {
    configured: () => !!(window.MEADOW_CONFIG && window.MEADOW_CONFIG.GOOGLE_CLIENT_ID),
    loadScript() {
      return new Promise((res, rej) => {
        if (window.google && window.google.accounts) return res();
        const s = document.createElement('script');
        s.src = 'https://accounts.google.com/gsi/client';
        s.async = true;
        s.onload = res;
        s.onerror = () => rej(new Error('Could not load Google sign-in.'));
        document.head.append(s);
      });
    },
    async renderButton(el) {
      try {
        await M.google.loadScript();
        window.google.accounts.id.initialize({
          client_id: window.MEADOW_CONFIG.GOOGLE_CLIENT_ID,
          callback: (resp) => {
            try {
              const payload = JSON.parse(decodeURIComponent(escape(atob(resp.credential.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))));
              M.act.signIn({ name: payload.name, email: payload.email, photo: payload.picture, google: true });
              afterLogin();
            } catch (e) {
              M.toast('Google sign-in failed: ' + e.message);
            }
          },
        });
        window.google.accounts.id.renderButton(el, { theme: 'outline', size: 'large', shape: 'pill', text: 'signin_with' });
      } catch (e) {
        el.textContent = e.message;
      }
    },
    async connectCalendar(uid) {
      await M.google.loadScript();
      return new Promise((resolve, reject) => {
        const client = window.google.accounts.oauth2.initTokenClient({
          client_id: window.MEADOW_CONFIG.GOOGLE_CLIENT_ID,
          scope: 'https://www.googleapis.com/auth/calendar.freebusy', // free/busy only — no event details
          callback: async (resp) => {
            if (resp.error) return reject(new Error(resp.error));
            try {
              const now = new Date();
              const r = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
                method: 'POST',
                headers: { Authorization: 'Bearer ' + resp.access_token, 'Content-Type': 'application/json' },
                body: JSON.stringify({ timeMin: now.toISOString(), timeMax: new Date(+now + 60 * M.DAY).toISOString(), items: [{ id: 'primary' }] }),
              });
              const j = await r.json();
              const busy = ((j.calendars && j.calendars.primary && j.calendars.primary.busy) || []).map((b) => [Date.parse(b.start), Date.parse(b.end)]);
              M.act.setBusy(uid, busy, { source: 'google', name: 'Google Calendar (free/busy)', count: busy.length });
              resolve(busy.length);
            } catch (e) {
              reject(e);
            }
          },
        });
        client.requestAccessToken();
      });
    },
  };

  function afterLogin() {
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
    if (!M.store.ready()) { M.render(); return; }
    if (handleSpecialRoutes()) return;
    M.render();
  }

  window.addEventListener('hashchange', onRoute);
  M.store.subscribe(() => {
    parseHash();
    M.render();
  });

  document.addEventListener('DOMContentLoaded', async () => {
    M.render();
    await M.store.init();
    onRoute();
    if (M.store.ready()) M.safe(M.act.heartbeat);
    setInterval(() => { if (M.store.ready()) M.safe(M.act.heartbeat); }, 20000);
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
