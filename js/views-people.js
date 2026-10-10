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
            h('p', { class: 'hint' }, 'GroupMe is the most realistic bridge for student orgs (bot API). Outgoing messages are relayed only for members who opt in under Me. Incoming messages need a server-side webhook, so this demo includes a simulator in the chat sidebar. iMessage has no public API and is not supported.'),
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

    // handoff
    const draft = M.ui.handoffDraft && M.ui.handoffDraft.orgId === org.id ? M.ui.handoffDraft.text : org.handoff ? org.handoff.text : '';
    const ta = h('textarea', { rows: 14, class: 'mono', 'data-keep': 'handoff-' + org.id, 'aria-label': 'Handoff document' });
    ta.value = draft;

    return h('div', { class: 'main-scroll pad two-col', 'data-scroll': 'main' },
      h('div', null,
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
    const orgs = M.myOrgs(me.id);

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

    const icsFile = h('input', { type: 'file', accept: '.ics,text/calendar', 'aria-label': 'Upload .ics calendar', onChange: async () => {
      const f = icsFile.files[0];
      if (!f) return;
      try {
        const res = M.act.importICS(me.id, await f.text(), f.name);
        M.toast(`Imported ${res.events} events → ${res.blocks.length} busy blocks. Titles were discarded.`);
      } catch (e) {
        M.toast(e.message);
      }
    } });

    const friendIn = h('input', { list: 'people', placeholder: 'Name or email of someone on Meadow', 'data-keep': 'friend-in', 'aria-label': 'Add a friend' });
    const people = Object.values(state.users).filter((u) => u.id !== me.id && !u.placeholder);
    const friends = M.friendsOf(me.id).map((id) => state.users[id]);

    const cfg = M.AI.llmConfig();
    const key = h('input', { type: 'password', value: cfg.key || '', placeholder: 'sk-… (stays in this browser)', autocomplete: 'off', 'aria-label': 'API key' });
    const base = h('input', { value: cfg.base || '', placeholder: 'https://api.openai.com/v1' });
    const model = h('input', { value: cfg.model || '', placeholder: 'gpt-4o-mini' });

    return h('div', { class: 'main-scroll pad two-col', 'data-scroll': 'main' },
      h('div', null,
        h('section', { class: 'card' },
          h('div', { class: 'row tight' }, M.avatar(me, 56), h('div', null, h('h1', null, me.name), h('p', { class: 'hint' }, me.email || 'No email on file')))),
        h('section', { class: 'card' },
          h('h2', null, '📅 Calendar'),
          me.calendar
            ? h('p', null, h('span', { class: 'chip free' }, 'Connected'), ` ${me.calendar.name} · ${me.calendar.count} items · updated ${M.fmt.ago(me.calendar.importedAt)}`)
            : h('p', { class: 'notice' }, 'No calendar yet — Dewey can’t include you in suggestions until you share availability.'),
          h('p', { class: 'hint' }, 'Upload an .ics file (Google, Apple, Outlook, or your school’s class schedule export). Meadow keeps only busy time ranges; titles, locations and attendees are thrown away at import. All-day and “free” events are ignored.'),
          h('div', { class: 'row wrap' }, icsFile,
            h('button', { class: 'btn small', onClick: () => M.safe(() => { M.act.importICS(me.id, SAMPLE_ICS(), 'sample-schedule.ics'); M.toast('Sample class schedule imported'); }) }, 'Use a sample schedule')),
          h('div', { class: 'row wrap' },
            M.google.configured()
              ? h('button', { class: 'btn', onClick: () => M.google.connectCalendar(me.id).then((n) => M.toast(`Google Calendar connected (${n} busy blocks)`)).catch((e) => M.toast(e.message)) }, 'Connect Google Calendar (free/busy only)')
              : h('button', { class: 'btn', disabled: true, title: 'Add GOOGLE_CLIENT_ID to js/config.js' }, 'Connect Google Calendar'),
            me.calendar ? h('button', { class: 'btn danger small', onClick: () => M.confirm('Remove your calendar and all imported busy blocks?', () => { M.act.removeCalendar(me.id); M.toast('Calendar data deleted'); }) }, 'Disconnect & delete data') : null)),
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
        orgs.length
          ? h('section', { class: 'card' },
              h('h2', null, '📡 Messaging bridge opt-in'),
              h('p', { class: 'hint' }, 'If an org has a GroupMe bridge, your org-chat messages are mirrored out only if you opt in.'),
              orgs.map((o) => {
                const cb = h('input', { type: 'checkbox', checked: !!(me.bridgeOptIn && me.bridgeOptIn[o.id]), onChange: () => M.act.setBridgeOptIn(me.id, o.id, cb.checked) });
                return h('label', { class: 'check' }, cb, `${o.emoji} ${o.name}` + (o.bridge.type === 'none' ? ' (no bridge set up)' : ' (' + o.bridge.type + ')'));
              }))
          : null,
        h('section', { class: 'card' },
          h('h2', null, '🤖 Assistant'),
          h('p', { class: 'hint' }, 'Dewey works offline with a built-in parser. Optionally add an OpenAI-compatible API key to let an LLM refine requests and polish summaries. The key is stored only in this browser and only free/busy-derived text is sent.'),
          h('label', null, 'API key', key), h('label', null, 'Base URL (optional)', base), h('label', null, 'Model (optional)', model),
          h('div', { class: 'row' },
            h('button', { class: 'btn', onClick: () => { localStorage.setItem('meadow:llm', JSON.stringify({ key: key.value.trim(), base: base.value.trim(), model: model.value.trim() })); M.toast(key.value ? 'LLM enabled' : 'LLM disabled'); M.render(); } }, 'Save'),
            cfg.key ? h('button', { class: 'btn small', onClick: () => { localStorage.removeItem('meadow:llm'); M.render(); } }, 'Remove key') : null)),
        h('section', { class: 'card' },
          h('h2', null, '⚠️ Danger zone'),
          h('div', { class: 'row wrap' },
            h('button', { class: 'btn danger small', onClick: () => M.confirm('Delete your account and all your data from Meadow?', () => { M.act.deleteAccount(me.id); location.hash = '#/'; M.render(); }) }, 'Delete my account'),
            h('button', { class: 'btn small', onClick: () => M.confirm('Wipe ALL shared Meadow data on this server (every profile, org and message, for everyone)?', () => { M.store.reset(); M.session.set(null); location.hash = '#/'; M.render(); }) }, 'Reset shared data')))));
  };
})();
