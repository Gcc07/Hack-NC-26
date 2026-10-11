/* Meadow — chat (org channel, event channels, DMs) and Dewey's message cards. */
(function () {
  const M = window.Meadow;
  const { h } = M;
  const S = () => M.store.get();
  const V = (M.views = M.views || {});

  /** **bold**, *italic*, line breaks, @mentions — built as DOM nodes (never innerHTML). */
  V.richText = function (text) {
    const lines = String(text).split('\n');
    const out = [];
    lines.forEach((line, i) => {
      const parts = line.split(/(\*\*[^*]+\*\*|\*[^*]+\*|@[A-Za-z][\w'-]*(?: [A-Z][a-z]+)?)/g);
      parts.forEach((p) => {
        if (!p) return;
        if (/^\*\*[^*]+\*\*$/.test(p)) out.push(h('strong', null, p.slice(2, -2)));
        else if (/^\*[^*]+\*$/.test(p)) out.push(h('em', null, p.slice(1, -1)));
        else if (/^@/.test(p)) out.push(h('span', { class: 'mention' }, p));
        else out.push(p);
      });
      if (i < lines.length - 1) out.push(h('br'));
    });
    return out;
  };

  function patchMessage(id, fn) {
    M.store.update((s) => {
      const m = s.messages.find((x) => x.id === id);
      if (m) fn(m);
    });
  }

  /* ---------------------------------------------------------------- cards inside assistant messages */
  function card(m, state, me, org) {
    const p = m.payload;
    if (!p) return null;

    if (p.type === 'event') {
      const ev = state.events[p.eventId];
      if (!ev) return null;
      const prog = M.eventProgress(ev);
      return h('div', { class: 'msg-card' },
        h('div', { class: 'row between' },
          h('strong', null, ev.title),
          h('span', { class: 'pill ' + (ev.status === 'confirmed' ? 'ok' : ev.status === 'cancelled' ? 'bad' : 'warn') }, ev.status)),
        h('div', { class: 'hint' }, M.fmt.range(ev.start, ev.end) + (ev.location ? ' · ' + ev.location : '')),
        prog.need ? h('div', { class: 'meter', title: `${prog.have} of ${prog.need} required spots filled` }, h('i', { style: { width: Math.round(prog.ratio * 100) + '%' } })) : null,
        h('a', { class: 'btn small', href: '#/o/' + ev.orgId + '/events/' + ev.id }, 'View & claim roles'));
    }

    if (p.type === 'flare') {
      const f = state.flares[p.flareId];
      if (!f) return null;
      const ev = state.events[f.eventId];
      const role = ev && ev.roles.find((r) => r.id === f.roleId);
      if (!role) return null;
      const iHave = role.claims.includes(me.id);
      const claimer = f.claimedBy && state.users[f.claimedBy];
      return h('div', { class: 'msg-card flare' },
        h('div', { class: 'row between' }, h('strong', null, `🔥 ${role.name} — ${ev.title}`), h('span', { class: 'pill ' + (f.status === 'open' ? 'warn' : f.status === 'claimed' ? 'ok' : '') }, f.status)),
        h('div', { class: 'hint' }, M.fmt.day(M.roleShift(ev, role)[0]) + ', ' + M.fmt.time(M.roleShift(ev, role)[0]) + '–' + M.fmt.time(M.roleShift(ev, role)[1]) + ' · ' + f.reason),
        f.status === 'open'
          ? h('div', { class: 'row' },
              h('button', { class: 'btn small primary', disabled: iHave || role.claims.length >= role.headcount, onClick: () => claimWithCheck(ev, role, me) }, iHave ? 'You have this' : '🙋 I’ll take it'),
              h('a', { class: 'btn small', href: '#/o/' + ev.orgId + '/events/' + ev.id }, 'Details'))
          : f.status === 'claimed' && claimer ? h('div', { class: 'hint' }, `Claimed by ${claimer.name} 🎉`) : null);
    }

    if (p.type === 'suggestions') {
      const isOfficer = M.isOfficer(org, me.id);
      return h('div', { class: 'msg-card sugg' },
        p.results.map((r, i) =>
          h('div', { class: 'sugg-row' },
            h('div', { class: 'score', title: 'Score from the deterministic scheduler' }, h('b', null, r.score), h('small', null, '/100')),
            h('div', { class: 'sugg-main' },
              h('strong', null, `${M.fmt.day(r.start)} · ${M.fmt.time(r.start)}–${M.fmt.time(r.end)}`),
              h('div', { class: 'avatars' }, r.attendees.slice(0, 8).map((id) => state.users[id] && M.avatar(state.users[id], 20)), r.attendees.length > 8 ? h('small', null, '+' + (r.attendees.length - 8)) : null),
              h('details', null, h('summary', null, 'Why this time?'), h('ul', { class: 'reasons' }, r.reasons.map((x) => h('li', null, x))))),
            isOfficer
              ? h('button', { class: 'btn small primary', onClick: () => V.eventModal(org, { title: p.title, mode: p.constraints.mode, start: r.start, end: r.end, roles: p.constraints.roles }) }, 'Propose')
              : null)));
    }

    if (p.type === 'nudges') {
      const mine = p.forUser === me.id;
      return h('div', { class: 'msg-card' },
        p.drafts.map((d, i) => {
          const u = state.users[d.userId];
          const sent = p.sent && p.sent.includes(i);
          return h('div', { class: 'nudge' },
            h('div', { class: 'row tight' }, u && M.avatar(u, 22), h('strong', null, u ? u.name : '?')),
            h('p', null, d.text),
            mine
              ? h('button', { class: 'btn small' + (sent ? '' : ' primary'), disabled: sent, onClick: () => { M.act.sendNudge(d, me.id); patchMessage(m.id, (x) => (x.payload.sent = [...(x.payload.sent || []), i])); } }, sent ? 'Sent ✓' : 'Send nudge')
              : h('span', { class: 'hint' }, sent ? 'Sent' : 'Draft — only the asker can send'));
        }));
    }

    if (p.type === 'busy') {
      const mine = p.forUser === me.id;
      return h('div', { class: 'msg-card' },
        p.blocks.map((b) => h('div', { class: 'hint' }, `Busy ${M.fmt.day(b[0])} ${M.fmt.time(b[0])} → ${M.fmt.day(b[1])} ${M.fmt.time(b[1])}`)),
        mine
          ? h('button', { class: 'btn small' + (p.applied ? '' : ' primary'), disabled: !!p.applied, onClick: () => { M.act.applyBusy(me.id, p.blocks); patchMessage(m.id, (x) => (x.payload.applied = true)); } }, p.applied ? 'Added ✓' : 'Add to my availability')
          : h('span', { class: 'hint' }, 'Waiting for ' + M.firstName((state.users[p.forUser] || {}).name) + ' to confirm'));
    }
    return null;
  }

  /** Claim with a gentle conflict warning (we only warn — people decide). */
  function claimWithCheck(ev, role, me) {
    const state = S();
    const [s, e] = M.roleShift(ev, role);
    const free = !M.hasShared(me) || M.isFree(M.userIntervals(state, me.id, ev.id), s, e);
    const go = () => M.safe(() => {
      M.act.claimRole(ev.id, role.id, me.id);
      const current = S().events[ev.id];
      const prog = M.eventProgress(current);
      const toast = document.getElementById('toast-root');
      M.toast(`${role.name} claimed — ${prog.have} of ${prog.need} required spots filled. Saving…`);
      const message = toast.lastElementChild;
      if (message) { message.classList.add('bloom-toast'); message.prepend(M.icon('flower', 42)); }
    });
    if (free) go();
    else M.confirm(`Your calendar shows you as busy during ${M.fmt.time(s)}–${M.fmt.time(e)}. Claim ${role.name} anyway?`, go);
  }
  V.claimWithCheck = claimWithCheck;

  /* ---------------------------------------------------------------- message list */
  function messageEl(m, state, me, org) {
    const isBot = m.source === 'assistant';
    const user = m.userId && state.users[m.userId];
    const name = isBot ? 'Dewey' : user ? user.name : m.author || 'Unknown';
    const avatar = isBot ? M.deweySvg(34) : M.avatar(user || { name }, 34);
    const bridged = m.source === 'groupme' || m.source === 'sms';
    return h('div', { class: 'msg' + (isBot ? ' bot' : '') + (user && user.id === me.id ? ' mine' : '') },
      avatar,
      h('div', { class: 'msg-body' },
        h('div', { class: 'msg-meta' },
          h('strong', null, name),
          isBot ? h('span', { class: 'pill tiny' }, 'assistant') : null,
          bridged ? h('span', { class: 'pill tiny bridge' }, 'via ' + (m.source === 'groupme' ? 'GroupMe' : 'SMS')) : null,
          h('time', null, M.fmt.chatTime(m.ts))),
        h('div', { class: 'msg-text' }, V.richText(m.text)),
        card(m, state, me, org)));
  }

  V.chatPanel = function (channel, title, org, opts) {
    const state = S();
    const me = M.me();
    const msgs = state.messages.filter((m) => m.channel === channel);
    const input = h('input', { 'data-keep': 'chat-' + channel, id: 'chat-input', placeholder: (opts && opts.placeholder) || 'Message… (try @dewey help)', autocomplete: 'off', maxlength: 2000, 'aria-label': 'Message' });
    const send = (e) => {
      e && e.preventDefault();
      const text = input.value;
      if (!text.trim()) return;
      input.value = '';
      M.act.postMessage(channel, me.id, text);
    };
    const quick = (label, text, direct) =>
      h('button', { type: 'button', class: 'chip link', onClick: () => (direct ? M.act.postMessage(channel, me.id, text) : ((input.value = text), input.focus())) }, label);

    return h('section', { class: 'chat', 'aria-label': title },
      h('div', { class: 'chat-head' }, h('strong', null, title), org && !channel.startsWith('dm:') ? h('span', { class: 'hint' }, 'Dewey is listening for @dewey') : null),
      h('div', { class: 'chat-log', 'data-scroll': 'chat-' + channel, role: 'log', 'aria-live': 'polite' },
        msgs.length ? msgs.map((m) => messageEl(m, state, me, org)) : h('p', { class: 'hint pad' }, 'No messages yet. Say hello! 👋')),
      org && !channel.startsWith('dm:')
        ? h('div', { class: 'quick' },
            quick('✨ Find a time…', '@dewey find a time for a 2 hour social this weekend, not Sunday, need two tablers'),
            quick('📣 Nudge open roles', '@dewey nudge', true),
            quick('🧾 Summarize', '@dewey summarize', true),
            quick('❓ Help', '@dewey help', true))
        : null,
      h('form', { class: 'chat-form', onSubmit: send }, input, h('button', { class: 'btn primary', type: 'submit' }, 'Send')));
  };

  /* ---------------------------------------------------------------- tab */
  V.chatTab = function (org) {
    const state = S();
    const me = M.me();
    const events = Object.values(state.events)
      .filter((e) => e.orgId === org.id && e.status !== 'cancelled' && e.end > Date.now() - 86400000)
      .sort((a, b) => a.start - b.start);
    const dmIds = new Set();
    state.messages.forEach((m) => {
      if (m.channel.startsWith('dm:') && m.channel.split(':').slice(1).includes(me.id)) dmIds.add(m.channel);
    });
    if (M.ui.channel && M.ui.channel.startsWith('dm:') && M.ui.channel.split(':').slice(1).includes(me.id)) dmIds.add(M.ui.channel);

    const valid = (ch) =>
      ch === 'org:' + org.id || events.some((e) => 'event:' + e.id === ch) || dmIds.has(ch);
    let ch = M.ui.channel && valid(M.ui.channel) ? M.ui.channel : 'org:' + org.id;
    M.ui.channel = ch;

    const chBtn = (id, label, sub) =>
      h('button', { class: 'channel' + (ch === id ? ' active' : ''), onClick: () => { M.ui.channel = id; M.render(); } }, h('span', null, label), sub ? h('small', null, sub) : null);

    let title = '# general';
    if (ch.startsWith('event:')) title = '📅 ' + state.events[ch.split(':')[1]].title;
    if (ch.startsWith('dm:')) {
      const other = ch.split(':').slice(1).find((id) => id !== me.id);
      title = '💬 ' + ((state.users[other] || {}).name || 'Direct message');
    }

    return h('div', { class: 'chat-layout' },
      h('aside', { class: 'channels', 'aria-label': 'Channels' },
        h('h3', null, 'Channels'),
        chBtn('org:' + org.id, '# general'),
        events.length ? h('h3', null, 'Events') : null,
        events.map((e) => chBtn('event:' + e.id, e.title, e.status === 'pending' ? 'pending' : M.fmt.day(e.start))),
        dmIds.size ? h('h3', null, 'Direct') : null,
        [...dmIds].map((id) => {
          const other = id.split(':').slice(1).find((x) => x !== me.id);
          return chBtn(id, '💬 ' + M.firstName((state.users[other] || {}).name));
        }),
        ch === 'org:' + org.id ? bridgeSim(org) : null),
      V.chatPanel(ch, title, org));
  };

  function bridgeSim(org) {
    const who = h('input', { placeholder: 'Dana', 'data-keep': 'sim-who', 'aria-label': 'Sender name' });
    const txt = h('input', { placeholder: 'Message', 'data-keep': 'sim-text', 'aria-label': 'Message text' });
    const src = h('select', { 'aria-label': 'Bridge' }, h('option', { value: 'groupme' }, 'GroupMe'), h('option', { value: 'sms' }, 'SMS'));
    return h('details', { class: 'sim' },
      h('summary', null, '📡 Bridge simulator'),
      h('p', { class: 'hint' }, 'A real deployment receives these through a GroupMe bot callback or SMS webhook. Simulate one here.'),
      who, txt, src,
      h('button', { class: 'btn small', onClick: () => { if (txt.value.trim()) { M.act.simulateBridged(org.id, who.value || 'Someone', txt.value, src.value); txt.value = ''; } } }, 'Deliver'));
  }
})();
