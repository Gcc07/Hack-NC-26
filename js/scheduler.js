/* Meadow — deterministic scheduling engine.
 * Normalised busy intervals -> candidate slots -> scored, explained, ranked suggestions.
 * No AI in here: the assistant only builds the `constraints` object and narrates results.
 */
(function () {
  const M = window.Meadow;
  const { MIN, DAY } = M;

  /* Typical shifts for event roles. offsetMin is relative to event start (or end if anchor='end'). */
  M.ROLE_TEMPLATES = {
    Setup: { headcount: 2, required: true, offsetMin: -60, durationMin: 60, anchor: 'start' },
    Tabling: { headcount: 2, required: true, offsetMin: 0, durationMin: null, anchor: 'start' },
    'Food pickup': { headcount: 1, required: true, offsetMin: -45, durationMin: 45, anchor: 'start' },
    Greeter: { headcount: 1, required: true, offsetMin: 0, durationMin: 60, anchor: 'start' },
    Cleanup: { headcount: 2, required: false, offsetMin: 0, durationMin: 30, anchor: 'end' },
  };

  M.roleShift = (ev, role) => {
    const base = role.anchor === 'end' ? ev.end : ev.start;
    const s = base + (role.offsetMin || 0) * MIN;
    const len = role.durationMin ? role.durationMin * MIN : ev.end - ev.start;
    return [s, s + len];
  };

  M.userIntervals = (state, uid, excludeEventId) => {
    const u = state.users[uid];
    if (!u) return [];
    const out = [];
    (u.busy || []).forEach((b) => out.push([b[0], b[1]]));
    (u.statusBusy || []).forEach((b) => out.push([b[0], b[1]]));
    for (const ev of Object.values(state.events)) {
      if (ev.status === 'cancelled' || ev.id === excludeEventId) continue;
      for (const r of ev.roles) if (r.claims.includes(uid)) out.push(M.roleShift(ev, r));
    }
    return M.mergeIntervals(out);
  };

  M.isFree = (iv, s, e) => {
    let lo = 0;
    let hi = iv.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (iv[mid][1] <= s) lo = mid + 1;
      else hi = mid;
    }
    return lo >= iv.length || iv[lo][0] >= e;
  };

  M.hasShared = (user) => !!(user && user.calendar);

  /** Members of an org whose availability is known (they imported a calendar). */
  M.knownMembers = (state, org) =>
    Object.keys(org.members).filter((id) => M.hasShared(state.users[id]));

  /* ---------- role coverage: can enough distinct, free people cover each shift? ---------- */
  function assignRoles(roleShifts, known, ivs) {
    const items = roleShifts.map((rs) => ({
      ...rs,
      cands: known.filter((id) => M.isFree(ivs[id], rs.s, rs.e)),
      assigned: [],
    }));
    const order = items.slice().sort((a, b) => a.cands.length / a.headcount - b.cands.length / b.headcount);
    const taken = {}; // uid -> [[s,e]]
    for (const it of order) {
      for (const id of it.cands) {
        if (it.assigned.length >= it.headcount) break;
        const clash = (taken[id] || []).some(([s, e]) => s < it.e && e > it.s);
        if (clash) continue;
        it.assigned.push(id);
        (taken[id] = taken[id] || []).push([it.s, it.e]);
      }
    }
    return items;
  }

  /**
   * constraints: {
   *   orgId, mode:'officers'|'event', durationMin, from, to,
   *   days:[0..6], hourStart, hourEnd, prefStart, prefEnd, bufferMin,
   *   roles:[{name, headcount, required, offsetMin, durationMin, anchor}],
   *   requiredIds:[], excludeEventId, minAttendees, limit
   * }
   */
  M.suggest = function (state, c) {
    const org = state.orgs[c.orgId];
    if (!org) return { results: [], stats: { considered: 0, known: 0, unknown: 0 } };
    const memberIds = Object.keys(org.members);
    const known = M.knownMembers(state, org);
    const unknown = memberIds.filter((id) => !known.includes(id));
    const officers = memberIds.filter((id) => M.isOfficer(org, id));
    const required = c.mode === 'officers' ? officers : c.requiredIds || [];
    const ivs = {};
    known.forEach((id) => (ivs[id] = M.userIntervals(state, id, c.excludeEventId)));

    const dur = c.durationMin * MIN;
    const buf = (c.bufferMin == null ? 15 : c.bufferMin) * MIN;
    const prefStart = c.prefStart == null ? 10 : c.prefStart;
    const prefEnd = c.prefEnd == null ? 21 : c.prefEnd;
    const days = c.days && c.days.length ? c.days : [0, 1, 2, 3, 4, 5, 6];
    const roles = c.roles || [];
    const needed = roles.filter((r) => r.required).reduce((a, r) => a + r.headcount, 0);
    const earliest = Math.max(c.from || Date.now(), Date.now() + 30 * MIN);
    const names = (ids) => ids.map((id) => M.firstName(state.users[id].name));

    const all = [];
    let considered = 0;
    const day = new Date(M.startOfDay(c.from || Date.now()));
    const last = c.to || Date.now() + 14 * DAY;
    for (let guard = 0; day.getTime() < last && guard < 200; guard++, day.setDate(day.getDate() + 1)) {
      if (!days.includes(day.getDay())) continue;
      for (let mins = c.hourStart * 60; mins + c.durationMin <= c.hourEnd * 60; mins += 30) {
        const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, mins).getTime();
        const end = start + dur;
        if (start < earliest || end > last + DAY) continue;
        considered++;

        const free = known.filter((id) => M.isFree(ivs[id], start, end));
        const missingReq = required.filter((id) => known.includes(id) && !free.includes(id));
        if (missingReq.length) continue;
        if (free.length < (c.minAttendees || 1)) continue;

        const busy = known.filter((id) => !free.includes(id));
        const bufferOk = free.filter((id) => M.isFree(ivs[id], start - buf, end + buf)).length;

        const shifts = roles.map((r) => {
          const [s, e] = M.roleShift({ start, end }, r);
          return { name: r.name, headcount: r.headcount, required: r.required, s, e };
        });
        const cover = assignRoles(shifts, known, ivs);
        const covered = cover.filter((x) => x.required).reduce((a, x) => a + Math.min(x.assigned.length, x.headcount), 0);

        const startH = new Date(start).getHours() + new Date(start).getMinutes() / 60;
        const endH = startH + c.durationMin / 60;
        const pref = startH >= prefStart && endH <= prefEnd ? 1 : 0.4;
        const attend = known.length ? free.length / known.length : 0;
        const coverage = needed ? covered / needed : 1;
        const buffer = free.length ? bufferOk / free.length : 0;

        const w = needed ? { a: 0.4, c: 0.3, p: 0.15, b: 0.15 } : { a: 0.6, c: 0, p: 0.25, b: 0.15 };
        const score = 100 * (w.a * attend + w.c * coverage + w.p * pref + w.b * buffer);

        const reasons = [];
        reasons.push(
          `${free.length} of ${known.length} members free` +
            (busy.length && busy.length <= 3 ? ` (${M.joinNames(names(busy))} busy)` : '')
        );
        if (c.mode === 'officers') reasons.push(`All ${officers.length} officers are free`);
        if (needed) {
          const gaps = cover.filter((x) => x.required && x.assigned.length < x.headcount);
          if (!gaps.length) reasons.push(`All required roles coverable (${covered}/${needed} spots)`);
          else
            reasons.push(
              `Role gaps: ` + gaps.map((g) => `${g.name} ${g.assigned.length}/${g.headcount}`).join(', ')
            );
        }
        reasons.push(
          pref === 1
            ? `Inside preferred hours (${M.fmt.hour(prefStart)}–${M.fmt.hour(prefEnd)})`
            : `Outside preferred hours (${M.fmt.hour(prefStart)}–${M.fmt.hour(prefEnd)})`
        );
        reasons.push(
          bufferOk === free.length
            ? `Everyone has a ${Math.round(buf / MIN)}-minute buffer`
            : `${free.length - bufferOk} attendee(s) have back-to-back commitments`
        );
        if (unknown.length) reasons.push(`${M.plural(unknown.length, 'member')} haven't shared availability yet`);

        all.push({
          start,
          end,
          score: Math.round(score),
          attendees: free,
          busy,
          unknown,
          coverage: {
            ratio: coverage,
            roles: cover.map((x) => ({
              name: x.name,
              headcount: x.headcount,
              required: x.required,
              s: x.s,
              e: x.e,
              assigned: x.assigned,
            })),
          },
          breakdown: { attend, coverage, pref, buffer },
          reasons,
        });
      }
    }

    all.sort((a, b) => b.score - a.score || a.start - b.start);
    const picked = [];
    const perDay = {};
    const limit = c.limit || 6;
    for (const cand of all) {
      if (picked.length >= limit) break;
      const k = M.startOfDay(cand.start);
      if ((perDay[k] || 0) >= 2) continue;
      if (picked.some((p) => p.start < cand.end && p.end > cand.start)) continue;
      picked.push(cand);
      perDay[k] = (perDay[k] || 0) + 1;
    }
    return { results: picked, stats: { considered, known: known.length, unknown: unknown.length } };
  };

  /** Free-people heatmap: rows = hours, cols = days. */
  M.availGrid = function (state, orgId, firstDayMs, ndays, h0, h1) {
    const org = state.orgs[orgId];
    const known = M.knownMembers(state, org);
    const ivs = {};
    known.forEach((id) => (ivs[id] = M.userIntervals(state, id)));
    const cols = [];
    for (let d = 0; d < ndays; d++) {
      const dayMs = M.addDays(firstDayMs, d);
      const cells = [];
      for (let h = h0; h < h1; h++) {
        const dt = new Date(dayMs);
        const s = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate(), h).getTime();
        const e = s + 3600000;
        const free = known.filter((id) => M.isFree(ivs[id], s, e));
        cells.push({ h, s, e, free });
      }
      cols.push({ dayMs, cells });
    }
    return { cols, total: known.length };
  };

  /** Who could fill an open role? Free during the shift; least-loaded first. */
  M.candidatesForRole = function (state, ev, role) {
    const org = state.orgs[ev.orgId];
    const [s, e] = M.roleShift(ev, role);
    const now = Date.now();
    const out = [];
    for (const id of M.knownMembers(state, org)) {
      if (role.claims.includes(id)) continue;
      const iv = M.userIntervals(state, id, ev.id);
      // Already holding an overlapping role in this same event?
      const clash = ev.roles.some((r) => {
        if (r.id === role.id || !r.claims.includes(id)) return false;
        const [rs, re] = M.roleShift(ev, r);
        return rs < e && re > s;
      });
      if (clash || !M.isFree(iv, s, e)) continue;
      let load = 0;
      for (const o of Object.values(state.events)) {
        if (o.status === 'cancelled' || o.end < now) continue;
        o.roles.forEach((r) => r.claims.includes(id) && load++);
      }
      out.push({ id, load });
    }
    return out.sort((a, b) => a.load - b.load || state.users[a.id].name.localeCompare(state.users[b.id].name));
  };

  M.eventProgress = (ev) => {
    const req = ev.roles.filter((r) => r.required);
    const need = req.reduce((a, r) => a + r.headcount, 0);
    const have = req.reduce((a, r) => a + Math.min(r.claims.length, r.headcount), 0);
    return { need, have, open: need - have, ratio: need ? have / need : 1 };
  };

  M.recomputeStatus = (ev) => {
    if (ev.status === 'cancelled') return;
    ev.status = M.eventProgress(ev).open === 0 ? 'confirmed' : 'pending';
  };
})();
