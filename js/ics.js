/* Meadow — .ics parser.
 * Converts a calendar file into anonymous busy intervals. Titles, locations and
 * attendees are read only to decide whether an event blocks time, and are never stored.
 * Supports DTSTART/DTEND/DURATION, TZID, all-day (ignored), TRANSP:TRANSPARENT (ignored),
 * RRULE (DAILY/WEEKLY+BYDAY/MONTHLY/YEARLY, INTERVAL, COUNT, UNTIL) and EXDATE.
 */
(function () {
  const M = window.Meadow;
  const { MIN, DAY } = M;

  M.mergeIntervals = (list) => {
    const sorted = list.filter((x) => x[1] > x[0]).sort((a, b) => a[0] - b[0]);
    const out = [];
    for (const [s, e] of sorted) {
      const last = out[out.length - 1];
      if (last && s <= last[1]) last[1] = Math.max(last[1], e);
      else out.push([s, e]);
    }
    return out;
  };

  function tzOffset(ms, tz) {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const p = {};
    dtf.formatToParts(new Date(ms)).forEach((x) => (p[x.type] = x.value));
    const asUTC = Date.UTC(p.year, p.month - 1, p.day, Number(p.hour) % 24, p.minute, p.second);
    return asUTC - Math.floor(ms / 1000) * 1000;
  }

  function zonedToUtc(y, mo, d, h, mi, s, tz) {
    const guess = Date.UTC(y, mo - 1, d, h, mi, s);
    const off = tzOffset(guess, tz);
    let r = guess - off;
    const off2 = tzOffset(r, tz);
    if (off2 !== off) r = guess - off2;
    return r;
  }

  function unfold(text) {
    return text.replace(/\r\n|\r/g, '\n').replace(/\n[ \t]/g, '');
  }

  function splitProp(line) {
    // NAME;PARAM=v;PARAM2="v:2":VALUE  (first colon outside quotes)
    let inQ = false;
    let idx = -1;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') inQ = !inQ;
      else if (c === ':' && !inQ) {
        idx = i;
        break;
      }
    }
    if (idx < 0) return null;
    const head = line.slice(0, idx).split(';');
    const params = {};
    head.slice(1).forEach((p) => {
      const [k, v] = p.split('=');
      if (k) params[k.toUpperCase()] = (v || '').replace(/"/g, '');
    });
    return { name: head[0].toUpperCase(), params, value: line.slice(idx + 1).trim() };
  }

  /** Parse a DATE or DATE-TIME. Returns {parts, kind, tz, allDay, ms}. */
  function parseDate(value, params) {
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value);
    if (!m) return null;
    const [, y, mo, d, hh, mi, ss, z] = m;
    const parts = [+y, +mo, +d, +(hh || 0), +(mi || 0), +(ss || 0)];
    const allDay = hh === undefined || params.VALUE === 'DATE';
    let kind = 'local';
    let tz = null;
    if (z) kind = 'utc';
    else if (params.TZID) {
      kind = 'tz';
      tz = params.TZID;
    }
    return { parts, kind, tz, allDay, ms: toMs(parts, kind, tz) };
  }

  function toMs(parts, kind, tz) {
    const [y, mo, d, h, mi, s] = parts;
    if (kind === 'utc') return Date.UTC(y, mo - 1, d, h, mi, s);
    if (kind === 'tz') {
      try {
        return zonedToUtc(y, mo, d, h, mi, s, tz);
      } catch {
        /* unknown tz name (e.g. Windows zone names) — fall through to local */
      }
    }
    return new Date(y, mo - 1, d, h, mi, s).getTime();
  }

  function parseDuration(v) {
    const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v);
    if (!m) return null;
    const sign = m[1] === '-' ? -1 : 1;
    return (
      sign *
      ((+m[2] || 0) * 7 * DAY +
        (+m[3] || 0) * DAY +
        (+m[4] || 0) * 3600000 +
        (+m[5] || 0) * 60000 +
        (+m[6] || 0) * 1000)
    );
  }

  const WD = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

  function parseRRule(v) {
    const r = {};
    v.split(';').forEach((kv) => {
      const [k, val] = kv.split('=');
      if (k) r[k.toUpperCase()] = val;
    });
    return r;
  }

  /** Expand one recurring event into [start,end] pairs that intersect [winS, winE]. */
  function expand(ev, winS, winE) {
    const out = [];
    const dur = ev.duration;
    const push = (startMs) => {
      if (ev.exdates.has(startMs)) return;
      if (startMs + dur < winS || startMs > winE) return;
      out.push([startMs, startMs + dur]);
    };
    if (!ev.rrule) {
      push(ev.start.ms);
      return out;
    }
    const r = ev.rrule;
    const interval = Math.max(1, parseInt(r.INTERVAL || '1', 10));
    const count = r.COUNT ? parseInt(r.COUNT, 10) : Infinity;
    let until = Infinity;
    if (r.UNTIL) {
      const u = parseDate(r.UNTIL, {});
      if (u) until = u.allDay ? u.ms + DAY : u.ms;
    }
    const { parts, kind, tz } = ev.start;
    const [y, mo, d, hh, mi, ss] = parts;
    const mk = (Y, Mo, D) => toMs([Y, Mo, D, hh, mi, ss], kind, tz);
    const base = Date.UTC(y, mo - 1, d); // used only for calendar arithmetic
    const dateOf = (utcMs) => {
      const x = new Date(utcMs);
      return [x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate()];
    };
    let n = 0;
    const limit = Math.min(until, winE);
    const accept = (ms) => {
      if (ms < ev.start.ms) return true; // before series start: skip but continue
      if (ms > until) return false;
      n++;
      if (n > count) return false;
      push(ms);
      return ms <= limit;
    };

    const freq = r.FREQ;
    if (freq === 'DAILY') {
      for (let i = 0; i < 4000; i++) {
        const ms = mk(...dateOf(base + i * interval * DAY));
        if (!accept(ms)) break;
      }
    } else if (freq === 'WEEKLY') {
      const days = (r.BYDAY ? r.BYDAY.split(',') : [Object.keys(WD)[new Date(base).getUTCDay()]])
        .map((s) => WD[s.slice(-2)])
        .filter((x) => x !== undefined)
        .sort((a, b) => a - b);
      const startDow = new Date(base).getUTCDay();
      const weekStart = base - ((startDow + 6) % 7) * DAY; // Monday of the first week
      outer: for (let w = 0; w < 700; w++) {
        for (const dow of days) {
          const offset = (dow + 6) % 7; // Monday-based
          const ms = mk(...dateOf(weekStart + (w * interval * 7 + offset) * DAY));
          if (ms < ev.start.ms) continue;
          if (!accept(ms)) break outer;
        }
      }
    } else if (freq === 'MONTHLY') {
      for (let i = 0; i < 240; i++) {
        const x = new Date(Date.UTC(y, mo - 1 + i * interval, d));
        if (x.getUTCDate() !== d) continue; // skip months without that day
        if (!accept(mk(x.getUTCFullYear(), x.getUTCMonth() + 1, d))) break;
      }
    } else if (freq === 'YEARLY') {
      for (let i = 0; i < 40; i++) {
        if (!accept(mk(y + i * interval, mo, d))) break;
      }
    } else {
      push(ev.start.ms);
    }
    return out;
  }

  /**
   * @returns {{blocks:number[][], events:number, skipped:number}}
   *  blocks: merged [startMs,endMs] busy intervals (anonymous)
   */
  M.parseICS = function (text, opts) {
    opts = opts || {};
    const winS = opts.from || Date.now() - DAY;
    const winE = opts.to || Date.now() + 120 * DAY;
    const lines = unfold(text).split('\n');
    const events = [];
    let cur = null;
    let skipped = 0;
    for (const raw of lines) {
      const line = raw.trimEnd();
      if (line === 'BEGIN:VEVENT') {
        cur = { exdates: new Set(), transparent: false, cancelled: false };
        continue;
      }
      if (line === 'END:VEVENT') {
        if (cur && cur.start && !cur.start.allDay) {
          if (cur.transparent || cur.cancelled) skipped++;
          else {
            if (cur.duration == null) {
              if (cur.end) cur.duration = cur.end.ms - cur.start.ms;
              else cur.duration = 0;
            }
            if (cur.duration > 0) events.push(cur);
          }
        } else skipped++;
        cur = null;
        continue;
      }
      if (!cur) continue;
      const p = splitProp(line);
      if (!p) continue;
      switch (p.name) {
        case 'DTSTART':
          cur.start = parseDate(p.value, p.params);
          break;
        case 'DTEND':
          cur.end = parseDate(p.value, p.params);
          break;
        case 'DURATION':
          cur.duration = parseDuration(p.value);
          break;
        case 'RRULE':
          cur.rrule = parseRRule(p.value);
          break;
        case 'EXDATE':
          p.value.split(',').forEach((v) => {
            const d = parseDate(v.trim(), p.params);
            if (d) cur.exdates.add(d.ms);
          });
          break;
        case 'TRANSP':
          cur.transparent = p.value.toUpperCase() === 'TRANSPARENT';
          break;
        case 'STATUS':
          cur.cancelled = p.value.toUpperCase() === 'CANCELLED';
          break;
        default:
      }
    }
    let blocks = [];
    for (const ev of events) blocks = blocks.concat(expand(ev, winS, winE));
    return { blocks: M.mergeIntervals(blocks), events: events.length, skipped };
  };

  M.INTERVAL_MIN = MIN;
})();
