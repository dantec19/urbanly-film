// shadow.js: one directional sun shadow map, fitted each frame around what the camera looks at.
// Buildings render into it with a depth-only twin of their material (same vertex shader, so rising and
// growing buildings cast the right shadow); buildings, the ground plate and the street lines read it back.
import * as THREE from 'three';

export const SHADOW_GLSL = /* glsl */`
uniform sampler2D uShadowMap;
uniform mat4 uShadowMatrix;
uniform float uShadowOn;
uniform float uShadowTexel;
uniform float uShadowSoft;
uniform float uShadowBias;
float shadowAt(vec3 wp, float bias) {
  if (uShadowOn < .001) return 1.;
  vec4 s = uShadowMatrix * vec4(wp, 1.);
  vec3 p = s.xyz / s.w;
  if (p.x < 0. || p.x > 1. || p.y < 0. || p.y > 1. || p.z > 1.) return 1.;
  float lit = 0.;
  for (int i = -2; i <= 2; i++) for (int j = -2; j <= 2; j++) {
    vec2 o = vec2(float(i), float(j)) * uShadowTexel * uShadowSoft;
    float d = texture2D(uShadowMap, p.xy + o).r;
    lit += p.z - bias > d ? 0. : 1.;
  }
  return mix(1., lit / 25., uShadowOn);
}`;

export function makeShadow(renderer, size = 4096) {
  const depthTexture = new THREE.DepthTexture(size, size);
  depthTexture.type = THREE.FloatType;
  depthTexture.minFilter = depthTexture.magFilter = THREE.NearestFilter;
  const rt = new THREE.WebGLRenderTarget(size, size, { depthTexture, depthBuffer: true });
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 80000);
  const matrix = new THREE.Matrix4();
  const bias = new THREE.Matrix4().set(.5, 0, 0, .5, 0, .5, 0, .5, 0, 0, .5, .5, 0, 0, 0, 1);
  const uniforms = {
    uShadowMap: { value: depthTexture }, uShadowMatrix: { value: matrix }, uShadowOn: { value: 1 },
    uShadowTexel: { value: 1 / size }, uShadowSoft: { value: 1.2 }, uShadowBias: { value: 3e-5 },
  };
  // lightDir: unit vector pointing toward the sun (world: x east, y up, z south)
  function fit(tx, tz, radius, lightDir) {
    const D = 30000;
    cam.position.set(tx + lightDir.x * D, lightDir.y * D, tz + lightDir.z * D);
    cam.up.set(0, 1, 0);
    cam.lookAt(tx, 0, tz);
    cam.left = -radius; cam.right = radius; cam.top = radius; cam.bottom = -radius;
    cam.near = D - 3000; cam.far = D + 3000 + radius * 2;
    cam.updateProjectionMatrix(); cam.updateMatrixWorld(true);
    matrix.multiplyMatrices(bias, cam.projectionMatrix).multiply(cam.matrixWorldInverse);
  }
  // draw the casters (a group of meshes) with their depth material
  function render(root, depthMaterial) {
    const saved = [];
    root.traverse(o => { if (o.isMesh) { saved.push([o, o.material]); o.material = depthMaterial; } });
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(rt); renderer.setClearColor(0x000000, 1); renderer.clear(true, true, true);
    renderer.render(root, cam);
    renderer.setRenderTarget(prev);
    for (const [o, m] of saved) o.material = m;
  }
  return { rt, cam, uniforms, fit, render, size };
}
