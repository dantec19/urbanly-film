// agents.js: people as amber lights with trails that follow the street, travelling along real routed paths
// (data/agent-paths.mjs). Each agent makes one trip, departing at its own time; position is a closed-form
// function of t, so any frame can be rendered on its own. A trail is K short quads laid along the path, so
// it bends around corners instead of cutting them.
import * as THREE from 'three';
import { hash } from './util.js';

const K = 5;   // quads per trail

const VERT = /* glsl */`
uniform vec2 uRes;
uniform float uPx;
uniform float uWidth;
attribute vec3 aA;
attribute vec3 aB;
attribute vec2 aK;          // along-trail position of A and B: 0 = tail end, 1 = head
attribute float aAlpha;
varying float vK;
varying float vSide;
varying float vHalf;
varying float vAlpha;
void main() {
  vec4 c0 = projectionMatrix * modelViewMatrix * vec4(aA, 1.);
  vec4 c1 = projectionMatrix * modelViewMatrix * vec4(aB, 1.);
  vec2 s0 = c0.xy / c0.w * .5 * uRes, s1 = c1.xy / c1.w * .5 * uRes;
  vec2 d = s1 - s0; float len = length(d);
  vec2 dir = len > 1e-4 ? d / len : vec2(1., 0.);
  vec2 nrm = vec2(-dir.y, dir.x);
  float k = mix(aK.x, aK.y, position.x);
  float hw = uWidth * uPx * .5 * (.35 + .65 * k);
  vec4 c = mix(c0, c1, position.x);
  // overlap the quads slightly so joints at corners don't gap
  vec2 off = nrm * position.y * (hw + uPx) + dir * (position.x * 2. - 1.) * (hw + .5 * uPx);
  c.xy += off / (.5 * uRes) * c.w;
  vK = k; vSide = position.y * (hw + uPx); vHalf = hw; vAlpha = aAlpha;
  // drop trails that touch the camera plane: their projection would smear across the whole frame
  gl_Position = aAlpha <= 0. || c0.w < 1. || c1.w < 1. ? vec4(2., 2., 2., 1.) : c;
}`;
const FRAG = /* glsl */`
uniform vec3 uCol;
uniform float uPx;
uniform float uOpacity;
uniform float uHeadGain;
varying float vK;
varying float vSide;
varying float vHalf;
varying float vAlpha;
void main() {
  float aa = 1. - smoothstep(vHalf - .5 * uPx, vHalf + .6 * uPx, abs(vSide));
  float tail = pow(clamp(vK, 0., 1.), 2.4);
  float head = smoothstep(.9, 1., vK);
  vec3 c = uCol * (.5 + uHeadGain * head);
  gl_FragColor = vec4(min(c, vec3(8.)), aa * (tail * .8 + head * .5) * vAlpha * uOpacity);
}`;

// paths: { xy: Float32Array, off: Uint32Array (P+1), len: Float32Array (P) }
export function makeAgents(paths, opts = {}) {
  const P = paths.len.length;
  const N = Math.min(P, opts.max || P);
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([0, -1, 0, 1, -1, 0, 0, 1, 0, 1, 1, 0], 3));
  g.setIndex([0, 1, 2, 2, 1, 3]);
  const M = N * K;
  const A = new Float32Array(M * 3), B = new Float32Array(M * 3), KK = new Float32Array(M * 2), AL = new Float32Array(M);
  const aA = new THREE.InstancedBufferAttribute(A, 3), aB = new THREE.InstancedBufferAttribute(B, 3);
  const aK = new THREE.InstancedBufferAttribute(KK, 2), aAl = new THREE.InstancedBufferAttribute(AL, 1);
  for (const a of [aA, aB, aAl]) a.setUsage(THREE.DynamicDrawUsage);
  for (let i = 0; i < N; i++) for (let k = 0; k < K; k++) { KK[(i * K + k) * 2] = k / K; KK[(i * K + k) * 2 + 1] = (k + 1) / K; }
  g.setAttribute('aA', aA); g.setAttribute('aB', aB); g.setAttribute('aK', aK); g.setAttribute('aAlpha', aAl);
  g.instanceCount = M;
  const m = new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending,
    uniforms: {
      uRes: { value: new THREE.Vector2(1920, 1080) }, uPx: { value: 1 }, uWidth: { value: 2.4 },
      uCol: { value: new THREE.Color('#FFB547') }, uOpacity: { value: 1 }, uHeadGain: { value: 2.6 },
    },
  });
  const mesh = new THREE.Mesh(g, m); mesh.frustumCulled = false; mesh.renderOrder = 5;

  // departure time (s of film) and speed (m per film second) per agent
  const dep = new Float32Array(N), speed = new Float32Array(N);
  const spread = opts.spread ?? 6, v0 = opts.speed ?? 650;
  for (let i = 0; i < N; i++) { dep[i] = (opts.t0 ?? 0) + hash(i * 7.7 + 1.3) * spread; speed[i] = v0 * (.7 + .6 * hash(i * 3.1 + 7)); }

  const at = (i, s, out) => {
    const o0 = paths.off[i], o1 = paths.off[i + 1];
    // cumulative length is recomputed lazily into cum[] the first time a path is walked
    const cum = cumFor(i);
    let lo = 1, hi = o1 - o0 - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < s) lo = mid + 1; else hi = mid; }
    const k = o0 + lo, s0 = cum[lo - 1], s1 = cum[lo], f = s1 > s0 ? (s - s0) / (s1 - s0) : 0;
    out[0] = paths.xy[(k - 1) * 2] + (paths.xy[k * 2] - paths.xy[(k - 1) * 2]) * f;
    out[1] = paths.xy[(k - 1) * 2 + 1] + (paths.xy[k * 2 + 1] - paths.xy[(k - 1) * 2 + 1]) * f;
  };
  const cums = new Array(N);
  function cumFor(i) {
    if (cums[i]) return cums[i];
    const o0 = paths.off[i], o1 = paths.off[i + 1], c = new Float32Array(o1 - o0);
    for (let k = 1; k < o1 - o0; k++) c[k] = c[k - 1] + Math.hypot(paths.xy[(o0 + k) * 2] - paths.xy[(o0 + k - 1) * 2], paths.xy[(o0 + k) * 2 + 1] - paths.xy[(o0 + k - 1) * 2 + 1]);
    return (cums[i] = c);
  }
  const pa = [0, 0], pb = [0, 0];
  // state of agent i at film time t: distance travelled s (m) or -1 when not on the street
  const travelled = (i, t) => {
    const L = paths.len[i];
    if (paths.off[i + 1] - paths.off[i] < 2 || L < 1) return -1;
    const s = (t - dep[i]) * speed[i];
    return s < 0 || s > L + 1 ? -1 : Math.min(s, L);
  };
  // density: share of agents shown (stable subset); trail: metres; view: [x, y, r] cull disc (optional)
  function update(t, { density = 1, trail = 90, lift = 1.5, view = null } = {}) {
    for (let i = 0; i < N; i++) {
      let s = hash(i * 1.37) <= density ? travelled(i, t) : -1;
      if (s >= 0 && view) {
        at(i, s, pb);
        if ((pb[0] - view[0]) ** 2 + (pb[1] - view[1]) ** 2 > view[2] * view[2]) s = -1;
      }
      const L = paths.len[i];
      const fade = s < 0 ? 0 : Math.min(1, s / 80, (L - s) / 80 + .15);
      for (let k = 0; k < K; k++) {
        const j = i * K + k;
        if (s < 0) { AL[j] = 0; continue; }
        const sa = Math.max(0, s - trail * (1 - k / K)), sb = Math.max(0, s - trail * (1 - (k + 1) / K));
        at(i, sa, pa); at(i, sb, pb);
        A[j * 3] = pa[0]; A[j * 3 + 1] = lift; A[j * 3 + 2] = -pa[1];
        B[j * 3] = pb[0]; B[j * 3 + 1] = lift; B[j * 3 + 2] = -pb[1];
        AL[j] = sb - sa < .05 ? 0 : fade;
      }
    }
    aA.needsUpdate = aB.needsUpdate = aAl.needsUpdate = true;
  }
  function position(i, t, out = [0, 0]) { const s = travelled(i, t); at(i, s < 0 ? 0 : s, out); return s < 0 ? null : out; }
  return { mesh, update, position, travelled, N, dep, speed, paths };
}

export async function loadAgentPaths(prefix) {
  const get = async (f, T) => { const r = await fetch(prefix + f); if (!r.ok) throw new Error(prefix + f + ' ' + r.status); return new T(await r.arrayBuffer()); };
  const [xy, off, len] = await Promise.all([get('_xy.f32', Float32Array), get('_off.u32', Uint32Array), get('_len.f32', Float32Array)]);
  return { xy, off, len };
}
