// buildings.js: every footprint of the city extruded. To fit 405,653 buildings on the GPU the walls share
// vertices with the roof (a bottom ring and a top ring per footprint), normals come from screen derivatives,
// and the mesh is split into chunks with 16-bit indices. Per-building values live in two float textures
// indexed by building id, so heights, rise times, build/demolish years and highlight groups change per frame
// without touching geometry.
//   T1 (RGBA): height m, rise key (m), year built (0 = standing at start), year gone
//   T2 (RGBA): group (0 = plain; 1..3 highlight groups), done (end of construction), walk (m), walk reveal key (m)
import * as THREE from 'three';
import earcut from '../vendor/earcut.js';
import { SHADOW_GLSL } from './shadow.js';

const TEXW = 2048;

const VERT = /* glsl */`
precision highp float;
precision highp sampler2D;
uniform sampler2D uT1;
uniform sampler2D uT2;
uniform sampler2D uT3;
uniform float uRise;
uniform float uRiseW;
uniform float uRiseAll;
uniform float uYear;
uniform float uGrowYears;
uniform float uNewKeep;
uniform float uGroupH[4];
uniform float uHScale;
attribute float aTU;        // sign: top (+) / bottom (-); |aTU| - 1 = metres along the footprint ring
attribute float aId;
varying vec3 vW;
varying float vU;
varying float vH;
varying float vId;
varying float vNew;
varying float vGroup;
varying float vIso;
varying float vIsoR;
varying vec2 vCen;
vec4 fetch(sampler2D t, float id) {
  float fx = mod(id, ${TEXW}.), fy = floor(id / ${TEXW}.);
  return texelFetch(t, ivec2(int(fx), int(fy)), 0);
}
float backOut(float x) { x = clamp(x, 0., 1.) - 1.; float s = 1.3; return 1. + (s + 1.) * x * x * x + s * x * x; }
void main() {
  vec4 b1 = fetch(uT1, aId), b2 = fetch(uT2, aId);
  float h = b1.x * uHScale;
  float k = uRiseAll > .5 ? 1. : clamp((uRise - b1.y) / uRiseW, 0., 1.);
  float s = backOut(k);
  float born = b1.z, news = 0.;
  if (born > 0.) {
    // under construction from born to done (T2.y), then a fading amber afterglow down to uNewKeep
    float done = b2.y > born ? b2.y : born + uGrowYears;
    float kk = clamp((uYear - born) / max(done - born, .35), 0., 1.);
    s *= kk < 1. ? kk : backOut(clamp((uYear - done) / .25 + .8, 0., 1.));
    news = uYear < born ? 0. : uYear < done ? 1. : mix(uNewKeep, 1., exp(-(uYear - done) / 1.1));
  }
  s *= 1. - clamp((uYear - b1.w) / .45, 0., 1.);
  int g = int(b2.x + .5);
  if (g > 0 && g < 4) s *= uGroupH[g];
  float top = aTU > 0. ? 1. : 0.;
  vec3 p = vec3(position.x, top * h * s, position.z);
  vW = p; vU = abs(aTU) - 1.; vH = h * s; vId = aId; vNew = news; vGroup = float(g); vIso = b2.z; vIsoR = b2.w; vCen = fetch(uT3, aId).xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.);
  if (s < .003) gl_Position = vec4(2., 2., 2., 1.);
}`;

const FRAG = /* glsl */`
precision highp float;
${SHADOW_GLSL}
uniform vec3 uRoofC;
uniform vec3 uWallC;
uniform float uAmbient;
uniform float uDirect;
uniform vec3 uSunC;
uniform vec3 uBone;
uniform vec3 uDark;
uniform vec3 uAmber;
uniform vec3 uLight;
uniform float uNight;
uniform float uLit;
uniform float uAmberOn;
uniform vec3 uGroupCol[4];
uniform float uGroupMix[4];
uniform float uFloorLines;
uniform sampler2D uField;
uniform sampler2D uField2;
uniform vec4 uFieldRect;
uniform float uFieldOn;
uniform vec3 uCompass;
uniform float uCompassRot;
uniform float uSweep;
uniform float uFieldDimOut;
uniform sampler2D uRamp;
uniform float uHaze;        // 0..1 atmospheric falloff with distance from the camera target
uniform vec3 uHazeC;
uniform vec3 uTarget;
uniform float uHazeR;
uniform float uDim;         // 0..1 fade the whole city toward the ground colour
uniform float uIsoOn;       // walking time on the buildings: blend, front, ramp span, cut-off (metres)
uniform float uIsoFront;
uniform float uIsoMax;
uniform float uIsoCut;
uniform float uIsoMix;
uniform float uIsoDimOut;
varying float vIso;
varying float vIsoR;
varying vec2 vCen;
varying vec3 vW;
varying float vU;
varying float vH;
varying float vId;
varying float vNew;
varying float vGroup;
float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float fieldAt(vec2 xy, int w) {
  vec2 uv = (xy - uFieldRect.xy) / (uFieldRect.zw - uFieldRect.xy);
  vec4 a = texture2D(uField, uv), b = texture2D(uField2, uv);
  return w == 0 ? a.r : w == 1 ? a.g : w == 2 ? a.b : w == 3 ? a.a : w == 4 ? b.r : w == 5 ? b.g : w == 6 ? b.b : b.a;
}
void main() {
  vec3 N = cross(dFdx(vW), dFdy(vW));
  N = dot(N, N) > 1e-20 ? normalize(N) : vec3(0., 1., 0.);
  bool roof = N.y > .6;
  float sh = shadowAt(vW + N * .15, uShadowBias);
  float ndl = max(dot(N, uLight), 0.);
  float ao = roof ? 1. : mix(.34, 1., smoothstep(0., 26., vW.y));
  float amb = uAmbient * (.72 + .28 * N.y) * ao;
  vec3 lum = vec3(amb) + uSunC * (uDirect * ndl * sh);
  vec3 day = (roof ? uRoofC : uWallC) * lum;
  float rim = roof ? 0. : smoothstep(.45, 0., vH - vW.y);
  day += uBone * rim * .16 * (.4 + .6 * sh);
  // night: a faint high light from the north-east keeps roofs and walls apart
  float nd = max(dot(N, normalize(vec3(.4, .8, -.45))), 0.);
  vec3 night = uDark * (roof ? 1.15 : (.45 + .55 * nd) * ao);
  if (!roof && vH > 4.) {
    // windows: 3 m floors, 3.4 m bays; each building has its own share of lights on, each window its own
    // warmth and brightness. Where a window would be smaller than a few pixels the pattern gives way to its
    // average, so distant facades glow evenly instead of shimmering.
    float fl = floor(vW.y / 3.), bay = floor(vU / 3.4);
    vec2 cell = vec2(fract(vU / 3.4), fract(vW.y / 3.));
    float win = step(.3, cell.x) * step(cell.x, .7) * step(.34, cell.y) * step(cell.y, .78);
    float occ = uLit * (.25 + 1.5 * hash(vec3(vId * .713, 3.1, 7.7)) * hash(vec3(vId * 1.37, 1.9, 4.3)));
    float h1 = hash(vec3(vId, fl, bay));
    float on = step(h1, occ) * step(1., fl) * step(vW.y, vH - 1.);
    float h2 = hash(vec3(vId * .37, fl * 1.7, bay * 2.3));
    vec3 wc = mix(uAmber, vec3(1., .86, .62), step(.72, h2)) * (.35 + .65 * h2);
    float fw = max(fwidth(vU / 3.4), fwidth(vW.y / 3.));
    float far = smoothstep(.22, .55, fw);
    vec3 lit = mix(wc * win * on, uAmber * .16 * occ * .55 * step(1., fl), far);
    night += lit * 1.7;
  }
  night += uBone * rim * .08;
  vec3 c = mix(day, night, uNight);
  // new buildings: amber, hot while under construction; a little brighter from afar so the decade reads at city scale
  float farGlow = 1. + 1.6 * smoothstep(.15, .9, max(fwidth(vW.x), fwidth(vW.z)) / 6.);
  vec3 ambC = uAmber * (roof ? 1.25 : .5 + .5 * nd) * farGlow;
  c = mix(c, ambC, vNew * uAmberOn);
  int g = int(vGroup + .5);
  if (g > 0 && g < 4) {
    vec3 gc = uGroupCol[g] * (roof ? 1.12 : .45 + .6 * ndl) * ao;
    if (uFloorLines > 0. && !roof) gc *= 1. - .4 * uFloorLines * (1. - smoothstep(0., .07, fract(vW.y / 3.)));
    c = mix(c, gc, uGroupMix[g]);
  }
  if (uFieldOn > 0.) {
    // the compass: eight wedges around uCompass.xy (radius uCompass.z), each read by its own field. The wedges
    // appear one after another as a sweep passes (uSweep, radians clockwise from the compass's first wedge).
    vec2 xy = vec2(vW.x, -vW.z);
    vec2 d = xy - uCompass.xy;
    float r = length(d);
    float ang = mod(atan(d.x, d.y) - uCompassRot + 3.14159265 / 8., 6.2831853);
    int wedge = int(floor(ang / (6.2831853 / 8.)));
    float v = fieldAt(vCen, wedge);            // one value per building: read at its centroid
    vec3 fc = texture2D(uRamp, vec2(v, .5)).rgb * (roof ? 1.02 : .4 + .55 * nd) * ao;
    float inside = 1. - smoothstep(uCompass.z * .985, uCompass.z, r);
    float shown = smoothstep(uSweep, uSweep - .05, ang);
    float edge = shown * exp(-max(uSweep - ang, 0.) / .1);
    fc *= 1. + edge * 1.6;
    c = mix(c, fc, uFieldOn * inside * shown);
    c = mix(c, uHazeC, uFieldOn * (1. - inside) * uFieldDimOut);
  }
  if (uIsoOn > 0.) {
    float reached = step(vIsoR, uIsoFront) * step(vIso, uIsoCut);
    float k = clamp(vIso / uIsoMax, 0., 1.);
    vec3 ic = texture2D(uRamp, vec2(1. - k, .5)).rgb;
    float edge = exp(-max(uIsoFront - vIsoR, 0.) / 70.);
    vec3 tint = ic * (roof ? 1. : .38 + .5 * nd) * ao * (1. + edge * 2.6);
    c = mix(c, tint, uIsoOn * reached * uIsoMix);
    c = mix(c, uHazeC, uIsoOn * (1. - reached) * uIsoDimOut);
  }
  float dist = length(vW.xz - uTarget.xz);
  c = mix(c, uHazeC, uHaze * smoothstep(uHazeR * .35, uHazeR, dist));
  c = mix(c, uHazeC, uDim);
  gl_FragColor = vec4(clamp(c, 0., 16.), 1.);
}`;

// rings: { xy, off (ring offsets, n+1), bld (building of ring) }; per building: h, rise, born, gone, group
export function makeBuildings(rings, per, opts = {}) {
  const nR = rings.off.length - 1, nB = per.h.length;
  const material = new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: FRAG,
    uniforms: {
      uT1: { value: null }, uT2: { value: null }, uT3: { value: null },
      uRise: { value: 0 }, uRiseW: { value: 600 }, uRiseAll: { value: 1 },
      uYear: { value: 0 }, uGrowYears: { value: .6 }, uNewKeep: { value: .35 }, uHScale: { value: 1 }, uGroupH: { value: [1, 1, 1, 1] },
      uBone: { value: new THREE.Color('#F0F4EF') }, uDark: { value: new THREE.Color('#3A2C34') },
      uRoofC: { value: new THREE.Color('#D8D1CE') }, uWallC: { value: new THREE.Color('#EAE4E1') }, uAmbient: { value: .26 }, uDirect: { value: 1.05 }, uSunC: { value: new THREE.Color('#FFE6CC') },
      ...(opts.shadow ? opts.shadow.uniforms : { uShadowMap: { value: null }, uShadowMatrix: { value: new THREE.Matrix4() }, uShadowOn: { value: 0 }, uShadowTexel: { value: 1 / 4096 }, uShadowSoft: { value: 1 }, uShadowBias: { value: 3e-5 } }),
      uAmber: { value: new THREE.Color('#FFB547') }, uLight: { value: new THREE.Vector3(-.52, .7, -.49).normalize() },
      uNight: { value: 0 }, uLit: { value: .3 }, uAmberOn: { value: 1 },
      uGroupCol: { value: [new THREE.Color(), new THREE.Color('#FFB547'), new THREE.Color('#F77138'), new THREE.Color('#F0F4EF')] },
      uGroupMix: { value: [0, 0, 0, 0] }, uFloorLines: { value: 0 },
      uField: { value: null }, uField2: { value: null }, uFieldRect: { value: new THREE.Vector4(0, 0, 1, 1) }, uFieldOn: { value: 0 },
      uCompass: { value: new THREE.Vector3(0, 0, 1000) }, uCompassRot: { value: 0 }, uSweep: { value: 7 }, uFieldDimOut: { value: .45 }, uRamp: { value: opts.ramp || null },
      uHaze: { value: 0 }, uHazeC: { value: new THREE.Color('#1B1418') }, uTarget: { value: new THREE.Vector3() }, uHazeR: { value: 20000 },
      uDim: { value: 0 },
      uIsoOn: { value: 0 }, uIsoFront: { value: 0 }, uIsoMax: { value: 800 }, uIsoCut: { value: 800 }, uIsoMix: { value: .85 }, uIsoDimOut: { value: .35 },
    },
  });
  const group = new THREE.Group();
  // build chunks of <= 65535 vertices
  const MAXV = 65535;
  let r = 0;
  const tmp = [];
  while (r < nR) {
    // count how many rings fit
    let nv = 0, ni = 0, r1 = r;
    while (r1 < nR) {
      const m = rings.off[r1 + 1] - rings.off[r1];
      const v = 2 * (m + 1);
      if (nv + v > MAXV) break;
      nv += v; ni += 6 * m + 3 * (m - 2); r1++;
    }
    const pos = new Float32Array(nv * 3), tu = new Float32Array(nv), id = new Float32Array(nv), idx = new Uint16Array(ni);
    let v = 0, ii = 0;
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity, maxh = 0;
    for (let q = r; q < r1; q++) {
      const o0 = rings.off[q], m = rings.off[q + 1] - o0, b = rings.bld[q];
      const base = v;
      let u = 0;
      tmp.length = 0;
      for (let k = 0; k <= m; k++) {
        const kk = k % m, x = rings.xy[(o0 + kk) * 2], y = rings.xy[(o0 + kk) * 2 + 1];
        if (k > 0) { const px = rings.xy[(o0 + k - 1) * 2], py = rings.xy[(o0 + k - 1) * 2 + 1]; u += Math.hypot(x - px, y - py); }
        if (k < m) tmp.push(x, y);
        // bottom
        pos[v * 3] = x; pos[v * 3 + 1] = 0; pos[v * 3 + 2] = -y; tu[v] = -(u + 1); id[v] = b; v++;
        // top
        pos[v * 3] = x; pos[v * 3 + 1] = 0; pos[v * 3 + 2] = -y; tu[v] = u + 1; id[v] = b; v++;
        if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
      }
      maxh = Math.max(maxh, per.h[b]);
      for (let k = 0; k < m; k++) {
        const b0 = base + k * 2, t0 = b0 + 1, b1 = base + (k + 1) * 2, t1 = b1 + 1;
        // outward-facing for a CCW ring (x east, y north), world z = -north
        idx[ii++] = b0; idx[ii++] = b1; idx[ii++] = t0;
        idx[ii++] = t0; idx[ii++] = b1; idx[ii++] = t1;
      }
      const tri = earcut(tmp);
      for (let k = 0; k < tri.length; k += 3) {
        const a = tri[k], c1 = tri[k + 1], c2 = tri[k + 2];
        const cross = (tmp[c1 * 2] - tmp[a * 2]) * (tmp[c2 * 2 + 1] - tmp[a * 2 + 1]) - (tmp[c1 * 2 + 1] - tmp[a * 2 + 1]) * (tmp[c2 * 2] - tmp[a * 2]);
        idx[ii++] = base + a * 2 + 1;
        if (cross >= 0) { idx[ii++] = base + c1 * 2 + 1; idx[ii++] = base + c2 * 2 + 1; }
        else { idx[ii++] = base + c2 * 2 + 1; idx[ii++] = base + c1 * 2 + 1; }
      }
      for (let k = tri.length; k < 3 * (m - 2); k++) idx[ii++] = base + 1;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aTU', new THREE.BufferAttribute(tu, 1));
    g.setAttribute('aId', new THREE.BufferAttribute(id, 1));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    // bounds for frustum culling (heights up to the tallest building in the chunk, with overshoot room)
    const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(cx, maxh * .6, -cy), Math.hypot(maxx - minx, maxy - miny, maxh * 1.6) / 2 + 10);
    const mesh = new THREE.Mesh(g, material);
    mesh.renderOrder = 1;
    group.add(mesh);
    r = r1;
  }
  // per-building textures
  const rows = Math.ceil(nB / TEXW);
  const t1 = new Float32Array(TEXW * rows * 4), t2 = new Float32Array(TEXW * rows * 4);
  for (let b = 0; b < nB; b++) {
    t1[b * 4] = per.h[b]; t1[b * 4 + 1] = per.rise ? per.rise[b] : 0; t1[b * 4 + 2] = per.born ? per.born[b] : 0; t1[b * 4 + 3] = per.gone ? per.gone[b] : 1e5;
    t2[b * 4] = per.group ? per.group[b] : 0; t2[b * 4 + 1] = per.done ? per.done[b] : 0; t2[b * 4 + 2] = t2[b * 4 + 3] = 1e9;
  }
  // T3: footprint centroid (x, y), from the first ring of each building
  const t3 = new Float32Array(TEXW * rows * 4), seen = new Uint8Array(nB);
  for (let q = 0; q < nR; q++) {
    const b = rings.bld[q]; if (seen[b]) continue; seen[b] = 1;
    const o0 = rings.off[q], o1 = rings.off[q + 1];
    let sx = 0, sy = 0;
    for (let k = o0; k < o1; k++) { sx += rings.xy[k * 2]; sy += rings.xy[k * 2 + 1]; }
    t3[b * 4] = per.cx ? per.cx[b] : sx / (o1 - o0); t3[b * 4 + 1] = per.cy ? per.cy[b] : sy / (o1 - o0);
  }
  const T1 = new THREE.DataTexture(t1, TEXW, rows, THREE.RGBAFormat, THREE.FloatType);
  const T2 = new THREE.DataTexture(t2, TEXW, rows, THREE.RGBAFormat, THREE.FloatType);
  const T3 = new THREE.DataTexture(t3, TEXW, rows, THREE.RGBAFormat, THREE.FloatType);
  for (const T of [T1, T2, T3]) { T.minFilter = T.magFilter = THREE.NearestFilter; T.needsUpdate = true; }
  material.uniforms.uT1.value = T1; material.uniforms.uT2.value = T2; material.uniforms.uT3.value = T3;
  // back faces only: the stored depth is the far side of each building, so lit faces never self-shadow and
  // the receivers can use a bias far below a metre
  const depthMaterial = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: 'void main(){ gl_FragColor = vec4(1.); }', uniforms: material.uniforms, side: THREE.BackSide });
  group.userData = { material, depthMaterial, T1, T2, t1, t2, nB, chunks: group.children.length };
  return group;
}
