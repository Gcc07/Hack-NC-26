/* Meadow — shell views: login, title bar, org rail, home, buddy list, org window. */
(function () {
  const M = window.Meadow;
  const { h } = M;
  const S = () => M.store.get();
  M.views = M.views || {};
  const V = M.views;

  const TAGLINE = 'Meet Everyone, Anywhere, Doing Ordinary Wonders';

  /* ------------------------------------------------------------------ login */
  V.login = function () {
    const pending = sessionStorage.getItem('meadow:pendingJoin');
    const profiles = Object.values(S().users).filter((u) => !u.placeholder).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
    const nameIn = h('input', { id: 'login-name', 'data-keep': 'login-name', placeholder: 'Your name', autocomplete: 'name', required: true });
    const emailIn = h('input', { id: 'login-email', 'data-keep': 'login-email', type: 'email', placeholder: 'you@school.edu (optional)', autocomplete: 'email' });
    const googleSlot = h('div', { class: 'google-slot' });
    if (M.google.configured()) setTimeout(() => M.google.renderButton(googleSlot), 0);

    const signIn = (e) => {
      e.preventDefault();
      M.safe(() => {
        M.act.signIn({ name: nameIn.value, email: emailIn.value });
        M.afterLogin();
      });
    };

    return h(
      'div',
      { class: 'login' },
      h(
        'div',
        { class: 'login-hero' },
        M.logo(220),
        h('h1', { class: 'sr-only' }, 'Meadow'),
        h('p', { class: 'tagline' }, TAGLINE),
        h('p', { class: 'lede' }, 'Discord for student org event planning. Share availability, get a concrete plan, commit to a role, and chat — all in one sunny little place.'),
        h('ul', { class: 'bullets' },
          h('li', null, '📅 Free/busy sharing — never your event titles'),
          h('li', null, '🤖 Dewey suggests times; people decide'),
          h('li', null, '🙋 Roles that actually get claimed'))
      ),
      h(
        'div',
        { class: 'login-card glass' },
        h('h2', null, 'Sign in'),
        pending ? h('p', { class: 'notice' }, `You've been invited to an org (code ${pending}). Sign in to join!`) : null,
        M.google.configured()
          ? googleSlot
          : h('p', { class: 'hint' }, 'Google sign-in is available once you add a Google OAuth client ID in ', h('code', null, 'js/config.js'), '. For now, create a demo profile on this server:'),
        h('form', { class: 'stack', onSubmit: signIn },
          h('label', { for: 'login-name' }, 'Name'), nameIn,
          h('label', { for: 'login-email' }, 'School email'), emailIn,
          h('button', { class: 'btn primary lg', type: 'submit' }, 'Sign in')),
        profiles.length
          ? h('div', { class: 'profiles' },
              h('h3', null, 'Welcome back'),
              h('div', { class: 'profile-list' },
                profiles.slice(0, 8).map((u) =>
                  h('button', { class: 'profile', onClick: () => { M.session.set(u.id); M.store.update((s) => (s.users[u.id].lastSeen = Date.now()), { silent: true }); M.afterLogin(); } },
                    M.avatar(u, 28), h('span', null, u.name)))))
          : null,
        h('div', { class: 'divider' }, h('span', null, 'or')),
        h('button', {
          class: 'btn glossy-green lg',
          onClick: () => {
            const { orgId, ids } = M.act.seedDemo();
            M.session.set(ids['Maya Chen']);
            M.store.update((s) => (s.users[ids['Maya Chen']].lastSeen = Date.now()), { silent: true });
            location.hash = '#/o/' + orgId + '/chat';
            M.afterLogin();
          },
        }, '✨ Launch the demo org'),
        h('p', { class: 'hint' }, 'Creates “Sunrise Service Society” with 8 members, calendars, an event that needs people, and chat.')
      )
    );
  };

  /* ------------------------------------------------------------------ title bar / footer */
  V.titlebar = function (me, org) {
    return h(
      'header',
      { class: 'titlebar glass' },
      h('a', { class: 'brand', href: '#/', 'aria-label': 'Meadow home' }, M.logo(40), h('span', { class: 'wordmark' }, 'Meadow')),
      h('span', { class: 'tagline-sm' }, org ? `${org.emoji} ${org.name}` : TAGLINE),
      h('div', { class: 'spacer' }),
      h('a', { class: 'btn small', href: '#/me', 'aria-label': 'My profile and calendar' }, M.avatar(me, 22), h('span', null, me.name)),
      h('button', { class: 'btn small', onClick: () => { M.act.signOut(); location.hash = '#/'; M.render(); } }, 'Sign out')
    );
  };

  V.footer = () =>
    h('footer', { class: 'footer' }, 'Meadow · the system proposes, humans commit · Dewey only sees free/busy, never your event details');

  /* ------------------------------------------------------------------ org rail */
  V.rail = function (orgs, active, route) {
    return h(
      'nav',
      { class: 'rail glass', 'aria-label': 'Your organizations' },
      h('a', { class: 'rail-btn' + (route.name === 'home' ? ' active' : ''), href: '#/', title: 'Home', 'aria-label': 'Home' }, '🏠'),
      orgs.map((o) =>
        h('a', { class: 'rail-btn' + (active && active.id === o.id ? ' active' : ''), href: '#/o/' + o.id + '/chat', title: o.name, 'aria-label': o.name }, o.emoji)
      ),
      h('button', { class: 'rail-btn add', title: 'Create or join an org', 'aria-label': 'Create or join an org', onClick: () => V.orgModal() }, '+')
    );
  };

  V.orgModal = function () {
    const me = M.me();
    M.modal('Create or join an org', (close) => {
      const nm = h('input', { placeholder: 'e.g. Robotics Club', required: true });
      const emoji = h('select', null, ['🌿', '🌅', '🎨', '🤖', '🎭', '⚽', '📚', '🌎', '🎵', '🔬', '🍕', '🛠️'].map((e) => h('option', { value: e }, e)));
      const code = h('input', { placeholder: 'Invite code, e.g. SUNRISE' });
      return h('div', { class: 'stack' },
        h('h3', null, 'Start a new org'),
        h('div', { class: 'row' }, emoji, nm),
        h('button', { class: 'btn primary', onClick: () => M.safe(() => { const id = M.act.createOrg(me.id, nm.value, emoji.value); close(); M.go('#/o/' + id + '/members'); M.toast('Org created — share the invite link!'); }) }, 'Create org'),
        h('div', { class: 'divider' }, h('span', null, 'or')),
        h('h3', null, 'Join with an invite code'),
        h('div', { class: 'row' }, code, h('button', { class: 'btn', onClick: () => M.safe(() => { const id = M.act.joinOrg(me.id, code.value); close(); M.go('#/o/' + id + '/chat'); }) }, 'Join'))
      );
    });
  };

  /* ------------------------------------------------------------------ home */
  V.home = function (orgs) {
    const me = M.me();
    const state = S();
    const hasDemo = Object.values(state.orgs).some((o) => o.demo);
    const steps = [
      [!!me.calendar, 'Share your availability', 'Import an .ics file (or connect Google Calendar). Only busy times are kept.', () => M.go('#/me')],
      [orgs.length > 0, 'Join or create an org', 'Use an invite link from your officers, or start your own.', () => V.orgModal()],
      [orgs.some((o) => Object.values(state.events).some((e) => e.orgId === o.id && Object.values(e.roles).some((r) => r.claims.includes(me.id)))), 'Claim a role', 'Find an event that needs people and take a shift.', () => orgs[0] && M.go('#/o/' + orgs[0].id + '/events')],
    ];
    return h(
      'div',
      { class: 'main-scroll pad', 'data-scroll': 'main' },
      h('h1', null, `Hi ${M.firstName(me.name)}! `, h('span', { class: 'wave' }, '👋')),
      h('p', { class: 'lede' }, 'Welcome to Meadow — where student orgs figure out when, where, and who.'),
      h('section', { class: 'card' },
        h('h2', null, 'Getting started'),
        h('ol', { class: 'steps' },
          steps.map(([done, title, desc, fn]) =>
            h('li', { class: done ? 'done' : '' },
              h('span', { class: 'check', 'aria-hidden': 'true' }, done ? '✓' : ''),
              h('div', null, h('strong', null, title), h('p', { class: 'hint' }, desc)),
              h('button', { class: 'btn small', onClick: fn }, done ? 'Review' : 'Do it'))))
      ),
      h('section', { class: 'card' },
        h('h2', null, 'Your orgs'),
        orgs.length
          ? h('div', { class: 'org-grid' },
              orgs.map((o) => {
                const upcoming = Object.values(state.events).filter((e) => e.orgId === o.id && e.status !== 'cancelled' && e.end > Date.now()).sort((a, b) => a.start - b.start);
                const pend = upcoming.filter((e) => e.status === 'pending').length;
                return h('a', { class: 'org-card', href: '#/o/' + o.id + '/chat' },
                  h('span', { class: 'org-emoji' }, o.emoji),
                  h('strong', null, o.name),
                  h('span', { class: 'hint' }, `${M.plural(Object.keys(o.members).length, 'member')} · ${o.members[me.id].role}`),
                  h('span', { class: 'pill ' + (pend ? 'warn' : 'ok') }, pend ? `${pend} event${pend > 1 ? 's' : ''} need people` : upcoming.length ? `${upcoming.length} upcoming` : 'No events yet'));
              }))
          : h('p', { class: 'hint' }, 'You are not in any orgs yet.'),
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', onClick: () => V.orgModal() }, 'Create or join an org'),
          h('button', { class: 'btn glossy-green', onClick: () => {
            const { orgId, ids } = M.act.seedDemo();
            // Put the current user into the demo org so they can try everything.
            M.store.update((s) => { s.orgs[orgId].members[me.id] = { role: 'Events Chair', joinedAt: Date.now() }; });
            M.go('#/o/' + orgId + '/chat');
            M.toast('Demo org loaded — you are Events Chair. Open other people in new tabs from the buddy list!');
          } }, hasDemo ? '↻ Reload demo org' : '✨ Load demo org')),
      )
    );
  };

  /* ------------------------------------------------------------------ buddy list (presence, away messages, friends) */
  function freeNow(state, user) {
    if (!M.hasShared(user)) return null;
    const now = Date.now();
    return M.isFree(M.userIntervals(state, user.id), now, now + 15 * M.MIN);
  }

  V.buddies = function (me, org) {
    const state = S();
    const statusMsg = h('input', { 'data-keep': 'status-msg', id: 'status-msg', placeholder: 'Set an away message…', value: me.away || '', maxlength: 140, 'aria-label': 'Away message' });
    const presence = h('select', { 'aria-label': 'Presence', value: me.presence === 'away' ? 'away' : 'online', onChange: () => M.act.setStatus(me.id, { presence: presence.value }) },
      h('option', { value: 'online' }, '🟢 Available'), h('option', { value: 'away' }, '🟡 Away'));
    const saveStatus = () => {
      const res = M.act.setStatus(me.id, { away: statusMsg.value });
      M.toast(res.notes.length ? `Dewey read your status: ${res.notes.join(', ')}` : 'Away message saved');
    };

    const rowFor = (u, showMe) => {
      const p = M.presenceOf(u);
      const fn = freeNow(state, u);
      const dm = () => {
        if (u.id === me.id) return;
        const ch = 'dm:' + [me.id, u.id].sort().join(':');
        M.ui.channel = ch;
        M.go(org ? '#/o/' + org.id + '/chat' : '#/');
        M.render();
      };
      return h('li', null,
        h('button', { class: 'buddy', onClick: dm, title: u.id === me.id ? 'That is you' : 'Message ' + u.name },
          h('span', { class: 'dot ' + p, 'aria-label': p }),
          h('span', { class: 'buddy-main' },
            h('span', { class: 'buddy-name' }, u.name, u.id === me.id ? ' (you)' : ''),
            u.away ? h('span', { class: 'buddy-away' }, '“' + u.away + '”') : null),
          fn === null ? null : h('span', { class: 'chip ' + (fn ? 'free' : 'busy') }, fn ? 'free now' : 'busy now')));
    };

    const groups = [];
    if (org) {
      const members = Object.keys(org.members).map((id) => state.users[id]).filter(Boolean);
      const by = { online: [], away: [], offline: [] };
      members.forEach((u) => by[M.presenceOf(u)].push(u));
      for (const k of ['online', 'away', 'offline']) {
        by[k].sort((a, b) => a.name.localeCompare(b.name));
        if (by[k].length) groups.push(h('details', { open: k !== 'offline', class: 'bgroup' }, h('summary', null, `${M.titleCase(k)} (${by[k].length})`), h('ul', null, by[k].map((u) => rowFor(u)))));
      }
    }
    const friends = M.friendsOf(me.id).map((id) => state.users[id]).filter((u) => u && (!org || !org.members[u.id]));
    if (friends.length) groups.push(h('details', { open: true, class: 'bgroup' }, h('summary', null, `Friends (${friends.length})`), h('ul', null, friends.map((u) => rowFor(u)))));
    if (!groups.length) groups.push(h('p', { class: 'hint pad-sm' }, 'Join an org or add friends to see who is around.'));

    const demoPeople = org && org.demo ? Object.keys(org.members).map((id) => state.users[id]).filter((u) => u && u.id !== me.id) : [];

    return h(
      'aside',
      { class: 'buddies glass', 'aria-label': 'Buddy list' },
      h('div', { class: 'buddy-head' }, h('strong', null, '💬 Buddy List'), h('span', { class: 'hint' }, 'who’s around')),
      h('div', { class: 'my-status' },
        h('div', { class: 'row tight' }, M.avatar(me, 28), h('strong', null, M.firstName(me.name)), presence),
        statusMsg,
        h('button', { class: 'btn small', onClick: saveStatus }, 'Set away message'),
        h('p', { class: 'hint' }, 'Try “busy until 5pm” or “can’t do Thursday”.')),
      h('div', { class: 'buddies-scroll', 'data-scroll': 'buddies' }, groups),
      demoPeople.length
        ? h('details', { class: 'demo-switch' }, h('summary', null, '🎭 Demo: be someone else'),
            h('p', { class: 'hint' }, 'Opens a new tab signed in as that person. Chat and claims sync live between tabs.'),
            h('div', { class: 'demo-people' }, demoPeople.map((u) => h('a', { class: 'chip link', href: location.pathname + '#/as/' + u.id, target: '_blank', rel: 'noopener' }, M.firstName(u.name)))))
        : null
    );
  };

  /* ------------------------------------------------------------------ org window with tabs */
  V.orgWindow = function (org) {
    const me = M.me();
    const r = M.ui.route;
    const tabs = [['chat', '💬', 'Chat'], ['events', '📅', 'Events'], ['schedule', '🗓️', 'Schedule'], ['board', '📌', 'Board'], ['members', '👥', 'Members']];
    const state = S();
    const openFlares = Object.values(state.flares).filter((f) => f.status === 'open' && state.events[f.eventId] && state.events[f.eventId].orgId === org.id).length;
    const tab = tabs.find((t) => t[0] === r.tab) ? r.tab : 'chat';
    let body;
    if (tab === 'chat') body = V.chatTab(org);
    else if (tab === 'events') body = V.eventsTab(org);
    else if (tab === 'schedule') body = V.scheduleTab(org);
    else if (tab === 'board') body = V.boardTab(org);
    else body = V.membersTab(org);

    return h(
      'div',
      { class: 'org-window' },
      h('div', { class: 'org-head' },
        h('div', { class: 'org-title' }, h('span', { class: 'org-emoji sm' }, org.emoji), h('h1', null, org.name), h('span', { class: 'pill' }, org.members[me.id].role)),
        h('div', { class: 'tabs', role: 'tablist' },
          tabs.map(([k, icon, label]) =>
            h('a', { class: 'tab' + (tab === k ? ' active' : ''), role: 'tab', 'aria-selected': tab === k ? 'true' : 'false', href: '#/o/' + org.id + '/' + k },
              icon + ' ' + label, k === 'board' && openFlares ? h('span', { class: 'badge' }, openFlares) : null)))),
      h('div', { class: 'org-body ' + tab }, body)
    );
  };
})();
