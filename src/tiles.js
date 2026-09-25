// tiles.js: map tiles drawn on a 2D canvas, used as textures for the yearly tiles (a decade stacked as a
// tower) and the present slab. North is up on the canvas; the canvas maps a world rectangle.
import * as THREE from 'three';

// rect: [x0, y0, x1, y1] metres (x east, y north); size: [w, h] px
export function makeMapper(rect, size) {
  const [x0, y0, x1, y1] = rect, [w, h] = size;
  return (x, y) => [(x - x0) / (x1 - x0) * w, (1 - (y - y0) / (y1 - y0)) * h];
}

// streets: { nodes, edges, cls } of the film's street set
export function drawStreets(g, streets, map, { alpha = .16, width = 1, bone = '240,244,239' } = {}) {
  const { nodes, edges, cls } = streets;
  for (const c of [0, 1, 2]) {
    g.strokeStyle = `rgba(${bone},${alpha * (c === 0 ? .7 : c === 1 ? 1 : 1.5)})`;
    g.lineWidth = width * (c === 0 ? .8 : c === 1 ? 1 : 1.5);
    g.beginPath();
    for (let e = 0; e < cls.length; e++) {
      if (cls[e] !== c) continue;
      const a = edges[e * 2], b = edges[e * 2 + 1];
      const [ax, ay] = map(nodes[a * 2], nodes[a * 2 + 1]), [bx, by] = map(nodes[b * 2], nodes[b * 2 + 1]);
      if ((ax < -2 && bx < -2) || (ay < -2 && by < -2) || (ax > g.canvas.width + 2 && bx > g.canvas.width + 2) || (ay > g.canvas.height + 2 && by > g.canvas.height + 2)) continue;
      g.moveTo(ax, ay); g.lineTo(bx, by);
    }
    g.stroke();
  }
}

// growth points: Float32Array N×4 (x, y, completeT, units); draws those completed in [t0, t1). With `inside`
// (one flag per point) the points outside the counted area are drawn as small dim dots; points completed at
// or after `freshFrom` get a hotter core.
export function drawGrowth(g, pts, map, t0, t1, { scale = 1, color = '255,181,71', inside = null, freshFrom = Infinity } = {}) {
  g.save();
  g.globalCompositeOperation = 'lighter';
  const n = pts.length / 4, W = g.canvas.width, H = g.canvas.height;
  for (let i = 0; i < n; i++) {
    const T = pts[i * 4 + 2];
    if (T < t0 || T >= t1) continue;
    const [x, y] = map(pts[i * 4], pts[i * 4 + 1]);
    if (x < -20 || y < -20 || x > W + 20 || y > H + 20) continue;
    const u = Math.max(1, pts[i * 4 + 3]), fresh = T >= freshFrom;
    const r = scale * (1.1 + .55 * Math.sqrt(u));
    if (inside && !inside[i]) {
      g.fillStyle = `rgba(${color},${fresh ? .5 : .26})`;
      g.beginPath(); g.arc(x, y, Math.max(1.1, r * .3), 0, Math.PI * 2); g.fill();
      continue;
    }
    const a = fresh ? 1 : .72, R = r * 2.6;
    const grd = g.createRadialGradient(x, y, 0, x, y, R);
    grd.addColorStop(0, `rgba(${color},${.9 * a})`); grd.addColorStop(.35, `rgba(${color},${.35 * a})`); grd.addColorStop(1, `rgba(${color},0)`);
    g.fillStyle = grd; g.fillRect(x - R, y - R, R * 2, R * 2);
    g.fillStyle = fresh ? 'rgba(255,246,228,1)' : 'rgba(255,236,200,.8)'; g.beginPath(); g.arc(x, y, r * .45, 0, Math.PI * 2); g.fill();
  }
  g.restore();
}

// the union of equal discs (centres in px): one flat fill and one outline around the whole shape
export function drawDiscs(g, centres, r, { fill = null, fillAlpha = .05, stroke = null, strokeAlpha = .3, lw = 1, dash = null } = {}) {
  const w = g.canvas.width, h = g.canvas.height;
  const discs = (cg, rr) => { cg.beginPath(); for (const [x, y] of centres) { cg.moveTo(x + rr, y); cg.arc(x, y, rr, 0, Math.PI * 2); } };
  if (fill) {
    const [c, cg] = newCanvas(w, h);
    cg.fillStyle = fill; discs(cg, r); cg.fill();
    g.save(); g.globalAlpha = fillAlpha; g.drawImage(c, 0, 0); g.restore();
  }
  if (stroke) {
    const [c, cg] = newCanvas(w, h);
    cg.strokeStyle = stroke; cg.lineWidth = lw; if (dash) cg.setLineDash(dash);
    for (const [x, y] of centres) { cg.beginPath(); cg.arc(x, y, r, 0, Math.PI * 2); cg.stroke(); }
    cg.globalCompositeOperation = 'destination-out'; cg.fillStyle = '#000'; discs(cg, r - lw * .6); cg.fill();
    g.save(); g.globalAlpha = strokeAlpha; g.drawImage(c, 0, 0); g.restore();
  }
}

export function drawLine(g, line, map, { width = 3, color = '#F77138', stations = true } = {}) {
  const p = line.polyline.flat();
  g.save();
  g.strokeStyle = color; g.lineWidth = width; g.lineJoin = 'round'; g.lineCap = 'round';
  g.beginPath();
  for (let i = 0; i < p.length / 2; i++) { const [x, y] = map(p[i * 2], p[i * 2 + 1]); i ? g.lineTo(x, y) : g.moveTo(x, y); }
  g.stroke();
  if (stations) for (const s of line.stations) {
    const [x, y] = map(s.x, s.y);
    g.fillStyle = '#1B1418'; g.beginPath(); g.arc(x, y, width * 1.5, 0, Math.PI * 2); g.fill();
    g.strokeStyle = color; g.lineWidth = width * .8; g.stroke();
  }
  g.restore();
}

export function canvasTexture(c) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  return t;
}

export function newCanvas(w, h, fill = null) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  if (fill) { g.fillStyle = fill; g.fillRect(0, 0, w, h); }
  return [c, g];
}
