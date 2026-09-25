// main.js: boots the renderer, loads the city, builds the film and exposes renderAt(t) to the renderer.
import { makeGL } from './gl.js';
import { Overlay } from './overlay.js';
import { buildFilm, DURATION } from './film.js';
import { loadWorld } from './data.js';

const params = new URLSearchParams(location.search);
const RENDER = params.has('render');
const DPR = +(params.get('dpr') || 1);
if (RENDER) document.body.classList.add('render');

const G = makeGL(document.getElementById('gl'), DPR);
const ov = new Overlay(document.getElementById('ov'));
window.DURATION = DURATION;
window.__G = G;
window.gpuInfo = () => {
  const gl = G.renderer.getContext(); const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
};

addEventListener('error', () => { window.failed = true; });
addEventListener('unhandledrejection', () => { window.failed = true; });
const t0 = performance.now();
const data = await loadWorld();
await Promise.all(['300 68px Montserrat', '400 20px Montserrat', '500 20px Montserrat', '800 20px Montserrat', '400 17px Archivo', '500 17px Archivo']
  .map(f => document.fonts.load(f)));
await document.fonts.ready;
const frame = await buildFilm(G, data, ov);
console.log(`world ready in ${(performance.now() - t0).toFixed(0)} ms`);

const nextFrame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
window.renderAt = async t => { frame(t); G.composer.render(); await nextFrame(); };
await window.renderAt(0);

if (!RENDER) {
  const scrub = document.getElementById('scrub'), tt = document.getElementById('tt');
  scrub.max = DURATION;
  const q = +(params.get('t') || 0);
  let busy = false, want = q;
  const go = async () => { if (busy) return; busy = true; while (want !== null) { const t = want; want = null; await window.renderAt(t); tt.textContent = t.toFixed(2) + ' s'; } busy = false; };
  scrub.value = q; want = q; go();
  scrub.oninput = () => { want = +scrub.value; go(); };
  // scale the 1920×1080 stage to the window
  const fit = () => { const s = Math.min(innerWidth / 1920, (innerHeight - 40) / 1080); document.getElementById('stage').style.transform = `scale(${s})`; document.getElementById('stage').style.transformOrigin = '0 0'; };
  addEventListener('resize', fit); fit();
}
window.ready = true;
