/* Meadow — Eyey the flower.
   Eyey is planted in the grass at the bottom of the login screen. Hover (or tap, or press Enter on) him and he
   burrows down into the grass, stays under for a moment, then pops up somewhere else along the grass.
   Self-contained: builds its own element, so full re-renders of #app never touch it. */
(function () {
  const BURROW_MS = 750;   // dive animation (keep in sync with css/eyey.css)
  const RISE_MS = 800;     // pop-up animation
  const UNDER_MIN = 600;   // time spent underground, min + random extra
  const UNDER_EXTRA = 500;

  const el = document.createElement('button');
  el.type = 'button';
  el.id = 'fx-eyey';
  el.className = 'eyey is-hidden';
  el.setAttribute('aria-label', 'Eyey the flower. Hover over him and he burrows into the grass and pops up somewhere else.');
  el.innerHTML =
    '<span class="eyey-clip"><span class="eyey-sway"><img class="eyey-img" src="Assets/EYEY2.png" alt="" draggable="false" width="62" height="80"></span></span>' +
    '<span class="eyey-mound"></span><span class="eyey-hole"></span>' +
    '<span class="eyey-say" role="status" aria-live="polite"></span>' +
    '<span class="eyey-puffs"><i></i><i></i><i></i><i></i><i></i><i></i></span>';

  let busy = true;

  /* Eyey talks a little: one short line each time he pops up, like a buddy-list pop-up. */
  const LINES = [
    'Psst. New here? Make an account and I’ll help your org find a meeting time.',
    'Hover me and I’ll hop somewhere else.',
    'Officers: I keep track of which jobs still need a person.',
  ];
  const PRIVACY = 'I only ever see when you’re busy, never what you’re doing.';
  const say = el.querySelector('.eyey-say');
  let line = 0, sayTimer = 0;
  function speak(text, ms) {
    if (busy || el.classList.contains('is-hidden') || document.documentElement.dataset.view !== 'login') return;
    clearTimeout(sayTimer);
    say.textContent = text;
    // Open toward whichever side has more room, never wider than that room, and stay quiet rather than cover the sign-in window.
    const half = (el.offsetWidth || 93) / 2, roomRight = window.innerWidth - spotX - half - 18, roomLeft = spotX - half - 18;
    say.dataset.side = roomRight >= roomLeft ? 'right' : 'left';
    say.style.maxWidth = Math.max(120, Math.min(220, Math.max(roomRight, roomLeft))) + 'px';
    el.classList.add('is-talking');
    const card = document.querySelector('.login-card');
    const a = say.getBoundingClientRect(), c = card && card.getBoundingClientRect();
    if (c && a.right > c.left && a.left < c.right && a.bottom > c.top && a.top < c.bottom) return hush();
    sayTimer = setTimeout(hush, ms || 6000);
  }
  function hush() { clearTimeout(sayTimer); el.classList.remove('is-talking'); }
  let spotX = null; // current centre x in px

  /* Pick a spot in the grass that stays clear of the sign-in card, the left effect buttons and the status chip. */
  function pickSpot(avoidX) {
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = el.offsetWidth || 93, h = el.offsetHeight || 120;
    const card = document.querySelector('.login-card');
    const cr = card && card.getBoundingClientRect();
    const maxBottom = Math.max(30, Math.min(90, vw * 0.12));
    const room = vw - w - 120 - 230;
    if (room > 0) {
      for (let i = 0; i < 60; i++) {
        const bottom = 14 + Math.random() * (maxBottom - 14);
        const cx = w / 2 + 120 + Math.random() * room;
        if (avoidX != null && Math.abs(cx - avoidX) < vw * 0.16) continue;
        const l = cx - w / 2, r = cx + w / 2, b = vh - bottom, t = b - h;
        if (cr && r > cr.left - 14 && l < cr.right + 14 && b > cr.top - 14 && t < cr.bottom + 14) continue;
        return { cx, bottom };
      }
    }
    return { cx: Math.max(w, vw * 0.3), bottom: 24 };
  }

  function plant(spot) {
    spotX = spot.cx;
    el.style.left = spot.cx + 'px';
    el.style.bottom = spot.bottom + 'px';
  }

  function rise(done) {
    el.classList.remove('is-hidden');
    el.classList.add('is-rising');
    setTimeout(() => {
      el.classList.remove('is-rising');
      busy = false;
      speak(LINES[line++ % LINES.length]);
      if (done) done();
    }, RISE_MS);
  }

  function burrow() {
    if (busy) return;
    hush();
    busy = true;
    el.classList.add('is-burrowing');
    setTimeout(() => {
      el.classList.remove('is-burrowing');
      el.classList.add('is-hidden');
      setTimeout(() => {
        plant(pickSpot(spotX));
        rise();
      }, UNDER_MIN + Math.random() * UNDER_EXTRA);
    }, BURROW_MS);
  }

  el.addEventListener('pointerenter', burrow);
  // The privacy promise, right when someone is deciding whether to sign up.
  document.addEventListener('pointerover', (e) => {
    if (e.target.closest && e.target.closest('.switch-mode .link-btn, #signup-password')) speak(PRIVACY, 5000);
  });
  el.addEventListener('click', burrow); // touch taps and keyboard (Enter / Space)

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    // Replant once he is above ground again, so a resize mid-animation never strands him off-screen.
    const replant = () => { if (busy) resizeTimer = setTimeout(replant, 300); else { hush(); plant(pickSpot(null)); } };
    resizeTimer = setTimeout(replant, 150);
  });

  function start() {
    document.body.appendChild(el);
    plant(pickSpot(null));
    // Planted a moment after the page loads, so he doesn't compete with the logo montage.
    setTimeout(() => rise(), 1400);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
