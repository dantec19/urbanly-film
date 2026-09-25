// s5.js: draw a line. A new Subte line is drawn across the city (Barracas to Plaza Italia, data/line) and
// walking time spreads along the real street network from each station as the pen passes it. The readout
// counts the homes (census dwellings, data/film) that the line brings within a ten-minute walk of the Subte.
import * as THREE from 'three';
import { makeLines } from './lines.js';
import { dijkstra, nodeGrid } from './graph.js';
import { seg, clamp, lerp, heroEase, easeOut, inOut, backOut, fmt, Q } from './util.js';
import { revealWordsAt, inOut as blockInOut, show } from './overlay.js';
import { toScreen } from './camera.js';

export const WALK = 80;                 // metres per minute, the planning convention (4.8 km/h)
export const REACH = 10 * WALK;         // a ten-minute walk, in metres
const PEN = [34.7, 37.1];               // the pen draws the whole line over this window
const RATE = 430;                       // wavefront speed on screen: metres of walk per film second
const T_WAVE = 34.7;                    // film time when the front is at 0

const penEase = x => inOut(x);

export async function setupS5(W, line) {
  const { scene, ov, D, G, adj, streets, ends } = W;
  const S = D.streets;
  const du = await fetch('data/film/buildings_dwelling_units.f32').then(r => r.arrayBuffer()).then(b => new Float32Array(b));
  const grid = nodeGrid(S.nodes, 120);

  // ---- the line: segments with their distance along the line, drawn by a moving front ----
  const P = line.polyline.flat(), nP = P.length / 2;
  const along = new Float32Array(nP);
  for (let i = 1; i < nP; i++) along[i] = along[i - 1] + Math.hypot(P[i * 2] - P[i * 2 - 2], P[i * 2 + 1] - P[i * 2 - 1]);
  const LEN = along[nP - 1];
  const la = new Float32Array((nP - 1) * 2), lb = new Float32Array((nP - 1) * 2), lg = new Float32Array((nP - 1) * 2), lc = new Uint8Array(nP - 1).fill(2);
  for (let i = 0; i < nP - 1; i++) {
    la[i * 2] = P[i * 2]; la[i * 2 + 1] = P[i * 2 + 1]; lb[i * 2] = P[i * 2 + 2]; lb[i * 2 + 1] = P[i * 2 + 3];
    lg[i * 2] = along[i]; lg[i * 2 + 1] = along[i + 1];
  }
  const mkLine = (width, alpha, colour, hot, order, additive = false) => {
    const m = makeLines({ a: la, b: lb, grow: lg, cls: lc }, { depthTest: false, renderOrder: order, additive });
    const u = m.material.uniforms;
    u.uRes.value.set(1920 * G.dpr, 1080 * G.dpr); u.uPx.value = G.dpr;
    u.uWidth.value.set(width, width, width); u.uAlpha.value.set(alpha, alpha, alpha);
    u.uBone.value.set(colour); u.uHot.value.copy(hot); u.uGrowAll.value = 0; u.uHeatLen.value = 210; u.uLift.value = 4;
    scene.add(m);
    return m;
  };
  const coral = new THREE.Color('#F77138');
  const glowLine = mkLine(15, .22, '#F77138', new THREE.Color('#FFB08A').multiplyScalar(1.6), 31, true);
  const coreLine = mkLine(4.6, 1, '#F77138', new THREE.Color('#FFD2BA').multiplyScalar(2.4), 32);
  const penAt = t => LEN * penEase(seg(t, PEN[0], PEN[1]));
  // the film time at which the pen passes a distance along the line
  const penTime = d => {
    let lo = PEN[0], hi = PEN[1];
    for (let k = 0; k < 40; k++) { const m = (lo + hi) / 2; penAt(m) < d ? lo = m : hi = m; }
    return (lo + hi) / 2;
  };

  // ---- the Subte as it is: lines A to H in bone, as context ----
  const sx = D.subte.xy, soff = D.subte.off, sline = D.subte.line;
  const ea = [], eb = [];
  for (let r = 0; r < soff.length - 1; r++) {
    if (sline[r] > 5) continue;
    for (let k = soff[r]; k < soff[r + 1] - 1; k++) { ea.push(sx[k * 2], sx[k * 2 + 1]); eb.push(sx[k * 2 + 2], sx[k * 2 + 3]); }
  }
  const nS = ea.length / 2;
  const subte = makeLines({ a: new Float32Array(ea), b: new Float32Array(eb), grow: new Float32Array(nS * 2), cls: new Uint8Array(nS).fill(1) }, { depthTest: false, renderOrder: 30 });
  const subU = subte.material.uniforms;
  subU.uRes.value.set(1920 * G.dpr, 1080 * G.dpr); subU.uPx.value = G.dpr;
  subU.uWidth.value.set(1.6, 1.6, 1.6); subU.uAlpha.value.set(.42, .42, .42); subU.uLift.value = 3;
  scene.add(subte);
  // and its stations, as small hollow rings (a transfer complex appears once per line; close rows merge)
  const oldSt = [];
  for (let i = 0; i < D.subte.stLine.length; i++) {
    if (D.subte.stLine[i] > 5) continue;
    const x = D.subte.stXY[i * 2], y = D.subte.stXY[i * 2 + 1];
    if (oldSt.some(q => Math.hypot(q.x - x, q.y - y) < 60)) continue;
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('r', 3.6); c.setAttribute('fill', '#1B1418'); c.setAttribute('stroke', '#F0F4EF'); c.setAttribute('stroke-width', 1.4);
    c.style.opacity = 0; ov.svg.appendChild(c);
    oldSt.push({ x, y, c });
  }

  // ---- walking distance over the street graph ----
  const snap = (x, y) => grid.nearest(x, y, 12);
  const newSrc = [], revSrc = [], pop = [];
  for (const s of line.stations) {
    const [n, d] = snap(s.x, s.y);
    const tp = penTime(s.alongLineM);
    pop.push(tp);
    newSrc.push([n, d]);
    revSrc.push([n, d + (tp - T_WAVE) * RATE]);
  }
  const oldSrc = [];
  for (let i = 0; i < D.subte.stLine.length; i++) {
    if (D.subte.stLine[i] > 5) continue;
    const [n, d] = snap(D.subte.stXY[i * 2], D.subte.stXY[i * 2 + 1]);
    oldSrc.push([n, d]);
  }
  const dNew = dijkstra(adj, newSrc), dOld = dijkstra(adj, oldSrc), dRev = dijkstra(adj, revSrc);

  // street segments carry the walk (colour) and the reveal key (order) at both ends
  const nE = ends.length / 2;
  const iso = streets.geometry.getAttribute('aIso'), isoR = streets.geometry.getAttribute('aIsoR');
  for (let e = 0; e < nE; e++) {
    const i = ends[e * 2], j = ends[e * 2 + 1];
    iso.array[e * 2] = dNew[i]; iso.array[e * 2 + 1] = dNew[j];
    isoR.array[e * 2] = dRev[i]; isoR.array[e * 2 + 1] = dRev[j];
  }
  iso.needsUpdate = isoR.needsUpdate = true;

  // ---- homes: each building walks to its nearest street node ----
  const B = D.buildings, nB = B.h.length;
  const t2 = W.bld.userData.t2;
  const gained = [];                     // [reveal key, units] of homes newly within the reach
  let served = 0, already = 0, gainedTotal = 0, gainedBld = 0;
  for (let b = 0; b < nB; b++) {
    const u = du[b];
    const [n, d] = snap(B.cx[b], B.cy[b]); if (n < 0) continue;
    const wNew = dNew[n] + d, wOld = dOld[n] + d;
    t2[b * 4 + 2] = wNew; t2[b * 4 + 3] = dRev[n] + d;
    if (wNew > REACH || !(u > 0)) continue;
    served += u;
    if (wOld <= REACH) { already += u; continue; }
    gained.push(dRev[n] + d, u); gainedTotal += u; gainedBld++;
  }
  W.bld.userData.T2.needsUpdate = true;
  const nG = gained.length / 2, order = Array.from({ length: nG }, (_, i) => i).sort((a, b) => gained[a * 2] - gained[b * 2]);
  const gKey = new Float32Array(nG), gCum = new Float64Array(nG);
  let acc = 0;
  for (let k = 0; k < nG; k++) { const i = order[k]; gKey[k] = gained[i * 2]; acc += gained[i * 2 + 1]; gCum[k] = acc; }
  const gainedAt = front => {
    let lo = 0, hi = nG;
    while (lo < hi) { const m = (lo + hi) >> 1; gKey[m] <= front ? lo = m + 1 : hi = m; }
    return lo ? gCum[lo - 1] : 0;
  };
  let maxRev = 0;
  for (let k = 0; k < nG; k++) maxRev = Math.max(maxRev, gKey[k]);
  console.log(`s5: line ${fmt(LEN)} m, ${line.stations.length} stations; homes within ${REACH} m walk of the new stations ${fmt(served)}, already near the Subte ${fmt(already)}, newly ${fmt(gainedTotal)} in ${fmt(gainedBld)} buildings`);

  // ---- stations: rings that pop as the pen passes, names set like a transit map ----
  const svg = ov.svg;
  const stn = line.stations.map((s, i) => {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.innerHTML = `<circle r="7.5" fill="#1B1418" stroke="#F77138" stroke-width="2.6"/><circle r="2.2" fill="#F77138"/>`;
    g.style.opacity = 0; svg.appendChild(g);
    const name = ov.add('s5-st' + i, s.name, 'stn');
    return { g, name, s, i, tp: pop[i] };
  });

  // ---- type ----
  ov.add('s5-hl', 'Draw a line.<br>The network answers.', 'hl', { left: '120px', top: '792px' });
  const words = ov.splitWords('s5-hl');
  const WT = [34.85, 35.02, 35.18, 36.45, 36.62, 36.85];
  const read = ov.add('s5-read', '', 'figs', { left: '122px', top: '952px' });
  const legend = ov.add('s5-leg', `<span class="tk">0</span><i class="ramp"></i><span class="tk">10 min walk to a new station</span>`, 'legend', { left: '122px', top: '994px' });

  function update(t, cs) {
    const on = t > 34.5 && t < 47.8;
    const pen = penAt(t);
    for (const m of [glowLine, coreLine]) {
      m.visible = on && pen > 0;
      const u = m.material.uniforms;
      // the pen's hot tip cools once the line is drawn
      u.uGrow.value = pen + Math.max(0, t - PEN[1]) * 2600;
      u.uOpacity.value = 1 - seg(t, 46.4, 47.4);
    }
    subte.visible = on;
    subU.uOpacity.value = heroEase(seg(t, 34.6, 35.6)) * (1 - seg(t, 46.4, 47.4));
    for (const q of oldSt) {
      const p = subte.visible ? toScreen(W.camera, q.x, q.y, 3) : null;
      const o = p ? subU.uOpacity.value * .7 : 0;
      q.c.style.opacity = o;
      if (p) { q.c.setAttribute('cx', p[0].toFixed(1)); q.c.setAttribute('cy', p[1].toFixed(1)); }
    }

    // the walk wave
    const front = (t - T_WAVE) * RATE;
    const su = W.su;
    su.uIsoOn.value = heroEase(seg(t, 34.8, 35.3)) * (1 - inOut(seg(t, 40.4, 41.4)));
    su.uIsoFront.value = front; su.uIsoMax.value = REACH; su.uIsoCut.value = REACH; su.uIsoWiden.value = 1.2;
    const bu = W.bu;
    bu.uIsoOn.value = su.uIsoOn.value; bu.uIsoFront.value = front; bu.uIsoMax.value = REACH; bu.uIsoCut.value = REACH;

    // stations
    for (const st of stn) {
      const k = seg(t, st.tp - .05, st.tp + .45);
      const o = (k > 0 ? 1 : 0) * (1 - seg(t, 46.4, 47.2));
      const p = on && o > 0 ? toScreen(W.camera, st.s.x, st.s.y, 4) : null;
      if (!p) { st.g.style.opacity = 0; show(st.name, 0); continue; }
      const sc = backOut(k, 2.2);
      // the lower-left corner belongs to the headline: a station that drifts into it lets its name go
      const clear = clamp(Math.max((740 - p[1]) / 50, (p[0] - 840) / 50));
      st.g.setAttribute('transform', `translate(${p[0].toFixed(1)} ${p[1].toFixed(1)}) scale(${sc.toFixed(3)})`);
      st.g.style.opacity = o * clamp(k * 3) * (.35 + .65 * clear);
      const kn = heroEase(seg(t, st.tp + .1, st.tp + .6));
      show(st.name, o * kn * .92 * clear);
      // transit-map names: set at 38° along the straight run, flat beside the stations of the final turn
      const lay = st.i >= 9 ? `translate(${p[0] + 14}px, ${p[1] - 7}px)` : st.i === 8 ? `translate(${p[0] + 8}px, ${p[1] + 2}px) rotate(38deg)` : `translate(${p[0] + 7}px, ${p[1] - 13}px) rotate(-38deg)`;
      st.name.style.transform = `${lay} translateX(${(1 - kn) * -6 + 8}px)`;
    }

    revealWordsAt(words, t, WT);
    ov.get('s5-hl').style.opacity = 1 - heroEase(seg(t, 40.0, 40.6));
    const oR = heroEase(seg(t, 36.8, 37.4)) * (1 - heroEase(seg(t, 40.0, 40.6)));
    show(read, oR);
    if (oR > 0) {
      const g = Math.round(gainedAt(front));
      read.innerHTML = `<b>+${fmt(g)}</b> homes newly within a 10-minute walk of the Subte`;
    }
    const oL = heroEase(seg(t, 36.6, 37.3)) * (1 - heroEase(seg(t, 40.0, 40.6)));
    show(legend, oL);
  }

  // camera: the corridor seen from the east, the line running left to right from Barracas to Plaza Italia;
  // close on Barracas as the pen sets off, pulling back as it runs so the whole line is in view when it lands
  const keys = [
    [34.9, { x: Q('ax', -1850), y: Q('ay', -3500), w: Q('aw', 4400), pitch: Q('ap', 44), yaw: Q('ayaw', -90), fov: 24 }],
    [37.4, { x: Q('bx', -2350), y: Q('by', -900), w: Q('bw', 9400), pitch: Q('bp', 46), yaw: Q('byaw', -89), fov: 24 }],
    [40.3, { x: Q('cx', -2420), y: Q('cy', -760), w: Q('cw', 9900), pitch: Q('cp', 49), yaw: Q('cyaw', -85), fov: 24 }],
  ];
  return { update, keys, snap, dNew, dOld, dwellings: du, stats: { served, already, gained: gainedTotal, gainedBld, len: LEN } };
}
