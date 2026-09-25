// s3.js: one developer, one lot. Parcel 109670 on Av. José María Moreno, Caballito (data/showcase). The
// developer weighs two buildings against the owner's asking price with the model's own pro forma: three floors
// do not pay for the land, ten do. The old house goes and the ten floors rise, one at a time.
import * as THREE from 'three';
import { makeBuildings } from './buildings.js';
import { makeLines } from './lines.js';
import { seg, clamp, lerp, heroEase, easeOut, inOut, backOut, fmt, spring } from './util.js';
import { revealWordsAt, show } from './overlay.js';
import { toScreen } from './camera.js';
import { DEV_AT } from './s2.js';

const FLOOR = 3;
// the film's clock for this scene
const T = {
  glide: [16.9, 18.1],          // the developer glides onto the lot
  house: [17.5, 18.1],          // the old house lights up
  env: [17.9, 18.9],            // the zoning envelope draws itself
  optA: 19.1,                   // option 1: plates, receipt
  failAt: 20.25,
  optB: 20.85,                  // option 2
  passAt: 21.95,
  sink: [22.35, 22.85],         // the old house goes
  rise: [22.7, 24.3],           // ten floors, one at a time
  out: [24.3, 25.0],
};

export async function setupS3(W, s2) {
  const { scene, ov, G, D, bld } = W;
  const sc = await fetch('data/showcase/showcase.json').then(r => r.json());
  const S = sc.showcase, lot = S.parcel, nb = S.newBuilding, old = S.oldBuildings[0];
  const ring = lot.ringM, nR = ring.length / 2;
  const [cx, cy] = lot.centroidM;
  const ENV_H = lot.zone.maxHeightM;

  // ---- the old house: group 1 of the city mesh ----
  const t2 = bld.userData.t2;
  t2[old.row * 4] = 1;
  bld.userData.T2.needsUpdate = true;
  const bu = W.bu;
  bu.uGroupCol.value[1].set('#F0F4EF');

  // ---- the new building: its own mesh, group 2, rising floor by floor ----
  const fr = nb.footprintRingsM[0][0];
  const nbMesh = makeBuildings({ xy: new Float32Array(fr), off: new Uint32Array([0, fr.length / 2]), bld: new Uint32Array([0]) },
    { h: new Float32Array([nb.heightM]), group: new Float32Array([2]) }, { ramp: W.ramp, shadow: W.shadow });
  const nu = nbMesh.userData.material.uniforms;
  nu.uGroupCol.value[2].set('#FFB547'); nu.uGroupMix.value[2] = 1; nu.uFloorLines.value = 1;
  scene.add(nbMesh);

  // ---- the zoning envelope: the lot extruded to the height limit, dashed coral ----
  const ea = [], eb = [], eh = [], eg = [];
  let per = 0;
  for (let i = 0; i < nR; i++) {        // vertical edges first, then the top ring, then the ground ring
    const x = ring[i * 2], y = ring[i * 2 + 1];
    ea.push(x, y); eb.push(x, y); eh.push(0, ENV_H); eg.push(0, ENV_H);
  }
  for (let i = 0; i < nR; i++) {
    const j = (i + 1) % nR, L = Math.hypot(ring[j * 2] - ring[i * 2], ring[j * 2 + 1] - ring[i * 2 + 1]);
    ea.push(ring[i * 2], ring[i * 2 + 1]); eb.push(ring[j * 2], ring[j * 2 + 1]); eh.push(ENV_H, ENV_H); eg.push(ENV_H + per, ENV_H + per + L);
    ea.push(ring[i * 2], ring[i * 2 + 1]); eb.push(ring[j * 2], ring[j * 2 + 1]); eh.push(0, 0); eg.push(ENV_H + per, ENV_H + per + L);
    per += L;
  }
  const ENV_LEN = ENV_H + per;
  const nEnv = ea.length / 2;
  const env = makeLines({ a: new Float32Array(ea), b: new Float32Array(eb), h: new Float32Array(eh), grow: new Float32Array(eg), cls: new Uint8Array(nEnv).fill(2) }, { renderOrder: 14, depthTest: false });
  const envU = env.material.uniforms;
  envU.uRes.value.set(1920 * G.dpr, 1080 * G.dpr); envU.uPx.value = G.dpr;
  envU.uWidth.value.set(2.2, 2.2, 2.2); envU.uAlpha.value.set(1, 1, 1); envU.uLift.value = 0; envU.uGrowAll.value = 0; envU.uHeatLen.value = 6;
  envU.uBone.value.set('#F77138'); envU.uHot.value.set('#FFD2BA').multiplyScalar(2); envU.uDash.value = 1.6;
  scene.add(env);

  // ---- the massing study: a plate per floor, amber outlines over a faint fill ----
  const PLATES = nb.stories + 1;
  const pa = [], pb = [], ph = [], pg = [];
  for (let k = 0; k < PLATES; k++) for (let i = 0; i < nR; i++) {
    const j = (i + 1) % nR;
    pa.push(ring[i * 2], ring[i * 2 + 1]); pb.push(ring[j * 2], ring[j * 2 + 1]); ph.push(k * FLOOR + .15, k * FLOOR + .15); pg.push(k, k + .001);
  }
  const plates = makeLines({ a: new Float32Array(pa), b: new Float32Array(pb), h: new Float32Array(ph), grow: new Float32Array(pg), cls: new Uint8Array(pa.length / 2).fill(2) }, { renderOrder: 13, depthTest: false });
  const plU = plates.material.uniforms;
  plU.uRes.value.set(1920 * G.dpr, 1080 * G.dpr); plU.uPx.value = G.dpr;
  plU.uWidth.value.set(1.6, 1.6, 1.6); plU.uAlpha.value.set(.95, .95, .95); plU.uLift.value = 0; plU.uGrowAll.value = 0; plU.uHeatLen.value = .6;
  plU.uBone.value.set('#FFB547'); plU.uHot.value.set('#FFE2B8').multiplyScalar(2.2);
  scene.add(plates);
  const shape = new THREE.Shape();
  for (let i = 0; i < nR; i++) i ? shape.lineTo(ring[i * 2], ring[i * 2 + 1]) : shape.moveTo(ring[0], ring[1]);
  const fillGeo = new THREE.ShapeGeometry(shape);
  fillGeo.rotateX(-Math.PI / 2);
  const fills = Array.from({ length: PLATES }, (_, k) => {
    const m = new THREE.Mesh(fillGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color('#FFB547'), transparent: true, opacity: 0, depthWrite: false, depthTest: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
    m.position.y = k * FLOOR + .1; m.renderOrder = 12; scene.add(m);
    return m;
  });

  // S4 plays the whole run: keep its copy of this building out, the one here stays
  const ids = await fetch('data/film/new_id.u32').then(r => r.arrayBuffer()).then(b => new Uint32Array(b));

  // ---- the receipt ----
  const A = S.receipt.optionA.lines, B = S.receipt.optionB.lines;
  const K = (o, i) => o[i].usdK;
  const rc = ov.add('s3-rc', `
    <div class="eb">Pro forma &nbsp;·&nbsp; ${S.barrio}</div>
    <div class="ti"><span class="opt">Option 1</span><span class="what">3 floors · 4 flats</span></div>
    <div class="row"><span>Sale of the flats</span><b data-k="0"></b></div>
    <div class="row"><span>Construction and fees</span><b data-k="1"></b></div>
    <div class="row"><span>Developer’s 15% return</span><b data-k="2"></b></div>
    <div class="rule"></div>
    <div class="row hi"><span>Left to pay for the land</span><b data-k="3"></b></div>
    <div class="bar"><i class="fill"></i><i class="ask"></i><span class="askl">Owner asks ${fmt(K(A, 4))}</span></div>
    <div class="vd"></div>
    <div class="ft">USD thousands &nbsp;·&nbsp; the model’s own pro forma</div>`, 'panel rc', { left: '1262px', top: '214px' });
  const nums = [...rc.querySelectorAll('b[data-k]')];
  const opt = rc.querySelector('.opt'), what = rc.querySelector('.what'), vd = rc.querySelector('.vd'), fill = rc.querySelector('.fill'), ask = rc.querySelector('.ask'), askl = rc.querySelector('.askl');
  const BAR_W = 368, BAR_MAX = K(B, 3) * 1.04;
  ask.style.left = askl.style.left = `${K(A, 4) / BAR_MAX * BAR_W}px`;

  // ---- type ----
  ov.add('s3-hl', 'Developers build only<br>what pencils out.', 'hl', { left: '120px', top: '792px' });
  const words = ov.splitWords('s3-hl');
  const WT = [18.3, 18.52, 18.72, 19.0, 19.16, 19.36];
  const envTag = ov.add('s3-env', `Zoning limit &nbsp;${ENV_H.toFixed(1)} m`, 'tag coral');

  const dev = s2.dev, devTag = s2.devTag;
  // where scene two left it hovering (its bob frozen at the hand-over)
  const devFrom = new THREE.Vector3(DEV_AT[0], 30 + 2.5 * Math.sin(T.glide[0] * 2.4), -DEV_AT[1]), devTo = new THREE.Vector3(cx, ENV_H + 12, -cy);

  function update(t) {
    const on = t > 16.5 && t < 26;
    // the old house: lit while it is weighed, gone when the lot is bought
    bu.uGroupMix.value[1] = on ? .55 * heroEase(seg(t, ...T.house)) * (1 - seg(t, T.sink[0], T.sink[1])) : 0;
    const sunk = inOut(seg(t, ...T.sink)) * (1 - inOut(seg(t, 33.4, 34.2)));
    bu.uGroupH.value[1] = 1 - sunk;

    // the new building: ten floors, one after another; back into the ground when the film rewinds to today
    const rk = seg(t, ...T.rise) * nb.stories;
    const fl = Math.floor(rk), fk = rk - fl;
    const hk = fl >= nb.stories ? 1 : (fl + backOut(clamp(fk / .55), 2)) / nb.stories;
    nu.uGroupH.value[2] = hk * (1 - inOut(seg(t, 33.4, 34.2)));
    nbMesh.visible = t > T.rise[0] && nu.uGroupH.value[2] > .002;
    for (const k of ['uNight', 'uLit', 'uHaze', 'uHazeR', 'uDim', 'uDirect', 'uAmbient']) nu[k].value = bu[k].value;
    nu.uLight.value.copy(bu.uLight.value); nu.uTarget.value.copy(bu.uTarget.value); nu.uSunC.value.copy(bu.uSunC.value);
    nu.uGroupMix.value[2] = lerp(1, .55, seg(t, 24.4, 26));

    // envelope
    env.visible = on && t > T.env[0];
    envU.uGrow.value = ENV_LEN * easeOut(seg(t, ...T.env));
    envU.uOpacity.value = 1 - seg(t, 24.3, 24.9);
    // the limit's label sits off the envelope's right-most top corner
    let tp = null;
    for (let i = 0; i < nR; i++) { const q = toScreen(W.camera, ring[i * 2], ring[i * 2 + 1], ENV_H); if (q && (!tp || q[0] > tp[0])) tp = q; }
    show(envTag, env.visible && tp ? heroEase(seg(t, 18.6, 19.1)) * (1 - seg(t, 24.2, 24.7)) : 0);
    if (tp) envTag.style.transform = `translate(${tp[0] + 16}px, ${tp[1] - 8}px)`;

    // plates: option 1 = ground + 3 floors, option 2 = ground + 10 floors; they hand over to the rising building
    const nA = 4 * heroEase(seg(t, T.optA, T.optA + .45));
    const nBp = (PLATES - 4) * easeOut(seg(t, T.optB + .05, T.optB + .9));
    const shown = t < T.optA ? 0 : nA + (t > T.optB ? nBp : 0);
    plates.visible = on && shown > 0;
    plU.uGrow.value = shown - .999;
    plU.uOpacity.value = 1 - seg(t, 24.1, 24.6);
    for (let k = 0; k < PLATES; k++) {
      const vis = clamp(shown - k);
      const built = rk * FLOOR > k * FLOOR + 1.2;
      fills[k].visible = on && vis > 0;
      fills[k].material.opacity = vis * (built ? .0 : .035) * (1 - seg(t, 24.1, 24.6));
    }

    // the developer: glides from its hover point onto the lot, watches, then leaves with the building up
    if (t >= T.glide[0] && t < 24.8) {
      const k = inOut(seg(t, ...T.glide));
      const p = new THREE.Vector3().lerpVectors(devFrom, devTo, k);
      p.y += Math.sin(t * 2.4) * .8 + 4 * Math.sin(Math.PI * k);
      const away = easeOut(seg(t, 23.6, 24.6));
      p.y += away * 60;
      dev.visible = true; dev.position.copy(p);
      const D0 = W.camera.position.distanceTo(p);
      const sz = D0 * .006;
      dev.scale.set(sz * .7, sz, sz * .7); dev.rotation.y = t * 1.3;
      dev.material.opacity = 1 - away;
      devTag.place(null, 0);
    } else if (t >= 24.8 && t < 26) dev.visible = false;

    // receipt: in, option 1 lines, fail; option 2 rolls the numbers up, pass
    const oR = heroEase(seg(t, T.optA - .1, T.optA + .5)) * (1 - heroEase(seg(t, 24.2, 24.8)));
    show(rc, oR);
    if (oR > 0) {
      rc.style.transform = `translate(${(1 - heroEase(seg(t, T.optA - .1, T.optA + .6))) * 30}px, 0)`;
      const roll = inOut(seg(t, T.optB, T.optB + .9));
      for (let i = 0; i < 4; i++) {
        const lineIn = heroEase(seg(t, T.optA + .25 + i * .16, T.optA + .6 + i * .16));
        nums[i].parentElement.style.opacity = lineIn;
        const v = Math.round(lerp(K(A, i), K(B, i), roll));
        nums[i].textContent = (v < 0 ? '−' : '') + fmt(Math.abs(v));
      }
      rc.querySelector('.bar').style.opacity = heroEase(seg(t, T.optA + .75, T.optA + 1.1));
      const land = lerp(K(A, 3), K(B, 3), roll) * easeOut(seg(t, T.optA + .8, T.failAt));
      fill.style.width = `${land / BAR_MAX * BAR_W}px`;
      const second = t > T.optB;
      opt.textContent = second ? 'Option 2' : 'Option 1';
      what.textContent = second ? '10 floors · 18 flats' : '3 floors · 4 flats';
      what.style.opacity = second ? heroEase(seg(t, T.optB, T.optB + .35)) : 1;
      const failO = heroEase(seg(t, T.failAt, T.failAt + .3)) * (1 - heroEase(seg(t, T.optB - .1, T.optB + .15)));
      const passO = heroEase(seg(t, T.passAt, T.passAt + .3));
      if (passO > 0) {
        vd.className = 'vd pass'; vd.innerHTML = `Pencils out &nbsp;·&nbsp; buys the lot for ${fmt(K(B, 5))}`;
        vd.style.opacity = passO; vd.style.transform = `scale(${1 + .06 * spring(t, T.passAt, 7, 20)})`;
      } else {
        vd.className = 'vd fail'; vd.innerHTML = `Does not pencil out &nbsp;·&nbsp; short by ${fmt(K(A, 5))}`;
        vd.style.opacity = failO; vd.style.transform = `translateX(${6 * spring(t, T.failAt, 6, 34)}px)`;
      }
      fill.classList.toggle('pass', t > T.passAt - .25);
    }

    revealWordsAt(words, t, WT);
    ov.get('s3-hl').style.opacity = 1 - heroEase(seg(t, 24.4, 25.0));
  }

  // camera: close on the lot from the avenue side, a slow orbit while the developer does its sums
  const aim = (dx, dy) => [cx + dx, cy + dy];
  const [k1x, k1y] = aim(26, 14), [k2x, k2y] = aim(24, 18), [k3x, k3y] = aim(20, 20);
  const keys = [
    [18.3, { x: k1x, y: k1y, h: 12, w: 205, pitch: 31, yaw: -24, fov: 16 }],
    [21.4, { x: k2x, y: k2y, h: 14, w: 190, pitch: 29, yaw: -33, fov: 16 }],
    [24.3, { x: k3x, y: k3y, h: 17, w: 205, pitch: 28, yaw: -42, fov: 16, hold: true }],
  ];
  return { update, keys, ids, devID: nb.id, oldRow: old.row };
}
