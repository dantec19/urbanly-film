// gl.js: renderer, scene, camera and the post chain (MSAA render, bloom for anything brighter than white,
// sRGB output, then a display-space grade: vignette, lamp falloff and a fine deterministic grain).
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

const GRADE = {
  uniforms: {
    tDiffuse: { value: null }, uRes: { value: new THREE.Vector2(1920, 1080) }, uFrame: { value: 0 },
    uVig: { value: .42 }, uGrain: { value: .035 }, uFade: { value: 1 }, uFadeCol: { value: new THREE.Color('#1B1418') },
    uLamp: { value: new THREE.Vector2(.5, .46) },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform vec2 uRes; uniform float uFrame, uVig, uGrain, uFade; uniform vec3 uFadeCol; uniform vec2 uLamp;
    varying vec2 vUv;
    float h(vec2 p){ p = fract(p * vec2(443.897, 441.423)); p += dot(p, p.yx + 19.19); return fract((p.x + p.y) * p.x); }
    void main(){
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      vec2 q = (vUv - uLamp) * vec2(uRes.x / uRes.y, 1.);
      float v = 1. - uVig * smoothstep(.25, 1.05, length(q));
      c *= v;
      float g = h(vUv * uRes + fract(uFrame * .6180339) * 917.) - .5;
      c += g * uGrain * (.35 + .65 * (1. - dot(c, vec3(.299, .587, .114))));
      c = mix(uFadeCol, c, uFade);
      gl_FragColor = vec4(c, 1.);
    }`,
};

export function makeGL(canvas, dpr) {
  const W = 1920, H = 1080;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true, powerPreference: 'high-performance', alpha: false });
  renderer.setPixelRatio(dpr);
  renderer.setSize(W, H, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#1B1418');
  const camera = new THREE.PerspectiveCamera(20, W / H, 1, 100000);
  const rt = new THREE.WebGLRenderTarget(W * dpr, H * dpr, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, rt);
  composer.setPixelRatio(dpr); composer.setSize(W, H);
  const renderPass = new RenderPass(scene, camera);
  const bloom = new UnrealBloomPass(new THREE.Vector2(W * dpr, H * dpr), .55, .5, 1.0);
  const output = new OutputPass();
  const grade = new ShaderPass(GRADE);
  grade.uniforms.uRes.value.set(W * dpr, H * dpr);
  composer.addPass(renderPass); composer.addPass(bloom); composer.addPass(output); composer.addPass(grade);
  return { renderer, scene, camera, composer, bloom, grade, W, H, dpr };
}
