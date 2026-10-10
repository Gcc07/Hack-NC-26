/* Meadow — server-backed activity and searchable institutional memory. */
(function () {
  const M = window.Meadow;
  const { h } = M;
  const V = (M.views = M.views || {});
  const cache = new Map();
  const hour = (value) => M.fmt.hour(value) + ' UTC';

  function entry(orgId) {
    if (!cache.has(orgId)) cache.set(orgId, { loading: false, loaded: false, data: null, error: '', query: '', search: null, searching: false, searchError: '' });
    return cache.get(orgId);
  }

  async function get(path) {
    const response = await fetch(path, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('Could not load this information. Please try again.');
    return response.json();
  }

  async function refresh(orgId, state) {
    if (state.loading) return;
    state.loading = true;
    state.error = '';
    try {
      state.data = await get('/api/orgs/' + encodeURIComponent(orgId) + '/insights?days=14');
    } catch (error) {
      state.error = error.name === 'TimeoutError' ? 'The request took too long. Please try again.' : error.message;
    } finally {
      state.loading = false;
      state.loaded = true;
      M.render();
    }
  }

  async function search(orgId, state, query) {
    if (state.searching || !query.trim()) return;
    state.query = query.trim();
    state.searching = true;
    state.searchError = '';
    state.search = null;
    M.render();
    try {
      state.search = await get('/api/orgs/' + encodeURIComponent(orgId) + '/memory?q=' + encodeURIComponent(state.query));
    } catch (error) {
      state.searchError = error.name === 'TimeoutError' ? 'The search took too long. Please try again.' : error.message;
    } finally {
      state.searching = false;
      M.render();
    }
  }

  function sourceLink(orgId, result) {
    // Sources stay inside Meadow, even if imported text contains a hostile URL.
    if (result.eventId) return '#/o/' + encodeURIComponent(orgId) + '/events/' + encodeURIComponent(result.eventId);
    const url = result.url;
    return typeof url === 'string' && url.startsWith('#/o/' + encodeURIComponent(orgId) + '/') ? url : '#/o/' + encodeURIComponent(orgId) + '/board';
  }

  V.insightsPanel = function (org) {
    const state = entry(org.id);
    if (!state.loaded && !state.loading) refresh(org.id, state);
    const data = state.data;
    const activity = data ? data.activity || [] : [];
    const max = Math.max(1, ...activity.map((item) => (item.messages || 0) + (item.presence || 0)));
    const query = h('input', { type: 'search', value: state.query, maxlength: 300, placeholder: 'Try “fundraiser” or “room booking”', 'aria-label': 'Search organization memory', 'data-keep': 'memory-query-' + org.id, onInput: (event) => { state.query = event.target.value; } });
    return h('section', { class: 'card', 'aria-label': 'Organization insights and memory' },
      h('div', { class: 'row between wrap' }, h('h2', null, '🌱 Org pulse'), h('button', { class: 'btn small', disabled: state.loading, onClick: () => { refresh(org.id, state); M.render(); } }, state.loading ? 'Refreshing…' : 'Refresh')),
      h('p', { class: 'hint' }, 'The last 14 days of activity, plus a searchable memory for your next officer team.'),
      state.error ? h('p', { role: 'alert', class: 'notice' }, state.error) : null,
      !data && state.loading ? h('p', { role: 'status' }, 'Loading activity…') : null,
      data ? h('div', null,
        h('p', { class: 'hint' }, data.backend === 'tiger' ? 'Powered by Tiger Data' : 'Using this server’s in-memory data · resets on restart'),
        h('div', { class: 'row wrap' }, h('span', { class: 'pill' }, (data.totals.messages || 0) + ' messages'), h('span', { class: 'pill' }, (data.totals.checkins || 0) + ' check-ins')),
        activity.some((item) => item.messages || item.presence)
          ? h('div', null, h('h3', null, 'When your org is active'), h('p', { class: 'hint' }, 'Messages + presence signals by hour (UTC).'),
            h('div', { class: 'pulse-chart', role: 'img', 'aria-label': 'Hourly organization activity. Details are listed below.' }, activity.map((item) => h('span', { class: 'pulse-column', title: hour(item.hour) + ': ' + (item.messages || 0) + ' messages, ' + (item.presence || 0) + ' presence signals' }, h('i', { style: { height: (100 * ((item.messages || 0) + (item.presence || 0)) / max) + '%' } })))),
            h('div', { class: 'row between hint', 'aria-hidden': 'true' }, h('span', null, '12am'), h('span', null, '12pm'), h('span', null, '11pm UTC')),
            h('details', null, h('summary', null, 'Activity details'), h('ul', { class: 'plain' }, activity.filter((item) => item.messages || item.presence).map((item) => h('li', null, hour(item.hour) + ': ' + (item.messages || 0) + ' messages · ' + (item.presence || 0) + ' presence signals')))))
          : h('p', { class: 'hint' }, 'No activity recorded in this window yet. Send messages and check in to events to build your org’s history.'),
        data.preferredHours && data.preferredHours.length ? h('p', { class: 'hint' }, 'Most active hours: ' + data.preferredHours.map(hour).join(', ') + '. Check shared availability before planning an event.') : null,
        data.participation && data.participation.some((person) => person.checkins) ? h('details', null, h('summary', null, 'Event participation'), h('ul', { class: 'plain' }, data.participation.filter((person) => person.checkins).map((person) => h('li', null, person.name + ': ' + person.checkins + ' check-ins')))) : null) : null,
      h('h3', null, '🔎 Organization memory'),
      h('p', { class: 'hint' }, 'Find past decisions, event notes, and handoff advice. Open a source to read its context.'),
      h('form', { class: 'row wrap', onSubmit: (event) => { event.preventDefault(); search(org.id, state, query.value); } }, query, h('button', { type: 'submit', class: 'btn', disabled: state.searching }, state.searching ? 'Searching…' : 'Search')),
      state.searching ? h('p', { role: 'status' }, 'Searching organization memory…') : null,
      state.searchError ? h('p', { role: 'alert', class: 'notice' }, state.searchError) : null,
      state.search ? h('div', { 'aria-live': 'polite' },
        h('p', { class: 'hint' }, state.search.results.length + ' sources found' + (String(state.search.mode || '').startsWith('hybrid') ? ' · keyword + meaning search' : '') + '.'),
        state.search.warning ? h('p', { class: 'hint' }, state.search.warning) : null,
        state.search.results.length ? h('ul', { class: 'plain' }, state.search.results.map((result) => h('li', { class: 'memory-result' },
          h('a', { href: sourceLink(org.id, result) }, result.title || 'View source'),
          h('p', null, result.snippet || result.text || ''),
          result.source ? h('small', { class: 'hint' }, result.source) : null))) : h('p', { class: 'hint' }, 'No matching notes yet. Try another phrase, or add a guestbook note or handoff document.')) : null);
  };
})();
