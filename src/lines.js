// lines.js: street segments as instanced screen-space quads.
// Each segment carries two "reveal" distances (one per end) so a front can draw it progressively from its
// nearer end, a class (width, brightness), and two travel times (one per end) for the isochrone scene.
import * as THREE from 'three';
import { SHADOW_GLSL } from './shadow.js';

const VERT = /* glsl */`
uniform vec2 uRes;            // drawing-buffer px
uniform float uPx;            // device px per CSS px
uniform float uGrow;          // growth front, metres of network distance
uniform float uGrowAll;       // 1 = everything revealed (skip the front)
uniform vec3 uWidth;          // CSS px widths for class 0 (local), 1 (collector), 2 (avenue+)
uniform float uWorldW;        // when > 0: minimum width in metres (lines thicken as the camera comes close)
uniform float uLift;          // metres above ground
uniform float uIsoOn;
uniform float uIsoFront;
uniform float uIsoCut;
uniform float uIsoWiden;      // reached streets thicken by this factor
attribute vec3 aA;
attribute vec3 aB;
attribute vec2 aGrow;
attribute vec2 aIso;
attribute vec2 aIsoR;
attribute float aCls;
varying float vSide;
varying float vHalf;
varying float vD;
varying float vIso;
varying float vIsoR;
varying float vCls;
varying float vF;
varying vec3 vWP;
void main() {
  float f = uGrowAll > .5 ? 1. : clamp((uGrow - aGrow.x) / max(aGrow.y - aGrow.x, .01), 0., 1.);
  vF = f;
  vec3 A = aA + vec3(0., uLift, 0.);
  vec3 B = mix(aA, aB, f) + vec3(0., uLift, 0.);
  vec4 c0 = projectionMatrix * modelViewMatrix * vec4(A, 1.);
  vec4 c1 = projectionMatrix * modelViewMatrix * vec4(B, 1.);
  vec2 s0 = c0.xy / c0.w * .5 * uRes, s1 = c1.xy / c1.w * .5 * uRes;
  vec2 d = s1 - s0; float len = length(d);
  vec2 dir = len > 1e-4 ? d / len : vec2(1., 0.);
  vec2 nrm = vec2(-dir.y, dir.x);
  float wpx = (aCls < .5 ? uWidth.x : aCls < 1.5 ? uWidth.y : uWidth.z) * uPx;
  if (uWorldW > 0.) {
    // metres → px at this segment's depth: project a 1 m offset
    vec4 cm = projectionMatrix * modelViewMatrix * vec4(A + vec3(1., 0., 0.), 1.);
    float pxPerM = length(cm.xy / cm.w * .5 * uRes - s0);
    wpx = max(wpx, uWorldW * (aCls < .5 ? .55 : aCls < 1.5 ? .8 : 1.2) * pxPerM);
  }
  wpx *= 1. + uIsoWiden * uIsoOn * step(min(aIsoR.x, aIsoR.y), uIsoFront) * step(min(aIso.x, aIso.y), uIsoCut);
  float hw = wpx * .5;
  float along = position.x;
  vec4 c = mix(c0, c1, along);
  vec2 off = nrm * position.y * (hw + 1.2 * uPx) + dir * (along * 2. - 1.) * hw;
  c.xy += off / (.5 * uRes) * c.w;
  vSide = position.y * (hw + 1.2 * uPx);
  vHalf = hw;
  vD = mix(aGrow.x, mix(aGrow.x, aGrow.y, f), along);
  vIso = mix(aIso.x, mix(aIso.x, aIso.y, f), along);
  vIsoR = mix(aIsoR.x, mix(aIsoR.x, aIsoR.y, f), along);
  vCls = aCls;
  vWP = mix(A, B, along);
  gl_Position = f <= 0. || c0.w < 1. || c1.w < 1. ? vec4(2., 2., 2., 1.) : c;
}`;

const FRAG = /* glsl */`
${SHADOW_GLSL}
uniform float uLineShade;
uniform float uDash;          // > 0: dashed, period in metres along the segment's grow distance
varying vec3 vWP;
uniform float uPx;
uniform float uGrow;
uniform float uGrowAll;
uniform float uHeatLen;
uniform vec3 uBone;
uniform vec3 uHot;
uniform vec3 uAlpha;          // opacity per class
uniform float uOpacity;
uniform float uIsoOn;         // 0..1 blend to travel-time colouring
uniform float uIsoFront;      // seconds
uniform float uIsoMax;        // seconds mapped to the far end of the ramp
uniform float uIsoCut;        // seconds beyond which a street is never reached
uniform sampler2D uRamp;
uniform vec3 uTint;           // multiplies bone (e.g. dusk)
varying float vSide;
varying float vHalf;
varying float vD;
varying float vIso;
varying float vIsoR;
varying float vCls;
varying float vF;
void main() {
  float aa = 1. - smoothstep(vHalf - .6 * uPx, vHalf + .6 * uPx, abs(vSide));
  if (vHalf < .5 * uPx) aa *= vHalf / (.5 * uPx) * 1.6;            // sub-pixel lines fade instead of aliasing
  float heat = uGrowAll > .5 ? 0. : exp(-max(uGrow - vD, 0.) / uHeatLen);
  float a = vCls < .5 ? uAlpha.x : vCls < 1.5 ? uAlpha.y : uAlpha.z;
  vec3 c = mix(uBone * uTint, uHot, heat);
  a = min(1., a + heat * 1.2);
  if (uIsoOn > 0.) {
    // vIsoR orders the reveal (it may carry per-source start delays); vIso is the travel time itself
    float reached = step(vIsoR, uIsoFront) * step(vIso, uIsoCut);
    float k = clamp(vIso / uIsoMax, 0., 1.);
    vec3 ic = texture2D(uRamp, vec2(1. - k, .5)).rgb;
    float edge = exp(-max(uIsoFront - vIsoR, 0.) / 90.);             // bright wavefront
    vec3 lit = ic * (1.15 + edge * 2.2);
    float ia = reached * (.55 + .45 * (vCls / 2.)) + edge * reached * .6;
    c = mix(c, lit, uIsoOn * reached);
    a = mix(a, max(a * .5, ia), uIsoOn * reached);
    a = mix(a, a * .35, uIsoOn * (1. - reached));
  }
  c *= mix(uLineShade, 1., shadowAt(vWP, uShadowBias));
  if (uDash > 0. && fract(vD / uDash) > .56) discard;
  gl_FragColor = vec4(c, a * aa * uOpacity);
}`;

export function rampTexture(stops) {
  const n = 256, data = new Uint8Array(n * 4);
  const cs = stops.map(h => new THREE.Color(h));
  for (let i = 0; i < n; i++) {
    const k = i / (n - 1) * (cs.length - 1), j = Math.min(cs.length - 2, Math.floor(k)), f = k - j;
    const c = cs[j].clone().lerp(cs[j + 1], f);
    // keep the ramp in linear space: ShaderMaterial output is converted to sRGB by the OutputPass
    data[i * 4] = Math.round(c.r * 255); data[i * 4 + 1] = Math.round(c.g * 255); data[i * 4 + 2] = Math.round(c.b * 255); data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, n, 1, THREE.RGBAFormat);
  tex.magFilter = tex.minFilter = THREE.LinearFilter; tex.needsUpdate = true;
  return tex;
}

// segs: { a: Float32Array(n*2), b: Float32Array(n*2) (x east, y north), grow: Float32Array(n*2), iso: Float32Array(n*2), cls: Uint8Array(n),
//         h: Float32Array(n*2) optional height of each end (m) }
export function makeLines(segs, opts = {}) {
  const n = segs.cls.length;
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([0, -1, 0, 1, -1, 0, 0, 1, 0, 1, 1, 0], 3));
  g.setIndex([0, 1, 2, 2, 1, 3]);
  const A = new Float32Array(n * 3), B = new Float32Array(n * 3), C = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    A[i * 3] = segs.a[i * 2]; A[i * 3 + 1] = segs.h ? segs.h[i * 2] : 0; A[i * 3 + 2] = -segs.a[i * 2 + 1];
    B[i * 3] = segs.b[i * 2]; B[i * 3 + 1] = segs.h ? segs.h[i * 2 + 1] : 0; B[i * 3 + 2] = -segs.b[i * 2 + 1];
    C[i] = segs.cls[i];
  }
  g.setAttribute('aA', new THREE.InstancedBufferAttribute(A, 3));
  g.setAttribute('aB', new THREE.InstancedBufferAttribute(B, 3));
  g.setAttribute('aGrow', new THREE.InstancedBufferAttribute(segs.grow, 2));
  g.setAttribute('aIso', new THREE.InstancedBufferAttribute(segs.iso || new Float32Array(n * 2).fill(1e9), 2));
  g.setAttribute('aIsoR', new THREE.InstancedBufferAttribute(segs.isoR || new Float32Array(n * 2).fill(1e9), 2));
  g.setAttribute('aCls', new THREE.InstancedBufferAttribute(C, 1));
  g.instanceCount = n;
  const m = new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, depthTest: opts.depthTest ?? true,
    blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    uniforms: {
      uRes: { value: new THREE.Vector2(1920, 1080) }, uPx: { value: 1 },
      uGrow: { value: 0 }, uGrowAll: { value: 1 }, uHeatLen: { value: 260 },
      uWidth: { value: new THREE.Vector3(.8, 1.1, 1.7) }, uWorldW: { value: 0 }, uLift: { value: .6 },
      uBone: { value: new THREE.Color('#F0F4EF') }, uHot: { value: new THREE.Color('#FFD9A8').multiplyScalar(2.4) },
      uAlpha: { value: new THREE.Vector3(.34, .5, .72) }, uOpacity: { value: 1 },
      uIsoOn: { value: 0 }, uIsoFront: { value: 0 }, uIsoMax: { value: 1800 }, uIsoCut: { value: 1e9 }, uIsoWiden: { value: 0 }, uRamp: { value: opts.ramp || null },
      uTint: { value: new THREE.Color(1, 1, 1) }, uLineShade: { value: .5 }, uDash: { value: 0 },
      ...(opts.shadow ? opts.shadow.uniforms : { uShadowMap: { value: null }, uShadowMatrix: { value: new THREE.Matrix4() }, uShadowOn: { value: 0 }, uShadowTexel: { value: 1 / 4096 }, uShadowSoft: { value: 1 }, uShadowBias: { value: 3e-5 } }),
    },
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.frustumCulled = false;
  mesh.renderOrder = opts.renderOrder ?? 2;
  return mesh;
}
