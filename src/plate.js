// plate.js: the city's footprint as a slightly lighter plate on the night table (like an architectural
// model's base), receiving the buildings' shadows. The river and the province stay the table colour.
import * as THREE from 'three';
import earcut from '../vendor/earcut.js';
import { SHADOW_GLSL } from './shadow.js';

export function makePlate(boundary, shadow) {
  const pos = [], idx = [];
  for (let r = 0; r < boundary.off.length - 1; r++) {
    const o0 = boundary.off[r], o1 = boundary.off[r + 1], flat = [];
    for (let k = o0; k < o1; k++) flat.push(boundary.xy[k * 2], boundary.xy[k * 2 + 1]);
    const base = pos.length / 3, tri = earcut(flat);
    for (let k = 0; k < flat.length; k += 2) pos.push(flat[k], 0, -flat[k + 1]);
    for (let k = 0; k < tri.length; k += 3) idx.push(base + tri[k], base + tri[k + 2], base + tri[k + 1]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  const m = new THREE.ShaderMaterial({
    uniforms: { uCol: { value: new THREE.Color('#261D22') }, uShade: { value: .55 }, uOpacity: { value: 1 }, ...shadow.uniforms },
    vertexShader: `varying vec3 vW; void main(){ vW = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
    fragmentShader: `${SHADOW_GLSL}
      uniform vec3 uCol; uniform float uShade; uniform float uOpacity; varying vec3 vW;
      void main(){ float s = shadowAt(vW + vec3(0., .3, 0.), uShadowBias); gl_FragColor = vec4(uCol * mix(uShade, 1., s), uOpacity); }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.renderOrder = 0; mesh.frustumCulled = false;
  return mesh;
}
