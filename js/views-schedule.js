/* Meadow — schedule tab: availability heatmap + "Ask Dewey" slot finder. */
(function () {
  const M = window.Meadow;
  const { h } = M;
  const S = () => M.store.get();
  const V = (M.views = M.views || {});

  const DURATIONS = [30, 45, 60, 90, 120, 150, 180, 240, 300];
  const durLabel = (m) => (m < 60 ? m + ' min' : m % 60 === 0 ? m / 60 + ' hr' : Math.floor(m / 60) + ' hr ' + (m % 60) + ' min');
  const hourLabel = (hr) => (hr === 24 ? 'midnight' : M.fmt.hour(hr));

  function initSched(org) {
    const base = M.AI.parseRequest('', {});
    M.ui.sched = { orgId: org.id, text: '', understood: [], title: 'Event', c: { ...base.constraints, orgId: org.id }, results: null, stats: null, busy: false };
    return M.ui.sched;
  }

  /* ---------------------------------------------------------------- heatmap */
  function heatmap(org) {
    const state = S();
    const week0 = M.addDays(M.startOfDay(Date.now()), M.ui.heatWeek * 7);
    const grid = M.availGrid(state, org.id, week0, 7, 8, 22);
    const events = Object.values(state.events).filter((e) => e.orgId === org.id && e.status !== 'cancelled');
    const unknown = Object.keys(org.members).filter((id) => !M.hasShared(state.users[id]));

    const head = h('tr', null, h('th', { scope: 'col' }, ''), grid.cols.map((c) => h('th', { scope: 'col', class: M.startOfDay(Date.now()) === c.dayMs ? 'today' : '' }, M.fmt.day(c.dayMs).replace(',', ''))));
    const rows = [];
    for (let i = 0; i < 14; i++) {
      rows.push(h('tr', null,
        h('th', { scope: 'row' }, M.fmt.hour(8 + i)),
        grid.cols.map((c) => {
          const cell = c.cells[i];
          const ratio = grid.total ? cell.free.length / grid.total : 0;
          const names = cell.free.map((id) => M.firstName(state.users[id].name));
          const ev = events.find((e) => e.start < cell.e && e.end > cell.s);
          const label = `${M.fmt.day(cell.s)} ${M.fmt.hour(cell.h)}: ${cell.free.length} of ${grid.total} free` + (names.length ? ` (${names.join(', ')})` : '') + (ev ? ` — ${ev.title}` : '');
          return h('td', { class: 'heat' + (ev ? ' has-event' : ''), style: { '--r': ratio.toFixed(2) }, title: label, 'aria-label': label, tabindex: '-1' }, cell.free.length);
        })));
    }

    return h('section', { class: 'card' },
      h('div', { class: 'row between wrap' },
        h('h2', null, '🌤️ Who’s free'),
        h('div', { class: 'row tight' },
          h('button', { class: 'btn small', disabled: M.ui.heatWeek <= 0, 'aria-label': 'Previous week', onClick: () => { M.ui.heatWeek--; M.render(); } }, '‹'),
          h('span', { class: 'hint' }, M.fmt.day(week0) + ' – ' + M.fmt.day(M.addDays(week0, 6))),
          h('button', { class: 'btn small', disabled: M.ui.heatWeek >= 8, 'aria-label': 'Next week', onClick: () => { M.ui.heatWeek++; M.render(); } }, '›'))),
      h('p', { class: 'hint' }, 'Each cell is the number of members with no busy block that hour. Outlined cells already have an event.'),
      h('div', { class: 'heat-wrap' }, h('table', { class: 'heatmap' }, h('thead', null, head), h('tbody', null, rows))),
      h('div', { class: 'legend' }, h('span', null, 'fewer free'), h('i', { class: 'grad' }), h('span', null, 'more free')),
      unknown.length ? h('p', { class: 'notice' }, `${M.plural(unknown.length, 'member')} haven’t shared availability yet (${unknown.slice(0, 5).map((id) => M.firstName(state.users[id].name)).join(', ')}${unknown.length > 5 ? '…' : ''}). Dewey can’t see them.`) : null);
  }

  /* ---------------------------------------------------------------- finder form */
  function finder(org) {
    const me = M.me();
    const state = S();
    const sc = M.ui.sched && M.ui.sched.orgId === org.id ? M.ui.sched : initSched(org);
    const c = sc.c;
    const officer = M.isOfficer(org, me.id);

    const ask = h('textarea', { rows: 2, 'data-keep': 'sched-ask', id: 'sched-ask', placeholder: 'e.g. sometime this weekend, not Sunday, need two tablers Thursday', 'aria-label': 'Describe what you need' });
    ask.value = sc.text || '';

    const run = () => {
      sc.results = null;
      sc.busy = true;
      const res = M.suggest(S(), { ...c, orgId: org.id });
      sc.results = res.results;
      sc.stats = res.stats;
      sc.busy = false;
      M.render();
    };

    const askDewey = async () => {
      const text = ask.value.trim();
      if (!text) return M.toast('Tell Dewey what you need first.');
      sc.text = text;
      const parsed = await M.AI.parseRequestSmart(text, {});
      sc.c = { ...parsed.constraints, orgId: org.id };
      sc.understood = parsed.understood;
      sc.title = parsed.title;
      const res = M.suggest(S(), sc.c);
      sc.results = res.results;
      sc.stats = res.stats;
      M.render();
    };

    const sel = (opts, val, onChange, label) => {
      const el = h('select', { 'aria-label': label, onChange: () => onChange(el.value) }, opts.map(([v, t]) => h('option', { value: v }, t)));
      el.value = val;
      return el;
    };
    const hours = Array.from({ length: 25 }, (_, i) => [i, hourLabel(i)]);

    const form = h('div', { class: 'finder-form' },
      h('label', null, 'What', sel([['event', 'Event (maximize attendance)'], ['officers', 'Officer meeting (all officers)']], c.mode, (v) => { c.mode = v; M.render(); }, 'Kind of slot')),
      h('label', null, 'How long', sel(DURATIONS.map((d) => [d, durLabel(d)]), DURATIONS.includes(c.durationMin) ? c.durationMin : 120, (v) => (c.durationMin = +v), 'Duration')),
      h('label', null, 'From', h('input', { type: 'date', value: M.fmt.dateInput(c.from), onChange: (e) => (c.from = Math.max(Date.now(), M.parseLocal(e.target.value, '00:00'))) })),
      h('label', null, 'Until', h('input', { type: 'date', value: M.fmt.dateInput(c.to), onChange: (e) => (c.to = M.parseLocal(e.target.value, '23:59')) })),
      h('label', null, 'Earliest', sel(hours.slice(0, 24), Math.floor(c.hourStart), (v) => (c.hourStart = +v), 'Earliest start')),
      h('label', null, 'Latest end', sel(hours.slice(1), Math.ceil(c.hourEnd), (v) => (c.hourEnd = +v), 'Latest end')),
      h('div', { class: 'days', role: 'group', 'aria-label': 'Allowed days' },
        M.DAY_SHORT.map((d, i) => {
          const b = h('button', { type: 'button', class: 'chip toggle' + (c.days.includes(i) ? ' on' : ''), 'aria-pressed': c.days.includes(i) ? 'true' : 'false', onClick: () => {
            c.days = c.days.includes(i) ? c.days.filter((x) => x !== i) : [...c.days, i];
            M.render();
          } }, d);
          return b;
        })));

    const rolesBox = h('div', { class: 'roles-chips' },
      h('strong', null, 'Roles to staff: '),
      c.roles.map((r, i) => h('span', { class: 'chip person' }, `${r.name} ×${r.headcount}`, h('button', { class: 'x-btn', 'aria-label': 'Remove ' + r.name, onClick: () => { c.roles.splice(i, 1); M.render(); } }, '×'))),
      sel([['', '+ add role…'], ...Object.keys(M.ROLE_TEMPLATES).map((k) => [k, k])], '', (v) => { if (v) { c.roles.push({ name: v, ...M.ROLE_TEMPLATES[v] }); M.render(); } }, 'Add role'));

    const results = sc.results
      ? h('div', { class: 'results' },
          h('h3', null, sc.results.length ? `Top ${sc.results.length} times` : 'No times found'),
          sc.stats ? h('p', { class: 'hint' }, `Checked ${sc.stats.considered} possible slots against ${M.plural(sc.stats.known, 'member')}’ free/busy.`) : null,
          !sc.results.length ? h('p', { class: 'notice' }, 'Nothing fits. Try widening the days, hours, or window — or drop a required role.') : null,
          sc.results.map((r, i) => resultCard(r, i, org, c, sc.title, officer, state)))
      : null;

    return h('section', { class: 'card finder' },
      h('div', { class: 'row tight' }, M.deweySvg(40), h('h2', null, 'Ask Dewey for a time')),
      h('p', { class: 'hint' }, 'Describe it in plain words, then tweak the details. Dewey proposes; officers decide. Scores come from a deterministic scheduler — no guessing.'),
      ask,
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onClick: askDewey }, '✨ Ask Dewey'), M.AI.llmEnabled() ? h('span', { class: 'chip free' }, 'Gemini on') : h('span', { class: 'hint' }, 'Offline language parser (set GEMINI_API_KEY in .env to upgrade)')),
      sc.understood.length ? h('div', { class: 'understood' }, h('small', null, 'Dewey understood: '), sc.understood.map((u) => h('span', { class: 'chip' }, u))) : null,
      form,
      rolesBox,
      h('div', { class: 'row end' }, h('button', { class: 'btn glossy-green', onClick: run }, '🔎 Find times')),
      results);
  }

  function resultCard(r, i, org, c, title, officer, state) {
    const bar = (label, v) => h('div', { class: 'bar', title: `${label}: ${Math.round(v * 100)}%` }, h('small', null, label), h('div', { class: 'meter thin' }, h('i', { style: { width: Math.round(v * 100) + '%' } })));
    return h('article', { class: 'result' + (i === 0 ? ' best' : '') },
      h('div', { class: 'score big', title: 'Score out of 100' }, h('b', null, r.score)),
      h('div', { class: 'result-main' },
        h('div', { class: 'row between wrap' },
          h('strong', null, `${i === 0 ? '⭐ ' : ''}${M.fmt.dayLong(r.start)}, ${M.fmt.time(r.start)} – ${M.fmt.time(r.end)}`)),
        h('div', { class: 'avatars' }, r.attendees.slice(0, 12).map((id) => state.users[id] && M.avatar(state.users[id], 22)), r.attendees.length > 12 ? h('small', null, '+' + (r.attendees.length - 12)) : null,
          r.busy.length ? h('small', { class: 'hint' }, ` · busy: ${r.busy.slice(0, 4).map((id) => M.firstName(state.users[id].name)).join(', ')}${r.busy.length > 4 ? '…' : ''}`) : null),
        h('div', { class: 'bars' }, bar('attendance', r.breakdown.attend), c.roles.length ? bar('roles', r.breakdown.coverage) : null, bar('hours', r.breakdown.pref), bar('buffer', r.breakdown.buffer)),
        c.roles.length
          ? h('div', { class: 'cover' }, r.coverage.roles.map((x) => h('span', { class: 'chip ' + (x.assigned.length >= x.headcount ? 'free' : 'busy') }, `${x.name} ${M.fmt.time(x.s)}: ${x.assigned.map((id) => M.firstName(state.users[id].name)).join(', ') || 'nobody free'}`)))
          : null,
        h('ul', { class: 'reasons' }, r.reasons.map((x) => h('li', null, x)))),
      h('div', { class: 'result-actions' },
        officer
          ? h('button', { class: 'btn primary', onClick: () => V.eventModal(org, { title: title || 'Event', mode: c.mode, start: r.start, end: r.end, roles: c.roles }) }, 'Propose ›')
          : h('span', { class: 'hint' }, 'Officers can propose this')));
  }

  V.scheduleTab = function (org) {
    return h('div', { class: 'main-scroll pad two-col', 'data-scroll': 'main' }, finder(org), heatmap(org));
  };
})();
