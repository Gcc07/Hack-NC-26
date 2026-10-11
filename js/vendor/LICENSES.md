# Vendored front-end libraries

These files are copied unmodified from their npm packages so Meadow works offline (hackathon wifi!). They are loaded
by `index.html` and used by `js/fx.js` and `js/views-insights.js`.

| File | Package | Version | License | Used for |
| --- | --- | --- | --- | --- |
| `three.min.js` | [three](https://www.npmjs.com/package/three) | 0.134.0 | MIT | WebGL for Vanta + 3D soap bubbles (r134 is the last build Vanta supports as a global script) |
| `vanta.clouds.min.js` | [vanta](https://www.npmjs.com/package/vanta) | 0.5.24 | MIT | Animated blue-sky + clouds background |
| `tsparticles.bundle.min.js` | [tsparticles](https://www.npmjs.com/package/tsparticles) | 4.4.0 | MIT | Rising glossy bubbles that dodge the cursor |
| `gsap.min.js` | [gsap](https://www.npmjs.com/package/gsap) | 3.15.0 | [GSAP Standard License](https://gsap.com/standard-license) (free) | Entrance animations, bubble bursts, message pop-in |
| `vanilla-tilt.min.js` | [vanilla-tilt](https://www.npmjs.com/package/vanilla-tilt) | 1.8.1 | MIT | 3D tilt + glare on cards and the logo |
| `howler.min.js` | [howler](https://www.npmjs.com/package/howler) | 2.2.4 | MIT | UI sounds (`Assets/sounds/*.wav`) |
| `d3.min.js` | [d3](https://www.npmjs.com/package/d3) | 7.9.0 | ISC | Bubble chart on the Org pulse card |

The sound effects are synthesized by `scripts/make_sounds.py`, so they have no third-party license.
