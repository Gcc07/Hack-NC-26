/* Meadow — shared helpers (DOM builder, time formatting, small utilities) */
(function () {
  const M = (window.Meadow = window.Meadow || {});

  M.MIN = 60000;
  M.HOUR = 3600000;
  M.DAY = 86400000;

  M.uid = (prefix) =>
    prefix + '_' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);

  /* ---------- tiny DOM builder (no innerHTML => no XSS from chat text) ---------- */
  M.h = function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    let value;
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k.length > 2 && k.startsWith('on') && typeof v === 'function')
          el.addEventListener(k.slice(2).toLowerCase(), (event) => {
            try {
              const result = v(event);
              if (result && typeof result.catch === 'function') result.catch(e => M.toast(e.message));
            } catch (e) { M.toast(e.message); }
          });
        else if (k === 'value') value = v;
        else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, v);
      }
    }
    const add = (kid) => {
      if (kid == null || kid === false || kid === true) return;
      if (Array.isArray(kid)) kid.forEach(add);
      else el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    };
    kids.forEach(add);
    if (value !== undefined) el.value = value;
    return el;
  };

  /* ---------- time helpers ---------- */
  const pad = (n) => String(n).padStart(2, '0');
  M.startOfDay = (ms) => {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  M.addDays = (ms, n) => {
    const d = new Date(ms);
    d.setDate(d.getDate() + n);
    return d.getTime();
  };
  M.fmt = {
    time: (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
    day: (ms) =>
      new Date(ms).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }),
    dayLong: (ms) =>
      new Date(ms).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }),
    range: (s, e) => `${M.fmt.day(s)} · ${M.fmt.time(s)} – ${M.fmt.time(e)}`,
    dateInput: (ms) => {
      const d = new Date(ms);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    },
    timeInput: (ms) => {
      const d = new Date(ms);
      return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    },
    hour: (h) => {
      const hh = Math.floor(h) % 24;
      const suffix = hh >= 12 ? 'pm' : 'am';
      const h12 = hh % 12 === 0 ? 12 : hh % 12;
      return h12 + suffix;
    },
    ago: (ms) => {
      const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
      if (s < 45) return 'just now';
      if (s < 3600) return Math.round(s / 60) + 'm ago';
      if (s < 86400) return Math.round(s / 3600) + 'h ago';
      return Math.round(s / 86400) + 'd ago';
    },
    chatTime: (ms) => {
      const sameDay = M.startOfDay(ms) === M.startOfDay(Date.now());
      return sameDay ? M.fmt.time(ms) : M.fmt.day(ms) + ' ' + M.fmt.time(ms);
    },
  };
  M.parseLocal = (dateStr, timeStr) => {
    const [y, mo, d] = dateStr.split('-').map(Number);
    const [hh, mm] = (timeStr || '00:00').split(':').map(Number);
    return new Date(y, mo - 1, d, hh, mm, 0, 0).getTime();
  };
  M.DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  M.DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  /* ---------- misc ---------- */
  M.initials = (name) =>
    (name || '?')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((s) => s[0].toUpperCase())
      .join('');
  M.firstName = (name) => (name || 'friend').split(/\s+/)[0];
  M.hashHue = (str) => {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
    return h % 360;
  };
  M.plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + 's'}`;
  M.titleCase = (s) => s.replace(/\b([a-z])/g, (m) => m.toUpperCase());
  M.joinNames = (names) => {
    if (names.length <= 1) return names.join('');
    if (names.length === 2) return names.join(' and ');
    return names.slice(0, -1).join(', ') + ', and ' + names[names.length - 1];
  };
  // Seeded PRNG so the demo looks the same every time it is created for a given user.
  M.rng = (seed) => {
    let s = seed >>> 0 || 1;
    return () => {
      s ^= s << 13;
      s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5;
      s >>>= 0;
      return (s % 100000) / 100000;
    };
  };

  M.avatar = (user, size) => {
    const name = user ? user.name : '?';
    const hue = M.hashHue(name);
    return M.h(
      'span',
      {
        class: 'avatar' + (user && user.placeholder ? ' placeholder' : ''),
        style: {
          width: (size || 32) + 'px',
          height: (size || 32) + 'px',
          fontSize: Math.round((size || 32) * 0.4) + 'px',
          background: `radial-gradient(circle at 30% 25%, hsl(${hue} 90% 85%), hsl(${hue} 65% 50%))`,
        },
        'aria-hidden': 'true',
        title: name,
      },
      M.initials(name)
    );
  };

  M.toast = (text) => {
    const root = document.getElementById('toast-root');
    if (!root) return;
    const t = M.h('div', { class: 'toast', role: 'status' }, text);
    root.append(t);
    setTimeout(() => t.classList.add('out'), 3200);
    setTimeout(() => t.remove(), 3700);
  };

  M.copyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      M.toast('Copied to clipboard');
    } catch {
      window.prompt('Copy this:', text);
    }
  };

  M.download = (filename, text, type) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: type || 'text/plain' }));
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  /* Brand + assistant artwork (Meadow1.png = solid logo, Meadow2.png = outlined variant used for Dewey). */
  M.logo = (size) => {
    const img = document.createElement('img');
    img.className = 'logo-img';
    img.src = 'Assets/Meadow1.png';
    img.alt = 'Meadow';
    img.width = img.height = size || 40;
    return img;
  };

  /* Dewey, the assistant: his flower portrait (Assets/dewey.png) in a round avatar; see .dewey in aero.css. */
  M.deweySvg = (size) => {
    const wrap = document.createElement('span');
    wrap.className = 'dewey';
    wrap.style.width = wrap.style.height = (size || 36) + 'px';
    wrap.setAttribute('aria-hidden', 'true');
    return wrap;
  };
})();

(function () {
  const M = window.Meadow;
  const art = {
    leaf: '<path d="M7 26C2 10 16 6 28 5c1 13-4 24-16 22" fill="#79bd47"/><path d="M7 29L23 11M12 23l-1-8m6 3l7-1" fill="none" stroke="#326b35" stroke-width="2"/>',
    calendar: '<rect x="5" y="7" width="24" height="23" rx="4" fill="#f7fcff"/><path d="M5 14V10q0-3 4-3h16q4 0 4 3v4" fill="#58aada"/><path d="M11 5v5m12-5v5" stroke="#315d83" stroke-width="3" stroke-linecap="round"/><path d="M11 19h3m5 0h3m-11 5h3m5 0h3" stroke="#5c86a5" stroke-width="2"/>',
    chat: '<rect x="4" y="8" width="26" height="19" rx="4" fill="#d8f2ff"/><path d="M5 10l12 10 12-10" fill="none" stroke="#5193b6" stroke-width="2"/><path d="M6 25l8-8m14 8l-8-8" stroke="#a1c5dc"/>',
    drop: '<path d="M17 3C14 10 6 16 6 22a11 11 0 0022 0c0-6-8-12-11-19" fill="#54b9e2"/><path d="M11 19q-3 7 4 8" fill="none" stroke="#e8fcff" stroke-width="3" stroke-linecap="round"/>',
    folder: '<path d="M3 10q0-4 4-4h8l4 4h9q3 0 3 4v14H3Z" fill="#d4ad49"/><path d="M3 15h28l-3 14H5Z" fill="#f3d875"/><path d="M15 24q-2-9 9-8 0 9-9 8" fill="#5e9e45"/>',
    people: '<circle cx="12" cy="11" r="5" fill="#83bf69"/><circle cx="24" cy="13" r="4" fill="#69b2d7"/><path d="M3 29v-5a9 9 0 0118 0v5" fill="#6ba958"/><path d="M21 29V19q10-2 10 10" fill="#5298bc"/>',
    flower: '<path d="M17 19v13m0-4q-10 0-10-7 9 0 10 7m0-2q8 0 9-6-8 0-9 6" fill="#72b555" stroke="#427843"/><g fill="#fff9d8" stroke="#e6c97b" stroke-width=".7"><ellipse cx="17" cy="9" rx="4" ry="7"/><ellipse cx="17" cy="19" rx="4" ry="7"/><ellipse cx="12" cy="14" rx="7" ry="4"/><ellipse cx="22" cy="14" rx="7" ry="4"/></g><circle cx="17" cy="14" r="4" fill="#f9ca49"/>'
  };
  M.icon = function (name, size = 24) {
    const wrap = M.h('span', { class: 'aero-icon icon-' + name, 'aria-hidden': 'true', style: { width: size + 'px', height: size + 'px' } });
    wrap.innerHTML = '<svg viewBox="0 0 34 34" xmlns="http://www.w3.org/2000/svg">' + (art[name] || art.leaf) + '<path d="M7 9Q15 3 26 9" fill="none" stroke="white" stroke-opacity=".55" stroke-width="2" stroke-linecap="round"/></svg>';
    return wrap;
  };
  M.gardenProgress = function (prog) {
    return M.h('div', { class: 'garden-progress' }, M.icon(prog.ratio >= 1 ? 'flower' : 'leaf', 36),
      M.h('div', { class: 'grow' }, M.h('div', { class: 'meter', role: 'progressbar', 'aria-label': 'Required role spots filled', 'aria-valuemin': 0, 'aria-valuemax': prog.need, 'aria-valuenow': prog.have }, M.h('i', { style: { width: Math.round(prog.ratio * 100) + '%' } })),
      M.h('small', null, `${prog.have} of ${prog.need} required spots filled`)));
  };
})();
