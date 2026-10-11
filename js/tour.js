/* Meadow — guided tutorial mode: spotlights what to click on each page while someone narrates.

   A tour is a list of steps. Each step names a page (route), the element to highlight (its
   data-tour value), and a short caption. Steps marked `click` move on when the highlighted
   element is clicked; the rest move on with Next (or the → key). The spotlight lives outside
   #app and re-finds its target every frame, so the app's full re-renders never lose it. */
(function () {
  const M = window.Meadow;
  const { h } = M;
  const KEY = 'meadow:tour';
  const COMPACT_KEY = 'meadow:tourCompact';

  const sga = '#/o/org_sga/';
  const TOURS = {
    sga: {
      setup() {
        M.act.seedStudentGov(M.me().id);
        Object.assign(M.ui, { channel: null, sched: null, evFilter: 'upcoming', heatWeek: 0 });
      },
      steps: [
        { route: sga + 'overview', target: 'focus', title: 'Overview',
          text: 'Student Government at a glance: the next event, the spots that still need people, and your next shift.' },
        { route: sga + 'overview', target: 'buddies', title: 'Who’s around',
          text: 'Every member connected their calendar. Meadow shows who is free right now, never what their classes are.' },
        { route: sga + 'overview', target: 'tab-chat', click: true, title: 'Chat',
          text: 'Let’s talk to the org. Click Chat.' },
        { route: sga + 'chat', target: 'channels', title: 'Channels', enter: () => (M.ui.channel = 'org:org_sga'),
          text: '#general for the whole org, plus a channel for every event.' },
        { route: sga + 'chat', target: '#chat-input', title: 'Ask Dewey',
          fill: '@dewey find a time for a 1 hour town hall dry run next week, weekdays after 5pm',
          text: 'Dewey is our planning assistant. Mention @dewey and say what you need. We’ve typed a town hall dry run.' },
        { route: sga + 'chat', target: 'chat-send', click: true, title: 'Send',
          text: 'Send it. Dewey checks everyone’s free/busy and answers right in the chat.' },
        { route: sga + 'chat', target: 'sugg', last: true, title: 'Dewey’s picks', waiting: 'Waiting for Dewey to reply…',
          text: 'Ranked times with a score, who can make it, and “Why this time?”. Dewey suggests; officers decide.' },
        { route: sga + 'chat', target: 'tab-events', click: true, title: 'Events',
          text: 'Now let’s staff an event. Click Events.' },
        { route: sga + 'events', target: 'ev-filter', title: 'Events',
          text: 'Upcoming events, the ones that still need people, and past events with notes for next time.' },
        { route: sga + 'events', target: 'ev-evt_sga_homecoming', click: true, title: 'Homecoming Tabling',
          text: 'Homecoming still needs people. Click it.' },
        { route: sga + 'events/evt_sga_homecoming', target: 'ev-hero', title: 'Event status',
          text: 'Pending until every required role is filled. Then it confirms by itself.' },
        { route: sga + 'events/evt_sga_homecoming', target: 'claim:Food pickup', click: true, title: 'Claim a role',
          text: 'Take the open food pickup shift. If your calendar says you’re busy, Meadow warns you first.' },
        { route: sga + 'events/evt_sga_homecoming', target: 'roles', title: 'Roles',
          text: 'Officers see who is free for each open spot and can nudge them with one click.' },
        { route: sga + 'events/evt_sga_homecoming', target: 'tab-schedule', click: true, title: 'Schedule',
          text: 'Last stop: planning something new. Click Schedule.' },
        { route: sga + 'schedule', target: '#sched-ask', title: 'Describe it',
          fill: 'Homecoming afterparty, 2 hours next week after 6pm, need two greeters',
          text: 'Say what you need in plain words. We’ve typed a homecoming afterparty.' },
        { route: sga + 'schedule', target: 'ask-dewey', click: true, title: 'Ask Dewey',
          text: 'Click Ask Dewey.' },
        { route: sga + 'schedule', target: 'results', title: 'Best times', waiting: 'Waiting for Dewey…',
          text: 'Top times, scored on attendance, role coverage, preferred hours and breathing room. An officer can propose one as an event.' },
        { route: sga + 'schedule', target: 'heatmap', title: 'Who’s free',
          text: 'How many members are free each hour this week, straight from everyone’s calendars.' },
        { route: sga + 'overview', title: 'That’s Meadow',
          text: 'Overview, chat, events and schedule: less planning, more coming together.' },
      ],
    },
  };

  let tour = null; // { name, steps }
  let index = -1;
  let enteredAt = 0; // when the current step began; we keep its target in view for a moment
  let filledFor = -1;
  let frame = 0;
  let layer, ring, card;

  const save = () => {
    try {
      if (tour) sessionStorage.setItem(KEY, JSON.stringify({ name: tour.name, index }));
      else sessionStorage.removeItem(KEY);
    } catch { /* storage blocked: the tour just won't survive a reload */ }
  };
  const compact = () => { try { return sessionStorage.getItem(COMPACT_KEY) === '1'; } catch { return false; } };

  function find(step) {
    if (!step.target) return null;
    if (step.target[0] === '#') return document.getElementById(step.target.slice(1));
    const all = document.querySelectorAll(`#app [data-tour="${CSS.escape(step.target)}"]`);
    return all.length ? all[step.last ? all.length - 1 : 0] : null;
  }

  function build() {
    if (layer) return;
    ring = h('div', { class: 'tour-ring', 'aria-hidden': 'true' });
    card = h('div', { class: 'tour-card glass', role: 'dialog', 'aria-label': 'Tutorial' });
    layer = h('div', { id: 'tour-layer' }, ring, card);
    document.body.append(layer);
  }

  function drawCard() {
    const step = tour.steps[index];
    const last = index === tour.steps.length - 1;
    const small = compact();
    card.classList.toggle('compact', small);
    card.replaceChildren(...[
      h('div', { class: 'tour-top' },
        h('span', { class: 'tour-count' }, `${index + 1} / ${tour.steps.length}`),
        h('strong', null, step.title),
        h('button', { class: 'x-btn', title: small ? 'Show captions' : 'Hide captions', 'aria-label': small ? 'Show captions' : 'Hide captions', onClick: () => {
          try { sessionStorage.setItem(COMPACT_KEY, small ? '0' : '1'); } catch { /* ignore */ }
          drawCard();
        } }, small ? '▢' : '–')),
      small ? null : h('p', { class: 'tour-text' }, step.text),
      small ? null : h('p', { class: 'tour-wait hint small' }, step.waiting || ''),
      step.click && !small ? h('p', { class: 'tour-hint' }, '👆 Click the highlighted button') : null,
      h('div', { class: 'tour-nav' },
        h('button', { class: 'btn small', onClick: stop }, 'Exit'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn small', disabled: index === 0, onClick: () => go(index - 1) }, '‹ Back'),
        h('button', { class: 'btn small primary', onClick: next }, last ? 'Finish' : 'Next ›')),
    ].filter(Boolean));
  }

  function go(i, replace) {
    if (!tour) return;
    index = Math.max(0, Math.min(tour.steps.length - 1, i));
    filledFor = -1;
    enteredAt = performance.now();
    save();
    const step = tour.steps[index];
    if (step.enter) step.enter();
    if (step.route && location.hash !== step.route) {
      if (replace) location.replace(step.route);
      else location.hash = step.route;
    } else M.render();
    build();
    drawCard();
  }

  /** Next on a click step performs that click, so the story stays consistent either way. */
  function next() {
    if (!tour) return;
    if (index === tour.steps.length - 1) return stop();
    const step = tour.steps[index];
    const el = step.click && find(step);
    if (el) el.click();
    else go(index + 1);
  }

  function place() {
    frame = requestAnimationFrame(place);
    if (!tour || !layer) return;
    const ready = M.auth.account && M.store.ready() && M.me();
    layer.hidden = !ready;
    if (!ready) return;
    const step = tour.steps[index];
    const el = find(step);
    const rect = el && el.getBoundingClientRect();
    const visible = rect && rect.width > 0 && rect.height > 0;
    const modalOpen = !!document.querySelector('#modal-root .overlay');

    if (visible && step.fill && filledFor !== index && !el.value) {
      el.value = step.fill;
      filledFor = index;
    }
    // Instant, retried scrolling: a re-render restores the old scroll position mid-animation.
    // After a moment the presenter is free to scroll away.
    if (visible && performance.now() - enteredAt < 1500 && (rect.top < 60 || rect.bottom > innerHeight - 60)) {
      el.scrollIntoView({ block: 'center' });
    }
    const wait = card.querySelector('.tour-wait');
    if (wait) wait.hidden = visible || !step.waiting;

    ring.hidden = !visible || modalOpen;
    if (visible) {
      const pad = 6;
      Object.assign(ring.style, { left: rect.left - pad + 'px', top: rect.top - pad + 'px', width: rect.width + pad * 2 + 'px', height: rect.height + pad * 2 + 'px' });
    }

    // Card: below the target, else above, else beside it, else bottom centre.
    const cw = card.offsetWidth, ch = card.offsetHeight, gap = 18, edge = 12;
    let x, y;
    if (visible && !modalOpen) {
      if (rect.bottom + gap + ch < innerHeight - edge) { y = rect.bottom + gap; x = rect.left + rect.width / 2 - cw / 2; }
      else if (rect.top - gap - ch > edge) { y = rect.top - gap - ch; x = rect.left + rect.width / 2 - cw / 2; }
      else if (rect.right + gap + cw < innerWidth - edge) { x = rect.right + gap; y = rect.top + rect.height / 2 - ch / 2; }
      else if (rect.left - gap - cw > edge) { x = rect.left - gap - cw; y = rect.top + rect.height / 2 - ch / 2; }
    }
    if (x === undefined) { x = innerWidth / 2 - cw / 2; y = innerHeight - ch - 48; }
    card.style.left = Math.max(edge, Math.min(innerWidth - cw - edge, x)) + 'px';
    card.style.top = Math.max(edge, Math.min(innerHeight - ch - edge, y)) + 'px';
  }

  function onClick(e) {
    if (!tour) return;
    const step = tour.steps[index];
    if (!step.click) return;
    const el = find(step);
    if (!el || !el.contains(e.target)) return;
    const at = index;
    // Let the app handle the click (navigate, send, claim) before the next step looks for its target.
    setTimeout(() => { if (index === at) go(at + 1); }, 60);
  }

  function onKey(e) {
    if (!tour || e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); next(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(index - 1); }
  }

  function run(name, at, replace) {
    tour = { name, steps: TOURS[name].steps };
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey);
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(place);
    go(at, replace);
  }

  function stop() {
    tour = null;
    index = -1;
    save();
    cancelAnimationFrame(frame);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey);
    if (layer) layer.remove();
    layer = ring = card = null;
  }

  M.tour = {
    /** Seed the tour's data and start from step one. `replace` keeps #/tour out of history. */
    start(name, replace) {
      name = name || 'sga';
      stop();
      TOURS[name].setup();
      run(name, 0, replace);
    },
    stop,
    active: () => !!tour,
    /** Pick up where this tab left off after a reload. */
    resume() {
      if (tour) return;
      let saved = null;
      try { saved = JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch { /* ignore */ }
      if (saved && TOURS[saved.name] && M.store.get().orgs.org_sga) run(saved.name, saved.index || 0, true);
    },
  };
})();
