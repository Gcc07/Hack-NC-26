/* Meadow — shell views: login, title bar, org rail, home, buddy list, org window. */
(function () {
  const M = window.Meadow;
  const { h } = M;
  const S = () => M.store.get();
  M.views = M.views || {};
  const V = M.views;

  const TAGLINE = 'Meet Everyone, Anywhere, Doing Ordinary Wonders';

  /* ------------------------------------------------------------------ login */
  /* Stacked bars whose right edges ripple like a vertical sine wave down the screen.
     Palette (light -> dark): #cdf2ff, #b4dee6, #4aaae6, #318dde. */
  const PALETTE = ['#cdf2ff', '#b4dee6', '#4aaae6', '#318dde'];
  const mix = (a, b, t) => {
    const p = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const [r1, g1, b1] = p(a);
    const [r2, g2, b2] = p(b);
    return `rgb(${Math.round(r1 + (r2 - r1) * t)},${Math.round(g1 + (g2 - g1) * t)},${Math.round(b1 + (b2 - b1) * t)})`;
  };
  const paletteAt = (t) => {
    const x = Math.min(0.999, Math.max(0, t)) * (PALETTE.length - 1);
    const i = Math.floor(x);
    return mix(PALETTE[i], PALETTE[i + 1], x - i);
  };

  V.waveBackdrop = function () {
    const BARS = 16;
    const PERIODS = 6; // over a 200-unit tall canvas = 3 periods per screen height, so the drift loops seamlessly
    let paths = '';
    for (let i = BARS - 1; i >= 0; i--) {
      const t = i / (BARS - 1); // 0 = far left/lightest, 1 = wave edge/darkest
      const base = 10 + t * 74;
      const amp = 2.4 + t * 3.2;
      const phase = i * 0.32;
      let d = 'M0,0';
      for (let y = 0; y <= 200; y += 1) {
        const x = base + amp * Math.sin((y / 200) * PERIODS * 2 * Math.PI + phase);
        d += ` L${x.toFixed(2)},${y}`;
      }
      d += ' L0,200 Z';
      paths += `<path d="${d}" fill="${paletteAt(t)}" stroke="rgba(255,255,255,${(0.25 + t * 0.4).toFixed(2)})" stroke-width="1"/>`;
    }
    const wrap = document.createElement('div');
    wrap.className = 'wave-bg';
    wrap.setAttribute('aria-hidden', 'true');
    wrap.innerHTML = `<svg viewBox="0 0 100 200" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">${paths}</svg>`;
    return wrap;
  };

  /* Login hero: a tightly packed vertical montage of every Meadow logo. It pans downward fast, then eases out
     and comes to rest on the wide logo + tagline. The pan plays once per page load; if the screen re-renders
     mid-pan it resumes where it left off, and afterwards it shows the resting state. */
  const REEL_IMAGES = {
    one: ['Assets/Meadow1.png', 256, 256],
    two: ['Assets/Meadow2.png', 256, 256],
    three: ['Assets/Meadow3.png', 450, 337],
    wide: ['Assets/meadow_2.png', 484, 256],
  };
  const reelTile = (key, cls) => {
    const [src, width, height] = REEL_IMAGES[key];
    return h('img', { class: 'reel-tile' + (cls ? ' ' + cls : ''), src, width, height, alt: key === 'wide' && cls ? 'Meadow' : '', draggable: 'false' });
  };
  const REEL_MS = 9000;
  let reelStart = null; // the pan runs once per page load; a re-render resumes it at the right moment
  V.logoReel = function () {
    const above = h('div', { class: 'reel-above', 'aria-hidden': 'true' }, ['two', 'three', 'one'].map((k) => reelTile(k)));
    const belowKeys = [];
    for (let i = 0; i < 3; i++) belowKeys.push('three', 'two', 'one', 'wide');
    const below = h('div', { class: 'reel-below', 'aria-hidden': 'true' }, belowKeys.map((k) => reelTile(k)));
    const belowBox = h('div', { class: 'reel-below-box' }, below);
    const main = h('div', { class: 'reel-main-block' }, reelTile('wide', 'reel-main'), h('h1', { class: 'tagline' }, TAGLINE));
    const col = h('div', { class: 'reel-col' }, above, main, belowBox);
    if (reelStart === null) reelStart = performance.now();
    const playing = performance.now() - reelStart < REEL_MS;
    const reel = h('div', { class: 'reel' + (playing ? ' reel-pending' : '') }, col);
    if (playing) {
      setTimeout(() => {
        reel.classList.remove('reel-pending');
        const calm = window.matchMedia('(max-width: 760px), (prefers-reduced-motion: reduce)').matches;
        if (calm || !col.isConnected || !col.animate) return;
        const distance = Math.max(0, below.offsetHeight - reel.clientHeight / 2 - 20);
        const run = col.animate(
          [{ transform: `translateY(calc(-50% - ${distance}px))` }, { transform: 'translateY(-50%)' }],
          { duration: REEL_MS, easing: 'cubic-bezier(.08,.6,.12,1)', fill: 'both' }
        );
        run.currentTime = Math.min(REEL_MS, performance.now() - reelStart);
      }, 0);
    }
    return reel;
  };

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
      V.waveBackdrop(),
      h(
        'div',
        { class: 'login-hero' },
        V.logoReel()
      ),
      h(
        'div',
        { class: 'login-card glass' },
        h('div', { class: 'login-chrome' }, M.icon('folder', 20), 'meadow / welcome'),
        h('h2', null, 'Come on in.'),
        h('p', { class: 'hint' }, 'Your people are just a little closer.'),
        pending ? h('p', { class: 'notice' }, `You've been invited to an org (code ${pending}). Sign in to join!`) : null,
        M.google.configured()
          ? googleSlot
          : h('p', { class: 'hint' }, 'Choose a name to explore this local demo.'),
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
            location.hash = '#/o/' + orgId + '/overview';
            M.afterLogin();
          },
        }, M.icon('leaf'), 'Launch the demo org'),
        h('p', { class: 'hint' }, 'Take a look around Sunrise Service Society. Eight friendly faces, shared calendars, and plans in the making.')
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
      h('a', { class: 'rail-btn' + (route.name === 'home' ? ' active' : ''), href: '#/', title: 'Home', 'aria-label': 'Home' }, M.icon('folder', 30)),
      orgs.map((o) =>
        h('a', { class: 'rail-btn' + (active && active.id === o.id ? ' active' : ''), href: '#/o/' + o.id + '/overview', title: o.name, 'aria-label': o.name }, o.emoji)
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
  V.focusPanel = function (orgs) {
    const me = M.me(), now = Date.now();
    const ids = new Set(orgs.map(o => o.id));
    const events = Object.values(S().events).filter(e => ids.has(e.orgId) && e.status !== 'cancelled' && e.end > now).sort((a,b) => a.start-b.start);
    const next = events[0];
    const open = events.filter(e => M.eventProgress(e).open > 0);
    const shifts = events.flatMap(e => e.roles.filter(r => r.claims.includes(me.id)).map(r => ({event:e, role:r, times:M.roleShift(e,r)}))).filter(s => s.times[1] > now).sort((a,b) => a.times[0]-b.times[0]);
    const shift = shifts[0];
    const link = (e, label) => h('a', {class:'btn small', href:'#/o/'+e.orgId+'/events/'+e.id}, label);
    return h('section', {class:'focus-section'},
      h('div', {class:'section-heading'}, h('h2', null, 'Your meadow, at a glance'), h('p', {class:'hint'}, 'A little less planning. A little more coming together.')),
      h('div', {class:'focus-grid'},
        h('article', {class:'card focus-card'}, h('span', {class:'eyebrow'}, M.icon('calendar'), 'Next event'), h('h3', null, next ? next.title : 'Room for a new idea'), h('p', null, next ? M.fmt.range(next.start,next.end) : 'Your upcoming events will appear here.'), next ? link(next,'View event') : null),
        h('article', {class:'card focus-card'}, h('span', {class:'eyebrow'}, M.icon('flower'), 'People needed'), h('h3', null, open.length ? M.plural(open.reduce((n,e)=>n+M.eventProgress(e).open,0),'open spot') : 'All caught up'), h('p', null, open.length ? M.plural(open.length,'event')+' could use a helping hand.' : 'No upcoming required roles are waiting.'), open.length ? link(open[0],'View open roles') : null),
        h('article', {class:'card focus-card'}, h('span', {class:'eyebrow'}, M.icon('leaf'), 'Your next commitment'), h('h3', null, shift ? shift.role.name : 'Find your part'), h('p', null, shift ? shift.event.title+' · '+M.fmt.range(...shift.times) : 'Claim a role to put your next shift here.'), shift ? link(shift.event,'View your shift') : open.length ? link(open[0],'Explore roles') : null)));
  };

  V.home = function (orgs) {
    const me = M.me();
    const state = S();
    const hasDemo = Object.values(state.orgs).some((o) => o.demo);
    const steps = [
      [!!me.calendar, 'Share your availability', 'Import an .ics file (or connect Google Calendar). Only busy times are kept.', () => M.go('#/me')],
      [orgs.length > 0, 'Join or create an org', 'Use an invite link from your officers, or start your own.', () => V.orgModal()],
      [orgs.some((o) => Object.values(state.events).some((e) => e.orgId === o.id && Object.values(e.roles).some((r) => r.claims.includes(me.id)))), 'Claim a role', 'Find an event that needs people and take a shift.', () => orgs[0] && M.go('#/o/' + orgs[0].id + '/events')],
    ];
    const page = h(
      'div',
      { class: 'main-scroll pad home-content', 'data-scroll': 'main' },
      h('h1', null, `Hi ${M.firstName(me.name)}! `, h('span', { class: 'wave' }, '👋')),
      h('p', { class: 'lede' }, 'Welcome to Meadow — where student orgs figure out when, where, and who.'),
      V.focusPanel(orgs),
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
                return h('a', { class: 'org-card', href: '#/o/' + o.id + '/overview' },
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
    return h('div', { class: 'home-wrap' }, V.waveBackdrop(), page);
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
      h('div', { class: 'buddy-head' }, h('strong', { class: 'icon-label' }, M.icon('people', 22), 'Buddy List'), h('span', { class: 'hint' }, 'who’s around')),
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
    const tabs = [['overview', 'leaf', 'Overview'], ['chat', 'chat', 'Chat'], ['events', 'calendar', 'Events'], ['schedule', 'calendar', 'Schedule'], ['board', 'folder', 'Board'], ['members', 'people', 'Members']];
    const state = S();
    const openFlares = Object.values(state.flares).filter((f) => f.status === 'open' && state.events[f.eventId] && state.events[f.eventId].orgId === org.id).length;
    const tab = tabs.find((t) => t[0] === r.tab) ? r.tab : 'chat';
    let body;
    if (tab === 'overview') body = h('div', { class: 'main-scroll pad' }, V.focusPanel([org]), h('section', { class: 'card' }, h('h2', null, 'Make something happen'), h('p', { class: 'hint' }, 'Share availability, agree on a time, and take a role. Dewey can help you plan.'), h('a', { class: 'btn', href: '#/o/' + org.id + '/schedule' }, M.icon('calendar'), 'Find a time')));
    else if (tab === 'chat') body = V.chatTab(org);
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
              M.icon(icon, 21), label, k === 'board' && openFlares ? h('span', { class: 'badge' }, openFlares) : null)))),
      h('div', { class: 'org-body ' + tab }, body)
    );
  };
})();
