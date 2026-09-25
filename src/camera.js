// camera.js: a camera described the way a cinematographer would, and smooth paths through keys.
// State: x, y = ground target in metres (x east, y north); w = ground width in view at the target (m);
// pitch = degrees below the horizon (90 = straight down); yaw = compass heading (0 = north up);
// fov = vertical field of view in degrees; h = target height (m).
import * as THREE from 'three';

const D2R = Math.PI / 180;

export function applyCamera(cam, s, aspect) {
  const fov = s.fov ?? 20, tanH = Math.tan(fov * D2R / 2);
  const D = s.w / (2 * tanH * aspect);
  const p = s.pitch * D2R, yw = s.yaw * D2R;
  const fwd = new THREE.Vector3(Math.sin(yw) * Math.cos(p), -Math.sin(p), -Math.cos(yw) * Math.cos(p));
  const target = new THREE.Vector3(s.x, s.h || 0, -s.y);
  cam.fov = fov; cam.aspect = aspect;
  cam.position.copy(target).addScaledVector(fwd, -D);
  cam.rotation.set(-p, -yw, s.roll ? s.roll * D2R : 0, 'YXZ');
  cam.near = Math.max(1, D * 0.05); cam.far = D * 6 + 60000;
  cam.updateProjectionMatrix(); cam.updateMatrixWorld(true);
  return D;
}

// Smooth path through keyed camera states: [[t, {x,y,w,pitch,yaw,fov,h}], ...].
// Cubic Hermite per property with Catmull-Rom tangents (continuous velocity through keys), zero velocity at the
// first and last key, and w interpolated in log space so zooms feel constant-rate. A key may set `hold: true` to
// force zero velocity there (the camera eases to a stop), and `e` to ease the segment that ends at it.
const PROPS = ['x', 'y', 'lw', 'pitch', 'yaw', 'fov', 'h', 'roll'];
export function camPath(t, keys) {
  const ks = keys.map(([kt, s]) => [kt, { ...s, lw: Math.log(s.w), h: s.h || 0, roll: s.roll || 0, fov: s.fov ?? 20 }]);
  if (t <= ks[0][0]) return unlog(ks[0][1]);
  if (t >= ks[ks.length - 1][0]) return unlog(ks[ks.length - 1][1]);
  let i = 0; while (t >= ks[i + 1][0]) i++;
  const [t0, a] = ks[i], [t1, b] = ks[i + 1], dt = t1 - t0;
  let u = (t - t0) / dt;
  if (b.e) u = b.e(u);
  const out = {};
  for (const p of PROPS) {
    const m0 = tangent(ks, i, p) * dt, m1 = tangent(ks, i + 1, p) * dt;
    const u2 = u * u, u3 = u2 * u;
    out[p] = (2 * u3 - 3 * u2 + 1) * a[p] + (u3 - 2 * u2 + u) * m0 + (-2 * u3 + 3 * u2) * b[p] + (u3 - u2) * m1;
  }
  return unlog(out);
}
function tangent(ks, i, p) {
  if (i === 0 || i === ks.length - 1 || ks[i][1].hold) return 0;
  const [ta, a] = ks[i - 1], [tb, b] = ks[i + 1];
  return (b[p] - a[p]) / (tb - ta);
}
function unlog(s) { return { ...s, w: Math.exp(s.lw) }; }

// world (metres, y north) → screen px (CSS px of the 1920×1080 stage); null when behind the camera
const _v = new THREE.Vector3();
export function toScreen(cam, x, y, h = 0, W = 1920, H = 1080) {
  _v.set(x, h, -y).project(cam);
  if (_v.z > 1) return null;
  return [(_v.x * .5 + .5) * W, (-_v.y * .5 + .5) * H, _v.z];
}
