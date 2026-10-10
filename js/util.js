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
          el.addEventListener(k.slice(2).toLowerCase(), v);
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

  /* Dewey, the assistant: a cropped close-up of the Meadow2 flowers + butterfly so it reads at avatar size. */
  M.deweySvg = (size) => {
    const wrap = document.createElement('span');
    wrap.className = 'dewey';
    wrap.style.width = wrap.style.height = (size || 36) + 'px';
    wrap.setAttribute('aria-hidden', 'true');
    return wrap;
  };
})();