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

  /* ================================================================== hills and koi pond (stationary SVG landscape) */
  function buildHills() {
    const el = $('#fx-hills');
    if (!el) return;
    el.innerHTML = `<svg viewBox="0 0 1440 560" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="distant" x2="0" y2="1"><stop stop-color="#b8dda6"/><stop offset="1" stop-color="#659d65"/></linearGradient>
        <radialGradient id="sunlit" cx=".28" cy=".08" r=".95"><stop stop-color="#d3ef83"/><stop offset=".3" stop-color="#8ac848"/><stop offset=".65" stop-color="#45923a"/><stop offset="1" stop-color="#174e36"/></radialGradient>
        <radialGradient id="near" cx=".72" cy=".05" r=".85"><stop stop-color="#b6dd57"/><stop offset=".35" stop-color="#71af38"/><stop offset=".8" stop-color="#2d7435"/><stop offset="1" stop-color="#164c31"/></radialGradient>
        <linearGradient id="front" x1=".1" y1="0" x2=".8" y2="1"><stop stop-color="#8bbd42"/><stop offset=".5" stop-color="#3c8538"/><stop offset="1" stop-color="#154e35"/></linearGradient>
        <linearGradient id="trail" x2="0" y2="1"><stop stop-color="#e1e9a1" stop-opacity=".08"/><stop offset="1" stop-color="#dbdf97" stop-opacity=".48"/></linearGradient>
        <radialGradient id="pond-water" cx=".4" cy=".25" r=".8"><stop stop-color="#a6ebdb"/><stop offset=".35" stop-color="#50b7b0"/><stop offset=".75" stop-color="#247b84"/><stop offset="1" stop-color="#16505f"/></radialGradient>
        <linearGradient id="pond-bank" x2="0" y2="1"><stop stop-color="#a8c55a"/><stop offset=".45" stop-color="#668e3d"/><stop offset="1" stop-color="#b0c075"/></linearGradient>
        <clipPath id="pond-clip"><path d="M-166 0C-185-34-94-62-25-47S61-54 122-34 194 16 146 35 57 43-20 47-154 40-166 0Z"/></clipPath>
        <pattern id="grass" width="23" height="19" patternUnits="userSpaceOnUse"><path d="M3 19l2-7m11 4l-1-5m5 8l2-4" stroke="#e3f9aa" stroke-opacity=".15" stroke-width=".8"/></pattern>
      </defs>
      <path d="M-40 185 Q150 38 340 150 T740 140 T1130 90 T1480 140 V560 H-40Z" fill="url(#distant)"/>
      <path d="M-40 280 C160 80 320 60 540 196 S880 300 1090 205 S1330 120 1480 178 V560 H-40Z" fill="url(#sunlit)"/>
      <path d="M-40 280 C160 80 320 60 540 196 S880 300 1090 205 S1330 120 1480 178" fill="none" stroke="#efffc2" stroke-opacity=".42" stroke-width="2"/>
      <path d="M-40 385 C190 450 420 360 635 290 S1020 152 1230 252 S1400 300 1480 290 V560 H-40Z" fill="url(#near)"/>
      <path d="M-40 385 C190 450 420 360 635 290 S1020 152 1230 252 S1400 300 1480 290" fill="none" stroke="#e6f5a1" stroke-opacity=".3" stroke-width="2"/>
      <path d="M-40 453 C240 335 400 350 650 445 S1080 535 1480 390 V560 H-40Z" fill="url(#front)"/>
      <path d="M-40 453 C240 335 400 350 650 445 S1080 535 1480 390 V560 H-40Z" fill="url(#grass)"/>
      <path d="M855 271 C760 315 729 337 794 377 S945 449 883 560 H1000 C1045 463 861 404 816 377 S802 313 855 271Z" fill="url(#trail)"/>
      <g class="meadow-pond" transform="translate(365 467)">
        <ellipse cx="6" cy="20" rx="185" ry="51" fill="#183d27" opacity=".18"/>
        <path d="M-166 0C-185-34-94-62-25-47S61-54 122-34 194 16 146 35 57 43-20 47-154 40-166 0Z" fill="url(#pond-bank)" stroke="url(#pond-bank)" stroke-width="17"/>
        <path d="M-166 0C-185-34-94-62-25-47S61-54 122-34 194 16 146 35 57 43-20 47-154 40-166 0Z" fill="url(#pond-water)" stroke="#315f46" stroke-width="3"/>
        <g clip-path="url(#pond-clip)">
          <path d="M-162-14Q-94-47-27-30T134-18" fill="none" stroke="#e3fff3" stroke-opacity=".55" stroke-width="3"/>
          <ellipse cx="20" cy="8" rx="121" ry="25" fill="none" stroke="#c1f6e7" stroke-opacity=".2"/>
          <g transform="translate(-66 8) rotate(-16)"><g class="pond-koi koi-one">
            <path d="M-16 0l-12-7 2 7-2 7Z" fill="#ffe9c6"/><ellipse rx="20" ry="7" fill="#fff5d9"/>
            <path d="M-11-6q9-2 12 6-6 6-13 4Z M10-5q10 1 8 6l-7 3Z" fill="#ed823a"/>
            <path d="M0-5l-5-6 11 6M0 5l-4 7 10-7" fill="#fff5d9" opacity=".8"/><circle cx="15" cy="-2" r="1.2" fill="#253c40"/>
          </g></g>
          <g transform="translate(49 17) rotate(166)"><g class="pond-koi koi-two">
            <path d="M-14 0l-10-6 2 6-2 6Z" fill="#e8dbad"/><ellipse rx="17" ry="6" fill="#f6d18c"/>
            <path d="M-11-4l9-1 4 6-9 3Z M7-5l6 2-3 5-5-1Z" fill="#d85f26"/>
            <path d="M-1-4l-5-5 10 5M0 5l-3 5 7-5" fill="#fff0cf" opacity=".75"/><circle cx="12" cy="-2" r="1" fill="#253c40"/>
          </g></g>
          <g transform="translate(7 -18) rotate(12)"><g class="pond-koi koi-three">
            <path d="M-12 0l-9-5 2 5-2 5Z" fill="#f7f4db"/><ellipse rx="14" ry="5" fill="#f8f4e0"/><path d="M-6-4l7 1 1 6-6 1Z" fill="#425659"/><path d="M7-4l5 2-2 4-4-2Z" fill="#ed7638"/><circle cx="10" cy="-1" r="1" fill="#263a3d"/>
          </g></g>
          <g class="pond-ripple" fill="none" stroke="#e9fff7" stroke-width="1.2"><ellipse cx="-62" cy="4" rx="39" ry="12"/><ellipse cx="48" cy="15" rx="29" ry="9"/></g>
        </g>
        <g fill="#618c40" stroke="#b6d174" stroke-width="1">
          <path d="M-115-15l15-9a20 10 0 11-1-1Z"/><path d="M113 22l12-7a16 8 0 11-1-1Z"/>
        </g>
        <g transform="translate(-118 -21)" fill="#fff0ed" stroke="#dbaac0" stroke-width=".7"><path d="M0 3Q-15-1-10-7Q0-6 0 3M0 3Q-5-13 1-14Q8-7 0 3M0 3Q14-9 13-1Q7 6 0 3"/><ellipse cy="2" rx="4" ry="2" fill="#f7d276"/></g>
        <g fill="#b7bea0" stroke="#71856a" stroke-width="1"><ellipse cx="-157" cy="-26" rx="13" ry="5" transform="rotate(-14 -157 -26)"/><ellipse cx="-140" cy="-36" rx="9" ry="4"/><ellipse cx="145" cy="36" rx="14" ry="5"/><ellipse cx="164" cy="28" rx="8" ry="4"/></g>
        <path d="M-181 15q-6-20-11-23m11 23q1-22 7-28m-7 28q-11-11-18-10M175-7q3-15 10-19m-10 19q-3-20-7-23" fill="none" stroke="#789c43" stroke-width="3" stroke-linecap="round"/>
      </g>
    </svg>`;
  }

  function buildFlowers() {
    const el = $('#fx-flowers');
    if (!el) return;
    const spots = [
      [8, 78, 1], [18, 86, 0.75], [29, 82, 0.95], [41, 90, 0.7],
      [54, 84, 1.05], [67, 88, 0.8], [78, 80, 0.9], [88, 86, 0.7], [96, 82, 0.85],
    ];
    el.innerHTML = spots.map(([x, y, s], i) =>
      '<i class="bloom b' + (i % 3) + '" style="left:' + x + '%;bottom:' + (100 - y) + '%;--s:' + s + ';animation-delay:' + (-i * 0.7) + 's"></i>'
    ).join('');
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
      if (!fx.visual) { c && c.destroy(); } else { bubbles = c; dodge.last = 0; dodge.raf = requestAnimationFrame(dodgeLoop); }
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
  buildHills();
  buildFlowers();
  applySound();
  applyVisual();
  if (!reduced) pointerRaf = requestAnimationFrame(smoothPointerLoop);
})();
