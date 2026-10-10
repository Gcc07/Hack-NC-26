/* Meadow — Frutiger Aero effects layer.
   Sky (Vanta clouds) · rolling hills · sun glare · rising bubbles (tsParticles) · 3D soap bubbles (Three.js)
   · entrance + burst animation (GSAP) · tilt/glare cards (vanilla-tilt) · UI sounds (Howler).

   Every effect is optional: if a library or WebGL is missing, Meadow still works with its CSS gradient sky.
   The app re-renders #app from scratch on each store update, so scenery lives outside #app and per-render
   enhancements (tilt, entrances) are re-applied from the M.render wrapper at the bottom of this file. */
(function () {
  const M = window.Meadow;
  const $ = (sel, root) => (root || document).querySelector(sel);
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const warn = (what, e) => console.warn('[meadow fx] ' + what + ' unavailable:', (e && e.message) || e);

  const pref = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(key);
        return v == null ? fallback : v === '1';
      } catch { return fallback; }
    },
    set(key, on) {
      try { localStorage.setItem(key, on ? '1' : '0'); } catch { /* private mode */ }
    },
  };

  const fx = (M.fx = { visual: pref.get('meadow:fx', !reduced), sound: pref.get('meadow:sfx', true), reduced });

  /* ================================================================== sounds (Howler) */
  const VOLUME = { click: 0.35, bloop: 0.5, pop: 0.5, chime: 0.45, welcome: 0.55 };
  const sounds = {};
  if (window.Howl) {
    for (const [name, volume] of Object.entries(VOLUME)) sounds[name] = new Howl({ src: ['Assets/sounds/' + name + '.wav'], volume, preload: true });
  }
  const lastPlayed = {};
  fx.play = function (name) {
    const s = sounds[name];
    if (!fx.sound || !s) return;
    const now = performance.now();
    if (now - (lastPlayed[name] || 0) < 70) return; // never machine-gun a sound
    lastPlayed[name] = now;
    const id = s.play();
    s.rate(0.94 + Math.random() * 0.14, id); // slight pitch variety keeps repeats from feeling robotic
  };

  /* ================================================================== sky: Vanta clouds */
  let sky = null;
  function startSky() {
    if (sky || !window.VANTA || !window.THREE) return;
    try {
      sky = VANTA.CLOUDS({
        el: '#fx-sky',
        mouseControls: false, touchControls: false, gyroControls: false,
        minHeight: 200, minWidth: 200,
        skyColor: 0x2c8fe4, cloudColor: 0x9cc3ef, cloudShadowColor: 0x2c5f9a,
        sunColor: 0xffd070, sunGlareColor: 0xffa84d, sunlightColor: 0xffd89a,
        speed: reduced ? 0 : 0.7,
        scale: Math.max(1, (window.devicePixelRatio || 1) / 0.6), // render at ~0.6x: clouds are soft, and this keeps laptops cool
        scaleMobile: 2,
      });
    } catch (e) { warn('cloud sky', e); sky = null; }
  }
  function stopSky() {
    if (sky) { try { sky.destroy(); } catch { /* already gone */ } sky = null; }
  }

  /* ================================================================== hills (static SVG, gentle sway) */
  function buildHills() {
    const el = $('#fx-hills');
    if (!el) return;
    el.innerHTML =
      '<svg viewBox="0 0 1440 320" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">' +
      '<defs>' +
      '<linearGradient id="hill-a" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#a6ec8c"/><stop offset="1" stop-color="#55c84c"/></linearGradient>' +
      '<linearGradient id="hill-b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6fd656"/><stop offset="1" stop-color="#2f9e2f"/></linearGradient>' +
      '<linearGradient id="hill-c" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3dba3a"/><stop offset="1" stop-color="#137224"/></linearGradient>' +
      '</defs>' +
      '<g class="hill h1"><path d="M-40,180 C240,110 480,230 720,170 C960,110 1200,200 1480,140 L1480,320 L-40,320Z" fill="url(#hill-a)" opacity=".85"/>' +
      '<path d="M-40,180 C240,110 480,230 720,170 C960,110 1200,200 1480,140" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width="2"/></g>' +
      '<g class="hill h2"><path d="M-40,230 C200,190 420,270 700,225 C980,180 1200,260 1480,215 L1480,320 L-40,320Z" fill="url(#hill-b)"/>' +
      '<path d="M-40,230 C200,190 420,270 700,225 C980,180 1200,260 1480,215" fill="none" stroke="#fff" stroke-opacity=".4" stroke-width="2"/></g>' +
      '<g class="hill h3"><path d="M-40,275 C260,245 520,300 820,270 C1100,240 1300,295 1480,265 L1480,320 L-40,320Z" fill="url(#hill-c)"/></g>' +
      '</svg>';
  }

  /* ================================================================== rising bubbles: tsParticles */
  const TINTS = ['120,220,255', '150,235,170', '205,175,255', '255,255,255'];
  function bubbleSprite(tint) {
    const svg =
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><defs>" +
      "<radialGradient id='b'><stop offset='55%' stop-color='rgb(" + tint + ")' stop-opacity='0.05'/><stop offset='85%' stop-color='rgb(" + tint + ")' stop-opacity='0.4'/><stop offset='100%' stop-color='white' stop-opacity='0.95'/></radialGradient>" +
      "<radialGradient id='h'><stop offset='0' stop-color='white' stop-opacity='.95'/><stop offset='1' stop-color='white' stop-opacity='0'/></radialGradient></defs>" +
      "<circle cx='50' cy='50' r='48' fill='url(#b)' stroke='white' stroke-opacity='.6' stroke-width='1.5'/>" +
      "<ellipse cx='33' cy='27' rx='15' ry='8' fill='url(#h)' transform='rotate(-35 33 27)'/>" +
      "<ellipse cx='68' cy='76' rx='9' ry='4.5' fill='url(#h)' opacity='.6' transform='rotate(-35 68 76)'/></svg>";
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  let bubbles = null;
  let bubblesLoading = false;
  let particlePlugins = null;
  async function startBubbles() {
    if (bubbles || bubblesLoading || !window.tsParticles) return;
    bubblesLoading = true;
    try {
      // tsParticles v4 needs its plugin bundle registered once, before the first load().
      if (!particlePlugins) particlePlugins = window.loadFull ? loadFull(tsParticles) : Promise.resolve();
      await particlePlugins;
      const c = await tsParticles.load({
        id: 'fx-bubbles',
        options: {
          fullScreen: { enable: false },
          background: { color: 'transparent' },
          fpsLimit: 45,
          detectRetina: false,
          particles: {
            number: { value: 11, limit: { value: 16, mode: 'delete' } },
            opacity: { value: { min: 0.35, max: 0.85 } },
            size: { value: { min: 10, max: 52 } },
            shape: {
              type: 'image',
              options: { image: TINTS.map((t) => ({ src: bubbleSprite(t), width: 100, height: 100, replaceColor: false })) },
            },
            move: {
              enable: true, direction: 'top', speed: { min: 0.35, max: 1.2 }, straight: false,
              outModes: { default: 'out' },
            },
            wobble: { enable: true, distance: 14, speed: { min: -2, max: 2 } },
          },
          interactivity: {
            detectsOn: 'window',
            events: { onHover: { enable: true, mode: 'repulse' } }, // no click-spawning: it cluttered the working screens
            modes: { repulse: { distance: 110, duration: 0.5 } },
          },
        },
      });
      if (!fx.visual) c && c.destroy(); else bubbles = c;
    } catch (e) { warn('bubbles', e); } finally { bubblesLoading = false; }
  }
  function stopBubbles() {
    if (bubbles) { try { bubbles.destroy(); } catch { /* ignore */ } bubbles = null; }
  }

  /* ================================================================== 3D soap bubbles: Three.js */
  const orbs = { running: false, raf: 0, list: [], renderer: null, scene: null, camera: null, uniforms: { uTime: { value: 0 }, uMul: { value: 1 } }, mouse: { x: 0, y: 0, nx: 0, ny: 0 }, halfW: 6, halfH: 3.6, last: 0, slow: 0 };
  const ORB_COUNT = 3;

  const ORB_VERT = [
    'uniform float uTime; uniform float uSeed; uniform float uPop;',
    'varying vec3 vN; varying vec3 vV;',
    'void main(){',
    '  vec3 p = position + normal * (0.035 * sin(uTime*1.6 + position.y*4.0 + uSeed*6.28) + 0.03 * uPop);',
    '  vN = normalize(normalMatrix * normal);',
    '  vec4 mv = modelViewMatrix * vec4(p, 1.0);',
    '  vV = normalize(-mv.xyz);',
    '  gl_Position = projectionMatrix * mv;',
    '}',
  ].join('\n');
  const ORB_FRAG = [
    'uniform float uTime; uniform float uSeed; uniform float uFade; uniform float uMul;',
    'varying vec3 vN; varying vec3 vV;',
    'void main(){',
    '  vec3 n = normalize(vN); vec3 v = normalize(vV);',
    '  float ndv = clamp(dot(n, v), 0.0, 1.0);',
    '  float fres = pow(1.0 - ndv, 2.2);',
    '  float film = ndv * 2.2 + uSeed + uTime * 0.07;',                       // thin-film interference hue shift
    '  vec3 irid = mix(vec3(1.0), 0.5 + 0.5 * cos(6.28318 * (film + vec3(0.0, 0.33, 0.67))), 0.85);',
    '  vec3 L = normalize(vec3(-0.5, 0.7, 0.6));',
    '  float spec = pow(max(dot(reflect(-L, n), v), 0.0), 38.0);',             // sun glint
    '  float win = smoothstep(0.86, 0.985, dot(n, normalize(vec3(-0.42, 0.58, 0.7))));', // soft window reflection
    '  vec3 col = irid * fres * 0.95 + vec3(1.0) * (spec * 1.2 + win * 0.4) + vec3(0.55, 0.85, 1.0) * 0.05;',
    '  float a = clamp(fres * 0.62 + spec + win * 0.4 + 0.03, 0.0, 0.7) * uFade * uMul;',
    '  gl_FragColor = vec4(col, a);',
    '}',
  ].join('\n');

  function respawn(o, anywhere) {
    o.r = 0.22 + Math.random() * 0.45;
    o.x = (Math.random() * 2 - 1) * orbs.halfW;
    o.y = anywhere ? (Math.random() * 2 - 1) * orbs.halfH : -orbs.halfH - o.r - Math.random() * 2;
    o.z = -1.5 + Math.random() * 2.5;
    o.vx = 0; o.vy = 0;
    o.rise = 0.12 + Math.random() * 0.22;
    o.phase = Math.random() * 6.28;
    o.pop = -1;
    o.mesh.material.uniforms.uSeed.value = Math.random();
    o.mesh.material.uniforms.uFade.value = 1;
    o.mesh.material.uniforms.uPop.value = 0;
  }

  function sizeOrbs() {
    const r = orbs.renderer;
    if (!r) return;
    const w = window.innerWidth, h = window.innerHeight;
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    r.setSize(w, h, false);
    orbs.camera.aspect = w / h;
    orbs.camera.updateProjectionMatrix();
    orbs.halfH = Math.tan((orbs.camera.fov * Math.PI) / 360) * orbs.camera.position.z;
    orbs.halfW = orbs.halfH * orbs.camera.aspect;
  }

  function initOrbs() {
    if (orbs.renderer || !window.THREE) return !!orbs.renderer;
    const canvas = $('#fx-orbs');
    try {
      orbs.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    } catch (e) { warn('3D bubbles (WebGL)', e); orbs.renderer = null; return false; }
    orbs.renderer.setClearColor(0x000000, 0);
    orbs.scene = new THREE.Scene();
    orbs.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 50);
    orbs.camera.position.z = 10;
    const geo = new THREE.SphereGeometry(1, 48, 32);
    for (let i = 0; i < ORB_COUNT; i++) {
      const mat = new THREE.ShaderMaterial({
        vertexShader: ORB_VERT, fragmentShader: ORB_FRAG, transparent: true, depthWrite: false,
        uniforms: { uTime: orbs.uniforms.uTime, uMul: orbs.uniforms.uMul, uSeed: { value: 0 }, uFade: { value: 1 }, uPop: { value: 0 } },
      });
      const mesh = new THREE.Mesh(geo, mat);
      orbs.scene.add(mesh);
      orbs.list.push({ mesh });
    }
    sizeOrbs();
    orbs.list.forEach((o) => respawn(o, true));
    window.addEventListener('resize', sizeOrbs);
    window.addEventListener('pointermove', (e) => {
      orbs.mouse.nx = (e.clientX / window.innerWidth) * 2 - 1;
      orbs.mouse.ny = -((e.clientY / window.innerHeight) * 2 - 1);
    }, { passive: true });
    return true;
  }

  function stepOrbs(dt) {
    const m = orbs.mouse;
    m.x += (m.nx - m.x) * Math.min(1, dt * 3);
    m.y += (m.ny - m.y) * Math.min(1, dt * 3);
    orbs.camera.position.x = m.x * 0.5;
    orbs.camera.position.y = m.y * 0.3;
    orbs.camera.lookAt(0, 0, 0);
    const cx = m.nx * orbs.halfW, cy = m.ny * orbs.halfH; // cursor in world space (z = 0 plane)
    for (const o of orbs.list) {
      if (o.pop >= 0) { // popping: swell + fade, then reborn at the bottom
        o.pop += dt / 0.28;
        o.mesh.material.uniforms.uFade.value = Math.max(0, 1 - o.pop);
        o.mesh.material.uniforms.uPop.value = o.pop;
        if (o.pop >= 1) respawn(o, false);
      } else {
        const dx = o.x - cx, dy = o.y - cy, d2 = dx * dx + dy * dy, reach = 1.4 + o.r;
        if (d2 < reach * reach && d2 > 1e-4) { // bubbles drift away from the cursor
          const d = Math.sqrt(d2), f = (1 - d / reach) * 2.2;
          o.vx += (dx / d) * f * dt * 6; o.vy += (dy / d) * f * dt * 6;
        }
        o.vx *= 1 - Math.min(1, dt * 1.6); o.vy *= 1 - Math.min(1, dt * 1.6);
        o.x += (o.vx + Math.sin(performance.now() / 1700 + o.phase) * 0.12) * dt;
        o.y += (o.vy + o.rise) * dt;
        if (o.y - o.r > orbs.halfH + 0.5) respawn(o, false);
      }
      const s = o.r * (o.pop >= 0 ? 1 + o.pop * 0.35 : 1);
      o.mesh.position.set(o.x, o.y, o.z);
      o.mesh.scale.setScalar(s);
    }
  }

  function loopOrbs(now) {
    if (!orbs.running) return;
    orbs.raf = requestAnimationFrame(loopOrbs);
    if (document.hidden) { orbs.last = 0; return; }
    const dt = orbs.last ? Math.min(0.05, (now - orbs.last) / 1000) : 0.016;
    const raw = orbs.last ? now - orbs.last : 16;
    orbs.last = now;
    orbs.uniforms.uTime.value += dt;
    stepOrbs(dt);
    orbs.renderer.render(orbs.scene, orbs.camera);
    // Watchdog: on a struggling machine, shed the heaviest effect (the cloud shader) instead of stuttering.
    orbs.slow = raw > 45 ? orbs.slow + 1 : Math.max(0, orbs.slow - 1);
    if (orbs.slow > 90 && sky) { stopSky(); orbs.slow = 0; console.info('[meadow fx] slow frames detected — switched to the static sky'); }
  }
  function startOrbs() {
    if (orbs.running || !initOrbs()) return;
    orbs.running = true;
    orbs.last = 0;
    $('#fx-orbs').style.display = '';
    orbs.raf = requestAnimationFrame(loopOrbs);
  }
  function stopOrbs() {
    orbs.running = false;
    cancelAnimationFrame(orbs.raf);
    const c = $('#fx-orbs');
    if (c) c.style.display = 'none';
  }

  // Clicking a floating 3D bubble pops it.
  function tryPop(clientX, clientY) {
    // Inside the app the 3D bubbles sit behind the panels, so clicks there must never pop (or sound off for) hidden ones.
    if (!orbs.running || document.documentElement.dataset.view === 'app') return false;
    const wx = (clientX / window.innerWidth * 2 - 1) * orbs.halfW, wy = -(clientY / window.innerHeight * 2 - 1) * orbs.halfH;
    for (const o of orbs.list) {
      if (o.pop >= 0) continue;
      const dx = o.x - wx, dy = o.y - wy;
      const reach = o.r * (1 + (o.z + 1.5) * 0.02) + 0.25;
      if (dx * dx + dy * dy < reach * reach) { o.pop = 0; return true; }
    }
    return false;
  }

  /* ================================================================== visual on/off */
  function applyVisual() {
    document.documentElement.classList.toggle('fx-off', !fx.visual);
    const b = $('#fx-toggle-visual');
    if (b) { b.setAttribute('aria-pressed', String(fx.visual)); b.classList.toggle('off', !fx.visual); }
    if (fx.visual) {
      startSky(); // frozen (speed 0) under reduced motion
      if (!reduced) { startBubbles(); startOrbs(); } // the moving layers stay off for people who asked for less motion
    } else { stopSky(); stopBubbles(); stopOrbs(); }
  }
  function applySound() {
    const b = $('#fx-toggle-sound');
    if (b) { b.setAttribute('aria-pressed', String(fx.sound)); b.classList.toggle('off', !fx.sound); b.textContent = fx.sound ? '🔊' : '🔇'; }
  }
  fx.setVisual = (on) => { fx.visual = !!on; pref.set('meadow:fx', fx.visual); applyVisual(); };
  fx.setSound = (on) => { fx.sound = !!on; pref.set('meadow:sfx', fx.sound); applySound(); if (fx.sound) fx.play('bloop'); };

  /* ================================================================== GSAP: bursts + entrances */
  const INTERACTIVE = '.btn, .rail-btn, .tab, .seg-btn, button.chip, a.chip, .buddy, .channel, .org-card, .event-card, .profile, .fx-btn, .x-btn, .brand, summary';

  function burst(x, y, count) {
    if (reduced || !window.gsap) return;
    const layer = $('#fx-burst');
    for (let i = 0; i < count; i++) {
      const b = document.createElement('i');
      const size = 6 + Math.random() * 14;
      b.style.cssText = 'left:' + x + 'px;top:' + y + 'px;width:' + size + 'px;height:' + size + 'px';
      layer.append(b);
      const a = Math.random() * Math.PI * 2, dist = 24 + Math.random() * 60;
      gsap.fromTo(b, { x: 0, y: 0, scale: 0.3, opacity: 0.95 }, {
        x: Math.cos(a) * dist, y: Math.sin(a) * dist - 30 - Math.random() * 50, scale: 1 + Math.random() * 0.6, opacity: 0,
        duration: 0.7 + Math.random() * 0.5, ease: 'power2.out', onComplete: () => b.remove(),
      });
    }
  }

  document.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    const popped = tryPop(e.clientX, e.clientY);
    const interactive = !!(e.target.closest && e.target.closest(INTERACTIVE));
    if (popped) { burst(e.clientX, e.clientY, 9); fx.play('pop'); }
    else if (interactive) burst(e.clientX, e.clientY, 3);
  }, true);

  document.addEventListener('click', (e) => {
    const t = e.target.closest ? e.target.closest(INTERACTIVE) : null;
    if (!t) return;
    fx.play(t.matches('.btn.primary, .btn.glossy-green') ? 'bloop' : 'click');
  }, true);

  const ENTER_ITEMS = '.window .card, .window .org-card, .window .event-card, .window .result, .window .member, .window .flare-card, .window .role';
  function enter(root) {
    if (reduced || !window.gsap) return;
    const q = (s) => root.querySelectorAll(s);
    const heroes = q('.login-hero > *');
    if (heroes.length) gsap.from(heroes, { x: -46, opacity: 0, duration: 0.8, stagger: 0.09, ease: 'back.out(1.5)', clearProps: 'all' });
    const card = q('.login-card');
    if (card.length) gsap.from(card, { x: 60, opacity: 0, scale: 0.94, duration: 0.85, delay: 0.15, ease: 'back.out(1.4)', clearProps: 'all' });
    const rail = q('.rail-btn');
    if (rail.length) gsap.from(rail, { scale: 0, opacity: 0, duration: 0.55, stagger: 0.05, ease: 'back.out(2.6)', clearProps: 'all' });
    const win = q('.window');
    if (win.length) gsap.from(win, { y: 16, opacity: 0, duration: 0.45, ease: 'power2.out', clearProps: 'all' });
    const items = Array.from(q(ENTER_ITEMS)).slice(0, 16);
    if (items.length) gsap.from(items, { y: 22, opacity: 0, scale: 0.97, duration: 0.55, delay: 0.12, stagger: 0.055, ease: 'back.out(1.4)', clearProps: 'all' });
  }

  /* ================================================================== vanilla-tilt on clickable cards */
  function tilt(root) {
    if (reduced || !window.VanillaTilt) return;
    const els = root.querySelectorAll('.org-card, .event-card, .logo-tilt');
    if (els.length) VanillaTilt.init(els, { max: 7, speed: 450, scale: 1.03, glare: true, 'max-glare': 0.35, gyroscope: false });
  }

  /* ================================================================== newest chat messages pop in */
  const chatCounts = new Map();
  function chatPop(root, key) {
    if (reduced || !window.gsap) return;
    const log = root.querySelector('.chat-log');
    if (!log) return;
    const n = log.children.length, prev = chatCounts.get(key);
    chatCounts.set(key, n);
    if (prev != null && n > prev) {
      gsap.from(Array.from(log.children).slice(prev), { y: 16, opacity: 0, scale: 0.96, duration: 0.4, ease: 'back.out(2)', clearProps: 'all' });
    }
  }

  /* ================================================================== hooks into the app */
  const SUCCESS = /(created|joined|saved|loaded|copied|sent|claimed|confirmed|added|connected|welcome)/i;
  const toast = M.toast;
  M.toast = function (text) {
    fx.play(SUCCESS.test(String(text)) ? 'chime' : 'bloop');
    return toast.apply(this, arguments);
  };
  const afterLogin = M.afterLogin;
  M.afterLogin = function () {
    fx.play('welcome');
    return afterLogin.apply(this, arguments);
  };

  let lastKey = null;
  const baseRender = M.render;
  M.render = function () {
    const out = baseRender.apply(this, arguments);
    try {
      const root = document.getElementById('app');
      const me = M.me && M.store.ready() ? M.me() : null;
      const key = JSON.stringify(M.ui.route) + (M.ui.channel || '') + '|' + (M.store.ready() ? (me ? me.id : 'anon') : 'wait');
      const fresh = key !== lastKey;
      lastKey = key;
      document.documentElement.dataset.view = me ? 'app' : 'login';
      orbs.uniforms.uMul.value = me ? 0.85 : 1; // in the app the 3D bubbles live behind the panels (see css: data-view="app")
      tilt(root);
      if (fresh) enter(root); else chatPop(root, key);
    } catch (e) { warn('enhancements', e); }
    return out;
  };

  /* ================================================================== boot */
  $('#fx-toggle-visual').addEventListener('click', () => fx.setVisual(!fx.visual));
  $('#fx-toggle-sound').addEventListener('click', () => fx.setSound(!fx.sound));
  buildHills();
  applySound();
  applyVisual();
})();
