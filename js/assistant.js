/* Meadow — "Dewey", the scheduling assistant.
 *
 * Guardrails (see README):
 *  - Dewey only SUGGESTS. Nothing is booked, claimed or sent until a human clicks the button.
 *  - Dewey only reads free/busy intervals, never calendar details (we never store them).
 *  - Every suggestion carries the reasoning produced by the deterministic scorer.
 *
 * Language understanding is a rule-based parser that works offline. If the server has
 * GEMINI_API_KEY set in .env, the same functions are upgraded with Gemini (via /api/ai)
 * and fall back to the rules on any failure.
 */
(function () {
  const M = window.Meadow;
  const { MIN, HOUR, DAY } = M;

  const NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const DAYWORDS = {
    sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tues: 2, tue: 2, wednesday: 3, wed: 3,
    thursday: 4, thurs: 4, thur: 4, thu: 4, friday: 5, fri: 5, saturday: 6, sat: 6,
  };
  const DAYRE = '(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues|tue|wed|thurs|thur|thu|fri|sat)';

  /* ---------------------------------------------------------------- time words */
  function parseHour(str, defaultPm) {
    const m = /(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?/i.exec(str);
    if (!m) return null;
    let h = parseInt(m[1], 10);
    const min = m[2] ? parseInt(m[2], 10) : 0;
    const mer = m[3] && m[3][0].toLowerCase();
    if (mer === 'p' && h < 12) h += 12;
    else if (mer === 'a' && h === 12) h = 0;
    else if (!mer && defaultPm !== false && h >= 1 && h <= 7) h += 12; // "at 5" => 5pm
    return h + min / 60;
  }

  /* ---------------------------------------------------------------- scheduling requests */
  function roleFromWord(word) {
    const w = word.toLowerCase().replace(/s$/, '');
    if (/^tabl(er|ing)$/.test(w) || w === 'table') return 'Tabling';
    if (/^greet(er)?$/.test(w)) return 'Greeter';
    if (/^set\s?-?up( crew)?$/.test(w)) return 'Setup';
    if (/^clean\s?-?up( crew)?$/.test(w)) return 'Cleanup';
    if (/^food( pick\s?-?up| runner| run|pickup)?$/.test(w) || /^pick\s?-?up$/.test(w)) return 'Food pickup';
    return null;
  }

  M.AI = {};

  /**
   * Turn free text into scheduling constraints.
   * @returns {{constraints:object, understood:string[], title:string}}
   */
  M.AI.parseRequest = function (text, ctx) {
    const now = (ctx && ctx.now) || Date.now();
    const t = ' ' + text.toLowerCase().replace(/[“”]/g, '"') + ' ';
    const understood = [];
    const c = {
      mode: 'event',
      durationMin: 120,
      days: [0, 1, 2, 3, 4, 5, 6],
      hourStart: 8,
      hourEnd: 22,
      prefStart: 10,
      prefEnd: 21,
      bufferMin: 15,
      roles: [],
      from: now,
      to: now + 14 * DAY,
    };
    let working = t;

    // --- type
    if (/\b(officer|officers|exec|e-?board|leadership|board)\b/.test(t)) {
      c.mode = 'officers';
      c.durationMin = 60;
      understood.push('Officer meeting (all officers must be free)');
    } else if (/\bmeeting\b/.test(t)) {
      c.durationMin = 60;
    }

    // --- duration
    let dm;
    if ((dm = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h)\b/.exec(t))) c.durationMin = Math.round(parseFloat(dm[1]) * 60);
    else if ((dm = /(\d+)\s*(minutes?|mins?|m)\b/.exec(t))) c.durationMin = parseInt(dm[1], 10);
    else if (/(an|1)\s+hour and a half|hour and a half|1\.5 hours/.test(t)) c.durationMin = 90;
    else if (/half an hour|half hour|30 min/.test(t)) c.durationMin = 30;
    else if (/\b(an|one|1)\s+hour\b/.test(t)) c.durationMin = 60;
    else if (/\btwo hours?\b/.test(t)) c.durationMin = 120;
    else if (/\bthree hours?\b/.test(t)) c.durationMin = 180;
    c.durationMin = Math.min(Math.max(c.durationMin, 15), 600);
    understood.push(`${c.durationMin >= 60 && c.durationMin % 60 === 0 ? c.durationMin / 60 + ' hr' : c.durationMin + ' min'} long`);

    // --- days: negations first ("not Sunday", "except fri and sat")
    const excluded = new Set();
    const negRe = new RegExp(`\\b(?:not|except|excluding|avoid|no|besides|skip)\\s+(?:on\\s+)?((?:${DAYRE}|weekends?|weekdays?)(?:\\s*(?:,|and|or|&)\\s*(?:${DAYRE}|weekends?|weekdays?))*)`, 'g');
    let nm;
    while ((nm = negRe.exec(t))) {
      nm[1].split(/\s*(?:,|and|or|&)\s*/).forEach((w) => {
        w = w.trim();
        if (/^weekends?$/.test(w)) [0, 6].forEach((d) => excluded.add(d));
        else if (/^weekdays?$/.test(w)) [1, 2, 3, 4, 5].forEach((d) => excluded.add(d));
        else if (DAYWORDS[w] !== undefined) excluded.add(DAYWORDS[w]);
      });
      working = working.replace(nm[0], ' ');
    }

    // A day right after a role ("two tablers Thursday") describes the shift, not the event day.
    working = working.replace(
      new RegExp(`(tablers?|greeters?|crew|volunteers?|people)\\s+(?:on\\s+|for\\s+)?${DAYRE}\\b`, 'g'),
      ' $1 '
    );

    // --- days: positives
    const wanted = new Set();
    if (/\b(this|the|next)?\s*weekend\b/.test(working)) [0, 6].forEach((d) => wanted.add(d));
    if (/\bweekdays?\b/.test(working)) [1, 2, 3, 4, 5].forEach((d) => wanted.add(d));
    const dayRe = new RegExp(`\\b(${DAYRE})\\b`, 'g');
    let dmatch;
    while ((dmatch = dayRe.exec(working))) wanted.add(DAYWORDS[dmatch[1]]);
    if (wanted.size) c.days = [...wanted];
    c.days = c.days.filter((d) => !excluded.has(d));
    if (!c.days.length) c.days = [0, 1, 2, 3, 4, 5, 6].filter((d) => !excluded.has(d));
    if (wanted.size || excluded.size) {
      understood.push(
        'Days: ' + c.days.sort((a, b) => a - b).map((d) => M.DAY_SHORT[d]).join(', ')
      );
    }

    // --- window
    const today0 = M.startOfDay(now);
    const dow = new Date(now).getDay();
    if (/\btoday\b/.test(t)) {
      c.from = now;
      c.to = today0 + DAY;
      understood.push('Window: today');
    } else if (/\btomorrow\b/.test(t)) {
      c.from = today0 + DAY;
      c.to = today0 + 2 * DAY;
      understood.push('Window: tomorrow');
    } else if (/\bnext week\b/.test(t)) {
      const toMon = ((8 - dow) % 7) || 7;
      c.from = today0 + toMon * DAY;
      c.to = c.from + 7 * DAY;
      understood.push('Window: next week');
    } else if (/\bthis week\b/.test(t)) {
      c.from = now;
      c.to = today0 + (((7 - dow) % 7) + 1) * DAY;
      understood.push('Window: rest of this week');
    } else if (/\bthis weekend\b/.test(t)) {
      if (dow === 6) {
        c.from = now;
        c.to = today0 + 2 * DAY;
      } else if (dow === 0) {
        c.from = now;
        c.to = today0 + DAY;
      } else {
        c.from = today0 + (6 - dow) * DAY;
        c.to = c.from + 2 * DAY;
      }
      understood.push('Window: this weekend');
    } else if (/\bin (\d+) weeks?\b/.test(t)) {
      const n = parseInt(/\bin (\d+) weeks?\b/.exec(t)[1], 10);
      c.from = today0 + n * 7 * DAY;
      c.to = c.from + 7 * DAY;
      understood.push(`Window: in ${n} week(s)`);
    }
    if (c.to <= c.from) c.to = c.from + DAY;

    // --- time of day
    let tm;
    if ((tm = /\bbetween\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s+(?:and|-|to)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/.exec(t))) {
      const b = parseHour(tm[2]);
      let a = parseHour(tm[1], false);
      if (!/am|pm/.test(tm[1])) a = parseHour(tm[1] + (/pm/.test(tm[2]) ? 'pm' : /am/.test(tm[2]) ? 'am' : ''));
      if (a != null && b != null && b > a) {
        c.hourStart = a;
        c.hourEnd = b;
        understood.push(`Between ${M.fmt.hour(a)} and ${M.fmt.hour(b)}`);
      }
    } else if ((tm = /\bafter\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|noon)/.exec(t))) {
      const h = tm[1] === 'noon' ? 12 : parseHour(tm[1]);
      if (h != null) {
        c.hourStart = h;
        understood.push(`After ${M.fmt.hour(h)}`);
      }
    } else if ((tm = /\bbefore\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|noon)/.exec(t))) {
      const h = tm[1] === 'noon' ? 12 : parseHour(tm[1]);
      if (h != null) {
        c.hourEnd = h;
        understood.push(`Before ${M.fmt.hour(h)}`);
      }
    } else if ((tm = /\bat\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/.exec(t))) {
      const h = parseHour(tm[1]);
      if (h != null) {
        c.hourStart = h;
        c.hourEnd = Math.min(24, h + c.durationMin / 60);
        understood.push(`Starting at ${M.fmt.hour(h)}`);
      }
    } else if (/\bmornings?\b/.test(t)) {
      c.hourStart = 8;
      c.hourEnd = 12;
      understood.push('Morning');
    } else if (/\bafternoons?\b/.test(t)) {
      c.hourStart = 12;
      c.hourEnd = 17;
      understood.push('Afternoon');
    } else if (/\bevenings?\b|\bnight\b/.test(t)) {
      c.hourStart = 17;
      c.hourEnd = 22;
      understood.push('Evening');
    }
    if (c.hourEnd - c.hourStart < c.durationMin / 60) c.hourEnd = Math.min(24, c.hourStart + c.durationMin / 60);
    c.prefStart = Math.max(c.prefStart, c.hourStart);
    c.prefEnd = Math.min(c.prefEnd, c.hourEnd);
    if (c.prefEnd - c.prefStart < c.durationMin / 60) {
      c.prefStart = c.hourStart;
      c.prefEnd = c.hourEnd;
    }

    // --- roles: "need two tablers", "with a greeter and 2 setup crew"
    const seen = new Set();
    const addRole = (name, n) => {
      if (seen.has(name)) return;
      seen.add(name);
      const tpl = M.ROLE_TEMPLATES[name] || { headcount: 1, required: true, offsetMin: 0, durationMin: null, anchor: 'start' };
      c.roles.push({ name, ...tpl, headcount: n || tpl.headcount });
    };
    const numRe = '(a|an|one|two|three|four|five|six|seven|eight|nine|ten|\\d+)';
    const roleRe = new RegExp(
      `\\b${numRe}\\s+(tablers?|tabling|greeters?|set\\s?-?up(?:\\s+crew)?|clean\\s?-?up(?:\\s+crew)?|food\\s+pick\\s?-?ups?|food\\s+runners?|pick\\s?-?ups?)\\b`,
      'g'
    );
    let rm;
    while ((rm = roleRe.exec(t))) {
      const name = roleFromWord(rm[2].replace(/\s+/g, ' '));
      if (name) addRole(name, NUM[rm[1]] || parseInt(rm[1], 10));
    }
    const needRe = /\bneed(?:s)?\s+(a|an|one|two|three|four|five|six|\d+)\s+([a-z][a-z ]{2,18}?)(?=\s+(?:on|at|for|by|this|next|tomorrow|today|in|from|after|before|and|to)\b|[,.]|\s*$)/g;
    const rest = t.replace(new RegExp(roleRe.source, 'g'), ' ');
    while ((rm = needRe.exec(rest))) {
      const word = rm[2].replace(new RegExp(`\\b${DAYRE}\\b`, 'g'), '').trim();
      if (!word) continue;
      const name = roleFromWord(word) || M.titleCase(word.replace(/s$/, ''));
      if (!/\b(people|members|volunteers?|officers?|hours?|minutes?)\b/.test(word)) addRole(name, NUM[rm[1]] || parseInt(rm[1], 10));
    }
    if (c.roles.length) {
      understood.push('Roles: ' + c.roles.map((r) => `${r.name} ×${r.headcount}`).join(', '));
    }

    // --- title guess
    let title = c.mode === 'officers' ? 'Officer meeting' : 'Event';
    const tt = /\b(social|workshop|meeting|mixer|fundraiser|tabling|fair|potluck|game night|study session|cleanup|service project|retreat|party|bake sale)\b/.exec(t);
    if (tt) title = M.titleCase(tt[1]);
    if (c.mode === 'event' && c.roles.some((r) => r.name === 'Tabling') && !tt) title = 'Tabling';

    return { constraints: c, understood, title };
  };

  /* ---------------------------------------------------------------- free-text status -> availability */
  M.AI.parseStatus = function (text, now) {
    now = now || Date.now();
    const t = ' ' + text.toLowerCase() + ' ';
    const blocks = [];
    const notes = [];
    const today0 = M.startOfDay(now);
    const dow = new Date(now).getDay();
    const hourToMs = (h, base) => base + Math.round(h * 60) * MIN;

    let m;
    if ((m = /\b(?:busy|in class|studying|working|at work|out|away|in a meeting|in lab|at practice|exam|unavailable|swamped)\b[^.]*?\buntil\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/.exec(t))) {
      const h = parseHour(m[1]);
      if (h != null) {
        let end = hourToMs(h, today0);
        if (end <= now) end += DAY;
        blocks.push([now, end, 'status']);
        notes.push(`busy until ${M.fmt.time(end)}`);
      }
    }
    if ((m = /\b(?:free|available|around|back)\s+(?:again\s+)?after\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/.exec(t))) {
      const h = parseHour(m[1]);
      const end = h != null ? hourToMs(h, today0) : 0;
      if (end > now) {
        blocks.push([now, end, 'status']);
        notes.push(`busy until ${M.fmt.time(end)}`);
      }
    }
    const negRe = new RegExp(`\\b(?:out of town|traveling|travelling|away|can'?t(?: do)?|cannot(?: do)?|busy|unavailable|not free|no|gone|off campus)\\s+(?:on\\s+|this\\s+|next\\s+|for\\s+|the\\s+)*((?:${DAYRE}|weekend)(?:\\s*(?:,|and|&)\\s*(?:${DAYRE}|weekend))*)`, 'g');
    let nm;
    while ((nm = negRe.exec(t))) {
      const nextWeek = /next\s+$/.test(nm[0].replace(nm[1], '').trim() + ' ') || /\bnext\b/.test(nm[0]);
      nm[1].split(/\s*(?:,|and|&)\s*/).forEach((w) => {
        const days = w.trim() === 'weekend' ? [6, 0] : DAYWORDS[w.trim()] !== undefined ? [DAYWORDS[w.trim()]] : [];
        days.forEach((d) => {
          let delta = (d - dow + 7) % 7;
          if (nextWeek) delta += delta < 7 ? 7 : 0;
          const start = today0 + delta * DAY;
          blocks.push([Math.max(start, now), start + DAY, 'status']);
          notes.push(`unavailable ${M.DAY_NAMES[d]}`);
        });
      });
    }
    if ((m = new RegExp(`\\bback\\s+(?:on\\s+)?(${DAYRE})\\b`).exec(t))) {
      const d = DAYWORDS[m[1]];
      const delta = ((d - dow + 7) % 7) || 7;
      blocks.push([now, today0 + delta * DAY, 'status']);
      notes.push(`away until ${M.DAY_NAMES[d]}`);
    }
    return { blocks: M.mergeIntervals(blocks.map((b) => [b[0], b[1]])), notes: [...new Set(notes)] };
  };

  /* ---------------------------------------------------------------- nudges */
  const NUDGE_TEMPLATES = [
    (n, ev, role, when) => `Hey ${n}! ${ev.title} could use a ${role.name} (${when}). You look free then — want to claim it?`,
    (n, ev, role, when) => `Hi ${n} 👋 we're still looking for a ${role.name} for ${ev.title} on ${when}. It'd mean a lot if you could jump in!`,
    (n, ev, role, when) => `${n}, quick favor: ${role.name} spot open for ${ev.title} (${when}). Your schedule looks clear — can you take it?`,
  ];

  /** Draft friendly nudges for open roles. Returns drafts only; a human must send them. */
  M.AI.draftNudges = function (state, ev, forUserId) {
    const drafts = [];
    const used = new Set();
    let i = 0;
    for (const role of ev.roles) {
      const open = role.headcount - role.claims.length;
      if (open <= 0) continue;
      const [s, e] = M.roleShift(ev, role);
      const cands = M.candidatesForRole(state, ev, role).filter((x) => x.id !== forUserId && !used.has(x.id));
      cands.slice(0, Math.max(open, 1) + 1).forEach((cd) => {
        used.add(cd.id);
        const u = state.users[cd.id];
        const when = `${M.fmt.day(s)}, ${M.fmt.time(s)}–${M.fmt.time(e)}`;
        drafts.push({
          userId: cd.id,
          roleId: role.id,
          eventId: ev.id,
          text: NUDGE_TEMPLATES[i++ % NUDGE_TEMPLATES.length](M.firstName(u.name), ev, role, when),
        });
      });
    }
    return drafts;
  };

  /* ---------------------------------------------------------------- chat summaries */
  M.AI.summarize = function (state, messages) {
    const real = messages.filter((m) => m.userId && m.source !== 'assistant');
    if (real.length < 2) return { headline: 'Not much to summarize yet — the chat is quiet.', decisions: [], questions: [], people: [] };
    const nameOf = (m) => M.firstName((state.users[m.userId] || {}).name || 'Someone');
    const decisions = [];
    const questions = [];
    const decRe = /\b(let'?s|we('?ll| will| should| are going to)|decided|agreed|sounds good|confirmed|going with|i('?ll| will| can) (take|do|bring|handle)|booked|reserved)\b/i;
    for (const m of real.slice(-60)) {
      const sentences = m.text.split(/(?<=[.!?])\s+/);
      for (const s of sentences) {
        if (s.trim().endsWith('?') && s.length > 12) questions.push(`${nameOf(m)}: ${s.trim()}`);
        else if (decRe.test(s) && s.length > 10) decisions.push(`${nameOf(m)}: ${s.trim()}`);
      }
    }
    const people = [...new Set(real.map(nameOf))];
    const span = real[real.length - 1].ts - real[0].ts;
    return {
      headline: `${real.length} messages from ${M.joinNames(people)} over ${span > 2 * HOUR ? Math.round(span / HOUR) + ' hours' : Math.max(1, Math.round(span / MIN)) + ' minutes'}.`,
      decisions: decisions.slice(-5),
      questions: questions.slice(-4),
      people,
    };
  };

  /* ---------------------------------------------------------------- officer handoff */
  M.AI.handoff = function (state, orgId) {
    const org = state.orgs[orgId];
    const evs = Object.values(state.events).filter((e) => e.orgId === orgId);
    const past = evs.filter((e) => e.status !== 'cancelled' && e.end < Date.now());
    const cancelled = evs.filter((e) => e.status === 'cancelled');
    const flares = Object.values(state.flares).filter((f) => evs.some((e) => e.id === f.eventId));
    const notes = state.guestbook.filter((g) => evs.some((e) => e.id === g.eventId));
    const lines = [];
    const members = Object.keys(org.members).length;
    lines.push(`# ${org.name} — officer handoff (${new Date().toLocaleDateString([], { month: 'long', year: 'numeric' })})`);
    lines.push('');
    lines.push('## By the numbers');
    lines.push(`- ${members} members, ${Object.values(org.members).filter((m) => m.role !== 'Member').length} officers`);
    lines.push(`- ${past.length} events held, ${evs.filter((e) => e.end >= Date.now() && e.status !== 'cancelled').length} upcoming, ${cancelled.length} cancelled`);
    const att = past.map((e) => (e.attendance || []).length).filter((n) => n > 0);
    if (att.length) lines.push(`- Average check-in attendance: ${Math.round(att.reduce((a, b) => a + b, 0) / att.length)} (best: ${Math.max(...att)})`);
    lines.push(`- ${flares.length} role flares sent; ${flares.filter((f) => f.status === 'claimed').length} were backfilled by a member`);

    // Participation leaders
    const counts = {};
    past.forEach((e) => (e.attendance || []).forEach((id) => (counts[id] = (counts[id] || 0) + 1)));
    evs.forEach((e) => e.roles.forEach((r) => r.claims.forEach((id) => (counts[id] = (counts[id] || 0) + 0.5))));
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id]) => state.users[id] && M.firstName(state.users[id].name)).filter(Boolean);
    if (top.length) lines.push(`- Most engaged: ${M.joinNames(top)}`);

    // Roles that were hardest to fill
    const hard = {};
    flares.forEach((f) => {
      const ev = state.events[f.eventId];
      const role = ev && ev.roles.find((r) => r.id === f.roleId);
      if (role) hard[role.name] = (hard[role.name] || 0) + 1;
    });
    const hardest = Object.entries(hard).sort((a, b) => b[1] - a[1]);
    if (hardest.length) {
      lines.push('');
      lines.push('## Hardest roles to fill');
      hardest.slice(0, 3).forEach(([n, k]) => lines.push(`- ${n}: dropped/reopened ${k} time(s) — recruit backups early`));
    }

    // Lessons from guestbook
    const lessonRe = /\b(next time|should|tip|remember|vendor|room|deadline|book|reserve|order|bring|forgot|need(ed)? more|ran out|worked (well|great)|loved)\b/i;
    const lessons = notes.filter((g) => lessonRe.test(g.text)).slice(-6);
    lines.push('');
    lines.push('## What we learned (from the guestbook)');
    if (lessons.length) {
      lessons.forEach((g) => {
        const ev = state.events[g.eventId];
        lines.push(`- ${g.text.trim()} — ${M.firstName((state.users[g.userId] || {}).name)}, after “${ev ? ev.title : 'an event'}”`);
      });
    } else lines.push('- No lessons recorded yet. Ask members to sign the guestbook after each event.');

    lines.push('');
    lines.push('## Event log');
    evs
      .sort((a, b) => a.start - b.start)
      .forEach((e) => {
        const loc = e.location ? ` @ ${e.location}` : '';
        lines.push(`- ${M.fmt.day(e.start)} — ${e.title}${loc} [${e.status}${e.attendance && e.attendance.length ? `, ${e.attendance.length} attended` : ''}]`);
      });
    return lines.join('\n');
  };

  /* ---------------------------------------------------------------- optional Gemini upgrade */
  // The Gemini key lives in the server's .env (GEMINI_API_KEY); the browser never sees it.
  // The check runs while heavy page scripts are still loading, so retry a few times on failure.
  let llmOn = false;
  M.AI.llmEnabled = () => llmOn;
  M.AI.checkLLM = async (tries = 4) => {
    for (let i = 0; i < tries; i++) {
      try {
        const r = await fetch('/api/ai/status', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
        if (!r.ok) throw new Error('status ' + r.status);
        const on = !!(await r.json()).enabled;
        if (llmOn !== on) {
          llmOn = on;
          if (M.render) M.render();
        }
        return llmOn;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1500 * (i + 1)));
      }
    }
    return llmOn;
  };
  const llmReady = M.AI.checkLLM();

  async function ai(path, body) {
    const res = await fetch('/api/ai/' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) throw new Error('Gemini error ' + res.status);
    return res.json();
  }

  /** parseRequest with an optional Gemini pass layered on top of the rule-based result. */
  M.AI.parseRequestSmart = async function (text, ctx) {
    const base = M.AI.parseRequest(text, ctx);
    if (!(await llmReady) && !M.AI.llmEnabled()) return base;
    try {
      const j = (await ai('parse', { text })).result || {};
      const c = base.constraints;
      if (j.mode === 'officers' || j.mode === 'event') c.mode = j.mode;
      if (j.durationMin > 0) c.durationMin = Math.min(600, j.durationMin);
      if (Array.isArray(j.days) && j.days.length) c.days = j.days.filter((d) => d >= 0 && d <= 6);
      if (typeof j.hourStart === 'number') c.hourStart = j.hourStart;
      if (typeof j.hourEnd === 'number') c.hourEnd = j.hourEnd;
      if (Array.isArray(j.roles) && j.roles.length) {
        c.roles = j.roles.map((r) => ({
          name: M.titleCase(String(r.name)),
          ...(M.ROLE_TEMPLATES[M.titleCase(String(r.name))] || { required: true, offsetMin: 0, durationMin: null, anchor: 'start' }),
          headcount: Math.max(1, r.headcount | 0 || 1),
        }));
      }
      base.title = j.title || base.title;
      base.understood.push('✨ refined by Gemini');
    } catch (e) {
      /* fall back silently to the rule-based parse */
    }
    return base;
  };

  M.AI.polish = async function (text, instruction) {
    if (!(await llmReady) && !M.AI.llmEnabled()) return text;
    try {
      return (await ai('polish', { text, instruction })).text || text;
    } catch {
      return text;
    }
  };
})();
