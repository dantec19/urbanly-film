// util.js: pure helpers. Every frame is a pure function of t, so nothing here keeps state.
import * as THREE from 'three';

export const TAU = Math.PI * 2;
export const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
export const lerp = (a, b, k) => a + (b - a) * k;
export const seg = (t, a, b) => clamp((t - a) / (b - a));
export const smooth = x => { x = clamp(x); return x * x * (3 - 2 * x); };
export const inOut = x => { x = clamp(x); return x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
export const inOut5 = x => { x = clamp(x); return x < .5 ? 16 * x ** 5 : 1 - Math.pow(-2 * x + 2, 5) / 2; };
export const easeOut = x => 1 - Math.pow(1 - clamp(x), 3);
export const easeOut5 = x => 1 - Math.pow(1 - clamp(x), 5);
export const easeIn = x => Math.pow(clamp(x), 3);
export const expoOut = x => { x = clamp(x); return x === 1 ? 1 : 1 - Math.pow(2, -10 * x); };
export const expoInOut = x => { x = clamp(x); if (x === 0 || x === 1) return x; return x < .5 ? Math.pow(2, 20 * x - 10) / 2 : (2 - Math.pow(2, -20 * x + 10)) / 2; };
export const backOut = (x, s = 1.70158) => { x = clamp(x); const c3 = s + 1; return 1 + c3 * Math.pow(x - 1, 3) + s * Math.pow(x - 1, 2); };
// the site's --ease: cubic-bezier(.4, 0, .2, 1)
export const siteEase = bezier(.4, 0, .2, 1);
export const heroEase = bezier(.2, .7, .3, 1);

export function bezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = u => ((ax * u + bx) * u + cx) * u, sy = u => ((ay * u + by) * u + cy) * u;
  const dx = u => (3 * ax * u + 2 * bx) * u + cx;
  return x => {
    x = clamp(x); let u = x;
    for (let i = 0; i < 8; i++) { const e = sx(u) - x; const d = dx(u); if (Math.abs(e) < 1e-6 || Math.abs(d) < 1e-6) break; u -= e / d; }
    return sy(clamp(u));
  };
}

// keyframes: kf(t, [[t0, v0], [t1, v1], ...], easeFn). Values may be numbers or arrays of numbers.
export function kf(t, keys, e = inOut) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (t < keys[i][0]) {
      const [a, va] = keys[i - 1], [b, vb] = keys[i], k = (keys[i][2] || e)((t - a) / (b - a));
      return Array.isArray(va) ? va.map((v, j) => lerp(v, vb[j], k)) : lerp(va, vb, k);
    }
  }
  return keys[keys.length - 1][1];
}

// stable pseudo-random in [0,1) from an integer-ish seed
export function hash(i) { let x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }
export function hash2(a, b) { return hash(a * 12.9898 + b * 78.233); }

// damped wobble kicked at t0 (settles, follow-through)
export const spring = (t, t0, k = 6, w = 18) => t < t0 ? 0 : Math.exp(-k * (t - t0)) * Math.sin(w * (t - t0));

// colour: sRGB hex → linear THREE.Color
export const col = hex => new THREE.Color(hex);
export const PAL = {
  ground: '#1B1418', plum: '#281E24', panel: '#2C2127',
  bone: '#F0F4EF', secondary: '#C6BCC4', muted: '#9DAFAF', label: '#92ADAE',
  coral: '#F77138', amber: '#FFB547', ember: '#FF8A3D',
  up: '#5EC962', down: '#C68A72',
};
// viridis stops, as on urbanly.org's --meter-ramp
export const VIRIDIS = ['#440154', '#482878', '#3E4A89', '#31688E', '#26828E', '#1F9E89', '#35B779', '#6DCD59', '#B4DE2C', '#FDE725'];
export function viridis(k) {
  k = clamp(k) * (VIRIDIS.length - 1); const i = Math.min(VIRIDIS.length - 2, Math.floor(k)), f = k - i;
  return new THREE.Color(VIRIDIS[i]).lerp(new THREE.Color(VIRIDIS[i + 1]), f);
}
export function viridisCss(k) { return '#' + viridis(k).getHexString(); }

// number formatting for on-screen figures (Archivo, tabular)
export const fmt = (n, d = 0) => n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

// tuning knobs from the URL (render.mjs --q=a=1&b=2), for A/B stills only
const QS = new URLSearchParams(location.search);
export const Q = (k, d) => QS.has(k) ? +QS.get(k) : d;
