/* Meadow — members, board (flares, guestbook, handoff) and the "Me" page. */
(function () {
  const M = window.Meadow;
  const { h } = M;
  const S = () => M.store.get();
  const V = (M.views = M.views || {});

  const SAMPLE_ICS = () => {
    // A small fake class schedule anchored to this week, so anyone can try the flow.
    const d = new Date();
    const mon = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
    const f = (date, hh, mm) => {
      const x = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hh, mm);
      return `${x.getFullYear()}${String(x.getMonth() + 1).padStart(2, '0')}${String(x.getDate()).padStart(2, '0')}T${String(hh).padStart(2, '0')}${String(mm).padStart(2, '0')}00`;
    };
    const tue = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 1);
    return ['BEGIN:VCALENDAR', 'VERSION:2.0',
      'BEGIN:VEVENT', 'DTSTART:' + f(mon, 9, 0), 'DTEND:' + f(mon, 9, 50), 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=40', 'SUMMARY:Class A', 'END:VEVENT',
      'BEGIN:VEVENT', 'DTSTART:' + f(tue, 11, 0), 'DTEND:' + f(tue, 12, 15), 'RRULE:FREQ=WEEKLY;BYDAY=TU,TH;COUNT=30', 'SUMMARY:Class B', 'END:VEVENT',
      'BEGIN:VEVENT', 'DTSTART:' + f(tue, 17, 30), 'DTEND:' + f(tue, 19, 0), 'RRULE:FREQ=WEEKLY;COUNT=12', 'SUMMARY:Practice', 'END:VEVENT',
      'END:VCALENDAR'].join('\r\n');
  };

  /* ---------------------------------------------------------------- members */
  V.membersTab = function (org) {
    const state = S();
    const me = M.me();
    const officer = M.isOfficer(org, me.id);
    const link = location.href.split('#')[0] + '#/join/' + org.inviteCode;
    const evs = Object.values(state.events).filter((e) => e.orgId === org.id);
    const stat = (id) => ({
      attended: evs.filter((e) => (e.attendance || []).includes(id)).length,
      roles: evs.filter((e) => e.status !== 'cancelled').reduce((a, e) => a + e.roles.filter((r) => r.claims.includes(id)).length, 0),
    });
    const members = Object.keys(org.members).map((id) => state.users[id]).filter(Boolean).sort((a, b) => (M.isOfficer(org, b.id) - M.isOfficer(org, a.id)) || a.name.localeCompare(b.name));

    const rosterTa = h('textarea', { rows: 5, 'data-keep': 'roster', placeholder: 'Name, email\nAva Lopez, ava@school.edu\nBen Ito, ben@school.edu', 'aria-label': 'Roster CSV' });
    const file = h('input', { type: 'file', accept: '.csv,.txt', 'aria-label': 'Roster file', onChange: async () => { if (file.files[0]) rosterTa.value = await file.files[0].text(); } });

    const bridgeType = h('select', { 'aria-label': 'Bridge type' }, h('option', { value: 'none' }, 'None'), h('option', { value: 'groupme' }, 'GroupMe bot'));
    bridgeType.value = org.bridge.type;
    const bot = h('input', { value: org.bridge.botId, placeholder: 'GroupMe bot ID', 'aria-label': 'GroupMe bot id' });

    return h('div', { class: 'main-scroll pad', 'data-scroll': 'main' },
      h('section', { class: 'card' },
        h('h2', null, '🔗 Invite people'),
        h('div', { class: 'row wrap' }, h('code', { class: 'invite' }, link), h('button', { class: 'btn small', onClick: () => M.copyText(link) }, 'Copy link')),
        h('p', { class: 'hint' }, 'Invite code: ', h('strong', null, org.inviteCode), '. Links work for anyone connected to this Meadow server.')),
      h('section', { class: 'card' },
        h('h2', null, `👥 Members (${members.length})`),
        h('div', { class: 'member-list' },
          members.map((u) => {
            const st = stat(u.id);
            const roleSel = h('select', { 'aria-label': 'Role for ' + u.name, onChange: () => M.safe(() => M.act.setMemberRole(org.id, me.id, u.id, roleSel.value)) }, M.ORG_ROLES.map((r) => h('option', { value: r }, r)));
            roleSel.value = org.members[u.id].role;
            return h('div', { class: 'member' },
              M.avatar(u, 36),
              h('div', { class: 'grow' }, h('strong', null, u.name), u.placeholder ? h('span', { class: 'pill tiny' }, 'on roster · not signed in') : null,
                h('div', { class: 'hint' }, `${st.attended} check-ins · ${M.plural(st.roles, 'role')} claimed`)),
              h('span', { class: 'chip ' + (u.calendar ? 'free' : 'busy'), title: u.calendar ? 'Shares free/busy only' : 'Has not shared availability' }, u.calendar ? '📅 shared' : 'no calendar'),
              officer ? roleSel : h('span', { class: 'pill' }, org.members[u.id].role));
          }))),
      officer
        ? h('section', { class: 'card' },
            h('h2', null, '📥 Roster import'),
            h('p', { class: 'hint' }, 'Paste a sign-up form export (name, email). Duplicates merge by email or name; people join your calendar view once they sign in with the same email.'),
            rosterTa, h('div', { class: 'row' }, file, h('button', { class: 'btn', onClick: () => M.safe(() => { const r = M.act.importRoster(org.id, me.id, rosterTa.value); rosterTa.value = ''; M.toast(`${r.added} added, ${r.merged} merged, ${r.skipped} skipped`); }) }, 'Import')))
        : null,
      officer
        ? h('section', { class: 'card' },
            h('h2', null, '📡 Messaging bridge'),
            h('p', { class: 'hint' }, 'GroupMe mirrors org chat for members who opt in under Me. iMessage (Dewey) texts role holders for reminders and surveys — members enable it under Me → iMessage. Bridge status: ' + (M.imsg && M.imsg.enabled() ? M.imsg.statusLabel() : 'not configured') + '.'),
            h('div', { class: 'row' }, bridgeType, bot, h('button', { class: 'btn', onClick: () => { M.act.setBridge(org.id, { type: bridgeType.value, botId: bot.value }); M.toast('Bridge settings saved'); } }, 'Save')))
        : null,
      h('section', { class: 'card' }, h('button', { class: 'btn danger small', onClick: () => M.confirm(`Leave ${org.name}?`, () => M.safe(() => { M.act.leaveOrg(org.id, me.id); M.go('#/'); })) }, 'Leave this org')));
  };

  /* ---------------------------------------------------------------- board */
  V.boardTab = function (org) {
    const state = S();
    const me = M.me();
    const officer = M.isOfficer(org, me.id);
    const orgEvents = Object.values(state.events).filter((e) => e.orgId === org.id);
    const flares = Object.values(state.flares).filter((f) => state.events[f.eventId] && state.events[f.eventId].orgId === org.id).sort((a, b) => b.createdAt - a.createdAt);
    const open = flares.filter((f) => f.status === 'open');
    const done = flares.filter((f) => f.status === 'claimed').slice(0, 4);

    const flareCard = (f) => {
      const ev = state.events[f.eventId];
      const role = ev.roles.find((r) => r.id === f.roleId);
      if (!role) return null;
      const [s, e] = M.roleShift(ev, role);
      const iHave = role.claims.includes(me.id);
      return h('div', { class: 'flare-card' + (f.status === 'open' ? ' open' : '') },
        h('div', { class: 'flare-icon' }, f.status === 'open' ? '🔥' : '✅'),
        h('div', { class: 'grow' }, h('strong', null, `${role.name} · ${ev.title}`), h('div', { class: 'hint' }, `${M.fmt.day(s)}, ${M.fmt.time(s)}–${M.fmt.time(e)} · ${f.reason}`),
          f.status === 'claimed' ? h('div', { class: 'hint' }, 'Claimed by ' + ((state.users[f.claimedBy] || {}).name || 'someone')) : null),
        f.status === 'open' ? h('button', { class: 'btn small primary', disabled: iHave, onClick: () => V.claimWithCheck(ev, role, me) }, iHave ? 'Yours' : '🙋 I’ll take it') : null);
    };

    // guestbook
    const entries = state.guestbook.filter((g) => state.events[g.eventId] && state.events[g.eventId].orgId === org.id).sort((a, b) => b.ts - a.ts).slice(0, 12);
    const started = orgEvents.filter((e) => e.start <= Date.now() && e.status !== 'cancelled').sort((a, b) => b.start - a.start);
    const evSel = h('select', { 'aria-label': 'Event' }, started.map((e) => h('option', { value: e.id }, `${e.title} (${M.fmt.day(e.start)})`)));
    const note = h('input', { placeholder: 'What worked? What should next year’s officers know?', maxlength: 300, 'data-keep': 'gb-board', 'aria-label': 'Guestbook note' });

    // Dewey / iMessage intel across the org (officer view)
    const planLabel = (p) =>
      p.status === 'going' ? 'Going'
        : p.status === 'late' ? `Late${p.minutes ? ` (~${p.minutes} min)` : ''}`
          : p.status === 'cant' ? "Can't make it" : String(p.status || '');
    const intelEvents = orgEvents
      .map((ev) => {
        const plans = ev.plans || {};
        const votes = ev.meetingTimeVotes || {};
        const food = ev.foodFeedback || {};
        const planIds = Object.keys(plans);
        const voteIds = Object.keys(votes);
        const foodIds = Object.keys(food);
        const gb = state.guestbook.filter((g) => g.eventId === ev.id);
        if (!planIds.length && !voteIds.length && !foodIds.length && !gb.length) return null;
        const counts = {
          going: planIds.filter((id) => plans[id].status === 'going').length,
          late: planIds.filter((id) => plans[id].status === 'late').length,
          cant: planIds.filter((id) => plans[id].status === 'cant').length,
        };
        return { ev, plans, votes, food, planIds, voteIds, foodIds, gb, counts };
      })
      .filter(Boolean)
      .sort((a, b) => b.ev.start - a.ev.start);
    const optedIn = Object.keys(org.members).filter((id) => {
      const u = state.users[id];
      return u && u.phone && u.imessageOptIn;
    });
    const deweyIntel = officer
      ? h('section', { class: 'card' },
          h('h2', { class: 'icon-label' }, M.icon('chat'), 'Dewey intel (iMessage)'),
          h('p', { class: 'hint' }, 'RSVPs, time prefs, and food notes members texted back. Open an event for the full thread.'),
          h('p', null,
            h('span', { class: 'chip free' }, M.plural(optedIn.length, 'member') + ' opted in'),
            M.imsg && M.imsg.enabled()
              ? h('span', { class: 'hint' }, ' · bridge ' + M.imsg.statusLabel())
              : h('span', { class: 'hint' }, ' · bridge offline')),
          intelEvents.length
            ? h('div', { class: 'stack' }, intelEvents.map(({ ev, plans, votes, food, planIds, voteIds, foodIds, gb, counts }) =>
                h('div', { class: 'flare-card' },
                  h('div', { class: 'grow' },
                    h('a', { href: '#/o/' + org.id + '/events/' + ev.id }, h('strong', null, ev.title)),
                    h('div', { class: 'hint' }, M.fmt.day(ev.start) + (ev.imessage && ev.imessage.remindedAt ? ' · last texted ' + M.fmt.ago(ev.imessage.remindedAt) : '')),
                    planIds.length
                      ? h('p', null,
                          h('span', { class: 'pill ok' }, counts.going + ' in'),
                          ' ',
                          h('span', { class: 'pill warn' }, counts.late + ' late'),
                          ' ',
                          h('span', { class: 'pill bad' }, counts.cant + " can't"))
                      : null,
                    planIds.length
                      ? h('ul', { class: 'guestbook' }, planIds.map((uid) => {
                          const u = state.users[uid];
                          return h('li', null,
                            (u ? M.firstName(u.name) : uid) + ' — ' + planLabel(plans[uid]));
                        }))
                      : null,
                    voteIds.length
                      ? h('div', null,
                          h('small', null, 'Preferred times'),
                          h('ul', { class: 'guestbook' }, voteIds.map((uid) => {
                            const u = state.users[uid];
                            return h('li', null,
                              (u ? M.firstName(u.name) : uid) + ': ' + String(votes[uid].choice));
                          })))
                      : null,
                    foodIds.length || gb.length
                      ? h('div', null,
                          h('small', null, 'Food / notes'),
                          h('ul', { class: 'guestbook' }, [
                            ...foodIds.map((uid) => {
                              const u = state.users[uid];
                              return h('li', null,
                                h('q', null, String(food[uid].answer || '')),
                                h('small', null, ' — ' + (u ? M.firstName(u.name) : uid) + ' (text)'));
                            }),
                            ...gb.slice(0, 6).map((g) => {
                              const u = state.users[g.userId];
                              return h('li', null,
                                h('q', null, g.text),
                                h('small', null, ' — ' + (u ? M.firstName(u.name) : 'someone')));
                            }),
                          ]))
                      : null),
                  h('a', { class: 'btn small', href: '#/o/' + org.id + '/events/' + ev.id }, 'Open'))))
            : h('p', { class: 'hint' }, 'No SMS replies yet. Text role holders from an event, then replies land here and on that event’s page.'))
      : null;

    // handoff
    const draft = M.ui.handoffDraft && M.ui.handoffDraft.orgId === org.id ? M.ui.handoffDraft.text : org.handoff ? org.handoff.text : '';
    const ta = h('textarea', { rows: 14, class: 'mono', 'data-keep': 'handoff-' + org.id, 'aria-label': 'Handoff document' });
    ta.value = draft;

    return h('div', { class: 'main-scroll pad two-col', 'data-scroll': 'main' },
      h('div', null,
        V.insightsPanel(org),
        deweyIntel,
        h('section', { class: 'card' },
          h('h2', null, '🔥 Open flares'),
          open.length ? open.map(flareCard) : h('p', { class: 'hint' }, 'No open flares. When someone drops a role, it shows up here so anyone can claim it.'),
          done.length ? h('details', null, h('summary', null, 'Recently backfilled'), done.map(flareCard)) : null),
        h('section', { class: 'card' },
          h('h2', null, '📖 Guestbook'),
          entries.length
            ? h('ul', { class: 'guestbook' }, entries.map((g) => h('li', null, h('q', null, g.text), h('small', null, ` — ${(state.users[g.userId] || {}).name || 'someone'}, ${state.events[g.eventId].title}`))))
            : h('p', { class: 'hint' }, 'Signed notes from after each event will collect here.'),
          started.length
            ? h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); const t = note.value; note.value = ''; M.act.addGuestbook(evSel.value, me.id, t); M.toast('Signed!'); } },
                h('div', { class: 'row' }, evSel, note, h('button', { class: 'btn', type: 'submit' }, 'Sign')))
            : h('p', { class: 'hint' }, 'You can sign after an event starts.'))),
      officer
        ? h('section', { class: 'card' },
            h('h2', null, '🧳 Officer handoff'),
            h('p', { class: 'hint' }, 'Turns this year’s events, flares, check-ins and guestbook notes into a document for the next officer team. Review and edit before saving.'),
            ta,
            h('div', { class: 'row wrap' },
              h('button', { class: 'btn primary', onClick: () => { M.ui.handoffDraft = { orgId: org.id, text: M.AI.handoff(S(), org.id) }; M.render(); } }, '✨ Generate'),
              h('button', { class: 'btn', onClick: () => { M.act.saveHandoff(org.id, ta.value); M.toast('Handoff saved'); } }, 'Save'),
              h('button', { class: 'btn', onClick: () => M.copyText(ta.value) }, 'Copy'),
              h('button', { class: 'btn', onClick: () => M.download(org.name.replace(/\W+/g, '-') + '-handoff.md', ta.value, 'text/markdown') }, 'Download .md')),
            org.handoff ? h('p', { class: 'hint' }, 'Last saved ' + M.fmt.ago(org.handoff.ts)) : null)
        : h('section', { class: 'card' }, h('h2', null, '🧳 Officer handoff'), h('p', { class: 'hint' }, 'Officers can generate a handoff document for the next team.')));
  };

  /* ---------------------------------------------------------------- me */
  V.me = function () {
    const state = S();
    const me = M.me();
    const isMe = me.id === M.auth.account.userId; // false while borrowing a demo cast member

    // what the org sees: busy bars for the next 7 days
    const days = Array.from({ length: 7 }, (_, i) => M.addDays(M.startOfDay(Date.now()), i));
    const iv = M.userIntervals(state, me.id);
    const H0 = 7;
    const H1 = 23;
    const track = (day) => {
      const end = M.addDays(day, 1);
      const segs = iv.filter(([s, e]) => s < end && e > day).map(([s, e]) => {
        const a = Math.max(s, day + H0 * M.HOUR);
        const b = Math.min(e, day + H1 * M.HOUR);
        if (b <= a) return null;
        return h('i', { style: { left: ((a - day - H0 * M.HOUR) / ((H1 - H0) * M.HOUR)) * 100 + '%', width: ((b - a) / ((H1 - H0) * M.HOUR)) * 100 + '%' }, title: `Busy ${M.fmt.time(a)}–${M.fmt.time(b)}` });
      });
      return h('div', { class: 'track-row' }, h('span', null, M.fmt.day(day)), h('div', { class: 'track' }, segs));
    };

    // The native file picker stays hidden; a regular button opens it.
    const icsFile = h('input', { type: 'file', accept: '.ics,text/calendar', class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true', onChange: async () => {
      const f = icsFile.files[0];
      if (!f) return;
      try {
        const res = M.act.importICS(me.id, await f.text(), f.name);
        M.toast(`Imported ${res.events} events → ${res.blocks.length} busy blocks. Titles were discarded.`);
      } catch (e) {
        M.toast(e.message);
      } finally {
        icsFile.value = ''; // picking the same file again still fires change
      }
    } });
    const icsButton = h('button', { type: 'button', class: 'btn small', onClick: () => icsFile.click() }, '📁 Upload .ics file');

    const friendIn = h('input', { list: 'people', placeholder: 'Name or email of someone on Meadow', 'data-keep': 'friend-in', 'aria-label': 'Add a friend' });
    const people = Object.values(state.users).filter((u) => u.id !== me.id && !u.placeholder);
    const friends = M.friendsOf(me.id).map((id) => state.users[id]);

    return h('div', { class: 'main-scroll pad two-col profile-page', 'data-scroll': 'main' },
      h('div', null,
        h('section', { class: 'card' },
          h('div', { class: 'row tight' }, M.avatar(me, 56), h('div', null, h('h1', null, me.name), h('p', { class: 'hint' }, me.email || 'No email on file')))),
        h('section', { class: 'card' },
          h('h2', null, '📅 Calendar'),
          me.calendar
            ? h('p', null, h('span', { class: 'chip free' }, 'Connected'), ` ${me.calendar.name} · ${me.calendar.count} items · updated ${M.fmt.ago(me.calendar.importedAt)}`)
            : h('p', { class: 'notice' }, 'No calendar yet — Dewey can’t include you in suggestions until you share availability.'),
          h('p', { class: 'hint' }, 'Upload an .ics file (Google, Apple, Outlook, or your school’s class schedule export). Meadow keeps only busy time ranges; titles, locations and attendees are thrown away at import. All-day and “free” events are ignored.'),
          isMe && M.auth.account.googleCalendar && !M.auth.account.googleCalendarList
            ? h('p', { class: 'notice' }, 'Only your primary Google calendar is included. Click “Update Google permissions” and allow Meadow to see your calendar list to include your other calendars too.')
            : null,
          h('div', { class: 'row wrap' }, icsFile, icsButton,
            h('button', { class: 'btn small', onClick: () => M.safe(() => { M.act.importICS(me.id, SAMPLE_ICS(), 'sample-schedule.ics'); M.toast('Sample class schedule imported'); }) }, 'Use a sample schedule')),
          h('div', { class: 'row wrap' },
            !isMe
              ? null
              : M.auth.account.googleCalendar
              ? h('button', { class: 'btn', onClick: async (e) => {
                  e.currentTarget.disabled = true;
                  try { M.toast(`Google Calendar synced (${await M.google.sync()} busy blocks)`); }
                  catch (err) { M.toast(err.message); if (err.code === 'google_not_connected') M.auth.check().then(M.render); }
                } }, 'Sync Google Calendar')
              : M.google.configured()
              ? h('button', { class: 'btn', onClick: M.google.link }, 'Connect Google Calendar (free/busy only)')
              : h('button', { class: 'btn', disabled: true, title: 'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the server .env' }, 'Connect Google Calendar'),
            // Re-runs Google's consent screen so a skipped or revoked calendar permission can be granted again.
            isMe && M.google.configured() && (M.auth.account.google || M.auth.account.googleCalendar)
              ? h('button', { class: 'btn small', title: 'Review what Meadow can access in your Google account', onClick: M.google.link }, '🔑 Update Google permissions')
              : null,
            me.calendar ? h('button', { class: 'btn danger small', onClick: () => M.confirm('Remove your calendar and all imported busy blocks?' + (isMe && M.auth.account.googleCalendar ? ' Meadow’s Google Calendar access is revoked too.' : ''), async () => {
              M.act.removeCalendar(me.id);
              if (isMe && M.auth.account.googleCalendar) { await M.auth.disconnectCalendar().catch(() => {}); await M.auth.check(); M.render(); }
              M.toast('Calendar data deleted');
            }) }, 'Disconnect & delete data') : null)),
        h('section', { class: 'card' },
          h('h2', null, '🔒 What your orgs see'),
          h('p', { class: 'hint' }, 'Exactly this — grey “busy” bars. No titles, places, or people.'),
          h('div', { class: 'tracks' }, days.map(track)),
          h('div', { class: 'track-scale' }, h('span', null, M.fmt.hour(H0)), h('span', null, M.fmt.hour((H0 + H1) / 2)), h('span', null, M.fmt.hour(H1))))),
      h('div', null,
        h('section', { class: 'card' },
          h('h2', null, '🧑‍🤝‍🧑 Friends'),
          friends.length ? h('ul', { class: 'plain' }, friends.map((u) => h('li', { class: 'row between' }, h('span', { class: 'row tight' }, M.avatar(u, 24), u.name), h('button', { class: 'btn small', onClick: () => M.act.removeFriend(me.id, u.id) }, 'Remove')))) : h('p', { class: 'hint' }, 'Friends make quick invites and cross-org coordination easy.'),
          h('datalist', { id: 'people' }, people.map((u) => h('option', { value: u.name }, u.email))),
          h('div', { class: 'row' }, friendIn, h('button', { class: 'btn', onClick: () => {
            const q = friendIn.value.trim().toLowerCase();
            const u = people.find((x) => x.name.toLowerCase() === q || (x.email && x.email === q));
            if (!u) return M.toast('Nobody on Meadow matches that.');
            M.act.addFriend(me.id, u.id);
            friendIn.value = '';
            M.toast('You and ' + M.firstName(u.name) + ' are friends now');
          } }, 'Add'))),
        isMe && M.imsg && M.imsg.enabled()
          ? h('section', { class: 'card' },
              h('h2', null, '📱 iMessage (Dewey)'),
              h('p', { class: 'hint' }, 'Officers can text you about event roles (reminders, RSVP, food surveys). Bridge: ' + M.imsg.statusLabel() + '.'),
              (() => {
                const phoneIn = h('input', {
                  type: 'tel',
                  value: me.phone || '',
                  placeholder: '+1 555 555 0100',
                  maxlength: 40,
                  'data-keep': 'imsg-phone',
                  'aria-label': 'Phone number for iMessage',
                });
                const opted = !!me.imessageOptIn;
                return h('div', null,
                  h('label', null, 'Phone', phoneIn),
                  me.imessageError ? h('p', { class: 'notice' }, me.imessageError) : null,
                  h('div', { class: 'row wrap imsg-actions' },
                    h('button', {
                      class: 'btn primary small',
                      onClick: () => M.safe(async () => {
                        await M.imsg.savePhone(me.id, phoneIn.value, true);
                        M.toast('iMessage enabled — officers can text your roles');
                        M.render();
                      }),
                    }, opted ? 'Update & keep enabled' : 'Enable iMessage'),
                    opted
                      ? h('button', {
                          class: 'btn small',
                          onClick: () => M.safe(async () => {
                            await M.imsg.savePhone(me.id, phoneIn.value || me.phone, false);
                            M.toast('iMessage turned off');
                            M.render();
                          }),
                        }, 'Disable')
                      : null),
                  opted ? h('p', null, h('span', { class: 'chip free' }, 'Opted in'), ' Dewey can text this number.') : h('p', { class: 'hint' }, 'Not opted in yet.'));
              })())
          : null,
        h('section', { class: 'card' },
          h('h2', null, '🤖 Assistant'),
          M.AI.llmEnabled()
            ? h('p', null, h('span', { class: 'chip free' }, 'Gemini on'), ' Dewey uses Gemini to refine requests and polish summaries. Only free/busy-derived text is sent.')
            : h('p', { class: 'hint' }, 'Dewey works offline with a built-in parser. To upgrade it with Gemini, set GEMINI_API_KEY in the server’s .env and restart.')),
        h('section', { class: 'card' },
          h('h2', null, '⚠️ Danger zone'),
          h('div', { class: 'row wrap' },
            isMe ? h('button', { class: 'btn danger small', onClick: () => M.confirm('Delete your account and all your data from Meadow?', () => M.act.deleteAccount(me.id).catch((e) => M.toast(e.message))) }, 'Delete my account') : null,
            h('button', { class: 'btn small', onClick: () => M.confirm('Wipe ALL shared Meadow data on this server (every profile, org and message, for everyone)? Accounts stay; profiles are recreated at next sign-in.', () => { M.store.reset(); M.session.actAs(null); location.hash = '#/'; M.render(); }) }, 'Reset shared data')))));
  };
})();
