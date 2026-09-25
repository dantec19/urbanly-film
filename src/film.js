// film.js: the timeline. One world (Buenos Aires), one continuous camera; every value is a function of t.
// This file builds the shared world (plate, streets, buildings, sun) and runs scene one; the other scenes
// live in their own modules and get the same world object.
import * as THREE from 'three';
import { clamp, lerp, seg, smooth, inOut, easeOut, heroEase, fmt, kf, VIRIDIS, Q } from './util.js';
import { applyCamera, camPath, toScreen } from './camera.js';
import { makeLines, rampTexture } from './lines.js';
import { makeBuildings } from './buildings.js';
import { adjacency, dijkstra, nearestNode } from './graph.js';
import { inOut as blockInOut } from './overlay.js';
import { makeShadow } from './shadow.js';
import { makePlate } from './plate.js';
import { setupS2, LOT } from './s2.js';
import { setupS3 } from './s3.js';
import { setupS4 } from './s4.js';
import { setupS5 } from './s5.js';
import { setupS6 } from './s6.js';
import { setupS78 } from './s78.js';

export const DURATION = 63;

// camera states (metres; y north)
const CITY_C = [-10200, -850];     // camera centre that puts the whole city in the right 60% of the frame
const W0 = 700, W_CITY = 36000;
const D2R = Math.PI / 180;
// direction toward the sun: azimuth clockwise from north, elevation above the horizon (world: x east, y up, z south)
const sunVec = (az, el) => new THREE.Vector3(Math.sin(az * D2R) * Math.cos(el * D2R), Math.sin(el * D2R), -Math.cos(az * D2R) * Math.cos(el * D2R));

function glowTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d'), r = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(.08, 'rgba(255,255,255,.85)'); r.addColorStop(.25, 'rgba(255,255,255,.25)');
  r.addColorStop(.6, 'rgba(255,255,255,.05)'); r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r; g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

export async function buildFilm(G, D, ov) {
  const { scene, camera, renderer } = G;
  const ramp = rampTexture(VIRIDIS);
  const shadow = makeShadow(renderer, 4096);
  const plate = makePlate(D.boundary, shadow);
  scene.add(plate);

  // ---------------- streets: grown from Plaza de Mayo in network order ----------------
  const S = D.streets;
  const nN = S.nodes.length / 2, nE = S.edges.length / 2;
  const adj = adjacency(nN, S.edges, S.len);
  const origin = nearestNode(S.nodes, 0, 0);
  const dist = dijkstra(adj, [[origin, 0]]);
  let maxD = 0;
  for (let i = 0; i < nN; i++) {
    if (!isFinite(dist[i])) dist[i] = 1.3 * Math.hypot(S.nodes[i * 2], S.nodes[i * 2 + 1]) + 300;
    maxD = Math.max(maxD, dist[i]);
  }
  const sa = new Float32Array(nE * 2), sb = new Float32Array(nE * 2), grow = new Float32Array(nE * 2);
  const ends = new Uint32Array(nE * 2);   // the node at each end of each drawn segment (a nearer the Plaza)
  for (let e = 0; e < nE; e++) {
    let i = S.edges[e * 2], j = S.edges[e * 2 + 1];
    if (dist[i] > dist[j]) [i, j] = [j, i];
    ends[e * 2] = i; ends[e * 2 + 1] = j;
    sa[e * 2] = S.nodes[i * 2]; sa[e * 2 + 1] = S.nodes[i * 2 + 1];
    sb[e * 2] = S.nodes[j * 2]; sb[e * 2 + 1] = S.nodes[j * 2 + 1];
    grow[e * 2] = dist[i]; grow[e * 2 + 1] = dist[j];
  }
  const streets = makeLines({ a: sa, b: sb, grow, cls: S.cls }, { ramp, shadow });
  scene.add(streets);
  const su = streets.material.uniforms;
  su.uRes.value.set(1920 * G.dpr, 1080 * G.dpr); su.uPx.value = G.dpr;

  // ---------------- buildings ----------------
  const B = D.buildings;
  const nB = B.h.length;
  const rise = new Float32Array(nB);
  for (let b = 0; b < nB; b++) rise[b] = Math.hypot(B.cx[b], B.cy[b]);
  const bld = makeBuildings(B.rings, { h: B.h, rise, cx: B.cx, cy: B.cy }, { ramp, shadow });
  scene.add(bld);
  const bu = bld.userData.material.uniforms;

  // ---------------- the first point of light ----------------
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: new THREE.Color('#FFE2B8'), blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, transparent: true }));
  glow.renderOrder = 10; scene.add(glow);

  // ---------------- type ----------------
  const stats = D.stats;
  ov.add('s1-coord', 'Plaza de Mayo<br><span class="dim">34.608° S &nbsp;58.372° W</span>', 'eyebrow');
  ov.add('s1-city', 'Buenos Aires', 'eyebrow', { left: '120px', top: '846px' });
  const figs = ov.add('s1-figs', '', 'figs', { left: '120px', top: '878px' });

  const W = { G, D, ov, scene, camera, renderer, shadow, plate, streets, su, bld, bu, ramp, adj, dist, maxD, ends };
  const scrim = document.getElementById('scrim'), scrimTop = document.getElementById('scrim-top');
  const SCRIM = [[4.2, 0], [4.8, .5], [6.0, .5], [6.6, .9], [7.4, .9], [8.0, 0], [10.5, 0], [11.2, 1], [32.4, 1], [33.0, 0],
    [34.8, 0], [35.4, 1], [53.1, 1], [53.6, 0]];

  // ---------------- the other scenes ----------------
  const s2 = await setupS2(W);
  const s3 = await setupS3(W, s2);
  const s4 = await setupS4(W, s3);

  // the two futures: the baseline run and the run with the new line, completions per point (x, y, t, units)
  const [growBase, line] = await Promise.all([
    fetch('data/film/growth_base.f32').then(r => r.arrayBuffer()).then(b => new Float32Array(b)),
    fetch('data/line/line.json').then(r => r.json()),
  ]);
  const s5 = await setupS5(W, line);
  const s6 = await setupS6(W, s5);
  const growLine = await fetch('data/film/growth_line.f32').then(r => r.arrayBuffer()).then(b => new Float32Array(b));
  const s78 = await setupS78(W, { line, growth: [growBase, growLine] });

  // ---------------- S1: the growth front and the zoom share one clock ----------------
  const zoomK = t => inOut(seg(t, .8, 4.6));
  const wAt = t => W0 * Math.pow(W_CITY / W0, zoomK(t));
  const frontAt = t => .6 * wAt(t) * smooth(seg(t, .8, 1.7)) + Math.max(0, maxD - .6 * W_CITY) * inOut(seg(t, 3.5, 5.3));

  // one camera path for the whole film: an exponential pull-back first, then keys (Catmull-Rom through them)
  const KEYS = [
    [4.6, { x: CITY_C[0], y: CITY_C[1], w: W_CITY, pitch: 90, yaw: 0, fov: 18 }],
    [5.4, { x: CITY_C[0] + 220, y: CITY_C[1] + 50, w: W_CITY * .965, pitch: 89, yaw: 2, fov: 18 }],
    [9.4, { x: -3300, y: -450, w: 3400, pitch: 34, yaw: 42, fov: 16 }],
    ...s2.keys,
    ...s3.keys,
    // S4
    [27.6, { x: LOT[0] + 350, y: LOT[1] + 700, w: 4200, pitch: 40, yaw: -20, fov: 16 }],
    [30.6, { x: -3700, y: -1600, w: 14600, pitch: 42, yaw: 6, fov: 16 }],
    [32.6, { x: -5600, y: -600, h: 5200, w: 40000, pitch: 17, yaw: 24, fov: 16 }],
    [33.1, { x: -5500, y: -620, h: 5000, w: 39000, pitch: 17.5, yaw: 23, fov: 16, hold: true }],
    ...s5.keys,
    ...s6.keys,
    ...s78.keys,
  ];
  function camAt(t) {
    if (t < 4.6) {
      const w = wAt(t), k = Math.pow(clamp(Math.log(w / W0) / Math.log(W_CITY / W0)), 1.6);
      return { x: lerp(0, CITY_C[0], smooth(k)), y: lerp(0, CITY_C[1], smooth(k)), w, pitch: 90, yaw: 0, fov: 18 };
    }
    return camPath(t, KEYS);
  }

  // ---------------- light: an afternoon sun that sets into night during scene two ----------------
  const DAY_SUN = new THREE.Color('#FFE6CC'), DUSK_SUN = new THREE.Color('#FF8A4C');
  function light(t) {
    const k = inOut(seg(t, 9.6, 11.4));
    const el = lerp(Q('el', 14), 3, k), az = lerp(Q('az', 312), 300, k);
    const sun = sunVec(az, el);
    bu.uLight.value.copy(sun);
    bu.uSunC.value.copy(DAY_SUN).lerp(DUSK_SUN, k);
    bu.uDirect.value = 1.05 * (1 - inOut(seg(t, 10.3, 11.7)));
    bu.uNight.value = inOut(seg(t, 10.1, 11.9));
    bu.uLit.value = .42 * easeOut(seg(t, 10.7, 12.8));
    return { sun, night: bu.uNight.value };
  }

  return function frame(t) {
    const cs = camAt(t);
    applyCamera(camera, cs, 1920 / 1080);
    const L = light(t);

    // streets
    const front = frontAt(t);
    su.uGrowAll.value = front >= maxD + 10 ? 1 : 0;
    su.uGrow.value = front;
    su.uHeatLen.value = Math.max(40, front * .05);
    const zoomOut = clamp(Math.log(cs.w / 1500) / Math.log(W_CITY / 1500));
    su.uWidth.value.set(lerp(1.3, .75, zoomOut), lerp(1.7, 1.0, zoomOut), lerp(2.4, 1.5, zoomOut));
    const nightDim = lerp(1, .5, L.night);
    su.uAlpha.value.set(lerp(.55, .30, zoomOut) * nightDim, lerp(.65, .46, zoomOut) * nightDim, lerp(.8, .7, zoomOut) * nightDim);
    su.uTint.value.setScalar(lerp(1, .55, L.night));

    // buildings: rise in a wave from the Plaza while the camera tilts
    bu.uRiseAll.value = 0;
    // … and lie down again, the far ones first, before the two futures
    bu.uRise.value = t < 46 ? lerp(-600, 21000, inOut(seg(t, 5.5, 9.0))) : lerp(21000, -600, inOut(seg(t, 46.15, 47.25)));
    bu.uRiseW.value = 1400;
    bu.uTarget.value.set(cs.x, 0, -cs.y);
    bld.visible = t > 5.4;
    // haze: distant blocks sink into the night table in oblique views
    const oblique = 1 - smooth(seg(cs.pitch, 55, 85));
    bu.uHaze.value = oblique * .85; bu.uHazeR.value = cs.w * 1.7;
    plate.material.uniforms.uCol.value.set('#261D22').lerp(new THREE.Color('#1E171B'), L.night);

    // the point of light: a breath, a blink of anticipation, then it lets the lines go
    const breath = .55 + .25 * Math.sin(t * 5.5);
    const k0 = heroEase(seg(t, 0, .55));
    const dip = 1 - .45 * Math.exp(-Math.pow((t - .7) / .07, 2));
    const fade = 1 - smooth(seg(t, 1.1, 3.0));
    const I = k0 * breath * dip * fade * 2.6 + Math.exp(-Math.pow((t - .82) / .12, 2)) * 2.2 * k0;
    glow.material.color.set('#FFE2B8').multiplyScalar(I);
    glow.position.set(0, 1, 0);
    const gs = cs.w * .09;
    glow.scale.set(gs, gs, 1);
    glow.visible = I > .01;

    // type
    const p = t < 2.5 ? toScreen(camera, 0, 0) : null;
    blockInOut(ov.get('s1-coord'), t, .3, 2.2, { din: .6, dout: .5, x: p ? p[0] + 46 : 0, y: p ? p[1] - 22 : 0 });
    blockInOut(ov.get('s1-city'), t, 4.4, 7.4, { din: .8, dout: .7 });
    const oFig = blockInOut(figs, t, 4.6, 7.4, { din: .8, dout: .7 });
    if (oFig > 0) {
      const k = easeOut(seg(t, 4.6, 6.0));
      figs.innerHTML = `${fmt(Math.round(stats.streetKm * k))} km of streets &nbsp;·&nbsp; ${fmt(Math.round(stats.parcels * k))} parcels &nbsp;·&nbsp; ${fmt(Math.round(stats.buildings * k))} buildings`;
    }

    s2.update(t, cs, L);
    s3.update(t);
    s4.update(t, cs, L);
    s5.update(t, cs);
    s6.update(t);
    s78.update(t);

    // the city leaves the table as it becomes the slab of scene seven
    const gone = inOut(seg(t, 46.4, 47.3));
    bu.uDim.value = gone; su.uOpacity.value = 1 - gone; plate.material.uniforms.uOpacity.value = 1 - gone;
    bld.visible = bld.visible && gone < .999; streets.visible = gone < .999; plate.visible = gone < .999;

    // a soft dark corner behind the lower-left type, only while there is type
    scrim.style.opacity = kf(t, SCRIM, heroEase);
    scrimTop.style.opacity = kf(t, [[25.2, 0], [25.8, 1], [34.4, 1], [34.9, 0]], heroEase);   // behind scene four's year counter

    // sun shadows, fitted to what the camera sees (off once the sun has set)
    const reach = cs.w * (.55 + .9 * oblique);
    shadow.fit(cs.x, -cs.y, Math.min(reach, 22000), L.sun);
    const shadowOn = bld.visible && bu.uDirect.value > .01;
    if (shadowOn) shadow.render(bld, bld.userData.depthMaterial);
    shadow.uniforms.uShadowOn.value = shadowOn ? 1 : 0;

    // post
    G.grade.uniforms.uFrame.value = Math.round(t * 30);
    G.grade.uniforms.uFade.value = 1;
  };
}
