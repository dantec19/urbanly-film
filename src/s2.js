// s2.js: dusk falls on one neighbourhood and the city fills with agents. Amber = life: people travel home
// from work along their routed paths, windows light up, and the headline names the agent types while a tag
// finds each one in the scene.
import * as THREE from 'three';
import { makeAgents, loadAgentPaths } from './agents.js';
import { seg, clamp, lerp, heroEase, easeOut, fmt } from './util.js';
import { toScreen } from './camera.js';
import { revealWordsAt, inOut as blockInOut, show } from './overlay.js';

// the neighbourhood the camera settles on (metres, y north): Caballito, around the showcase lot of scene three
// (data/showcase: parcel 109670 on Av. José María Moreno, centroid -5755, -1600)
export const LOT = [-5755.4, -1600.3];
export const FOCUS = [LOT[0] + 110, LOT[1] + 150];
export const DEV_AT = [LOT[0] + 80, LOT[1] + 70];

const exists = async u => { try { const r = await fetch(u, { method: 'HEAD' }); return r.ok; } catch { return false; } };

// a map callout: ring at the anchor, a hairline up, the label on top
function makeTag(ov, id, text) {
  const el = ov.add(id, text, 'tag');
  const line = ov.svgAdd(id + '-l', 'line', { stroke: '#FFB547', 'stroke-width': 1, 'stroke-opacity': .7 });
  const dot = ov.svgAdd(id + '-d', 'circle', { r: 5, fill: 'none', stroke: '#FFB547', 'stroke-width': 1.5 });
  return {
    place(p, o, rise = 52) {
      const vis = p && o > .001;
      show(el, vis ? o : 0);
      line.setAttribute('opacity', vis ? o : 0); dot.setAttribute('opacity', vis ? o : 0);
      if (!vis) return;
      const [x, y] = p, k = heroEase(clamp(o * 1.6));
      line.setAttribute('x1', x); line.setAttribute('y1', y - 6); line.setAttribute('x2', x); line.setAttribute('y2', y - 6 - rise * k);
      dot.setAttribute('cx', x); dot.setAttribute('cy', y); dot.setAttribute('r', 3 + 2 * k);
      el.style.transform = `translate(${x - 1}px, ${y - rise * k - 26}px)`;
    },
  };
}

export async function setupS2(W) {
  const { ov, scene, camera, D, G } = W;
  // the city-wide sample and the pairs that touch this neighbourhood (data/film/commute_near.json), as one set
  const prefix = await exists('data/film/agents_len.f32') ? 'data/film/agents' : 'data/film-test/agents';
  const parts = [await loadAgentPaths(prefix)];
  if (await exists('data/film/agents_near_len.f32')) parts.push(await loadAgentPaths('data/film/agents_near'));
  const paths = joinPaths(parts);
  const ag = makeAgents(paths, { t0: 10.2, spread: 7, speed: 620 });
  const au = ag.mesh.material.uniforms;
  au.uRes.value.set(1920 * G.dpr, 1080 * G.dpr); au.uPx.value = G.dpr;
  scene.add(ag.mesh);

  // ---- headline ----
  ov.add('s2-hl', 'Every person, household, firm<br>and developer is an agent.', 'hl', { left: '120px', top: '792px' });
  const words = ov.splitWords('s2-hl');
  const WT = [10.95, 11.15, 11.42, 11.7, 11.92, 12.06, 12.36, 12.48, 12.6];
  const s = D.stats;
  ov.add('s2-figs', `${fmt(s.persons)} people &nbsp;·&nbsp; ${fmt(s.households)} households &nbsp;·&nbsp; ${fmt(s.jobs)} jobs`, 'figs', { left: '120px', top: '952px' });

  // ---- the four tags and what they point at ----
  const B = D.buildings;
  const near = (x, y, r, pred) => {
    let best = -1, bd = Infinity;
    for (let b = 0; b < B.h.length; b++) {
      const d = Math.hypot(B.cx[b] - x, B.cy[b] - y);
      if (d < r && pred(b) && d < bd) { bd = d; best = b; }
    }
    return best;
  };
  const home = near(FOCUS[0] - 350, FOCUS[1] + 200, 400, b => B.type[b] === 0 && B.h[b] > 18 && B.h[b] < 45);
  // a firm: an employer's building (commerce, offices, food, hospital) near the right of the frame
  const firm = near(FOCUS[0] + 380, FOCUS[1] + 120, 700, b => [2, 5, 10, 12].includes(B.type[b]) && B.h[b] > 5);
  // the person: an agent already on its way home when its word appears, arriving before the tags leave,
  // and near the focus from start to finish; its tag lets go when it gets home
  let person = -1, pd = Infinity;
  const pp = [0, 0];
  for (const [teMin, R] of [[13.8, 520], [13.4, 650], [12.9, 800], [12.4, 1000]]) {
    for (let i = 0; i < ag.N; i++) {
      if (ag.travelled(i, 11.1) < 0) continue;
      const te = ag.dep[i] + ag.paths.len[i] / ag.speed[i];
      if (te < teMin || te > 15.8) continue;
      let worst = 0, sum = 0, ok = true;
      for (const tt of [11.1, (11.1 + te) / 2, te - .05]) {
        const a = ag.position(i, tt, pp); if (!a) { ok = false; break; }
        const d = Math.hypot(pp[0] - FOCUS[0] + 40, pp[1] - FOCUS[1] + 40);
        worst = Math.max(worst, d); sum += d;
      }
      if (ok && worst < R && sum < pd) { pd = sum; person = i; }
    }
    if (person >= 0) { console.log(`s2: person arrives at ${(ag.dep[person] + ag.paths.len[person] / ag.speed[person]).toFixed(2)} s, within ${R} m`); break; }
  }
  console.log(`s2: ${ag.N} agents; person ${person}, home ${home} (${home >= 0 ? B.h[home].toFixed(0) : '-'} m), firm ${firm} (${firm >= 0 ? B.h[firm].toFixed(0) : '-'} m)`);
  const tags = {
    person: makeTag(ov, 's2-t-person', 'Person'),
    household: makeTag(ov, 's2-t-household', 'Household'),
    firm: makeTag(ov, 's2-t-firm', 'Firm'),
    developer: makeTag(ov, 's2-t-developer', 'Developer'),
  };

  // ---- the developer: an amber diamond that will lead the camera to its parcel ----
  const dev = new THREE.Mesh(new THREE.OctahedronGeometry(1, 0), new THREE.MeshBasicMaterial({ color: new THREE.Color('#FFB547').multiplyScalar(2.2), transparent: true, depthTest: false }));
  dev.renderOrder = 12; dev.visible = false; scene.add(dev);

  const keys = [
    [11.4, { x: FOCUS[0] - 80, y: FOCUS[1] - 170, w: 1560, pitch: 32, yaw: 36, fov: 16 }],
    [16.6, { x: FOCUS[0] + 20, y: FOCUS[1] - 60, w: 1150, pitch: 35, yaw: 24, fov: 16 }],
  ];

  function update(t, cs, L) {
    const on = t > 10 && t < 26;
    ag.mesh.visible = on;
    if (on) {
      ag.update(t, { density: 1, trail: 110, lift: 2 });
      au.uWidth.value = lerp(2.6, 2.0, clamp((cs.w - 1200) / 2000));
      au.uOpacity.value = smoothFade(t, 10.2, 11.2, 24, 25.5);
    }

    revealWordsAt(words, t, WT);
    const oh = 1 - heroEase(seg(t, 16.2, 16.9));
    ov.get('s2-hl').style.opacity = oh;
    blockInOut(ov.get('s2-figs'), t, 12.9, 16.7, { din: .8, dout: .6 });

    // tags: in with their word, out together before scene three
    const tagO = (t0) => heroEase(seg(t, t0, t0 + .5)) * (1 - heroEase(seg(t, 15.9, 16.5)));
    const pos = person >= 0 ? ag.position(person, t, pp) : null;
    const left = person >= 0 ? ag.paths.len[person] - ag.travelled(person, t) : 0;
    tags.person.place(pos ? toScreen(camera, pos[0], pos[1], 2) : null, pos ? tagO(11.22) * clamp(left / 90) : 0);
    tags.household.place(home >= 0 ? toScreen(camera, B.cx[home], B.cy[home], B.h[home] * .75) : null, tagO(11.48), 60);
    tags.firm.place(firm >= 0 ? toScreen(camera, B.cx[firm], B.cy[firm], B.h[firm]) : null, tagO(11.78), 48);

    // developer glyph: appears with its word, hovers over its parcel
    const dO = heroEase(seg(t, 12.1, 12.6));
    dev.visible = dO > .001 && t < 16.9;
    if (dev.visible) {
      const bob = 2.5 * Math.sin(t * 2.4);
      const D0 = camera.position.distanceTo(new THREE.Vector3(DEV_AT[0], 30, -DEV_AT[1]));
      const sz = D0 * .006 * (.6 + .4 * dO);
      dev.scale.set(sz * .7, sz, sz * .7);
      dev.rotation.y = t * 1.3;
      dev.position.set(DEV_AT[0], 30 + bob, -DEV_AT[1]);
      dev.material.opacity = dO;
    }
    tags.developer.place(dev.visible ? toScreen(camera, DEV_AT[0], DEV_AT[1], 30) : null, dev.visible ? tagO(12.12) : 0, 46);
  }
  return { keys, update, agents: ag, dev, devTag: tags.developer };
}

function joinPaths(parts) {
  let nV = 0, nP = 0;
  for (const p of parts) { nV += p.xy.length / 2; nP += p.len.length; }
  const xy = new Float32Array(nV * 2), off = new Uint32Array(nP + 1), len = new Float32Array(nP);
  let v = 0, q = 0;
  for (const p of parts) {
    xy.set(p.xy, v * 2);
    for (let i = 0; i < p.len.length; i++) { off[q + i] = p.off[i] + v; len[q + i] = p.len[i]; }
    v += p.xy.length / 2; q += p.len.length;
  }
  off[nP] = v;
  return { xy, off, len };
}

function smoothFade(t, a0, a1, b0, b1) { return heroEase(seg(t, a0, a1)) * (1 - seg(t, b0, b1)); }
