/* Meadow — actions (everything that changes data). Views call these; they call the store. */
(function () {
  const M = window.Meadow;
  const { MIN, HOUR, DAY } = M;
  const S = () => M.store.get();
  const A = (M.act = {});

  const cap = (s, n) => String(s || '').trim().slice(0, n);
  const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');

  /* ------------------------------------------------------------------ users / auth */
  /* Sign-up, login and Google sign-in happen on the server (M.auth); profiles are created there. */
  A.signOut = () => M.auth.logout();

  A.heartbeat = function () {
    const me = M.session.get();
    if (!me) return;
    M.store.update((s) => {
      if (s.users[me]) s.users[me].lastSeen = Date.now();
    }, { silent: true });
  };

  A.setStatus = function (uid, { presence, away }) {
    const out = { notes: [] };
    M.store.update((s) => {
      const u = s.users[uid];
      if (presence) u.presence = presence;
      if (away !== undefined) {
        u.away = cap(away, 140);
        const parsed = M.AI.parseStatus(u.away);
        u.statusBusy = parsed.blocks.map((b) => [b[0], b[1]]);
        out.notes = parsed.notes;
        if (u.statusBusy.length && !u.calendar) u.calendar = { source: 'status', name: 'Status messages', importedAt: Date.now() };
      }
    });
    return out;
  };

  A.deleteAccount = function (uid) {
    M.store.update((s) => {
      delete s.users[uid];
      Object.values(s.orgs).forEach((o) => delete o.members[uid]);
      Object.values(s.events).forEach((e) => {
        e.roles.forEach((r) => (r.claims = r.claims.filter((x) => x !== uid)));
        e.attendance = (e.attendance || []).filter((x) => x !== uid);
        M.recomputeStatus(e);
      });
      s.friendships = s.friendships.filter((f) => f.a !== uid && f.b !== uid);
    });
    return M.store.flush().then(() => M.auth.deleteAccount());
  };

  /* ------------------------------------------------------------------ calendar / privacy */
  A.setBusy = function (uid, blocks, meta) {
    M.store.update((s) => {
      const u = s.users[uid];
      u.busy = M.mergeIntervals(blocks).map((b) => [b[0], b[1]]);
      u.calendar = { source: meta.source, name: meta.name, importedAt: Date.now(), count: meta.count || u.busy.length };
    });
  };

  A.importICS = function (uid, text, filename) {
    const res = M.parseICS(text);
    if (!res.events) throw new Error("That file doesn't look like an .ics calendar with timed events.");
    A.setBusy(uid, res.blocks, { source: 'ics', name: filename || 'calendar.ics', count: res.events });
    return res;
  };

  A.removeCalendar = function (uid) {
    M.store.update((s) => {
      const u = s.users[uid];
      u.busy = [];
      u.statusBusy = [];
      u.calendar = null;
    });
  };

  /* ------------------------------------------------------------------ friends */
  A.addFriend = function (uid, otherId) {
    M.store.update((s) => {
      if (uid === otherId) return;
      if (!s.friendships.some((f) => (f.a === uid && f.b === otherId) || (f.a === otherId && f.b === uid))) s.friendships.push({ a: uid, b: otherId });
    });
  };
  A.removeFriend = function (uid, otherId) {
    M.store.update((s) => {
      s.friendships = s.friendships.filter((f) => !((f.a === uid && f.b === otherId) || (f.a === otherId && f.b === uid)));
    });
  };
  M.friendsOf = (uid) =>
    S().friendships.filter((f) => f.a === uid || f.b === uid).map((f) => (f.a === uid ? f.b : f.a)).filter((id) => S().users[id]);

  /* ------------------------------------------------------------------ orgs */
  const inviteCode = () => Math.random().toString(36).slice(2, 8).toUpperCase();

  A.createOrg = function (uid, name, emoji) {
    name = cap(name, 60);
    if (!name) throw new Error('Give your org a name.');
    return M.store.update((s) => {
      const org = {
        id: M.uid('o'),
        name,
        emoji: emoji || '🌿',
        inviteCode: inviteCode(),
        createdAt: Date.now(),
        members: { [uid]: { role: 'President', joinedAt: Date.now() } },
        bridge: { type: 'none', botId: '' },
        handoff: null,
      };
      s.orgs[org.id] = org;
      A._say(s, 'org:' + org.id, `Welcome to **${name}**! I'm Dewey, your scheduling helper. Share the invite link so members can join, ask them to import a calendar, then try “@dewey find a time for a 2 hour social this weekend”.`);
      return org.id;
    });
  };

  A.joinOrg = function (uid, code) {
    code = cap(code, 12).toUpperCase();
    const org = Object.values(S().orgs).find((o) => o.inviteCode === code);
    if (!org) throw new Error('No org found for that invite code.');
    M.store.update((s) => {
      const o = s.orgs[org.id];
      if (!o.members[uid]) {
        o.members[uid] = { role: 'Member', joinedAt: Date.now() };
        A._say(s, 'org:' + o.id, `${s.users[uid].name} joined the org. Say hi! 👋`);
      }
    });
    return org.id;
  };

  A.setMemberRole = function (orgId, actorId, targetId, role) {
    M.store.update((s) => {
      const o = s.orgs[orgId];
      if (!M.isOfficer(o, actorId)) throw new Error('Only officers can change roles.');
      const officers = Object.keys(o.members).filter((id) => M.isOfficer(o, id));
      if (role === 'Member' && officers.length === 1 && officers[0] === targetId) throw new Error('An org needs at least one officer.');
      o.members[targetId].role = role;
    });
  };

  A.leaveOrg = function (orgId, uid) {
    M.store.update((s) => {
      const o = s.orgs[orgId];
      const officers = Object.keys(o.members).filter((id) => M.isOfficer(o, id));
      if (officers.length === 1 && officers[0] === uid && Object.keys(o.members).length > 1) throw new Error('Promote another officer before leaving.');
      delete o.members[uid];
      Object.values(s.events).filter((e) => e.orgId === orgId).forEach((e) => {
        e.roles.forEach((r) => (r.claims = r.claims.filter((x) => x !== uid)));
        M.recomputeStatus(e);
      });
      if (!Object.keys(o.members).length) delete s.orgs[orgId];
    });
  };

  A.setBridge = function (orgId, bridge) {
    M.store.update((s) => {
      s.orgs[orgId].bridge = { type: bridge.type, botId: cap(bridge.botId, 80) };
    });
  };

  A.setBridgeOptIn = function (uid, orgId, on) {
    M.store.update((s) => {
      s.users[uid].bridgeOptIn = s.users[uid].bridgeOptIn || {};
      s.users[uid].bridgeOptIn[orgId] = !!on;
    });
  };

  /** Roster import: "Name, email[, role]" lines or a CSV with a header. Merges duplicates. */
  A.importRoster = function (orgId, actorId, text) {
    const rows = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => l.split(/\s*[,\t]\s*/).map((c) => c.replace(/^"|"$/g, '')));
    if (rows.length && /name|email/i.test(rows[0].join(' ')) && !/@/.test(rows[0].join(' '))) rows.shift();
    const res = { added: 0, merged: 0, skipped: 0 };
    M.store.update((s) => {
      const org = s.orgs[orgId];
      if (!M.isOfficer(org, actorId)) throw new Error('Only officers can import a roster.');
      for (const row of rows) {
        let name = '';
        let email = '';
        row.forEach((c) => (/@/.test(c) ? (email = c.toLowerCase()) : !name && c && (name = c)));
        if (!name && email) name = email.split('@')[0];
        if (!name) {
          res.skipped++;
          continue;
        }
        const nn = normName(name);
        let u = Object.values(s.users).find((x) => (email && x.email === email) || (!email && normName(x.name) === nn) || (x.placeholder && normName(x.name) === nn));
        if (u) {
          if (org.members[u.id]) {
            res.merged++;
            if (email && !u.email) u.email = email;
            continue;
          }
          res.merged++;
        } else {
          u = { id: M.uid('u'), name: cap(name, 60), email, createdAt: Date.now(), busy: [], statusBusy: [], calendar: null, bridgeOptIn: {}, placeholder: true };
          s.users[u.id] = u;
          res.added++;
        }
        org.members[u.id] = { role: 'Member', joinedAt: Date.now() };
      }
      A._say(s, 'org:' + orgId, `Roster imported: ${res.added} new, ${res.merged} merged with existing members, ${res.skipped} skipped.`);
    });
    return res;
  };

  /* ------------------------------------------------------------------ messages */
  A._say = function (s, channel, text, payload, source) {
    s.messages.push({ id: M.uid('m'), channel, userId: null, text, ts: Date.now(), source: source || 'assistant', payload: payload || null });
  };

  const orgOfChannel = (s, channel) => {
    const [kind, id] = channel.split(':');
    if (kind === 'org') return s.orgs[id];
    if (kind === 'event') return s.events[id] && s.orgs[s.events[id].orgId];
    return null;
  };

  A.postMessage = function (channel, uid, text, opts) {
    text = String(text || '').trim().slice(0, 2000);
    if (!text) return;
    opts = opts || {};
    let relay = null;
    M.store.update((s) => {
      s.messages.push({ id: M.uid('m'), channel, userId: uid, text, ts: Date.now(), source: opts.source || 'app', author: opts.author || null, payload: null });
      const org = orgOfChannel(s, channel);
      const u = s.users[uid];
      if (!opts.source && org && org.bridge.type === 'groupme' && org.bridge.botId && u && u.bridgeOptIn && u.bridgeOptIn[org.id] && channel.startsWith('org:'))
        relay = { botId: org.bridge.botId, text: `${u.name}: ${text}` };
      // keep storage bounded
      if (s.messages.length > 1500) s.messages.splice(0, s.messages.length - 1500);
    });
    if (relay) A._relayGroupMe(relay);
    if (/@dewey\b/i.test(text) && !opts.source) A.assistantRespond(channel, uid, text);
  };

  A._relayGroupMe = function ({ botId, text }) {
    // GroupMe's bot API accepts a simple POST. Browsers may block reading the reply (CORS), so fire-and-forget.
    fetch('https://api.groupme.com/v3/bots/post', {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ bot_id: botId, text }),
    }).catch(() => {});
  };

  /** Simulate a message arriving through the bridge (a real deployment receives these via webhook). */
  A.simulateBridged = function (orgId, author, text, source) {
    A.postMessage('org:' + orgId, null, text, { source: source || 'groupme', author: cap(author, 40) || 'Someone' });
  };

  /* ------------------------------------------------------------------ events */
  const defaultRoleId = () => M.uid('r');

  A.createEvent = function (orgId, actorId, data) {
    return M.store.update((s) => {
      const org = s.orgs[orgId];
      if (!M.isOfficer(org, actorId)) throw new Error('Only officers can create events.');
      const title = cap(data.title, 80);
      if (!title) throw new Error('Give the event a title.');
      if (!(data.end > data.start)) throw new Error('The end time must be after the start time.');
      const ev = {
        id: M.uid('e'),
        orgId,
        title,
        type: data.type || 'Event',
        location: cap(data.location, 80),
        description: cap(data.description, 400),
        start: data.start,
        end: data.end,
        status: 'pending',
        createdBy: actorId,
        createdAt: Date.now(),
        checkinCode: 'MDW-' + Math.floor(1000 + Math.random() * 9000),
        attendance: [],
        roles: (data.roles || []).map((r) => ({
          id: defaultRoleId(),
          name: cap(r.name, 40),
          required: r.required !== false,
          headcount: Math.max(1, parseInt(r.headcount, 10) || 1),
          offsetMin: r.offsetMin || 0,
          durationMin: r.durationMin || null,
          anchor: r.anchor || 'start',
          claims: [],
        })),
      };
      M.recomputeStatus(ev);
      s.events[ev.id] = ev;
      const prog = M.eventProgress(ev);
      A._say(s, 'org:' + orgId, `📅 New event: **${ev.title}** — ${M.fmt.range(ev.start, ev.end)}.` + (prog.need ? ` ${prog.need} role spots to fill — it stays pending until every required role is claimed.` : ''), { type: 'event', eventId: ev.id });
      return ev.id;
    });
  };

  A.claimRole = function (eventId, roleId, uid) {
    M.store.update((s) => {
      const ev = s.events[eventId];
      const role = ev.roles.find((r) => r.id === roleId);
      if (ev.status === 'cancelled') throw new Error('This event was cancelled.');
      if (!s.orgs[ev.orgId].members[uid]) throw new Error('Join the org first.');
      if (role.claims.includes(uid)) return;
      if (role.claims.length >= role.headcount) throw new Error('That role is already full.');
      const was = ev.status;
      role.claims.push(uid);
      M.recomputeStatus(ev);
      const name = s.users[uid].name;
      const flare = Object.values(s.flares).find((f) => f.eventId === eventId && f.roleId === roleId && f.status === 'open');
      if (flare && role.claims.length >= role.headcount) {
        flare.status = 'claimed';
        flare.claimedBy = uid;
        flare.resolvedAt = Date.now();
        A._say(s, 'org:' + ev.orgId, `🎉 ${name} picked up the **${role.name}** flare for ${ev.title}. Thank you!`);
      }
      A._say(s, 'event:' + ev.id, `${name} claimed **${role.name}**.`);
      if (was !== 'confirmed' && ev.status === 'confirmed') A._say(s, 'org:' + ev.orgId, `✅ **${ev.title}** is confirmed — every required role is filled!`, { type: 'event', eventId: ev.id });
    });
  };

  A.releaseRole = function (eventId, roleId, uid) {
    M.store.update((s) => {
      const ev = s.events[eventId];
      const role = ev.roles.find((r) => r.id === roleId);
      role.claims = role.claims.filter((x) => x !== uid);
      const was = ev.status;
      M.recomputeStatus(ev);
      const name = s.users[uid].name;
      A._say(s, 'event:' + ev.id, `${name} released **${role.name}**.`);
      if (role.required && role.claims.length < role.headcount && ev.status !== 'cancelled') {
        const flare = { id: M.uid('f'), eventId, roleId, createdAt: Date.now(), status: 'open', reason: `${name} can no longer make it`, createdBy: uid };
        // one open flare per role
        Object.values(s.flares).filter((f) => f.eventId === eventId && f.roleId === roleId && f.status === 'open').forEach((f) => (f.status = 'expired'));
        s.flares[flare.id] = flare;
        const [fs, fe] = M.roleShift(ev, role);
        A._say(s, 'org:' + ev.orgId, `🔥 **Flare!** ${role.name} is open for ${ev.title} (${M.fmt.day(fs)}, ${M.fmt.time(fs)}–${M.fmt.time(fe)}). ${name} had to drop out — can someone grab it?`, { type: 'flare', flareId: flare.id });
        if (was === 'confirmed') A._say(s, 'org:' + ev.orgId, `⚠️ **${ev.title}** is back to pending.`, { type: 'event', eventId: ev.id });
      }
    });
  };

  /** An officer asks the whole org to fill an open role. People still claim it themselves. */
  A.sendFlare = function (eventId, roleId, actorId) {
    M.store.update((s) => {
      const ev = s.events[eventId];
      const role = ev.roles.find((r) => r.id === roleId);
      if (!M.isOfficer(s.orgs[ev.orgId], actorId)) throw new Error('Only officers can send flares.');
      Object.values(s.flares).filter((f) => f.eventId === eventId && f.roleId === roleId && f.status === 'open').forEach((f) => (f.status = 'expired'));
      const flare = { id: M.uid('f'), eventId, roleId, createdAt: Date.now(), status: 'open', reason: `${s.users[actorId].name} is looking for a volunteer`, createdBy: actorId };
      s.flares[flare.id] = flare;
      const [fs, fe] = M.roleShift(ev, role);
      A._say(s, 'org:' + ev.orgId, `🔥 **Flare!** ${role.name} is open for ${ev.title} (${M.fmt.day(fs)}, ${M.fmt.time(fs)}–${M.fmt.time(fe)}). Can someone grab it?`, { type: 'flare', flareId: flare.id });
    });
  };

  A.cancelEvent = function (eventId, actorId) {
    M.store.update((s) => {
      const ev = s.events[eventId];
      if (!M.isOfficer(s.orgs[ev.orgId], actorId)) throw new Error('Only officers can cancel events.');
      ev.status = 'cancelled';
      Object.values(s.flares).filter((f) => f.eventId === eventId && f.status === 'open').forEach((f) => (f.status = 'expired'));
      A._say(s, 'org:' + ev.orgId, `🚫 **${ev.title}** was cancelled by ${s.users[actorId].name}.`);
    });
  };

  A.checkIn = function (eventId, uid, code) {
    M.store.update((s) => {
      const ev = s.events[eventId];
      if (String(code).trim().toUpperCase() !== ev.checkinCode) throw new Error("That code doesn't match.");
      if (ev.status === 'cancelled') throw new Error('This event was cancelled.');
      ev.attendance = ev.attendance || [];
      if (!ev.attendance.includes(uid)) ev.attendance.push(uid);
    });
  };

  A.addGuestbook = function (eventId, uid, text) {
    text = cap(text, 300);
    if (!text) return;
    M.store.update((s) => {
      s.guestbook.push({ id: M.uid('g'), eventId, userId: uid, text, ts: Date.now() });
    });
  };

  A.saveHandoff = function (orgId, text) {
    M.store.update((s) => {
      s.orgs[orgId].handoff = { text, ts: Date.now() };
    });
  };

  A.sendNudge = function (draft, fromId) {
    // Nudges go to the org chat as an @mention so everyone can see the ask (and can claim it themselves).
    const s = S();
    const u = s.users[draft.userId];
    const ev = s.events[draft.eventId];
    A.postMessage('event:' + ev.id, fromId, `@${u.name} — ${draft.text}`);
  };

  /* ------------------------------------------------------------------ assistant responder */
  A.assistantRespond = async function (channel, uid, text) {
    const s0 = S();
    const org = orgOfChannel(s0, channel);
    if (!org) return;
    const q = text.replace(/@dewey/gi, '').trim();
    const lc = q.toLowerCase();
    const say = (t, payload) => M.store.update((s) => A._say(s, channel, t, payload));
    const state = () => S();
    const evId = channel.startsWith('event:') ? channel.split(':')[1] : null;

    try {
      if (!q || /\b(help|what can you do|how do)\b/.test(lc)) {
        say('Here’s what I can do:\n• **find a time** — “find a time for a 2 hour social this weekend, not Sunday, need two tablers”\n• **officer meeting** — “officer meeting next week after 6pm”\n• **nudge** — draft friendly asks for unfilled roles\n• **summarize** — decisions and open questions from this chat\n• **handoff** — build the officer handoff doc\n• Tell me when you’re busy — “I’m busy until 3” or “can’t do Thursday” — and I’ll offer to add it to your availability.\nI only suggest; people decide. 💧');
        return;
      }
      if (/summar|recap|tl;?dr/.test(lc)) {
        const msgs = state().messages.filter((m) => m.channel === channel).slice(-80);
        const sum = M.AI.summarize(state(), msgs);
        let out = '**Summary** — ' + sum.headline;
        if (sum.decisions.length) out += '\n\n**Decisions & commitments**\n' + sum.decisions.map((d) => '• ' + d).join('\n');
        if (sum.questions.length) out += '\n\n**Still open**\n' + sum.questions.map((d) => '• ' + d).join('\n');
        say(await M.AI.polish(out, 'Rewrite this chat summary clearly, keep every bullet. Do not invent facts.'), { type: 'summary' });
        return;
      }
      if (/handoff|hand-off|hand off/.test(lc)) {
        say('I drafted an officer handoff from this org’s events, roles and guestbook. Open the **Board** tab → *Officer handoff* to review, edit and save it.');
        return;
      }
      if (/nudge|remind|unfilled|open roles?|who (can|should)/.test(lc)) {
        const evs = evId ? [state().events[evId]] : Object.values(state().events).filter((e) => e.orgId === org.id && e.status === 'pending' && e.end > Date.now());
        const drafts = evs.flatMap((e) => M.AI.draftNudges(state(), e, uid));
        if (!drafts.length) say('Every role is filled or nobody is free to ask right now — nothing to nudge. 🎉');
        else say(`I drafted ${M.plural(drafts.length, 'nudge')} for people who look free. Nothing is sent until you press Send.`, { type: 'nudges', drafts, forUser: uid });
        return;
      }
      if (/\b(i'?m|i am|can'?t|cannot|busy|out of town|unavailable|free after|not free)\b/.test(lc) && !/\b(find|schedule|suggest|propose|plan)\b/.test(lc)) {
        const p = M.AI.parseStatus(q);
        if (p.blocks.length) {
          say(`Got it — I read that as: ${p.notes.join(', ')}. Want me to add it to your availability?`, { type: 'busy', blocks: p.blocks, forUser: uid });
          return;
        }
      }
      // default: find times
      const parsed = await M.AI.parseRequestSmart(q);
      const c = { ...parsed.constraints, orgId: org.id, excludeEventId: null };
      const res = M.suggest(state(), c);
      if (!res.results.length) {
        say(`I couldn’t find a slot that works for ${parsed.understood.join(' · ')}. Try a wider window or fewer required roles.${res.stats.unknown ? ` (${res.stats.unknown} members haven’t shared availability, which limits what I can see.)` : ''}`);
        return;
      }
      say(`Here are my top ${res.results.length} picks (${parsed.understood.join(' · ')}). Officers can turn one into an event.`, { type: 'suggestions', constraints: c, results: res.results, title: parsed.title });
    } catch (e) {
      say('Hmm, I tripped over that one. Try “@dewey help”.');
    }
  };

  A.applyBusy = function (uid, blocks) {
    M.store.update((s) => {
      const u = s.users[uid];
      u.statusBusy = M.mergeIntervals([...(u.statusBusy || []), ...blocks.map((b) => [b[0], b[1]])]);
      if (!u.calendar) u.calendar = { source: 'status', name: 'Chat & status messages', importedAt: Date.now() };
    });
  };

  /* ------------------------------------------------------------------ demo cast */
  const CLASS_SLOTS = [[8, 0, 9, 15], [9, 30, 10, 45], [11, 0, 12, 15], [12, 30, 13, 45], [14, 0, 15, 15], [15, 30, 16, 45]];

  /** A believable, repeatable class schedule (MWF + TR) for the next five weeks, seeded by name. */
  function classBusy(name, today0) {
    const rnd = M.rng(M.hashHue(name) * 977 + 13);
    const pick = (n) => {
      const set = new Set();
      while (set.size < n) set.add(Math.floor(rnd() * CLASS_SLOTS.length));
      return [...set].map((k) => CLASS_SLOTS[k]);
    };
    const mwf = pick(2 + Math.floor(rnd() * 2));
    const tr = pick(2);
    const busy = [];
    for (let d = -1; d < 35; d++) {
      const day0 = M.addDays(today0, d);
      const wd = new Date(day0).getDay();
      const set = wd === 1 || wd === 3 || wd === 5 ? mwf : wd === 2 || wd === 4 ? tr : [];
      set.forEach(([h1, m1, h2, m2]) => busy.push([new Date(day0).setHours(h1, m1, 0, 0), new Date(day0).setHours(h2, m2, 0, 0)]));
      if (rnd() < 0.22) {
        const st = 17 + Math.floor(rnd() * 3);
        busy.push([new Date(day0).setHours(st, 0, 0, 0), new Date(day0).setHours(st + 2, 0, 0, 0)]);
      }
      if ((wd === 6 || wd === 0) && rnd() < 0.2) busy.push([new Date(day0).setHours(12, 0, 0, 0), new Date(day0).setHours(16, 0, 0, 0)]);
    }
    return busy;
  }

  /** Weekly blocks beyond classes: [weekdays, startHour, endHour], e.g. a job or practice. */
  function weeklyBusy(today0, blocks) {
    const busy = [];
    for (let d = -1; d < 35; d++) {
      const day0 = M.addDays(today0, d);
      const wd = new Date(day0).getDay();
      blocks.forEach(([days, h1, h2]) => {
        if (days.includes(wd)) busy.push([new Date(day0).setHours(Math.floor(h1), (h1 % 1) * 60, 0, 0), new Date(day0).setHours(Math.floor(h2), (h2 % 1) * 60, 0, 0)]);
      });
    }
    return busy;
  }

  A.seedDemo = function () {
    const now = Date.now();
    const today0 = M.startOfDay(now);
    const dow = new Date(now).getDay();
    const nextDow = (target, hour, min) => {
      let delta = (target - dow + 7) % 7;
      if (delta === 0) delta = 7;
      return new Date(M.addDays(today0, delta)).setHours(hour, min || 0, 0, 0);
    };
    const cast = [
      { name: 'Maya Chen', role: 'President', presence: 'online', away: '' },
      { name: 'Jordan Reyes', role: 'Events Chair', presence: 'online', away: 'tabling queen 👑' },
      { name: 'Priya Nair', role: 'Treasurer', presence: 'away', away: 'in lab until 4pm' },
      { name: 'Sam Okafor', role: 'Member', presence: 'online', away: '' },
      { name: 'Alex Kim', role: 'Member', presence: 'away', away: 'studying for midterms' },
      { name: 'Riley Brooks', role: 'Member', presence: 'online', away: '' },
      { name: 'Noor Haddad', role: 'Member', presence: 'offline', away: 'back Monday' },
      { name: 'Theo Martin', role: 'Member', presence: 'online', away: 'free after 6!' },
    ];

    let orgId;
    const ids = {};
    M.store.update((s) => {
      // Keep iMessage bridge fields across demo reload (same fixed event/member ids).
      const keepEv = s.events.evt_sample_meeting;
      const keptBridge = keepEv ? {
        plans: keepEv.plans || {},
        imessage: keepEv.imessage || {},
        meetingTimeVotes: keepEv.meetingTimeVotes || {},
        foodFeedback: keepEv.foodFeedback || {},
      } : null;
      const keptGuest = s.guestbook.filter((g) => g.eventId === 'evt_sample_meeting');

      // remove an older demo, if any (the tutorial org is seeded separately)
      Object.values(s.users).filter((u) => u.demo && !u.demoSet).forEach((u) => delete s.users[u.id]);
      Object.values(s.orgs).filter((o) => o.demo && !o.demoSet).forEach((o) => {
        Object.values(s.events).filter((e) => e.orgId === o.id).forEach((e) => {
          delete s.events[e.id];
          s.guestbook = s.guestbook.filter((g) => g.eventId !== e.id);
        });
        s.messages = s.messages.filter((m) => !m.channel.endsWith(o.id));
        delete s.orgs[o.id];
      });

      cast.forEach((p, i) => {
        const busy = classBusy(p.name, today0);
        // Stable ids so iMessage (meadow) can write plans onto the same Flask rows the org UI reads.
        const id = p.name === 'Alex Kim' ? 'mem_alex' : M.uid('u');
        ids[p.name] = id;
        s.users[id] = {
          id, name: p.name, email: p.name.split(' ')[0].toLowerCase() + '@demo.meadow', createdAt: now, demo: true,
          busy: M.mergeIntervals(busy), statusBusy: [], calendar: { source: 'demo', name: 'Demo class schedule', importedAt: now, count: busy.length },
          bridgeOptIn: {}, presence: p.presence === 'away' ? 'away' : 'online', demoPresence: p.presence, away: p.away, lastSeen: 0,
          phone: '', imessageOptIn: p.name === 'Alex Kim', imessageError: '',
        };
      });

      const org = {
        id: 'org_demo', name: 'Sunrise Service Society', emoji: '🌅', inviteCode: 'SUNRISE', createdAt: now, demo: true,
        members: {}, bridge: { type: 'none', botId: '' }, handoff: null,
      };
      cast.forEach((p, i) => (org.members[ids[p.name]] = { role: p.role, joinedAt: now - (30 - i) * DAY }));
      s.orgs[org.id] = org;
      orgId = org.id;

      const mkEvent = (title, type, loc, start, end, roles, extra) => {
        const ev = {
          id: (extra && extra.id) || M.uid('e'), orgId, title, type, location: loc, description: '', start, end, status: 'pending', createdBy: ids['Jordan Reyes'],
          createdAt: now - 3 * DAY, checkinCode: 'MDW-' + Math.floor(1000 + Math.random() * 9000), attendance: [],
          roles: roles.map((r) => ({ id: M.uid('r'), name: r[0], required: r[1], headcount: r[2], offsetMin: r[3], durationMin: r[4], anchor: r[5] || 'start', claims: (r[6] || []).map((n) => ids[n]) })),
          plans: {}, imessage: {}, meetingTimeVotes: {}, foodFeedback: {},
          ...extra,
        };
        M.recomputeStatus(ev);
        s.events[ev.id] = ev;
        return ev;
      };

      const thu = nextDow(4, 11);
      const fair = mkEvent('Involvement Fair Tabling', 'Tabling', 'Student Union Plaza', thu, thu + 4 * HOUR, [
        ['Setup', true, 2, -60, 60, 'start', ['Jordan Reyes']],
        ['Tabling (shift 1)', true, 2, 0, 120, 'start', ['Sam Okafor', 'Alex Kim']],
        ['Tabling (shift 2)', true, 2, 120, 120, 'start', ['Riley Brooks']],
        ['Food pickup', true, 1, -45, 45, 'start', []],
        ['Cleanup', false, 2, 0, 30, 'end', []],
      ]);
      const repairDay = nextDow(0, 13);
      const repair = mkEvent('Community Share & Repair', 'Workshop', 'Community lounge · proposed venue', repairDay, repairDay + 2 * HOUR, [
        ['Setup', true, 2, -30, 30, 'start', ['Jordan Reyes']],
        ['Welcome desk', true, 1, 0, 120, 'start', ['Priya Nair']],
        ['Mending station', true, 1, 0, 120, 'start', []],
        ['Exchange station', true, 1, 0, 120, 'start', []],
        ['Cleanup', true, 2, 0, 30, 'end', ['Theo Martin']],
      ], {description: 'Demo scenario: a free clothing and dorm-item swap with a mending station. Everyone is welcome; bringing an item is optional. Help neighbors reuse what they have and learn a repair skill. The venue and supplies still need organizer confirmation; staffing complete does not mean all logistics are ready.'});
      const tue = nextDow(2, 18, 30);
      // Fixed id matches meadow SAMPLE.eventId — SMS RSVPs land on event.plans[mem_alex].
      const meeting = mkEvent('Weekly General Meeting', 'Meeting', 'Hall 204', tue, tue + HOUR, [], {
        id: 'evt_sample_meeting',
        ...(keptBridge || {}),
      });
      if (keptGuest.length) s.guestbook.push(...keptGuest);
      const past = new Date(M.addDays(today0, -6)).setHours(18, 0, 0, 0);
      const social = mkEvent('Welcome Social', 'Social', 'Quad lawn', past, past + 2 * HOUR, [
        ['Setup', true, 2, -45, 45, 'start', ['Jordan Reyes', 'Theo Martin']],
        ['Greeter', true, 1, 0, 60, 'start', ['Priya Nair']],
      ]);
      social.attendance = ['Jordan Reyes', 'Theo Martin', 'Priya Nair', 'Maya Chen', 'Riley Brooks', 'Sam Okafor'].map((n) => ids[n]);
      [
        ['Riley Brooks', 'Loved the lawn spot! Next time we should book the quad at least two weeks ahead — it filled up fast.'],
        ['Theo Martin', 'Ran out of pizza at 7. Order 30% more, and remember to bring napkins.'],
        ['Priya Nair', 'Budget tip: the student activities office reimburses within a week if you file the receipts the same day.'],
      ].forEach(([n, t], i) => s.guestbook.push({ id: M.uid('g'), eventId: social.id, userId: ids[n], text: t, ts: past + (3 + i) * HOUR }));

      // seed chat
      const say = (n, t, ago) => s.messages.push({ id: M.uid('m'), channel: 'org:' + orgId, userId: ids[n], text: t, ts: now - ago * MIN, source: 'app', payload: null });
      s.messages.push({ id: M.uid('m'), channel: 'org:' + orgId, userId: null, text: 'Welcome to **Sunrise Service Society**! I\'m Dewey. Ask me things like “@dewey find a time for a 2 hour social this weekend, not Sunday, need two tablers”.', ts: now - 300 * MIN, source: 'assistant', payload: null });
      s.messages.push({ id: M.uid('m'), channel: 'org:' + orgId, userId: null, text: 'Help bring Community Share & Repair to life: welcome neighbors, run the exchange, or help with mending. The venue still needs confirmation.', ts: now - 250 * MIN, source: 'assistant', payload: { type: 'event', eventId: repair.id } });
      say('Maya Chen', 'Hey all — the involvement fair is Thursday! We still need a food pickup and a second tabling crew.', 240);
      say('Jordan Reyes', 'I\'ll handle setup. Sam and Alex are on the first tabling shift 🙌', 200);
      say('Riley Brooks', 'I can do the second shift but I need one more person with me.', 150);
      say('Theo Martin', 'Sounds good — let\'s plan the next social for the weekend after. Can someone check which Saturday works?', 90);
      s.messages.push({ id: M.uid('m'), channel: 'org:' + orgId, userId: null, text: '📅 Involvement Fair Tabling is pending — ' + M.eventProgress(fair).open + ' required role spots are open.', ts: now - 60 * MIN, source: 'assistant', payload: { type: 'event', eventId: fair.id } });
      s.messages.push({ id: M.uid('m'), channel: 'org:' + orgId, userId: null, author: 'Dana', text: 'Is the fair still on Thursday? I can bring cookies!', ts: now - 30 * MIN, source: 'groupme', payload: null });

      s.friendships.push({ a: ids['Maya Chen'], b: ids['Jordan Reyes'] }, { a: ids['Maya Chen'], b: ids['Theo Martin'] });
      cast.forEach((p) => {
        const u = s.users[ids[p.name]];
        // don't let the scripted claims clash with scripted class times
        Object.values(s.events).forEach((ev) => ev.roles.forEach((r) => {
          if (!r.claims.includes(u.id)) return;
          const [rs, re] = M.roleShift(ev, r);
          u.busy = M.mergeIntervals(u.busy.filter((b) => !(b[0] < re && b[1] > rs)).concat([]));
          // trimming whole blocks that overlap is fine for a demo
        }));
      });
    });
    return { orgId, ids };
  };
  /* ------------------------------------------------------------------ tutorial org: Student Government */
  A.SGA_ORG = 'org_sga';
  A.SGA_HOMECOMING = 'evt_sga_homecoming';

  /** Seed (or reset) the Student Government org used by the guided tutorial, with `meId` as President. */
  A.seedStudentGov = function (meId) {
    const now = Date.now();
    const today0 = M.startOfDay(now);
    const dow = new Date(now).getDay();
    const nextDow = (target, hour, min) => {
      let delta = (target - dow + 7) % 7;
      if (delta === 0) delta = 7;
      return new Date(M.addDays(today0, delta)).setHours(hour, min || 0, 0, 0);
    };
    const orgId = A.SGA_ORG;
    // [name, role, presence, away message, calendar name, weekly blocks beyond classes]
    const cast = [
      ['Jasmine Okoye', 'Vice President', 'online', 'town hall prep 📝', 'Classes + campus job', [[[2, 4], 17, 20]]],
      ['Marcus Lee', 'Treasurer', 'away', 'budget spreadsheets 📊', 'Classes + chem lab', [[[3], 13, 17]]],
      ['Hannah Park', 'Secretary', 'online', '', 'Fall classes', []],
      ['Diego Alvarez', 'Events Chair', 'online', 'homecoming mode 🎉', 'Classes + RA duty', [[[0, 4], 20, 23]]],
      ['Aisha Rahman', 'Member', 'online', 'free after 4!', 'Fall classes', []],
      ['Ben Carter', 'Member', 'away', 'at practice ⚽', 'Classes + soccer practice', [[[1, 2, 3, 4, 5], 15.5, 17.5]]],
      ['Chloe Nguyen', 'Member', 'online', '', 'Classes + weekend shifts', [[[6], 10, 16]]],
      ['Ethan Brooks', 'Member', 'offline', 'back Monday', 'Fall classes', []],
      ['Fatima Ali', 'Member', 'online', 'in the library', 'Classes + bio lab', [[[2], 13, 17]]],
      ['Grace Kim', 'Member', 'away', 'midterm szn', 'Classes + tutoring', [[[1, 3], 18, 20]]],
      ['Liam O’Connor', 'Member', 'online', '', 'Classes + band rehearsal', [[[2, 4], 19, 21]]],
    ];
    const ids = {};
    cast.forEach(([name]) => (ids[name] = 'sga_' + name.split(' ')[0].toLowerCase()));

    M.store.update((s) => {
      // Reset an earlier copy so the tutorial always starts from the same story.
      const oldEvents = new Set(Object.values(s.events).filter((e) => e.orgId === orgId).map((e) => e.id));
      const oldUsers = new Set(Object.values(s.users).filter((u) => u.demoSet === 'sga').map((u) => u.id));
      oldEvents.forEach((id) => delete s.events[id]);
      oldUsers.forEach((id) => delete s.users[id]);
      Object.values(s.flares).filter((f) => oldEvents.has(f.eventId)).forEach((f) => delete s.flares[f.id]);
      s.guestbook = s.guestbook.filter((g) => !oldEvents.has(g.eventId));
      s.messages = s.messages.filter((m) => m.channel !== 'org:' + orgId && !oldEvents.has(m.channel.split(':')[1])
        && !(m.channel.startsWith('dm:') && m.channel.split(':').some((id) => oldUsers.has(id))));
      s.friendships = s.friendships.filter((f) => !oldUsers.has(f.a) && !oldUsers.has(f.b));

      cast.forEach(([name, , presence, away, calName, extra]) => {
        const id = ids[name];
        const busy = M.mergeIntervals(classBusy(name, today0).concat(weeklyBusy(today0, extra)));
        s.users[id] = {
          id, name, email: name.split(' ')[0].toLowerCase() + '@sga.demo.meadow', createdAt: now, demo: true, demoSet: 'sga',
          busy, statusBusy: [], calendar: { source: 'demo', name: calName, importedAt: now, count: busy.length },
          bridgeOptIn: {}, presence: presence === 'offline' ? 'online' : presence, demoPresence: presence, away, lastSeen: 0,
          phone: '', imessageOptIn: false, imessageError: '',
        };
      });

      const me = s.users[meId];
      if (me && !M.hasShared(me)) {
        // The presenter needs a calendar too, or the heatmap reports them as unknown.
        const busy = M.mergeIntervals(classBusy(me.name || 'you', today0));
        me.busy = busy;
        me.calendar = { source: 'demo', name: 'Demo class schedule', importedAt: now, count: busy.length };
      }

      const org = {
        id: orgId, name: 'Student Government Association', emoji: '🏛️', inviteCode: 'SGA', createdAt: now, demo: true, demoSet: 'sga',
        members: {}, bridge: { type: 'none', botId: '' }, handoff: null,
      };
      cast.forEach(([name, role], i) => (org.members[ids[name]] = { role, joinedAt: now - (60 - i) * DAY }));
      if (me) org.members[meId] = { role: 'President', joinedAt: now - 90 * DAY };
      s.orgs[orgId] = org;

      const mkEvent = (id, title, type, loc, start, end, roles, extra) => {
        const ev = {
          id, orgId, title, type, location: loc, description: '', start, end, status: 'pending', createdBy: ids['Diego Alvarez'],
          createdAt: now - 4 * DAY, checkinCode: 'SGA-' + Math.floor(1000 + Math.random() * 9000), attendance: [],
          roles: roles.map((r, i) => ({ id: id + '_r' + i, name: r[0], required: r[1], headcount: r[2], offsetMin: r[3], durationMin: r[4], anchor: r[5] || 'start', claims: (r[6] || []).map((n) => ids[n]) })),
          plans: {}, imessage: {}, meetingTimeVotes: {}, foodFeedback: {},
          ...extra,
        };
        M.recomputeStatus(ev);
        s.events[ev.id] = ev;
        return ev;
      };

      const fri = nextDow(5, 11);
      const homecoming = mkEvent(A.SGA_HOMECOMING, 'Homecoming Tabling', 'Tabling', 'Main Quad', fri, fri + 4 * HOUR, [
        ['Setup', true, 2, -60, 60, 'start', ['Diego Alvarez']],
        ['Tabling (shift 1)', true, 2, 0, 120, 'start', ['Aisha Rahman', 'Chloe Nguyen']],
        ['Tabling (shift 2)', true, 2, 120, 120, 'start', ['Fatima Ali']],
        ['Food pickup', true, 1, -45, 45, 'start', []],
        ['Cleanup', false, 2, 0, 30, 'end', []],
      ], { description: 'Homecoming week booth: hand out SGA swag, collect town hall questions, and sign students up for committees.' });
      const wed = nextDow(3, 18);
      const townHall = mkEvent('evt_sga_townhall', 'Student Town Hall', 'Meeting', 'Union Ballroom', wed, wed + 90 * MIN, [
        ['Setup', true, 2, -45, 45, 'start', ['Ethan Brooks', 'Grace Kim']],
        ['Greeter', true, 1, 0, 60, 'start', ['Hannah Park']],
        ['Mic runner', true, 2, 0, 90, 'start', ['Liam O’Connor']],
      ], { description: 'Open forum with the Dean of Students. Students bring questions about dining, parking and housing.' });
      const mon = nextDow(1, 19);
      mkEvent('evt_sga_senate', 'Weekly Senate Meeting', 'Meeting', 'Senate Chambers', mon, mon + HOUR, []);
      const tue = nextDow(2, 17);
      mkEvent('evt_sga_budget', 'Budget Committee', 'Meeting', 'Union 210', tue, tue + HOUR, []);
      const past = new Date(M.addDays(today0, -5)).setHours(18, 0, 0, 0);
      const mixer = mkEvent('evt_sga_mixer', 'Club Leaders Mixer', 'Social', 'Union Terrace', past, past + 2 * HOUR, [
        ['Setup', true, 2, -45, 45, 'start', ['Diego Alvarez', 'Ben Carter']],
        ['Greeter', true, 1, 0, 60, 'start', ['Hannah Park']],
      ]);
      mixer.attendance = ['Diego Alvarez', 'Ben Carter', 'Hannah Park', 'Jasmine Okoye', 'Marcus Lee', 'Aisha Rahman', 'Grace Kim'].map((n) => ids[n]);
      [
        ['Marcus Lee', 'We spent $212 of the $300 budget. Pizza for 60 was the right amount.'],
        ['Hannah Park', '40 club leaders came. Next time put the sign-in sheet by the door, not the food table.'],
      ].forEach(([n, t], i) => s.guestbook.push({ id: M.uid('g'), eventId: mixer.id, userId: ids[n], text: t, ts: past + (3 + i) * HOUR }));

      const say = (n, t, ago) => s.messages.push({ id: M.uid('m'), channel: 'org:' + orgId, userId: ids[n], text: t, ts: now - ago * MIN, source: 'app', payload: null });
      const dewey = (t, ago, payload) => s.messages.push({ id: M.uid('m'), channel: 'org:' + orgId, userId: null, text: t, ts: now - ago * MIN, source: 'assistant', payload: payload || null });
      dewey('Welcome to **Student Government Association**! I’m Dewey. Everyone here shared their calendar, so I can find times that work. Try “@dewey find a time for a 1 hour town hall dry run next week”.', 600);
      say('Jasmine Okoye', 'Homecoming tabling is Friday! We still need someone on food pickup and a second person for shift 2.', 300);
      say('Diego Alvarez', 'I’ve got setup. Aisha and Chloe are on shift 1 🙌', 270);
      say('Marcus Lee', 'Reminder: club budget requests are due before Budget Committee on Tuesday.', 200);
      dewey('📅 Homecoming Tabling is pending: ' + M.plural(M.eventProgress(homecoming).open, 'required spot') + ' still open.', 180, { type: 'event', eventId: homecoming.id });
      say('Hannah Park', 'Town hall agenda draft is in the shared drive. Can we find a time for a dry run before Wednesday?', 90);
      say('Grace Kim', 'Who’s free to run a mic at the town hall? We need one more.', 40);
      dewey('📅 Student Town Hall needs one more mic runner.', 35, { type: 'event', eventId: townHall.id });

      s.friendships.push({ a: ids['Jasmine Okoye'], b: ids['Hannah Park'] }, { a: ids['Diego Alvarez'], b: ids['Aisha Rahman'] });

      // Scripted claims (and the presenter's open shifts) should not clash with scripted classes.
      Object.values(s.events).filter((ev) => ev.orgId === orgId).forEach((ev) => ev.roles.forEach((r) => {
        const [rs, re] = M.roleShift(ev, r);
        r.claims.concat(me && me.calendar && me.calendar.source === 'demo' ? [meId] : []).forEach((uid) => {
          const u = s.users[uid];
          if (u) u.busy = u.busy.filter((b) => !(b[0] < re && b[1] > rs));
        });
      }));
    });
    return orgId;
  };
})();
