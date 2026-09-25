// s6.js: the compass. Around the new line's Av. Corrientes station the city is read eight ways at once, one
// reading per compass point, each ranked low to high on the same scale. Every field is real data: the
// parcels' land value, flat prices, built density and zoning of the region seed, the census dwellings, the
// tree census, the walk to a Subte station over the street graph (scene five), and the homes the run
// completes over the decade. Turning the compass puts every block under every reading.
import * as THREE from 'three';
import { seg, clamp, lerp, heroEase, easeOut, inOut, fmt } from './util.js';
import { revealWordsAt, show } from './overlay.js';
import { toScreen } from './camera.js';
import { newCanvas } from './tiles.js';

export const COMPASS = [-1840, 434];     // Av. Corrientes station of the new line (data/line)
const R = 1000;                          // compass radius, metres
const HALF = 1150, TEX = 1024;           // field rectangle half-size (m) and texture size (px)
const T = { sweep: [40.9, 42.1], turn: [42.1, 45.7], out: [45.5, 46.3] };
const TURN = -Math.PI / 2;               // the compass turns a quarter while the headline holds

// the eight readings, clockwise from north
const READINGS = [
  'Walk to the Subte', 'Land value', 'Flat prices', 'Homes per hectare',
  'Built density', 'Room to build', 'Trees', 'New homes, next decade',
];

export async function setupS6(W, s5) {
  const { ov, D, bu } = W;
  const P = D.parcels, B = D.buildings;
  const [cx, cy] = COMPASS;
  const x0 = cx - HALF, y0 = cy - HALF, S = TEX / (2 * HALF);
  const du = s5.dwellings;
  const grow = await fetch('data/film/growth_base.f32').then(r => r.arrayBuffer()).then(b => new Float32Array(b));

  // ---- per-parcel values for the parcels near the compass ----
  const nP = P.area.length;
  const near = [];
  for (let p = 0; p < nP; p++) {
    const px = P.cen[p * 2], py = P.cen[p * 2 + 1];
    if (Math.abs(px - cx) < HALF + 60 && Math.abs(py - cy) < HALF + 60) near.push(p);
  }
  const homes = new Float32Array(nP);
  for (let b = 0; b < B.h.length; b++) { const p = B.parcel[b]; if (p !== 0xFFFFFFFF && du[b] > 0) homes[p] += du[b]; }
  const walk = p => { const [n, d] = s5.snap(P.cen[p * 2], P.cen[p * 2 + 1]); return n < 0 ? NaN : Math.min(s5.dNew[n], s5.dOld[n]) + d; };
  const perParcel = [
    p => -walk(p),                                           // shorter walk ranks higher
    p => P.land[p],
    p => P.apt[p],
    p => homes[p] / Math.max(P.area[p], 1),
    p => P.builtFar[p],
    p => { const z = P.zoneMaxH[p]; return Number.isFinite(z) && z > 0 ? Math.max(0, z - P.maxBuiltH[p]) : NaN; },
  ];

  // rank a list of values to 0..1 (ties share a rank); NaN stays NaN
  const rank = vals => {
    const idx = [];
    for (let i = 0; i < vals.length; i++) if (Number.isFinite(vals[i])) idx.push(i);
    idx.sort((a, b) => vals[a] - vals[b]);
    const out = new Float32Array(vals.length).fill(NaN);
    for (let k = 0; k < idx.length;) {
      let j = k; while (j + 1 < idx.length && vals[idx[j + 1]] === vals[idx[k]]) j++;
      const r = idx.length > 1 ? ((k + j) / 2) / (idx.length - 1) : 1;
      for (let q = k; q <= j; q++) out[idx[q]] = r;
      k = j + 1;
    }
    return out;
  };

  // parcels drawn as polygons into a grey canvas (north up means canvas y grows with y, so row 0 is south)
  const drawParcels = (ranks) => {
    const [c, g] = newCanvas(TEX, TEX, 'rgb(0,0,0)');
    for (let k = 0; k < near.length; k++) {
      const v = ranks[k]; if (!Number.isFinite(v)) continue;
      const p = near[k], o0 = P.off[p], o1 = P.off[p + 1];
      g.beginPath();
      for (let q = o0; q < o1; q++) { const X = (P.xy[q * 2] - x0) * S, Y = (P.xy[q * 2 + 1] - y0) * S; q === o0 ? g.moveTo(X, Y) : g.lineTo(X, Y); }
      g.closePath();
      const u = Math.round(8 + v * 247);
      g.fillStyle = `rgb(${u},${u},${u})`; g.fill();
    }
    return g.getImageData(0, 0, TEX, TEX).data;
  };
  // point densities (tree cells, completed homes) smoothed on a grid, ranked over the texels inside the disc
  const density = (xs, ys, ws, radius) => {
    const G = 256, cell = 2 * HALF / G, grid = new Float32Array(G * G);
    for (let i = 0; i < xs.length; i++) {
      const gx = (xs[i] - x0) / cell, gy = (ys[i] - y0) / cell;
      if (gx < -4 || gy < -4 || gx > G + 4 || gy > G + 4) continue;
      const rr = radius / cell;
      for (let j = Math.max(0, Math.floor(gy - 2 * rr)); j <= Math.min(G - 1, Math.ceil(gy + 2 * rr)); j++)
        for (let k = Math.max(0, Math.floor(gx - 2 * rr)); k <= Math.min(G - 1, Math.ceil(gx + 2 * rr)); k++) {
          const d2 = ((k + .5 - gx) ** 2 + (j + .5 - gy) ** 2) / (rr * rr);
          if (d2 < 4) grid[j * G + k] += ws[i] * Math.exp(-d2);
        }
    }
    const inDisc = [], vals = [];
    for (let j = 0; j < G; j++) for (let k = 0; k < G; k++) {
      const X = x0 + (k + .5) * cell, Y = y0 + (j + .5) * cell;
      if (Math.hypot(X - cx, Y - cy) < R + 40) { inDisc.push(j * G + k); vals.push(grid[j * G + k]); }
    }
    const rk = rank(vals), img = new Uint8ClampedArray(TEX * TEX * 4);
    const out = new Float32Array(G * G);
    for (let i = 0; i < inDisc.length; i++) out[inDisc[i]] = rk[i];
    for (let j = 0; j < TEX; j++) for (let k = 0; k < TEX; k++) {
      const u = Math.round(8 + out[Math.floor(j * G / TEX) * G + Math.floor(k * G / TEX)] * 247);
      const q = (j * TEX + k) * 4; img[q] = img[q + 1] = img[q + 2] = u;
    }
    return img;
  };

  const planes = [];
  for (const f of perParcel) planes.push(drawParcels(rank(near.map(f))));
  const tx = [], ty = [], tw = [];
  for (let i = 0; i < D.trees.count.length; i++) { tx.push(D.trees.cellXY[i * 2]); ty.push(D.trees.cellXY[i * 2 + 1]); tw.push(D.trees.count[i]); }
  planes.push(density(tx, ty, tw, 22));
  const gx = [], gy = [], gw = [];
  for (let i = 0; i < grow.length / 4; i++) { gx.push(grow[i * 4]); gy.push(grow[i * 4 + 1]); gw.push(Math.max(1, grow[i * 4 + 3])); }
  planes.push(density(gx, gy, gw, 45));

  // pack eight grey planes into two RGBA textures
  const pack = (a, b, c, d) => {
    const data = new Uint8Array(TEX * TEX * 4);
    for (let i = 0; i < TEX * TEX; i++) { data[i * 4] = a[i * 4]; data[i * 4 + 1] = b[i * 4]; data[i * 4 + 2] = c[i * 4]; data[i * 4 + 3] = d[i * 4]; }
    const t = new THREE.DataTexture(data, TEX, TEX, THREE.RGBAFormat);
    t.magFilter = THREE.NearestFilter; t.minFilter = THREE.LinearFilter; t.needsUpdate = true;
    return t;
  };
  const F1 = pack(...planes.slice(0, 4)), F2 = pack(...planes.slice(4, 8));

  // ---- the compass rose, drawn over the city ----
  const svg = ov.svg, NS = 'http://www.w3.org/2000/svg';
  const ring = document.createElementNS(NS, 'path');
  ring.setAttribute('fill', 'none'); ring.setAttribute('stroke', '#F0F4EF'); ring.setAttribute('stroke-width', 1.4); ring.setAttribute('stroke-opacity', .8);
  const ring2 = document.createElementNS(NS, 'path');
  ring2.setAttribute('fill', 'none'); ring2.setAttribute('stroke', '#F0F4EF'); ring2.setAttribute('stroke-width', 1); ring2.setAttribute('stroke-opacity', .35);
  const spokes = Array.from({ length: 8 }, () => { const l = document.createElementNS(NS, 'line'); l.setAttribute('stroke', '#F0F4EF'); l.setAttribute('stroke-width', 1); l.setAttribute('stroke-opacity', .55); return l; });
  const ticks = document.createElementNS(NS, 'path');
  ticks.setAttribute('fill', 'none'); ticks.setAttribute('stroke', '#F0F4EF'); ticks.setAttribute('stroke-width', 1); ticks.setAttribute('stroke-opacity', .5);
  const hub = document.createElementNS(NS, 'circle');
  hub.setAttribute('r', 5); hub.setAttribute('fill', '#1B1418'); hub.setAttribute('stroke', '#F77138'); hub.setAttribute('stroke-width', 2);
  for (const e of [ring2, ring, ticks, ...spokes, hub]) { e.style.opacity = 0; svg.appendChild(e); }
  const labels = READINGS.map((txt, k) => ov.add('s6-l' + k, txt, 'tag'));

  ov.add('s6-hl', 'One city,<br>read eight ways.', 'hl', { left: '120px', top: '792px' });
  const words = ov.splitWords('s6-hl');
  const WT = [41.35, 41.55, 41.8, 41.95, 42.12];
  const legend = ov.add('s6-leg', `<span class="tk">Low</span><i class="ramp rev"></i><span class="tk">High, in each reading</span>`, 'legend', { left: '122px', top: '958px' });

  const heading = (a, r, h = 2) => toScreen(W.camera, cx + Math.sin(a) * r, cy + Math.cos(a) * r, h);
  const ellipse = (r, n = 96, a0 = 0, a1 = Math.PI * 2) => {
    let d = '';
    for (let i = 0; i <= n; i++) { const p = heading(a0 + (a1 - a0) * i / n, r); if (!p) return ''; d += (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }
    return d;
  };

  function update(t) {
    const on = t > 40.4 && t < 46.6;
    const fo = on ? heroEase(seg(t, 40.7, 41.2)) * (1 - inOut(seg(t, ...T.out))) : 0;
    bu.uFieldOn.value = fo;
    if (fo > 0) {
      bu.uField.value = F1; bu.uField2.value = F2;
      bu.uFieldRect.value.set(x0, y0, x0 + 2 * HALF, y0 + 2 * HALF);
      bu.uCompass.value.set(cx, cy, R);
    }
    const rot = TURN * inOut(seg(t, ...T.turn));
    bu.uCompassRot.value = rot;
    bu.uSweep.value = Math.PI * 2 * inOut(seg(t, ...T.sweep)) + (t > T.sweep[1] ? 1 : 0);
    bu.uFieldDimOut.value = .5;

    // the rose: the ring draws round with the sweep, spokes between the wedges, a label per wedge
    const sw = inOut(seg(t, ...T.sweep)), o = fo;
    const a0 = rot - Math.PI / 8;
    ring.setAttribute('d', o > 0 ? ellipse(R, 128, a0, a0 + Math.PI * 2 * Math.max(sw, .001)) : '');
    ring2.setAttribute('d', o > 0 ? ellipse(R + 55, 128) : '');
    ring.style.opacity = o; ring2.style.opacity = o * sw;
    let td = '';
    if (o > 0) for (let i = 0; i < 72; i++) {
      const a = rot + i * Math.PI / 36, p = heading(a, R), q = heading(a, R + (i % 9 === 0 ? 38 : 16));
      if (p && q) td += `M${p[0].toFixed(1)} ${p[1].toFixed(1)}L${q[0].toFixed(1)} ${q[1].toFixed(1)}`;
    }
    ticks.setAttribute('d', td); ticks.style.opacity = o * sw;
    const c0 = toScreen(W.camera, cx, cy, 2);
    if (c0) { hub.setAttribute('cx', c0[0]); hub.setAttribute('cy', c0[1]); }
    hub.style.opacity = o;
    for (let k = 0; k < 8; k++) {
      const a = rot - Math.PI / 8 + k * Math.PI / 4;
      const p = heading(a, 60), q = heading(a, R);
      const ks = clamp((sw * 8 - k) * 1.2);
      if (p && q) { spokes[k].setAttribute('x1', p[0]); spokes[k].setAttribute('y1', p[1]); spokes[k].setAttribute('x2', q[0]); spokes[k].setAttribute('y2', q[1]); }
      spokes[k].style.opacity = o * ks;
      const L = heading(rot + k * Math.PI / 4, R + 190), lab = labels[k];
      const lo = o * heroEase(clamp((sw * 8 - k - .3) * 1.4));
      show(lab, L ? lo : 0);
      if (L) lab.style.transform = `translate(${L[0]}px, ${L[1]}px) translate(-50%, -50%)`;
    }

    revealWordsAt(words, t, WT);
    ov.get('s6-hl').style.opacity = 1 - heroEase(seg(t, 45.7, 46.3));
    show(legend, heroEase(seg(t, 42.0, 42.6)) * (1 - heroEase(seg(t, 45.7, 46.3))));
  }

  // camera: down from the corridor onto the compass, then a slow turn against the compass's own
  const keys = [
    [41.6, { x: cx + 150, y: cy - 330, w: 4100, pitch: 53, yaw: -62, fov: 20 }],
    [45.9, { x: cx + 110, y: cy - 250, w: 3800, pitch: 57, yaw: -38, fov: 20, hold: true }],
  ];
  return { update, keys };
}
