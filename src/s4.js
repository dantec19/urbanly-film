// s4.js: the decade. The run's own ten years play out on the city, one year at a time: every building the
// model's developers start rises in amber over its construction period, every building they replace sinks,
// and back-of-lot additions spark on their lots. Numbers come from the run (data/film, data/sim).
import * as THREE from 'three';
import { makeBuildings } from './buildings.js';
import { seg, clamp, lerp, heroEase, easeOut, inOut, fmt, kf } from './util.js';
import { revealWordsAt, inOut as blockInOut, show } from './overlay.js';
import { toScreen } from './camera.js';
import { makeMapper, drawGrowth, canvasTexture, newCanvas } from './tiles.js';

const get = async (u, T) => { const r = await fetch(u); if (!r.ok) throw new Error(u + ' ' + r.status); return new T(await r.arrayBuffer()); };

// the film clock → the run's clock (years since 2022-01-01)
export const YEAR_KEYS = [[25.3, 0], [30.7, 10], [33.3, 10], [34.5, 0]];
export const yearAt = t => kf(t, YEAR_KEYS, x => x < .5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);

const SPARK_VERT = /* glsl */`
uniform float uYear;
uniform float uPx;
uniform float uScale;
attribute float aT;
attribute float aU;
varying float vA;
varying float vHot;
void main() {
  float age = uYear - aT;
  vA = age < 0. ? 0. : 1.;
  vHot = age < 0. ? 0. : exp(-age / .35);
  vec4 mv = modelViewMatrix * vec4(position, 1.);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = vA * uPx * uScale * (2.2 + 5. * vHot) * clamp(900. / -mv.z, .6, 3.);
  if (vA < .5) gl_Position = vec4(2., 2., 2., 1.);
}`;
const SPARK_FRAG = /* glsl */`
uniform vec3 uCol;
uniform float uOpacity;
varying float vA;
varying float vHot;
void main() {
  vec2 p = gl_PointCoord * 2. - 1.;
  float r = dot(p, p);
  float a = exp(-r * 3.2);
  gl_FragColor = vec4(uCol * (1. + 3. * vHot), a * vA * uOpacity * (.55 + .45 * vHot));
}`;

export async function setupS4(W, s3) {
  const { scene, ov, G, D, bld } = W;
  const [nxy, noff, nbld, meta, fxy, fmeta, demRow, demT, demShare] = await Promise.all([
    get('data/film/new_ring_xy.f32', Float32Array), get('data/film/new_ring_off.u32', Uint32Array), get('data/film/new_ring_bld.u32', Uint32Array),
    get('data/film/new_meta.f32', Float32Array), get('data/film/fondo_xy.f32', Float32Array), get('data/film/fondo_meta.f32', Float32Array),
    get('data/film/demolitions_row.u32', Uint32Array), get('data/film/demolitions_t.f32', Float32Array), get('data/film/demolitions_lot_share.f32', Float32Array),
  ]);
  const totals = await fetch('data/sim/buenosaires-totals.json').then(r => r.json());

  // ---- the run's new buildings ----
  const nN = meta.length / 8;
  const h = new Float32Array(nN), born = new Float32Array(nN), done = new Float32Array(nN), gone = new Float32Array(nN), group = new Float32Array(nN);
  for (let i = 0; i < nN; i++) {
    const m = i * 8;
    h[i] = meta[m + 2]; born[i] = Math.max(meta[m], .001); done[i] = Math.max(meta[m + 1], born[i] + .3);
    gone[i] = Number.isNaN(meta[m + 7]) ? 1e5 : meta[m + 7];
    // scene three's building stands on its own mesh; this copy never rises
    if (s3 && s3.ids[i] === s3.devID) { h[i] = 0; gone[i] = 0; }
  }
  const nb = makeBuildings({ xy: nxy, off: noff, bld: nbld }, { h, born, done, gone, group }, { ramp: W.ramp });
  const nu = nb.userData.material.uniforms;
  nu.uRiseAll.value = 1;
  scene.add(nb);

  // ---- demolitions: the seed buildings the run tears down. The engine also clears every neighbour whose
  // footprint touches a redeveloped lot by a sliver; those (under a tenth of the footprint on the lot) stay.
  const bT1 = bld.userData.t1;
  let nDem = 0, nSliver = 0;
  for (let k = 0; k < demRow.length; k++) {
    if (demShare[k] < .1) { nSliver++; continue; }
    const b = demRow[k];
    if (b === s3?.oldRow) continue;
    bT1[b * 4 + 3] = Math.min(bT1[b * 4 + 3], demT[k]); nDem++;
  }
  bld.userData.T1.needsUpdate = true;

  // ---- back-of-lot additions: sparks on their lots ----
  const nF = fmeta.length / 4;
  const fpos = new Float32Array(nF * 3), fT = new Float32Array(nF), fU = new Float32Array(nF);
  for (let i = 0; i < nF; i++) { fpos[i * 3] = fxy[i * 2]; fpos[i * 3 + 1] = 3; fpos[i * 3 + 2] = -fxy[i * 2 + 1]; fT[i] = fmeta[i * 4 + 1]; fU[i] = fmeta[i * 4 + 2]; }
  const fg = new THREE.BufferGeometry();
  fg.setAttribute('position', new THREE.BufferAttribute(fpos, 3));
  fg.setAttribute('aT', new THREE.BufferAttribute(fT, 1));
  fg.setAttribute('aU', new THREE.BufferAttribute(fU, 1));
  const sparks = new THREE.Points(fg, new THREE.ShaderMaterial({
    vertexShader: SPARK_VERT, fragmentShader: SPARK_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uYear: { value: 0 }, uPx: { value: G.dpr }, uScale: { value: 1 }, uCol: { value: new THREE.Color('#FFB547') }, uOpacity: { value: 1 } },
  }));
  sparks.frustumCulled = false; sparks.renderOrder = 6;
  scene.add(sparks);

  // ---- the decade as a stack: ten city-shaped tiles, each holding the homes completed in its year ----
  const growBase = await get('data/film/growth_base.f32', Float32Array);
  const RECT = [-15100, -10300, 3600, 8400], PX = [1024, 1024];
  const map = makeMapper(RECT, PX);
  const bd = W.D.boundary;
  const tracePlate = g => {
    g.beginPath();
    for (let r = 0; r < bd.off.length - 1; r++) {
      for (let k = bd.off[r]; k < bd.off[r + 1]; k++) { const [x, y] = map(bd.xy[k * 2], bd.xy[k * 2 + 1]); k === bd.off[r] ? g.moveTo(x, y) : g.lineTo(x, y); }
      g.closePath();
    }
  };
  const stack = new THREE.Group(); scene.add(stack);
  const tiles = [];
  for (let k = 0; k < 10; k++) {
    const [c, g] = newCanvas(...PX);
    tracePlate(g); g.fillStyle = 'rgba(44,33,39,.2)'; g.fill();
    g.strokeStyle = 'rgba(240,244,239,.5)'; g.lineWidth = 2; g.stroke();
    drawGrowth(g, growBase, map, k, k + 1, { scale: .55 });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(RECT[2] - RECT[0], RECT[3] - RECT[1]), new THREE.MeshBasicMaterial({ map: canvasTexture(c), transparent: true, depthWrite: false, side: THREE.DoubleSide, opacity: 0 }));
    m.rotation.x = -Math.PI / 2; m.position.set((RECT[0] + RECT[2]) / 2, 0, -(RECT[1] + RECT[3]) / 2);
    m.renderOrder = 20 + k; stack.add(m); tiles.push(m);
  }
  const tileLbl = Array.from({ length: 10 }, (_, k) => ov.add('s4-tl' + k, `Year ${k + 1}`, 'eyebrow', { fontSize: '13px' }));
  const STACK_DY = 1050;

  // ---- the run's numbers per year: homes and buildings completed (cumulative) ----
  const yrs = totals.years;
  const cumAt = y => {   // y: run years since start (0..10), linear inside a year
    let homes = 0, blds = 0;
    for (let k = 0; k < yrs.length; k++) {
      const f = clamp(y - k);
      homes += yrs[k].completed.units * f; blds += yrs[k].completed.buildings * f;
    }
    return { homes, blds };
  };
  console.log(`s4: ${nN} new buildings, ${nF} back-of-lot units, ${nDem} demolitions shown (${nSliver} sliver neighbours kept); completed ${fmt(cumAt(10).homes)} homes`);

  // ---- type ----
  ov.add('s4-hl', 'The next ten years,<br>one year at a time.', 'hl', { left: '120px', top: '792px' });
  const words = ov.splitWords('s4-hl');
  const WT = [25.5, 25.68, 25.84, 26.0, 26.3, 26.45, 26.6, 26.72, 26.86];
  const yearEl = ov.add('s4-year', '', 'year', { left: '116px', top: '96px' });
  const yearLbl = ov.add('s4-ylbl', 'Year', 'eyebrow', { left: '122px', top: '82px' });
  const cum = ov.add('s4-cum', '', 'figs', { left: '122px', top: '226px' });

  function update(t, cs, L) {
    const y = yearAt(t);
    nu.uYear.value = y; W.bu.uYear.value = y; sparks.material.uniforms.uYear.value = y;
    // new buildings live in the night palette like the rest
    for (const k of ['uNight', 'uLit', 'uHaze', 'uHazeR', 'uDim']) nu[k].value = W.bu[k].value;
    nu.uLight.value.copy(W.bu.uLight.value); nu.uTarget.value.copy(W.bu.uTarget.value);
    nb.visible = t > 17 && t < 47.8;
    sparks.visible = nb.visible && y > 0;
    sparks.material.uniforms.uOpacity.value = 1 - W.bu.uDim.value;

    // the stack rises out of the finished decade and folds back into the city on the way to the present
    stack.visible = t > 30.4 && t < 34.6;
    for (let k = 0; k < 10; k++) {
      const up = easeOut(seg(t, 30.5 + k * .1, 31.5 + k * .1)), down = inOut(seg(t, 33.0 + (9 - k) * .03, 34.1 + (9 - k) * .03));
      const hgt = (k + 1) * STACK_DY * up * (1 - down);
      tiles[k].position.y = hgt;
      tiles[k].material.opacity = clamp(up * 1.3) * (1 - down);
      const p = toScreen(W.camera, 3350, 1200, hgt);
      const o = tiles[k].material.opacity * (1 - heroEase(seg(t, 32.9, 33.3)));
      show(tileLbl[k], p ? o : 0);
      if (p) tileLbl[k].style.transform = `translate(${p[0] + 78}px, ${p[1] - 8}px)`;
    }

    revealWordsAt(words, t, WT);
    ov.get('s4-hl').style.opacity = 1 - heroEase(seg(t, 32.2, 32.9));
    const oy = heroEase(seg(t, 25.2, 25.8)) * (1 - heroEase(seg(t, 34.4, 34.9)));
    show(yearEl, oy); show(yearLbl, oy); show(cum, oy);
    if (oy > 0) {
      const shown = Math.min(10, Math.floor(y) + 1);
      yearEl.textContent = y <= 0.001 && t > 33 ? 'Today' : String(shown);
      yearLbl.textContent = y <= 0.001 && t > 33 ? '' : 'Year';
      const c = cumAt(y);
      cum.innerHTML = `${fmt(Math.round(c.homes))} homes &nbsp;·&nbsp; ${fmt(Math.round(c.blds))} buildings completed`;
    }
  }
  return { update, newBuildings: nb, yearAt, cumAt };
}
