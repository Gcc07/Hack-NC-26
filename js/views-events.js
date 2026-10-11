/* Meadow — events: list, detail with role claiming, check-in, guestbook, create modal. */
(function () {
  const M = window.Meadow;
  const { h } = M;
  const S = () => M.store.get();
  const V = (M.views = M.views || {});

  const statusPill = (ev) =>
    h('span', { class: 'pill ' + (ev.status === 'confirmed' ? 'ok' : ev.status === 'cancelled' ? 'bad' : 'warn') },
      ev.status === 'confirmed' ? '✅ confirmed' : ev.status === 'cancelled' ? 'cancelled' : '⏳ pending');

  /* ---------------------------------------------------------------- list */
  function list(org) {
    const state = S();
    const me = M.me();
    const now = Date.now();
    const all = Object.values(state.events).filter((e) => e.orgId === org.id);
    const filters = {
      upcoming: (e) => e.status !== 'cancelled' && e.end >= now,
      needs: (e) => e.status === 'pending' && e.end >= now,
      past: (e) => e.status !== 'cancelled' && e.end < now,
      cancelled: (e) => e.status === 'cancelled',
    };
    const labels = { upcoming: 'Upcoming', needs: 'Needs people', past: 'Past', cancelled: 'Cancelled' };
    const cur = filters[M.ui.evFilter] ? M.ui.evFilter : 'upcoming';
    const items = all.filter(filters[cur]).sort((a, b) => (cur === 'past' ? b.start - a.start : a.start - b.start));

    return h('div', { class: 'main-scroll pad', 'data-scroll': 'main' },
      h('div', { class: 'row between wrap' },
        h('div', { class: 'seg', role: 'group', 'aria-label': 'Filter events' },
          Object.keys(labels).map((k) => h('button', { class: 'seg-btn' + (cur === k ? ' active' : ''), 'aria-pressed': cur === k ? 'true' : 'false', onClick: () => { M.ui.evFilter = k; M.render(); } },
            labels[k] + ' ', h('small', null, all.filter(filters[k]).length)))),
        M.isOfficer(org, me.id)
          ? h('button', { class: 'btn primary', onClick: () => V.eventModal(org) }, '＋ New event')
          : h('span', { class: 'hint' }, 'Officers create events; everyone claims roles.')),
      items.length
        ? h('div', { class: 'event-grid' }, items.map((ev) => eventCard(ev, state, me)))
        : h('div', { class: 'empty' }, M.icon('leaf', 54), h('p', null, cur === 'upcoming' ? 'Plant the first idea.' : 'A quiet patch of meadow.'),
            cur === 'upcoming' ? h('p', { class: 'hint' }, 'Head to the Schedule tab and ask Dewey for the best times.') : null));
  }

  function eventCard(ev, state, me) {
    const prog = M.eventProgress(ev);
    const mine = ev.roles.filter((r) => r.claims.includes(me.id));
    const plans = Object.values(ev.plans || {});
    const planHint = plans.length
      ? plans.filter((p) => p.status === 'going').length + ' in · '
        + plans.filter((p) => p.status === 'late').length + ' late · '
        + plans.filter((p) => p.status === 'cant').length + " can't"
      : null;
    return h('a', { class: 'event-card status-' + ev.status, href: '#/o/' + ev.orgId + '/events/' + ev.id },
      h('div', { class: 'row between' }, h('span', { class: 'pill' }, ev.type), statusPill(ev)),
      h('h3', null, ev.title),
      h('div', { class: 'event-date icon-label' }, M.icon('calendar'), M.fmt.range(ev.start, ev.end)),
      ev.location ? h('div', { class: 'hint' }, '📍 ' + ev.location) : null,
      planHint ? h('div', { class: 'chip free' }, '📱 ' + planHint) : null,
      prog.need
        ? M.gardenProgress(prog)
        : h('small', null, 'No required roles'),
      mine.length ? h('div', { class: 'chip free' }, 'You: ' + mine.map((r) => r.name).join(', ')) : null,
      h('span', { class: 'event-cta' }, prog.open && ev.status !== 'cancelled' && ev.end > Date.now() ? 'View open roles →' : 'View event →'));
  }

  /* ---------------------------------------------------------------- .ics export of one event */
  function eventIcs(ev) {
    const f = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Meadow//EN', 'BEGIN:VEVENT', 'UID:' + ev.id + '@meadow', 'DTSTAMP:' + f(Date.now()), 'DTSTART:' + f(ev.start), 'DTEND:' + f(ev.end), 'SUMMARY:' + ev.title.replace(/[,;\n]/g, ' '), 'LOCATION:' + (ev.location || '').replace(/[,;\n]/g, ' '), 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  }

  /* ---------------------------------------------------------------- detail */
  function detail(org, ev) {
    const state = S();
    const me = M.me();
    if (!ev || ev.orgId !== org.id) return h('div', { class: 'pad' }, h('p', null, 'That event no longer exists.'), h('a', { class: 'btn', href: '#/o/' + org.id + '/events' }, '← All events'));
    const officer = M.isOfficer(org, me.id);
    const prog = M.eventProgress(ev);
    const now = Date.now();
    const cancelled = ev.status === 'cancelled';

    const roleRow = (role) => {
      const [s, e] = M.roleShift(ev, role);
      const iHave = role.claims.includes(me.id);
      const full = role.claims.length >= role.headcount;
      const openFlare = Object.values(state.flares).find((f) => f.eventId === ev.id && f.roleId === role.id && f.status === 'open');
      const cands = officer && !full && !cancelled ? M.candidatesForRole(state, ev, role).slice(0, 5) : [];
      return h('div', { class: 'role' + (full ? ' full' : '') },
        h('div', { class: 'role-main' },
          h('div', { class: 'row tight wrap' },
            h('strong', null, role.name),
            h('span', { class: 'pill tiny ' + (role.required ? 'warn' : '') }, role.required ? 'required' : 'optional'),
            openFlare ? h('span', { class: 'pill tiny bad' }, '🔥 flare out') : null),
          h('div', { class: 'hint' }, `${M.fmt.time(s)}–${M.fmt.time(e)}`),
          h('div', { class: 'claimants' },
            role.claims.map((id) => {
              const u = state.users[id];
              return h('span', { class: 'chip person' }, u && M.avatar(u, 18), u ? M.firstName(u.name) : '?');
            }),
            Array.from({ length: Math.max(0, role.headcount - role.claims.length) }, () => h('span', { class: 'chip empty', 'aria-label': 'open spot' }, 'open'))),
          cands.length
            ? h('div', { class: 'cands' },
                h('small', null, 'Free then — ask: '),
                cands.map((c) => {
                  const u = state.users[c.id];
                  return h('button', { class: 'chip link', title: `Send ${M.firstName(u.name)} a friendly nudge in the event chat`, onClick: () => {
                    const when = `${M.fmt.day(s)}, ${M.fmt.time(s)}–${M.fmt.time(e)}`;
                    M.act.sendNudge({ userId: c.id, eventId: ev.id, text: `${ev.title} needs a ${role.name} (${when}). You look free — want to take it?` }, me.id);
                    M.toast('Nudge sent to ' + M.firstName(u.name));
                  } }, '+ ' + M.firstName(u.name));
                }))
            : null),
        h('div', { class: 'role-actions' },
          cancelled ? null : iHave
            ? h('button', { class: 'btn small', onClick: () => M.confirm(`Release your ${role.name} spot? A flare will go out so someone else can pick it up.`, () => M.safe(() => M.act.releaseRole(ev.id, role.id, me.id))) }, 'Release')
            : h('button', { class: 'btn small primary', disabled: full, onClick: () => V.claimWithCheck(ev, role, me) }, M.icon('leaf', 19), full ? 'Full' : 'Claim'),
          officer && !full && !cancelled && !openFlare
            ? h('button', { class: 'btn small', title: 'Post a flare to the whole org', onClick: () => { M.act.sendFlare(ev.id, role.id, me.id); M.toast('Flare sent'); } }, M.icon('flower', 19), 'Flare')
            : null));
    };

    // check-in
    const within = now >= ev.start - 30 * M.MIN && now <= ev.end + 2 * M.HOUR;
    const checked = (ev.attendance || []).includes(me.id);
    const codeIn = h('input', { placeholder: 'MDW-1234', 'data-keep': 'checkin-' + ev.id, 'aria-label': 'Check-in code', maxlength: 12 });
    const checkin = h('section', { class: 'card' },
      h('h2', { class: 'icon-label' }, M.icon('calendar'), 'Check-in'),
      officer
        ? h('div', null, h('p', { class: 'hint' }, 'Show or read out this code at the event:'), h('div', { class: 'big-code' }, ev.checkinCode),
            h('p', { class: 'hint' }, `${(ev.attendance || []).length} checked in`),
            h('div', { class: 'claimants' }, (ev.attendance || []).map((id) => state.users[id] && h('span', { class: 'chip person' }, M.avatar(state.users[id], 18), M.firstName(state.users[id].name)))))
        : null,
      checked
        ? h('p', { class: 'chip free' }, 'You are checked in — thanks for coming!')
        : cancelled ? null : h('div', { class: 'row' }, codeIn, h('button', { class: 'btn', disabled: !within, onClick: () => M.safe(() => { M.act.checkIn(ev.id, me.id, codeIn.value); M.toast('Checked in!'); }) }, 'Check in')),
      !checked && !within && !cancelled ? h('p', { class: 'hint' }, 'Check-in opens 30 minutes before the event starts.') : null);

    // iMessage / SMS replies (plans, time votes, food) — written by meadow → Flask
    const plans = ev.plans || {};
    const votes = ev.meetingTimeVotes || {};
    const food = ev.foodFeedback || {};
    const planLabel = (p) =>
      p.status === 'going' ? '✅ Going'
        : p.status === 'late' ? `🕒 Late${p.minutes ? ` (~${p.minutes} min)` : ''}`
          : p.status === 'cant' ? "⚠️ Can't make it" : p.status;
    const planRows = Object.keys(plans).map((uid) => {
      const u = state.users[uid];
      return h('li', null,
        h('span', { class: 'chip person' }, u && M.avatar(u, 18), u ? M.firstName(u.name) : uid),
        ' ', planLabel(plans[uid]));
    });
    const voteRows = Object.keys(votes).map((uid) => {
      const u = state.users[uid];
      return h('li', null,
        h('span', { class: 'chip person' }, u && M.avatar(u, 18), u ? M.firstName(u.name) : uid),
        ' prefers ', h('strong', null, String(votes[uid].choice)));
    });
    const foodRows = Object.keys(food).map((uid) => {
      const u = state.users[uid];
      return h('li', null,
        h('span', { class: 'chip person' }, u && M.avatar(u, 18), u ? M.firstName(u.name) : uid),
        ': ', h('q', null, String(food[uid].answer || '')));
    });
    const hasBridge = planRows.length || voteRows.length || foodRows.length;
    const bridge = h('section', { class: 'card' },
      h('h2', { class: 'icon-label' }, M.icon('chat'), 'iMessage replies'),
      hasBridge
        ? h('div', null,
            planRows.length ? h('div', null, h('h3', null, 'RSVP'), h('ul', { class: 'guestbook' }, planRows)) : null,
            voteRows.length ? h('div', null, h('h3', null, 'Preferred time'), h('ul', { class: 'guestbook' }, voteRows)) : null,
            foodRows.length ? h('div', null, h('h3', null, 'Food feedback'), h('ul', { class: 'guestbook' }, foodRows)) : null)
        : h('p', { class: 'hint' }, 'When members reply to Dewey by text, RSVPs and votes show up here.'));

    // Officer: text participants via Dewey / Spectrum
    const claimedRoleNames = [...new Set(ev.roles.filter((r) => r.claims.length).map((r) => r.name))];
    const roleChecks = {};
    claimedRoleNames.forEach((name) => {
      roleChecks[name] = h('input', { type: 'checkbox', checked: true, 'data-role': name });
    });
    const audienceSel = h('select', { 'aria-label': 'Who to text', 'data-keep': 'imsg-aud-' + ev.id },
      h('option', { value: 'roles' }, 'Role holders'),
      h('option', { value: 'going' }, 'Marked going / late'),
      h('option', { value: 'reminded' }, 'Already reminded'),
      h('option', { value: 'org' }, 'Whole org (opted in)'));
    const msgIn = h('textarea', {
      rows: 3,
      maxlength: 500,
      placeholder: 'Write a text to send… (e.g. “Quad entrance is by the union — look for the green canopy.”)',
      'data-keep': 'imsg-msg-' + ev.id,
      'aria-label': 'Message to participants',
    });
    const remModeSel = h('select', { 'aria-label': 'Reminder message style', 'data-keep': 'imsg-rem-mode-' + ev.id },
      h('option', { value: 'standard' }, 'Standard RSVP (Dewey asks YES / late / can’t)'),
      h('option', { value: 'custom' }, 'Custom message (+ RSVP replies)'));
    const remMsgIn = h('textarea', {
      rows: 3,
      maxlength: 500,
      placeholder: 'Custom reminder… (e.g. “Bring your laptop — we’re in Manning 209. Reply YES if you’re still good.”)',
      'data-keep': 'imsg-rem-msg-' + ev.id,
      'aria-label': 'Custom reminder message',
    });
    const remWhenSel = h('select', { 'aria-label': 'When to send reminder', 'data-keep': 'imsg-rem-when-' + ev.id },
      h('option', { value: 'now' }, 'Send now'),
      h('option', { value: 'schedule' }, 'Schedule for a date & time'));
    const defRem = (() => {
      const t = ev.start && ev.start > Date.now() + 60 * 60 * 1000
        ? new Date(ev.start - 2 * 60 * 60 * 1000)
        : new Date(Date.now() + 60 * 60 * 1000);
      const pad = (n) => String(n).padStart(2, '0');
      return {
        date: `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`,
        time: `${pad(t.getHours())}:${pad(t.getMinutes())}`,
      };
    })();
    const remDateIn = h('input', {
      type: 'date',
      value: defRem.date,
      'data-keep': 'imsg-rem-date-' + ev.id,
      'aria-label': 'Reminder date',
    });
    const remTimeIn = h('input', {
      type: 'time',
      value: defRem.time,
      'data-keep': 'imsg-rem-time-' + ev.id,
      'aria-label': 'Reminder time',
    });
    const remCustomWrap = h('div', { style: remModeSel.value === 'custom' ? '' : 'display:none' },
      h('label', null, 'Custom reminder text', remMsgIn));
    const remScheduleWrap = h('div', { class: 'row wrap', style: remWhenSel.value === 'schedule' ? '' : 'display:none' },
      h('label', null, 'Date', remDateIn),
      h('label', null, 'Time', remTimeIn));
    remModeSel.addEventListener('change', () => {
      remCustomWrap.style.display = remModeSel.value === 'custom' ? '' : 'none';
    });
    const selectedRoles = () =>
      claimedRoleNames.length
        ? claimedRoleNames.filter((name) => roleChecks[name] && roleChecks[name].checked)
        : null;
    const previewTargets = () => {
      if (!M.imsg || !M.imsg.enabled()) return { reach: [], skip: [], ids: [] };
      const kind = audienceSel.value || 'roles';
      const roles = selectedRoles();
      const roleFilter = kind === 'roles' && claimedRoleNames.length ? (roles && roles.length ? roles : claimedRoleNames) : undefined;
      const ids = M.imsg.participantIds(state, ev, kind, roleFilter);
      const reach = M.imsg.reachable(state, ids);
      const skip = ids.filter((id) => !M.imsg.canText(state.users[id]));
      return { reach, skip, ids };
    };
    const remOpts = () => {
      const kind = audienceSel.value || 'roles';
      const roles = selectedRoles();
      if (kind === 'roles' && claimedRoleNames.length && (!roles || !roles.length)) {
        throw new Error('Select at least one role to text.');
      }
      const opts = {
        kind,
        roleFilter: kind === 'roles' && claimedRoleNames.length ? roles : undefined,
        askRsvp: true,
      };
      if (remModeSel.value === 'custom') {
        const text = String(remMsgIn.value || '').trim();
        if (!text) throw new Error('Write a custom reminder message, or switch to Standard RSVP.');
        opts.text = text;
      }
      if (remWhenSel.value === 'schedule') {
        const dateStr = remDateIn.value;
        const timeStr = remTimeIn.value;
        if (!dateStr || !timeStr) throw new Error('Pick a date and time for the reminder.');
        const sendAt = new Date(`${dateStr}T${timeStr}`).getTime();
        if (!Number.isFinite(sendAt)) throw new Error('That date/time looks invalid.');
        if (sendAt <= Date.now() + 2000) throw new Error('Pick a future date and time.');
        opts.sendAt = sendAt;
        opts.now = false;
      } else {
        opts.now = true;
      }
      return opts;
    };
    const prev = previewTargets();
    const scheduled = (ev.imessage && ev.imessage.scheduledReminders) || [];
    const imsgActions = officer && !cancelled && M.imsg && M.imsg.enabled()
      ? h('section', { class: 'card' },
          h('h2', { class: 'icon-label' }, M.icon('chat'), 'Text participants'),
          h('p', { class: 'hint' }, 'Bridge: ' + M.imsg.statusLabel() + '. Only members who enabled iMessage under Me get texts.'),
          h('label', null, 'Audience', audienceSel),
          claimedRoleNames.length
            ? h('div', { class: 'row wrap' },
                h('small', { class: 'hint' }, 'Roles (when audience is Role holders):'),
                claimedRoleNames.map((name) =>
                  h('label', { class: 'check' }, roleChecks[name], name)))
            : h('p', { class: 'hint' }, 'No role claims yet — “Role holders” falls back to opted-in org members.'),
          h('p', null,
            prev.reach.length
              ? h('span', { class: 'chip free' }, `Will text ${M.plural(prev.reach.length, 'person', 'people')}`)
              : h('span', { class: 'pill warn' }, 'Nobody reachable yet'),
            prev.skip.length
              ? h('span', { class: 'hint' }, ` · ${M.plural(prev.skip.length, 'person', 'people')} missing phone/opt-in`)
              : null),
          prev.reach.length
            ? h('ul', { class: 'guestbook' }, prev.reach.map((id) => {
                const u = state.users[id];
                return h('li', null,
                  h('span', { class: 'chip person' }, u && M.avatar(u, 18), u ? M.firstName(u.name) : id));
              }))
            : null,
          h('label', null, 'Custom message', msgIn),
          h('div', { class: 'row wrap' },
            h('button', {
              class: 'btn primary',
              disabled: !prev.reach.length,
              onClick: () => M.safe(async () => {
                const kind = audienceSel.value || 'roles';
                const roles = selectedRoles();
                if (kind === 'roles' && claimedRoleNames.length && (!roles || !roles.length)) {
                  throw new Error('Select at least one role to text.');
                }
                const res = await M.imsg.sendText(
                  ev,
                  me.id,
                  msgIn.value,
                  kind,
                  kind === 'roles' && claimedRoleNames.length ? roles : undefined
                );
                msgIn.value = '';
                M.toast(`Sent to ${M.plural(res.reached, 'person', 'people')}`);
                M.render();
              }),
            }, 'Send text'),
            h('button', {
              class: 'btn small',
              onClick: () => M.safe(async () => {
                const res = await M.imsg.sendSurvey(ev, me.id);
                M.toast(`Food survey queued for ${M.plural(res.reached, 'person', 'people')}`);
                M.render();
              }),
            }, 'Send food survey')),
          h('hr'),
          h('h3', { class: 'icon-label' }, M.icon('calendar'), 'RSVP reminder'),
          h('p', { class: 'hint' }, 'Standard uses Dewey’s RSVP wording. Custom lets you write the text — replies still count as YES / late / can’t.'),
          h('label', null, 'Message', remModeSel),
          remCustomWrap,
          h('label', null, 'When', remWhenSel),
          remScheduleWrap,
          scheduled.length
            ? h('ul', { class: 'guestbook' }, scheduled.slice(-5).map((j) =>
                h('li', null,
                  h('small', null,
                    (j.custom ? 'Custom' : 'Standard') +
                      ' · ' + M.plural(j.count, 'person', 'people') +
                      ' · ' + M.fmt.day(j.sendAt) + ', ' + M.fmt.time(j.sendAt)))))
            : null,
          (() => {
            const remBtn = h('button', {
              class: 'btn primary',
              disabled: !prev.reach.length,
              onClick: () => M.safe(async () => {
                const opts = remOpts();
                const res = await M.imsg.sendReminders(ev, me.id, opts);
                if (res.scheduled) {
                  M.toast(`Reminder scheduled for ${M.fmt.day(res.sendAt)}, ${M.fmt.time(res.sendAt)}`);
                } else {
                  M.toast(`RSVP reminder sent to ${M.plural(res.reached, 'person', 'people')}`);
                  if (remModeSel.value === 'custom') remMsgIn.value = '';
                }
                M.render();
              }),
            }, remWhenSel.value === 'schedule' ? 'Schedule reminder' : 'Send reminder');
            remWhenSel.addEventListener('change', () => {
              remScheduleWrap.style.display = remWhenSel.value === 'schedule' ? '' : 'none';
              remBtn.textContent = remWhenSel.value === 'schedule' ? 'Schedule reminder' : 'Send reminder';
            });
            return h('div', { class: 'row wrap' }, remBtn);
          })())
      : null;

    // guestbook
    const notes = state.guestbook.filter((g) => g.eventId === ev.id).sort((a, b) => a.ts - b.ts);
    const gbIn = h('input', { placeholder: 'Leave a short note for the next team…', maxlength: 300, 'data-keep': 'gb-' + ev.id, 'aria-label': 'Guestbook note' });
    const guest = h('section', { class: 'card' },
      h('h2', { class: 'icon-label' }, M.icon('folder'), 'Guestbook'),
      notes.length ? h('ul', { class: 'guestbook' }, notes.map((g) => h('li', null, h('q', null, g.text), h('small', null, ' — ' + ((state.users[g.userId] || {}).name || 'someone'))))) : h('p', { class: 'hint' }, 'No notes yet.'),
      now >= ev.start && !cancelled
        ? h('form', { class: 'row', onSubmit: (e) => { e.preventDefault(); const t = gbIn.value; gbIn.value = ''; M.act.addGuestbook(ev.id, me.id, t); } }, gbIn, h('button', { class: 'btn', type: 'submit' }, 'Sign'))
        : h('p', { class: 'hint' }, 'The guestbook opens when the event starts.'));

    return h('div', { class: 'main-scroll pad', 'data-scroll': 'main' },
      h('a', { class: 'back', href: '#/o/' + org.id + '/events' }, '← All events'),
      h('div', { class: 'event-hero card' },
        h('div', { class: 'row between wrap' }, h('h2', null, ev.title), statusPill(ev)),
        h('p', null, '🕒 ' + M.fmt.range(ev.start, ev.end)),
        ev.location ? h('p', null, '📍 ' + ev.location) : null,
        ev.description ? h('p', null, ev.description) : null,
        prog.need ? M.gardenProgress(prog) : null,
        ev.status === 'pending' ? h('p', { class: 'notice' }, `Pending — ${M.plural(prog.open, 'required spot')} still open. It confirms automatically once every required role is claimed.`) : null,
        h('div', { class: 'row wrap' },
          h('button', { class: 'btn small', onClick: () => M.download(ev.title.replace(/\W+/g, '-') + '.ics', eventIcs(ev), 'text/calendar') }, M.icon('calendar', 19), 'Add to my calendar'),
          officer && !cancelled && prog.open ? h('button', { class: 'btn small', onClick: () => { M.ui.channel = 'event:' + ev.id; M.act.postMessage('event:' + ev.id, me.id, '@dewey nudge'); M.toast('Dewey is drafting nudges in the event chat'); } }, M.icon('drop', 19), 'Draft nudges with Dewey') : null,
          officer && !cancelled ? h('button', { class: 'btn small danger', onClick: () => M.confirm('Cancel this event for everyone?', () => M.safe(() => M.act.cancelEvent(ev.id, me.id))) }, 'Cancel event') : null)),
      imsgActions,
      bridge,
      h('section', { class: 'card' }, h('h2', { class: 'icon-label' }, M.icon('people'), 'Roles'),
        ev.roles.length ? ev.roles.map(roleRow) : h('p', { class: 'hint' }, 'This event has no roles — just show up!')),
      checkin, guest,
      h('section', { class: 'card chat-embed' }, V.chatPanel('event:' + ev.id, '💬 Event chat', org, { placeholder: 'Coordinate with the crew…' })));
  }

  V.eventsTab = function (org) {
    const r = M.ui.route;
    return r.id ? detail(org, S().events[r.id]) : list(org);
  };

  /* ---------------------------------------------------------------- create event modal */
  V.eventModal = function (org, prefill) {
    prefill = prefill || {};
    const me = M.me();
    const state = S();
    const now = new Date();
    const dflt = prefill.start || new Date(now.getFullYear(), now.getMonth(), now.getDate() + 3, 18, 0).getTime();
    const dfltEnd = prefill.end || dflt + 2 * M.HOUR;
    let roles = (prefill.roles || []).map((r) => ({ ...r }));

    M.modal('New event', (close) => {
      const title = h('input', { value: prefill.title || '', placeholder: 'Spring Social', required: true });
      const type = h('select', null, ['Meeting', 'Tabling', 'Social', 'Workshop', 'Service', 'Fundraiser', 'Other'].map((t) => h('option', { value: t }, t)));
      type.value = prefill.mode === 'officers' ? 'Meeting' : prefill.type || (/tabl/i.test(prefill.title || '') ? 'Tabling' : /meeting/i.test(prefill.title || '') ? 'Meeting' : /social/i.test(prefill.title || '') ? 'Social' : 'Other');
      const loc = h('input', { placeholder: 'Where?' });
      const desc = h('input', { placeholder: 'Short description (optional)' });
      const date = h('input', { type: 'date', value: M.fmt.dateInput(dflt) });
      const st = h('input', { type: 'time', value: M.fmt.timeInput(dflt) });
      const en = h('input', { type: 'time', value: M.fmt.timeInput(dfltEnd) });
      const roleBox = h('div', { class: 'role-editor' });
      const checkOut = h('p', { class: 'hint', 'aria-live': 'polite' });

      const drawRoles = () => {
        roleBox.replaceChildren(
          roles.length ? null : h('p', { class: 'hint' }, 'No roles yet. Add the jobs people can commit to.'),
          roles.map((r, i) => {
            const nm = h('input', { value: r.name, 'aria-label': 'Role name', onInput: () => (r.name = nm.value) });
            const hc = h('input', { type: 'number', min: 1, max: 50, value: r.headcount, 'aria-label': 'Headcount', onInput: () => (r.headcount = parseInt(hc.value, 10) || 1) });
            const rq = h('input', { type: 'checkbox', checked: r.required !== false, 'aria-label': 'Required', onChange: () => (r.required = rq.checked) });
            const off = h('input', { type: 'number', value: r.offsetMin || 0, step: 15, 'aria-label': 'Shift offset in minutes', onInput: () => (r.offsetMin = parseInt(off.value, 10) || 0) });
            const dur = h('input', { type: 'number', min: 0, step: 15, value: r.durationMin || '', placeholder: 'whole', 'aria-label': 'Shift length in minutes', onInput: () => (r.durationMin = parseInt(dur.value, 10) || null) });
            const anc = h('select', { 'aria-label': 'Offset relative to', onChange: () => (r.anchor = anc.value) }, h('option', { value: 'start' }, 'from start'), h('option', { value: 'end' }, 'from end'));
            anc.value = r.anchor || 'start';
            return h('div', { class: 'role-edit' }, nm,
              h('label', null, '×', hc), h('label', { class: 'check' }, rq, 'req'),
              h('label', null, 'shift +', off, 'min'), anc, h('label', null, 'len', dur),
              h('button', { class: 'x-btn', type: 'button', 'aria-label': 'Remove role', onClick: () => { roles.splice(i, 1); drawRoles(); } }, '×'));
          }));
      };
      drawRoles();

      const tplBtn = (name) =>
        h('button', { type: 'button', class: 'chip link', onClick: () => { roles.push({ name, ...(M.ROLE_TEMPLATES[name] || { headcount: 1, required: true, offsetMin: 0, durationMin: null, anchor: 'start' }) }); drawRoles(); } }, '+ ' + name);

      const times = () => {
        const s = M.parseLocal(date.value, st.value);
        let e = M.parseLocal(date.value, en.value);
        return [s, e];
      };

      const checkFree = () => {
        const [s, e] = times();
        if (!(e > s)) return (checkOut.textContent = 'End time must be after start time.');
        const known = M.knownMembers(state, org);
        const free = known.filter((id) => M.isFree(M.userIntervals(state, id), s, e));
        const busy = known.filter((id) => !free.includes(id));
        checkOut.textContent = `${free.length} of ${known.length} members with shared calendars are free` + (busy.length ? ` — busy: ${busy.map((id) => M.firstName(state.users[id].name)).join(', ')}` : '.');
      };

      return h('form', { class: 'stack', onSubmit: (e) => {
        e.preventDefault();
        M.safe(() => {
          const [s, en2] = times();
          const id = M.act.createEvent(org.id, me.id, { title: title.value, type: type.value, location: loc.value, description: desc.value, start: s, end: en2, roles });
          close();
          M.go('#/o/' + org.id + '/events/' + id);
          M.toast('Event created');
        });
      } },
        h('label', null, 'Title', title),
        h('div', { class: 'row' }, h('label', null, 'Type', type), h('label', { class: 'grow' }, 'Location', loc)),
        h('label', null, 'Description', desc),
        h('div', { class: 'row' }, h('label', null, 'Date', date), h('label', null, 'Starts', st), h('label', null, 'Ends', en),
          h('button', { class: 'btn small', type: 'button', onClick: checkFree }, 'Who’s free?')),
        checkOut,
        h('h3', null, 'Roles'),
        h('p', { class: 'hint' }, 'The event stays pending until every required role is claimed. “shift +” moves the shift relative to the event start (negative = before).'),
        h('div', { class: 'row wrap' }, Object.keys(M.ROLE_TEMPLATES).map(tplBtn), tplBtn('Custom role')),
        roleBox,
        h('div', { class: 'row end' }, h('button', { class: 'btn', type: 'button', onClick: close }, 'Cancel'), h('button', { class: 'btn primary', type: 'submit' }, 'Create event')));
    }, { cls: 'wide' });
  };
})();
