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

  const fx = (M.fx = { visual: pref.get('meadow:fx', !reduced), sound: pref.get('meadow:sfx', false), reduced });

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

  /* Smooth cursor avoidance for the small bubbles: the pointer is low-pass filtered, push strength fades in with a
     smoothstep curve, and each bubble's push velocity eases toward its target. No impulses, so nothing ever snaps. */
  const pointer = { x: -9999, y: -9999, sx: -9999, sy: -9999, seen: false };
  window.addEventListener('pointermove', (e) => {
    pointer.x = e.clientX; pointer.y = e.clientY;
    if (!pointer.seen) { pointer.seen = true; pointer.sx = e.clientX; pointer.sy = e.clientY; }
  }, { passive: true });

  /* Smooth the pointer for bubble avoidance; the landscape stays stationary. */
  let pointerRaf = 0;
  function smoothPointerLoop() {
    pointerRaf = requestAnimationFrame(smoothPointerLoop);
    if (!pointer.seen) return;
    const dt = 0.016;
    pointer.sx += (pointer.x - pointer.sx) * Math.min(1, dt * 8);
    pointer.sy += (pointer.y - pointer.sy) * Math.min(1, dt * 8);

  }
  const dodge = { raf: 0, last: 0, push: new WeakMap() };
  function dodgeLoop(now) {
    if (!bubbles) return;
    dodge.raf = requestAnimationFrame(dodgeLoop);
    if (document.hidden || !pointer.seen) { dodge.last = 0; return; }
    const dt = dodge.last ? Math.min(0.05, (now - dodge.last) / 1000) : 0.016;
    dodge.last = now;
    for (const p of bubbles.particles.filter(() => true)) {
      const v = dodge.push.get(p) || { x: 0, y: 0 };
      const r = p.getRadius ? p.getRadius() : 20;
      const dx = p.position.x - pointer.sx, dy = p.position.y - pointer.sy, d = Math.hypot(dx, dy), reach = r + 140;
      let tx = 0, ty = 0;
      if (d < reach && d > 0.5) {
        const t = 1 - d / reach, f = t * t * (3 - 2 * t) * 280; // px/s at the centre of the effect
        tx = (dx / d) * f; ty = (dy / d) * f;
      }
      const ease = Math.min(1, dt * 6);
      v.x += (tx - v.x) * ease; v.y += (ty - v.y) * ease;
      p.position.x += v.x * dt; p.position.y += v.y * dt;
      dodge.push.set(p, v);
    }
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
          fpsLimit: 60,
          detectRetina: false,
          particles: {
            number: { value: 8, limit: { value: 10, mode: 'delete' } },
            opacity: { value: { min: 0.3, max: 0.75 } },
            size: { value: { min: 8, max: 30 } },
            shape: {
              type: 'image',
              options: { image: TINTS.map((t) => ({ src: bubbleSprite(t), width: 100, height: 100, replaceColor: false })) },
            },
            move: {
              enable: true, direction: 'top', speed: { min: 0.35, max: 1.2 }, straight: false,
              outModes: { default: 'out' },
            },
            wobble: { enable: true, distance: 6, speed: { min: -1, max: 1 } },
          },
          // No built-in interactivity: tsParticles' repulse snaps bubbles on contact. We ease them away ourselves (below).
        },
      });
      if (!fx.visual) { c && c.destroy(); }
      else {
        bubbles = c;
        dodge.last = 0;
        dodge.raf = requestAnimationFrame(dodgeLoop);
        // Keep bubbles out of text right after tsParticles moves them and before it draws (same frame, no lag).
        // This runs after the cursor dodge too, so dodging can never push a bubble onto text.
        const ps = c.particles, update = ps && ps.update;
        if (typeof update === 'function') ps.update = function () { const out = update.apply(this, arguments); guardBubbles(); return out; };
        guardBubbles(); // the spawn positions are random; fix them before anyone sees them
      }
    } catch (e) { warn('bubbles', e); } finally { bubblesLoading = false; }
  }
  function stopBubbles() {
    cancelAnimationFrame(dodge.raf);
    if (bubbles) { try { bubbles.destroy(); } catch { /* ignore */ } bubbles = null; }
  }

  /* ================================================================== 3D soap bubbles: Three.js */
  const orbs = { running: false, raf: 0, list: [], renderer: null, scene: null, camera: null, uniforms: { uTime: { value: 0 }, uMul: { value: 1 } }, mouse: { x: 0, y: 0, nx: 0, ny: 0, cx: 0, cy: 0, seen: false }, halfW: 6, halfH: 3.6, last: 0, slow: 0 };
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
      const m = orbs.mouse;
      m.nx = (e.clientX / window.innerWidth) * 2 - 1;
      m.ny = -((e.clientY / window.innerHeight) * 2 - 1);
      if (!m.seen) { m.seen = true; m.cx = m.nx; m.cy = m.ny; } // start the smoothed cursor where the mouse is: no first-move kick
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
    orbs.camera.updateMatrixWorld(); // guardOrb projects with this frame's camera
    // Low-pass filtered cursor (world space, z = 0 plane): fast flicks of the mouse can't cause a sudden shove.
    if (m.seen) { m.cx += (m.nx - m.cx) * Math.min(1, dt * 8); m.cy += (m.ny - m.cy) * Math.min(1, dt * 8); }
    const cx = m.cx * orbs.halfW, cy = m.cy * orbs.halfH;
    for (const o of orbs.list) {
      if (o.pop >= 0) { // popping: swell + fade, then reborn at the bottom
        o.pop += dt / 0.28;
        o.mesh.material.uniforms.uFade.value = Math.max(0, 1 - o.pop);
        o.mesh.material.uniforms.uPop.value = o.pop;
        if (o.pop >= 1) respawn(o, false);
      } else {
        // Bubbles glide away from the cursor: push strength follows a smoothstep falloff and velocity eases toward it.
        const dx = o.x - cx, dy = o.y - cy, d2 = dx * dx + dy * dy, reach = 1.1 + o.r;
        let tvx = 0, tvy = 0;
        if (m.seen && d2 < reach * reach && d2 > 1e-4) {
          const d = Math.sqrt(d2), t = 1 - d / reach, f = t * t * (3 - 2 * t) * 1.1;
          tvx = (dx / d) * f; tvy = (dy / d) * f;
        }
        const ease = Math.min(1, dt * 3.5);
        o.vx += (tvx - o.vx) * ease; o.vy += (tvy - o.vy) * ease;
        o.x += (o.vx + Math.sin(performance.now() / 1700 + o.phase) * 0.12) * dt;
        o.y += (o.vy + o.rise) * dt;
        if (o.y - o.r > orbs.halfH + 0.5) respawn(o, false);
        else guardOrb(o);
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

  /* ================================================================== text keep-out zones
     Every visible piece of readable text (plus inputs) gets a box padded by TEXT_PAD px. Neither bubble layer is
     allowed to overlap a box: a bubble touching one is held at its edge and slid sideways around it; one that is
     deep inside (text appeared on top of it) or boxed in by a full-width zone is quietly respawned below the screen.
     Zones are recomputed at most every ZONE_MS while the page changes, and once a second regardless (animations). */
  const TEXT_PAD = 40, ZONE_MS = 200, SLIDE_PX = 3, DEEP_PX = 24;
  const ZONE_SKIP = 'script, style, noscript, template, [aria-hidden="true"]';
  const zones = { list: [], dirty: true, last: 0, running: false, raf: 0, overlay: null };

  function collectZones() {
    const W = window.innerWidth, H = window.innerHeight;
    const view = { l: 0, t: 0, r: W, b: H };
    const clips = new Map(); // element -> visible region after every overflow-clipping ancestor
    const clipOf = (el) => {
      if (!el || el === document.body || el === document.documentElement) return view;
      if (clips.has(el)) return clips.get(el);
      let c = clipOf(el.parentElement);
      const cs = getComputedStyle(el);
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
        const b = el.getBoundingClientRect();
        c = { l: Math.max(c.l, b.left), t: Math.max(c.t, b.top), r: Math.min(c.r, b.right), b: Math.min(c.b, b.bottom) };
      }
      clips.set(el, c);
      return c;
    };
    const visible = (el) => !el.closest(ZONE_SKIP) && (!el.checkVisibility || el.checkVisibility({ visibilityProperty: true }));
    const out = [];
    const add = (b, el) => {
      if (b.width < 2 || b.height < 2) return; // .sr-only text is 1px
      const c = clipOf(el);
      const l = Math.max(b.left, c.l), t = Math.max(b.top, c.t), r = Math.min(b.right, c.r), bt = Math.min(b.bottom, c.b);
      if (r - l < 1 || bt - t < 1) return; // scrolled out of its panel or off screen
      out.push({ l: l - TEXT_PAD, t: t - TEXT_PAD, r: r + TEXT_PAD, b: bt + TEXT_PAD });
    };
    const range = document.createRange();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (/\S/.test(n.data) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || !visible(el)) continue;
      range.selectNodeContents(n);
      for (const b of range.getClientRects()) add(b, el);
    }
    for (const el of document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea, select')) {
      if (visible(el)) add(el.getBoundingClientRect(), el);
    }
    // Drop boxes that sit entirely inside another box (lines of one paragraph mostly collapse into each other).
    out.sort((a, b) => (b.r - b.l) * (b.b - b.t) - (a.r - a.l) * (a.b - a.t));
    const kept = [];
    for (const z of out) if (!kept.some((k) => z.l >= k.l && z.t >= k.t && z.r <= k.r && z.b <= k.b)) kept.push(z);
    return kept;
  }

  function refreshZones(now) {
    if (!(zones.dirty && now - zones.last > ZONE_MS) && now - zones.last < 1000) return;
    zones.list = collectZones();
    zones.dirty = false;
    zones.last = now;
    if (zones.overlay) drawZones();
  }

  /** Keep a circle (screen px) out of every zone. Returns null when it is clear, or {x, y} / {respawn: true}. */
  function keepOut(x, y, r) {
    const W = window.innerWidth;
    let moved = false;
    for (let pass = 0; pass < 3; pass++) {
      let hit = false;
      for (const z of zones.list) {
        const nx = Math.min(Math.max(x, z.l), z.r) - x, ny = Math.min(Math.max(y, z.t), z.b) - y;
        if (nx * nx + ny * ny >= r * r) continue;
        hit = moved = true;
        const left = x + r - z.l, right = z.r - (x - r), up = y + r - z.t, down = z.b - (y - r);
        const depth = Math.min(left, right, up, down);
        if (depth > DEEP_PX) return { respawn: true };
        if (depth === left) x -= left;
        else if (depth === right) x += right;
        else {
          y += depth === up ? -up : down;
          // Held at the top/bottom edge: slide toward whichever side exit is closer and still on screen.
          const canL = z.l - r >= 0, canR = z.r + r <= W;
          if (!canL && !canR) return { respawn: true };
          const goLeft = canL && (!canR || left < right);
          x += goLeft ? -Math.min(SLIDE_PX, left) : Math.min(SLIDE_PX, right);
        }
      }
      if (!hit) break;
    }
    return moved ? { x, y } : null;
  }

  /** A spot just below the screen whose rising path starts outside every zone. */
  function freeX(r, y) {
    const W = window.innerWidth;
    for (let i = 0; i < 12; i++) {
      const x = r + Math.random() * Math.max(1, W - 2 * r);
      if (!zones.list.some((z) => x + r > z.l && x - r < z.r && y + r > z.t && y - r < z.b)) return x;
    }
    return Math.random() * W;
  }

  function guardBubbles() {
    if (!bubbles || !bubbles.particles) return;
    const k = (bubbles.retina && bubbles.retina.pixelRatio) || 1; // particle coordinates are canvas pixels
    const H = window.innerHeight;
    for (const p of bubbles.particles.filter(() => true)) {
      if (p.destroyed || !p.position) continue;
      const r = p.getRadius() / k;
      const res = keepOut(p.position.x / k, p.position.y / k, r);
      if (!res) continue;
      if (res.respawn) {
        p.position.x = freeX(r, H + r) * k;
        p.position.y = (H + r - 1) * k;
      } else {
        p.position.x = res.x * k;
        p.position.y = res.y * k;
      }
    }
  }

  const orbTmp = window.THREE ? new THREE.Vector3() : null;
  function guardOrb(o) {
    if (!orbTmp || !zones.list.length) return;
    const W = window.innerWidth, H = window.innerHeight, cam = orbs.camera;
    const dist = cam.position.distanceTo(orbTmp.set(o.x, o.y, o.z));
    const ppu = H / 2 / (dist * Math.tan((cam.fov * Math.PI) / 360)); // screen px per world unit at the orb's depth
    orbTmp.set(o.x, o.y, o.z).project(cam);
    const sx = ((orbTmp.x + 1) / 2) * W, sy = ((1 - orbTmp.y) / 2) * H;
    const res = keepOut(sx, sy, o.r * ppu * 1.08); // + the rim wobble in the vertex shader
    if (!res) return;
    if (res.respawn) {
      respawn(o, false);
      return;
    }
    o.x += (res.x - sx) / ppu;
    o.y -= (res.y - sy) / ppu;
    o.vx *= 0.5; o.vy = Math.min(o.vy, 0);
  }

  function loopZones(now) {
    if (!zones.running) return;
    zones.raf = requestAnimationFrame(loopZones);
    if (document.hidden) return;
    refreshZones(now);
  }
  function startZones() {
    if (zones.running) return;
    zones.running = true;
    zones.dirty = true;
    refreshZones(performance.now()); // zones exist before the first bubble frame is drawn
    zones.raf = requestAnimationFrame(loopZones);
  }
  function stopZones() {
    zones.running = false;
    cancelAnimationFrame(zones.raf);
  }
  const markZones = () => { zones.dirty = true; };
  // Attributes too: entrance animations fade text in through inline styles, and that text counts while it is still faint.
  new MutationObserver(markZones).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
  window.addEventListener('resize', markZones);
  document.addEventListener('scroll', markZones, { capture: true, passive: true });

  // Debugging aid: Meadow.fx.showZones(true) outlines every keep-out box.
  function drawZones() {
    const c = zones.overlay, W = window.innerWidth, H = window.innerHeight;
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    const g = c.getContext('2d');
    g.clearRect(0, 0, W, H);
    g.strokeStyle = 'rgba(255, 60, 120, 0.85)';
    g.fillStyle = 'rgba(255, 60, 120, 0.08)';
    for (const z of zones.list) { g.fillRect(z.l, z.t, z.r - z.l, z.b - z.t); g.strokeRect(z.l + 0.5, z.t + 0.5, z.r - z.l - 1, z.b - z.t - 1); }
  }
  fx.showZones = (on) => {
    if (on && !zones.overlay) {
      zones.overlay = document.createElement('canvas');
      zones.overlay.setAttribute('aria-hidden', 'true');
      zones.overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;pointer-events:none';
      document.body.append(zones.overlay);
      drawZones();
    } else if (!on && zones.overlay) {
      zones.overlay.remove();
      zones.overlay = null;
    }
  };

  /* ================================================================== visual on/off */
  function applyVisual() {
    document.documentElement.classList.toggle('fx-off', !fx.visual);
    const b = $('#fx-toggle-visual');
    if (b) { b.setAttribute('aria-pressed', String(fx.visual)); b.classList.toggle('off', !fx.visual); }
    if (fx.visual) {
      startSky(); // frozen (speed 0) under reduced motion
      if (!reduced) { startZones(); startBubbles(); startOrbs(); } // the moving layers stay off for people who asked for less motion
    } else { stopSky(); stopBubbles(); stopOrbs(); stopZones(); }
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
    if (heroes.length) gsap.from(heroes, { y: 8, opacity: 0, duration: 0.3, stagger: 0.03, ease: 'power2.out', clearProps: 'all' });
    const card = q('.login-card');
    if (card.length) gsap.from(card, { y: 8, opacity: 0, duration: 0.3, ease: 'power2.out', clearProps: 'all' });

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
      if (orbs.uniforms) orbs.uniforms.uMul.value = me ? 0.55 : 0.7; // in the app the 3D bubbles live behind the panels (see css: data-view="app")
      if (fresh) enter(root); else chatPop(root, key);
    } catch (e) { warn('enhancements', e); }
    return out;
  };

  fx.debug = { orbs, pointer, dodge, get bubbles() { return bubbles; } }; // read-only peek for tests and tuning

  /* ================================================================== boot */
  $('#fx-toggle-visual').addEventListener('click', () => fx.setVisual(!fx.visual));
  $('#fx-toggle-sound').addEventListener('click', () => fx.setSound(!fx.sound));
  applySound();
  applyVisual();
  if (!reduced) pointerRaf = requestAnimationFrame(smoothPointerLoop);
})();
