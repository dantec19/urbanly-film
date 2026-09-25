// overlay.js: the type layer. Real DOM text (Montserrat, Archivo) over the WebGL canvas, positioned and
// animated per frame as a pure function of t.
import { clamp, easeOut, heroEase, siteEase, seg } from './util.js';

export class Overlay {
  constructor(root) {
    this.root = root;
    this.els = {};
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('width', 1920); this.svg.setAttribute('height', 1080);
    this.svg.style.cssText = 'position:absolute;left:0;top:0;overflow:visible;pointer-events:none';
    root.appendChild(this.svg);
  }
  // an absolutely positioned element; `cls` picks a text style from studio.html
  add(id, html, cls = '', css = {}) {
    const e = document.createElement('div');
    e.className = 'ov ' + cls; e.innerHTML = html;
    Object.assign(e.style, css);
    this.root.appendChild(e);
    this.els[id] = e;
    e.style.opacity = 0;
    return e;
  }
  get(id) { return this.els[id]; }
  // wrap each word of the element's text in a span so words can arrive one by one
  splitWords(id) {
    const e = this.els[id];
    const parts = e.innerHTML.split(/(\s+|<br>)/);
    e.innerHTML = parts.map(p => p === '<br>' ? '<br>' : /^\s+$/.test(p) ? p : p ? `<span class="w">${p}</span>` : '').join('');
    e._words = [...e.querySelectorAll('.w')];
    return e._words;
  }
  svgAdd(id, tag, attrs = {}) {
    const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    this.svg.appendChild(n);
    this.els[id] = n;
    return n;
  }
}

// words arrive one after another: rise 0.28em, un-blur, fade. p: 0..1 over the whole line.
export function revealWords(words, p, spread = .55) {
  const n = words.length;
  for (let i = 0; i < n; i++) {
    const a = n > 1 ? i / (n - 1) * spread : 0;
    const q = heroEase(clamp((p - a) / (1 - spread)));
    const w = words[i];
    w.style.opacity = q;
    w.style.transform = `translateY(${(1 - q) * .32}em)`;
    w.style.filter = q < .99 ? `blur(${(1 - q) * 6}px)` : 'none';
  }
}
// a word-by-word reveal driven by explicit times (seconds) per word
export function revealWordsAt(words, t, times, dur = .45) {
  for (let i = 0; i < words.length; i++) {
    const q = heroEase(seg(t, times[i], times[i] + dur));
    const w = words[i];
    w.style.opacity = q;
    w.style.transform = `translateY(${(1 - q) * .32}em)`;
    w.style.filter = q < .99 ? `blur(${(1 - q) * 6}px)` : 'none';
  }
}

// standard in/out for a block: fade + rise in over `din`, fade + lift out over `dout`
export function inOut(el, t, t0, t1, { din = .7, dout = .6, rise = 14, x = 0, y = 0 } = {}) {
  const a = heroEase(seg(t, t0, t0 + din)), b = siteEase(seg(t, t1 - dout, t1));
  const o = a * (1 - b);
  el.style.opacity = o;
  el.style.transform = `translate(${x}px, ${y + (1 - a) * rise - b * rise * .6}px)`;
  el.style.visibility = o <= .001 ? 'hidden' : 'visible';
  return o;
}

export function show(el, o) { el.style.opacity = o; el.style.visibility = o <= .001 ? 'hidden' : 'visible'; }
export function place(el, x, y, extra = '') { el.style.transform = `translate(${x}px, ${y}px) ${extra}`; }
export const ease = easeOut;
