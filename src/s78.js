// s78.js: two futures, then the mark. The city lies down into a map: a slab of the present at true scale,
// centred on the new line. The line's corridor lifts off it and forks into two towers of yearly tiles: the
// left tower is the baseline run, the right one the run with the line and its station zoning. Then the towers
// close into solid arms, the slab thickens into the base, the last year's tiles lift off, the depth folds
// flat, and the shape is the Urbanly voxel U, which was always two futures on one foundation.
//
// Geometry is built in the mark's own units (the SVG's viewBox units): X runs right-down on screen, Z right-up,
// Y up. With the camera at yaw -45°, pitch 30° (2:1 dimetric) local X = world east, local Z = world north,
// and a height of Y units is 0.8165·Y so that the projection matches the SVG exactly.
import * as THREE from 'three';
import { clamp, lerp, seg, smooth, inOut, easeOut, heroEase, backOut, fmt } from './util.js';
import { toScreen } from './camera.js';
import { show, revealWordsAt, inOut as blockInOut } from './overlay.js';
import { makeMapper, drawStreets, drawGrowth, drawLine, drawDiscs, canvasTexture, newCanvas } from './tiles.js';

export const S = 384;                 // metres per mark unit: the slab is the city at true scale
const VS = Math.sqrt(2 / 3);          // 0.8165: vertical factor under 2:1 dimetric
const ARM_W = 27, DEPTH = 23.4, GAP = 20.5, BASE_H = 29.7, ARM_TOP = 89, LIFT = 10.5;
const SPAN = 2 * ARM_W + GAP;         // 74.5: the base
const YEARS = 10;
const SLOT = (ARM_TOP - BASE_H) / (YEARS - 1);   // the arm holds years 1..9; year 10 is the lifted tile
const X0 = [0, ARM_W + GAP];                       // left / right tower X start
const XC = (SPAN - ARM_W) / 2;                     // the corridor: one arm wide, in the middle of the slab
const TH = 1.3;                                    // tile thickness while the towers stand
const Y1 = BASE_H + (SLOT - TH) / 2;               // bottom of the first year's tile
// centre of the new line's bounding box (data/line/line.json): the slab and the corridor are centred on it
const LINE_C = [-2967.1, -890.15];
export const ORIGIN = [LINE_C[0] - SPAN / 2 * S, LINE_C[1] - DEPTH / 2 * S];
const rectOf = (x0, x1) => [ORIGIN[0] + x0 * S, ORIGIN[1], ORIGIN[0] + x1 * S, ORIGIN[1] + DEPTH * S];
export const BASE_RECT = rectOf(0, SPAN), TILE_RECT = rectOf(XC, XC + ARM_W);

// SVG → local: x_svg = 36.6 + X + Z, y_svg = 143.5 + X/2 - Z/2 - Y  (Y in mark units)
export const MARK = {
  body: [[84.1, 138.3], [63.6, 127.2], [63.6, 67.5], [36.6, 54.5], [36.6, 143.5], [84.1, 167], [111.1, 153], [111.1, 90], [84.1, 77]],
  left: [[86.9, 45.1], [60, 32.2], [36.6, 44.5], [63.6, 57.5]],
  right: [[107.5, 54.7], [84.1, 67.1], [111.1, 80.1], [134.5, 67.7]],
};
// local mark coordinates → world; the slab's top (Y = BASE_H) lies on the ground
export const L2W = (X, Y, Z) => new THREE.Vector3(ORIGIN[0] + X * S, (Y - BASE_H) * VS * S, -(ORIGIN[1] + Z * S));

// timeline (s)
const T = {
  slab: [46.3, 47.1],        // the flattened city becomes the slab
  corridor: [46.95, 47.3],   // the corridor of the line lights up on it
  lift: [47.25, 47.75], fork: [47.35, 48.0],
  y2: 48.05, dy: .33,        // years 2..10 land one after another
  pill: 51.25, dice: 51.5, out: [53.0, 53.45],
  handover: [56.95, 57.15],  // the mark fades in over the folded boxes, drawn where they stand
  settle: [57.15, 57.85],    // then settles onto the file's geometry
};
const landAt = y => T.y2 + (y - 1) * T.dy;          // year index y >= 1 starts to drop

const VERT = /* glsl */`
varying vec3 vN;
varying vec2 vUv;
void main() {
  vN = normal; vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.);
}`;
const FRAG = /* glsl */`
uniform sampler2D uTex;
uniform float uHasTex;
uniform float uSolid;        // 0 = diagram (dark faces, map on top), 1 = the mark (flat bone)
uniform float uFlat;         // 0 = shaded faces, 1 = one flat colour
uniform float uOpacity;
uniform float uEdge;
uniform float uGlow;         // the year's new homes near the line, on the tile's edges
uniform vec3 uGlowC;
uniform vec3 uBone;
uniform vec3 uFace;
uniform vec3 uEdgeC;
varying vec3 vN;
varying vec2 vUv;
void main() {
  bool top = vN.y > .5, front = vN.z > .5, side = vN.x > .5;
  vec3 dia = uFace * (top ? 1. : front ? .78 : side ? .58 : .5);
  if (top && uHasTex > .5) { vec4 tx = texture2D(uTex, vUv); dia = mix(dia, tx.rgb, tx.a); }
  if (!top) dia = mix(dia, uGlowC * (front ? 1. : .7), uGlow);
  vec3 mk = uBone * mix(top ? 1. : front ? .9 : .74, 1., uFlat);
  vec3 c = mix(dia, mk, uSolid);
  // keyline along the face edges, ~1 px
  vec2 fw = fwidth(vUv);
  vec2 e2 = min(vUv, 1. - vUv) / max(fw, vec2(1e-5));
  float e = 1. - smoothstep(.6, 1.6, min(e2.x, e2.y));
  c = mix(c, uEdgeC, e * uEdge);
  gl_FragColor = vec4(c, uOpacity);
}`;

function tileMaterial(tex) {
  return new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: true,
    uniforms: {
      uTex: { value: tex || null }, uHasTex: { value: tex ? 1 : 0 }, uSolid: { value: 0 }, uFlat: { value: 0 }, uOpacity: { value: 1 },
      uEdge: { value: .8 }, uGlow: { value: 0 }, uGlowC: { value: new THREE.Color('#FFB547') },
      uBone: { value: new THREE.Color('#F0F4EF') }, uFace: { value: new THREE.Color('#2A2026') },
      uEdgeC: { value: new THREE.Color('#F0F4EF').multiplyScalar(.55) },
    },
  });
}

// one box in mark units: x0..x1, y0..y1, z0..z1
function setBox(m, x0, x1, y0, y1, z0, z1) {
  const a = L2W(x0, y0, z0), b = L2W(x1, y1, z1);
  m.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  m.scale.set(Math.max(Math.abs(b.x - a.x), .01), Math.max(Math.abs(b.y - a.y), .01), Math.max(Math.abs(b.z - a.z), .01));
}

// the tiles: the corridor in each year of each future, north up. Both show the area the numbers count
// (800 m around each new station); the future with the line also shows the line and its 38 m zoning (500 m).
function buildTextures(W, { line, growth }) {
  const St = W.D.streets, streets = { nodes: St.nodes, edges: St.edges, cls: St.cls };
  const TPX = [1024, Math.round(1024 * DEPTH / ARM_W)];
  const tmap = makeMapper(TILE_RECT, TPX), pxPerM = TPX[0] / (TILE_RECT[2] - TILE_RECT[0]);
  const stations = line.stations.map(s => tmap(s.x, s.y));
  const [bg, bgG] = newCanvas(...TPX, '#2A2026');
  drawStreets(bgG, streets, tmap, { alpha: .14, width: 1.1 });
  drawDiscs(bgG, stations, 800 * pxPerM, { fill: '#F0F4EF', fillAlpha: .045, stroke: '#F0F4EF', strokeAlpha: .4, lw: 1.6, dash: [7, 6] });
  const [bgL, bgLG] = newCanvas(...TPX);
  bgLG.drawImage(bg, 0, 0);
  drawDiscs(bgLG, stations, 500 * pxPerM, { fill: '#F77138', fillAlpha: .15, stroke: '#F77138', strokeAlpha: .55, lw: 1.4 });
  drawLine(bgLG, line, tmap, { width: 4.4 });
  const tex = growth.map((pts, tw) => {
    const n = pts.length / 4, inside = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const x = pts[i * 4], y = pts[i * 4 + 1];
      for (const s of line.stations) if (Math.hypot(s.x - x, s.y - y) < 800) { inside[i] = 1; break; }
    }
    return Array.from({ length: YEARS }, (_, y) => {
      const [c, g] = newCanvas(...TPX);
      // the line opens in year 2: before it, both futures are the same city
      g.drawImage(tw === 1 && y > 0 ? bgL : bg, 0, 0);
      drawGrowth(g, pts, tmap, 0, y + 1, { scale: 1.25, inside, freshFrom: y });
      return canvasTexture(c);
    });
  });
  // the present: the whole strip, drawn like the streets it replaces
  const BPX = [2048, Math.round(2048 * DEPTH / SPAN)], bmap = makeMapper(BASE_RECT, BPX);
  const [bc, bcG] = newCanvas(...BPX, '#211A1E');
  const bd = W.D.boundary;
  bcG.fillStyle = '#2A2026'; bcG.beginPath();
  for (let r = 0; r < bd.off.length - 1; r++) for (let k = bd.off[r]; k < bd.off[r + 1]; k++) {
    const [x, y] = bmap(bd.xy[k * 2], bd.xy[k * 2 + 1]);
    k === bd.off[r] ? bcG.moveTo(x, y) : bcG.lineTo(x, y);
  }
  bcG.fill();
  drawStreets(bcG, streets, bmap, { alpha: .2, width: 1 });
  return { tex, base: canvasTexture(bc) };
}

export async function setupS78(W, { line, growth }) {
  const { scene, camera, ov } = W;
  const cmp = await fetch('data/line/compare.json').then(r => r.json());
  const perYear = [cmp.within800m.unitsCompleted.baseline, cmp.within800m.unitsCompleted.line];
  const cum = perYear.map(a => a.reduce((o, v) => (o.push((o.at(-1) || 0) + v), o), []));
  const peak = Math.max(...perYear[0], ...perYear[1]);
  const total = cmp.within800m.unitsCompleted.total;
  const { tex, base: baseTex } = buildTextures(W, { line, growth });

  const group = new THREE.Group(); scene.add(group);
  const box = new THREE.BoxGeometry(1, 1, 1);
  // BoxGeometry faces: +x, -x, +y, -y, +z, -z. The mark's front face is local Z = 0, i.e. world +z (south).
  const base = new THREE.Mesh(box, tileMaterial(baseTex)); group.add(base);
  base.renderOrder = 1;   // after the city's plate, which it covers
  const tiles = [[], []];
  for (let tw = 0; tw < 2; tw++) for (let y = 0; y < YEARS; y++) {
    const m = new THREE.Mesh(box, tileMaterial(tex[tw][y]));
    m.renderOrder = 1; group.add(m); tiles[tw].push(m);
  }
  group.visible = false;

  // ---- type ----
  ov.add('s7-hl', 'Put one future<br>beside another.', 'hl', { left: '120px', top: '792px' });
  const words = ov.splitWords('s7-hl');
  const WT = [47.3, 47.45, 47.62, 47.9, 48.08];
  const figs = ov.add('s7-figs', `New homes within 800 m of the ${line.stations.length} new stations, over ten years`, 'figs', { left: '122px', top: '952px' });
  const dice = ov.add('s7-dice', 'Same city, same dice: the gap is the decision, not luck.', 'legend', { left: '122px', top: '994px' });
  const lab = [
    ov.add('s7-l0', `<div class="eb">Today’s rules</div><div class="n">0</div>`, 'tw r'),
    ov.add('s7-l1', `<div class="eb coral">With the line + 38 m zoning</div><div class="n"><span>0</span><i class="d">+${Math.round(total.percent)}%</i></div>`, 'tw'),
  ];
  const num = [lab[0].querySelector('.n'), lab[1].querySelector('.n span')], pill = lab[1].querySelector('.d');
  const year = ov.add('s7-year', '', 'eyebrow');

  // the exact mark, drawn in the overlay at the end so the brand geometry is the file's, not a reconstruction.
  // It takes over from the folded boxes drawn where they stand (their corners projected into SVG units), then
  // settles onto the file's corners: the base's bottom-right corner folds up into the mark's diagonal, and the
  // right arm and tiles, a unit or two off the 2:1 grid in the file, ease onto it
  const svgNS = 'http://www.w3.org/2000/svg';
  const mark = ov.svgAdd('s8-mark', 'g', {});
  const svgOf = ([X, Y, Z]) => [36.6 + X + Z, 143.5 + X / 2 - Z / 2 - Y];
  const TY = ARM_TOP + LIFT + .01, XR = ARM_W + GAP;
  const FOLDED = {
    body: [[XR, BASE_H, 0], [ARM_W, BASE_H, 0], [ARM_W, ARM_TOP, 0], [0, ARM_TOP, 0], [0, 0, 0], [XR, 0, 0], [SPAN, 0, 0], [SPAN, ARM_TOP, 0], [XR, ARM_TOP, 0]],
    left: [[ARM_W, TY, DEPTH], [0, TY, DEPTH], [0, TY, 0], [ARM_W, TY, 0]],
    right: [[XR, TY, DEPTH], [XR, TY, 0], [SPAN, TY, 0], [SPAN, TY, DEPTH]],
  };
  const polys = ['body', 'left', 'right'].map(k => {
    const p = document.createElementNS(svgNS, 'polygon');
    p.setAttribute('fill', '#F0F4EF');
    mark.appendChild(p);
    return { p, from: FOLDED[k].map(svgOf), to: MARK[k] };
  });
  const settleMark = s => {
    for (const { p, from, to } of polys) p.setAttribute('points', from.map((a, i) => `${lerp(a[0], to[i][0], s)},${lerp(a[1], to[i][1], s)}`).join(' '));
  };
  const word = ov.add('s8-word', '', '', { width: '470px', height: '62px', background: '#F0F4EF',
    webkitMask: 'url(fonts/urbanly-wordmark.png) center / contain no-repeat', mask: 'url(fonts/urbanly-wordmark.png) center / contain no-repeat' });
  const rule = ov.add('s8-rule', '', '', { width: '56px', height: '3px', background: '#F77138' });
  const tag = ov.add('s8-tag', 'Watch your city’s next decade<br>before you commit to it.', 'hl-s');
  const url = ov.add('s8-url', 'urbanly.org', 'eyebrow');

  // screen placement of the finished mark: SVG units → px
  const MARK_PX = 2.9, MARK_AT = [512, 344];   // px per SVG unit; screen point of SVG (36.6, 32.2)
  const svgToPx = (x, y) => [MARK_AT[0] + (x - 36.6) * MARK_PX, MARK_AT[1] + (y - 32.2) * MARK_PX];

  // camera: dimetric. camFor puts SVG point (sx, sy) at screen (px, py) with k px per SVG unit: the screen
  // centre is SVG point (sx + (960 - px)/k, sy + (540 - py)/k); pick the local point on that view ray at mid-depth
  const camFor = (sx, sy, px, py, k, extra = {}) => {
    const xs = sx + (960 - px) / k, ys = sy + (540 - py) / k, Z = DEPTH / 2;
    const X = xs - 36.6 - Z, Y = 143.5 + X / 2 - Z / 2 - ys;
    const c = L2W(X, Y, Z);
    return { x: c.x, y: -c.z, h: c.y, w: Math.SQRT1_2 * S * 1920 / k, pitch: 30, yaw: -45, fov: .4, ...extra };
  };

  const scr = v => toScreen(camera, v.x, -v.z, v.y);
  // how many years stand (continuous): drives the labels' height and the counters
  const stood = t => { let n = 0; for (let y = 1; y < YEARS; y++) n += heroEase(seg(t, landAt(y) + .12, landAt(y) + .5)); return n; };

  function place(t) {
    const close = inOut(seg(t, 53.4, 55.0));
    const solid = inOut(seg(t, 53.6, 55.3));
    const lift = inOut(seg(t, 54.6, 55.8));
    const fold = inOut(seg(t, 55.2, 56.9));
    const flat = smooth(seg(t, 56.2, 57.0));
    const depth = DEPTH * (1 - fold);
    // the present: the city's own map, then a slab that grows down into the base
    const bBot = lerp(BASE_H - 1.4, 0, close);
    setBox(base, 0, SPAN, bBot, BASE_H, 0, Math.max(depth, .02));
    base.material.uniforms.uOpacity.value = smooth(seg(t, ...T.slab));
    // year 1: the corridor lights up on the slab, lifts, and forks into both futures
    const on = heroEase(seg(t, ...T.corridor)), up = heroEase(seg(t, ...T.lift)), fork = inOut(seg(t, ...T.fork));
    for (let tw = 0; tw < 2; tw++) for (let y = 0; y < YEARS; y++) {
      const m = tiles[tw][y], last = y === YEARS - 1;
      const y0 = BASE_H + y * SLOT;
      let x = X0[tw], bottom, th, d, o;
      if (y === 0) {
        x = lerp(XC, X0[tw], fork);
        bottom = lerp(BASE_H + .03, lerp(Y1, y0, close), up); th = lerp(.02, lerp(TH, SLOT, close), up);
        d = Math.max(depth, .02); o = on;
      } else {
        const g = backOut(seg(t, landAt(y), landAt(y) + .55), 1.2);
        if (last) { bottom = lerp(y0 + (SLOT - TH) / 2, ARM_TOP + LIFT, lift); th = lerp(TH, .02, lift); d = DEPTH; }
        else { bottom = lerp(y0 + (SLOT - TH) / 2, y0, close); th = lerp(TH, SLOT, close); d = Math.max(depth, .02); }
        bottom += (1 - g) * 18;
        o = clamp(g * 1.4);
      }
      setBox(m, x, x + ARM_W, bottom, bottom + th, 0, d);
      m.visible = o > .001;
      const u = m.material.uniforms;
      u.uOpacity.value = o;
      u.uGlow.value = (.14 + .5 * perYear[tw][y] / peak) * (1 - solid) * up;
    }
    for (const m of [base, ...tiles[0], ...tiles[1]]) {
      const u = m.material.uniforms;
      u.uSolid.value = solid; u.uFlat.value = flat; u.uEdge.value = .8 * (1 - solid);
    }
    base.material.uniforms.uEdge.value *= smooth(seg(t, 46.85, 47.35));   // the slab's outline once it has settled
    return { solid, fold, flat };
  }

  function update(t) {
    const on = t > T.slab[0];
    group.visible = on && t < T.handover[1];   // the mark covers the folded boxes exactly by then
    const st = on ? place(t) : null;

    // ---- scene seven's type ----
    revealWordsAt(words, t, WT);
    const outK = 1 - heroEase(seg(t, ...T.out));
    ov.get('s7-hl').style.opacity = outK;
    blockInOut(figs, t, 48.4, T.out[1], { din: .8, dout: .45 });
    blockInOut(dice, t, T.dice, T.out[1], { din: .8, dout: .45 });
    const n = stood(t), topY = Y1 + TH + n * SLOT;
    const lo = heroEase(seg(t, 47.9, 48.5)) * outK;
    for (let tw = 0; tw < 2; tw++) {
      // left label beside the left tower's west corner, right label beside the right tower's east corner
      const a = scr(tw ? L2W(SPAN, topY, DEPTH) : L2W(0, topY, 0));
      show(lab[tw], a ? lo : 0);
      if (!a) continue;
      let v = cum[tw][0];
      for (let y = 1; y < YEARS; y++) v += perYear[tw][y] * easeOut(seg(t, landAt(y) + .1, landAt(y) + .55));
      num[tw].textContent = fmt(Math.round(v));
      const w = lab[tw].offsetWidth;
      lab[tw].style.transform = `translate(${tw ? a[0] + 34 : a[0] - 34 - w}px, ${a[1] - 70}px)`;
    }
    const pk = heroEase(seg(t, T.pill, T.pill + .5));
    pill.style.opacity = pk; pill.style.transform = `translateY(${(1 - pk) * 8}px)`;
    const ya = scr(L2W(SPAN / 2, topY + 8, DEPTH));
    const yo = heroEase(seg(t, 48.1, 48.6)) * outK;
    show(year, ya ? yo : 0);
    if (ya) {
      year.textContent = `Year ${1 + Math.round(n)}`;
      year.style.transform = `translate(${ya[0] - year.offsetWidth / 2}px, ${ya[1] - 12}px)`;
    }

    // ---- the mark: hand over to the exact SVG once the fold is complete ----
    const km = smooth(seg(t, ...T.handover));
    settleMark(inOut(seg(t, ...T.settle)));
    mark.setAttribute('transform', `translate(${MARK_AT[0] - 36.6 * MARK_PX} ${MARK_AT[1] - 32.2 * MARK_PX}) scale(${MARK_PX})`);
    mark.setAttribute('opacity', km);
    const [wx, wy] = svgToPx(134.5 + 32, 86);
    show(word, heroEase(seg(t, 57.3, 58.1)));
    word.style.transform = `translate(${wx}px, ${wy - 70 + 8 * (1 - heroEase(seg(t, 57.3, 58.1)))}px)`;
    show(rule, heroEase(seg(t, 57.7, 58.3)));
    rule.style.transform = `translate(${wx + 2}px, ${wy + 24}px) scaleX(${heroEase(seg(t, 57.7, 58.5))})`; rule.style.transformOrigin = '0 0';
    show(tag, heroEase(seg(t, 58.0, 58.9)));
    tag.style.transform = `translate(${wx}px, ${wy + 58 + 10 * (1 - heroEase(seg(t, 58.0, 58.9)))}px)`;
    show(url, heroEase(seg(t, 58.6, 59.4)));
    url.style.transform = `translate(${wx + 1}px, ${wy + 196}px)`;
    return st;
  }

  // camera keys (the caller merges them into the film's path): the slab, then up with the towers, then the lockup
  const keys = [
    [47.5, { ...camFor(85.55, 126.6, 985, 600, 10.2), hold: true }],
    [49.7, camFor(85.55, 110, 1050, 560, 8.9)],
    [51.6, camFor(85.55, 97, 1110, 560, 8.0)],
    [53.3, { ...camFor(85.55, 97, 1112, 562, 8.15), hold: true }],
    [56.9, { ...camFor(36.6, 32.2, MARK_AT[0], MARK_AT[1], MARK_PX), hold: true }],
    [63, camFor(36.6, 32.2, MARK_AT[0], MARK_AT[1], MARK_PX)],
  ];
  return { update, keys, group, svgToPx, MARK_PX, MARK_AT };
}
