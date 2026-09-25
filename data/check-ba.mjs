// Visual sanity check of the Buenos Aires film export. Reads ONLY the files in
// data/ba/ (no repo decoders), so it also proves the export is self-contained.
//
// Re-run (from the repo root, after export-ba.ts):
//
//   node .scratch/urbanly-film/data/check-ba.mjs
//
// Writes data/ba/check/city.png (whole city) and data/ba/check/crop_1km.png
// (1 km x 1 km around the origin, Plaza de Mayo). sharp comes from the repo's
// node_modules.
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, "ba");
const OUT = path.join(DIR, "check");
mkdirSync(OUT, { recursive: true });
const manifest = JSON.parse(readFileSync(path.join(DIR, "manifest.json"), "utf8"));
const CTORS = { float32: Float32Array, uint32: Uint32Array, uint16: Uint16Array, uint8: Uint8Array };
const load = (file) => {
  const entry = manifest.files.find((f) => f.file === file);
  if (!entry) throw new Error(`${file} not in manifest`);
  const buf = readFileSync(path.join(DIR, file));
  if (entry.dtype === "json") return JSON.parse(buf.toString("utf8"));
  if (buf.byteLength !== entry.bytes) throw new Error(`${file}: ${buf.byteLength} bytes, manifest says ${entry.bytes}`);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const a = new CTORS[entry.dtype](ab);
  if (a.length !== entry.count) throw new Error(`${file}: ${a.length} elements, manifest says ${entry.count}`);
  return a;
};

const hex = (h, a = 1) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), a];

class Canvas {
  constructor(w, h, bg, x0, y1, scale) {
    Object.assign(this, { w, h, x0, y1, s: scale });
    this.px = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) this.px.set([bg[0], bg[1], bg[2], 255], i * 4);
  }
  X(x) { return (x - this.x0) * this.s; }
  Y(y) { return (this.y1 - y) * this.s; }
  blend(i, c) {
    const o = i * 4, a = c[3];
    this.px[o] += (c[0] - this.px[o]) * a;
    this.px[o + 1] += (c[1] - this.px[o + 1]) * a;
    this.px[o + 2] += (c[2] - this.px[o + 2]) * a;
  }
  plot(x, y, c) {
    const ix = Math.floor(x), iy = Math.floor(y);
    if (ix >= 0 && iy >= 0 && ix < this.w && iy < this.h) this.blend(iy * this.w + ix, c);
  }
  /** Even-odd scanline fill of ring [v0, v1) of an interleaved xy array (world units). */
  fillRing(xy, v0, v1, c) {
    let minY = Infinity, maxY = -Infinity;
    for (let i = v0; i < v1; i++) {
      const py = this.Y(xy[i * 2 + 1]);
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
    const r0 = Math.max(0, Math.ceil(minY - 0.5)), r1 = Math.min(this.h - 1, Math.floor(maxY - 0.5));
    const xs = [];
    for (let r = r0; r <= r1; r++) {
      const yc = r + 0.5;
      xs.length = 0;
      for (let i = v0, j = v1 - 1; i < v1; j = i++) {
        const yi = this.Y(xy[i * 2 + 1]), yj = this.Y(xy[j * 2 + 1]);
        if (yi > yc !== yj > yc) {
          const xi = this.X(xy[i * 2]), xj = this.X(xy[j * 2]);
          xs.push(xi + ((yc - yi) * (xj - xi)) / (yj - yi));
        }
      }
      xs.sort((a, b) => a - b);
      for (let m = 0; m + 1 < xs.length; m += 2) {
        const c0 = Math.max(0, Math.ceil(xs[m] - 0.5)), c1 = Math.min(this.w - 1, Math.floor(xs[m + 1] - 0.5));
        for (let q = c0; q <= c1; q++) this.blend(r * this.w + q, c);
      }
    }
  }
  /** Stroke ring or polyline [v0, v1) with `line`. */
  strokeRing(xy, v0, v1, c, width = 1, closed = true) {
    for (let i = v0 + 1; i < v1; i++) this.line(xy[(i - 1) * 2], xy[(i - 1) * 2 + 1], xy[i * 2], xy[i * 2 + 1], c, width);
    if (closed && v1 - v0 > 2) this.line(xy[(v1 - 1) * 2], xy[(v1 - 1) * 2 + 1], xy[v0 * 2], xy[v0 * 2 + 1], c, width);
  }
  /** Line in world units, stamped every 0.5 px with a square of `width` px. */
  line(xa, ya, xb, yb, c, width = 1) {
    const x0 = this.X(xa), y0 = this.Y(ya), x1 = this.X(xb), y1 = this.Y(yb);
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2));
    const hw = (width - 1) / 2;
    let lastX = NaN, lastY = NaN;
    for (let k = 0; k <= n; k++) {
      const x = x0 + ((x1 - x0) * k) / n, y = y0 + ((y1 - y0) * k) / n;
      const ix = Math.floor(x), iy = Math.floor(y);
      if (ix === lastX && iy === lastY) continue;
      lastX = ix;
      lastY = iy;
      if (hw <= 0) this.plot(x, y, c);
      else for (let dy = -hw; dy <= hw; dy++) for (let dx = -hw; dx <= hw; dx++) this.plot(x + dx, y + dy, c);
    }
  }
  dot(x, y, r, c) {
    const px = this.X(x), py = this.Y(y);
    for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++)
      for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) if (dx * dx + dy * dy <= r * r) this.plot(px + dx, py + dy, c);
  }
  async save(file, downsample = 1) {
    let img = sharp(Buffer.from(this.px.buffer), { raw: { width: this.w, height: this.h, channels: 4 } });
    if (downsample > 1) img = sharp(await img.png().toBuffer()).resize(Math.round(this.w / downsample), Math.round(this.h / downsample), { kernel: "lanczos3" });
    await img.png().toFile(path.join(OUT, file));
  }
}

// ---- data
const nodes = load("streets_nodes.f32");
const edges = load("streets_edges.u32");
const eClass = load("streets_edge_class.u8");
const eFlags = load("streets_edge_flags.u8");
const bXY = load("buildings_xy.f32");
const bRing = load("buildings_ring_offsets.u32");
const bStart = load("buildings_ring_start.u32");
const bHeight = load("buildings_height.f32");
const pXY = load("parcels_xy.f32");
const pRing = load("parcels_ring_offsets.u32");
const tXY = load("trees_xy.f32");
const sXY = load("subte_lines_xy.f32");
const sOff = load("subte_lines_offsets.u32");
const sLine = load("subte_lines_line.u8");
const lines = load("subte_lines.json");
const stXY = load("subte_stations_xy.f32");
const stLine = load("subte_stations_line.u8");
const bdXY = load("boundary_xy.f32");
const bdOff = load("boundary_ring_offsets.u32");
const brXY = load("barrios_xy.f32");
const brOff = load("barrios_ring_offsets.u32");
const brHoleXY = load("barrios_hole_xy.f32");
const brHoleOff = load("barrios_hole_ring_offsets.u32");
const barrios = load("barrios.json");

const CLASS_COLOR = {
  0: "#ff00ff", 1: "#ff5a36", 2: "#ff8a3d", 3: "#ffb347", 4: "#ffd966", 5: "#e6e6e6",
  6: "#a9b1ba", 7: "#6f7780", 8: "#4f8f5f", 9: "#4fc3f7", 13: "#c39bd3",
};
const edgeColor = (e, alpha) => hex(CLASS_COLOR[eClass[e]] ?? "#ff00ff", alpha);
const edgeWidth = (e, scale) => (eClass[e] <= 2 && eClass[e] > 0 ? scale * 3 : eClass[e] <= 4 ? scale * 2 : scale);

// Degree of each node (to mark intersections in the crop).
const degree = new Uint8Array(nodes.length / 2);
for (let e = 0; e < edges.length / 2; e++) {
  degree[edges[e * 2]] = Math.min(255, degree[edges[e * 2]] + 1);
  degree[edges[e * 2 + 1]] = Math.min(255, degree[edges[e * 2 + 1]] + 1);
}

// ---- whole city
{
  const [x0, y0, x1, y1] = manifest.layers.streets.bbox;
  const SS = 2; // supersampling
  const targetH = 1800;
  const scale = (targetH * SS) / (y1 - y0);
  const c = new Canvas(Math.ceil((x1 - x0) * scale), targetH * SS, hex("#0e1116"), x0, y1, scale);
  for (let r = 0; r + 1 < bdOff.length; r++) c.fillRing(bdXY, bdOff[r], bdOff[r + 1], hex("#1b2230"));
  for (let r = 0; r + 1 < brOff.length; r++) c.strokeRing(brXY, brOff[r], brOff[r + 1], hex("#3a4a66", 0.9), SS);
  for (let r = 0; r + 1 < brHoleOff.length; r++) c.fillRing(brHoleXY, brHoleOff[r], brHoleOff[r + 1], hex("#0e1116"));
  for (let e = 0; e < edges.length / 2; e++) {
    const a = edges[e * 2], b = edges[e * 2 + 1];
    const inside = eFlags[e] & 4;
    if (eClass[e] >= 7 && eClass[e] !== 13) continue; // city view: vehicular + pedestrian streets only
    c.line(nodes[a * 2], nodes[a * 2 + 1], nodes[b * 2], nodes[b * 2 + 1], inside ? edgeColor(e, 0.85) : hex("#ff00ff", 0.5), edgeWidth(e, 1));
  }
  for (let r = 0; r + 1 < bRing.length; r++) c.fillRing(bXY, bRing[r], bRing[r + 1], hex("#dfe5ec", 0.75));
  for (let k = 0; k + 1 < sOff.length; k++) c.strokeRing(sXY, sOff[k], sOff[k + 1], hex(lines[sLine[k]].color), 3 * SS, false);
  for (let i = 0; i < stLine.length; i++) c.dot(stXY[i * 2], stXY[i * 2 + 1], 3 * SS, hex("#ffffff"));
  for (let r = 0; r + 1 < bdOff.length; r++) c.strokeRing(bdXY, bdOff[r], bdOff[r + 1], hex("#ffffff", 0.9), SS);
  for (const b of barrios) if (b.label) c.dot(b.label[0], b.label[1], 3 * SS, hex("#00e5ff"));
  c.dot(0, 0, 6 * SS, hex("#ff1744"));
  await c.save("city.png", SS);
}

// ---- 1 km x 1 km crop around the origin
{
  const half = 500, scale = 1.6;
  const c = new Canvas(Math.round(2 * half * scale), Math.round(2 * half * scale), hex("#10141a"), -half, half, scale);
  const inCrop = (x, y, m = 60) => x > -half - m && x < half + m && y > -half - m && y < half + m;
  for (let p = 0; p + 1 < pRing.length; p++) {
    if (!inCrop(pXY[pRing[p] * 2], pXY[pRing[p] * 2 + 1], 300)) continue;
    c.fillRing(pXY, pRing[p], pRing[p + 1], hex("#1c2530"));
    c.strokeRing(pXY, pRing[p], pRing[p + 1], hex("#34465a"), 1);
  }
  for (let b = 0; b + 1 < bStart.length; b++) {
    const r0 = bStart[b];
    if (!inCrop(bXY[bRing[r0] * 2], bXY[bRing[r0] * 2 + 1], 300)) continue;
    const t = Math.min(1, bHeight[b] / 60);
    const col = [Math.round(90 + 160 * t), Math.round(110 + 100 * t), Math.round(140 - 80 * t), 0.92];
    for (let r = bStart[b]; r < bStart[b + 1]; r++) c.fillRing(bXY, bRing[r], bRing[r + 1], col);
  }
  for (let e = 0; e < edges.length / 2; e++) {
    const a = edges[e * 2], b = edges[e * 2 + 1];
    if (!inCrop(nodes[a * 2], nodes[a * 2 + 1]) && !inCrop(nodes[b * 2], nodes[b * 2 + 1])) continue;
    c.line(nodes[a * 2], nodes[a * 2 + 1], nodes[b * 2], nodes[b * 2 + 1], edgeColor(e, 0.95), edgeWidth(e, 2));
  }
  for (let n = 0; n < degree.length; n++) {
    if (degree[n] < 3 || !inCrop(nodes[n * 2], nodes[n * 2 + 1])) continue;
    c.dot(nodes[n * 2], nodes[n * 2 + 1], 2.2, hex("#ffffff", 0.9));
  }
  for (let i = 0; i < tXY.length / 2; i++) {
    if (inCrop(tXY[i * 2], tXY[i * 2 + 1])) c.dot(tXY[i * 2], tXY[i * 2 + 1], 1.6, hex("#3ddc84", 0.9));
  }
  for (let k = 0; k + 1 < sOff.length; k++) c.strokeRing(sXY, sOff[k], sOff[k + 1], hex(lines[sLine[k]].color, 0.9), 4, false);
  for (let i = 0; i < stLine.length; i++) {
    if (!inCrop(stXY[i * 2], stXY[i * 2 + 1])) continue;
    c.dot(stXY[i * 2], stXY[i * 2 + 1], 7, hex(lines[stLine[i]].color));
    c.dot(stXY[i * 2], stXY[i * 2 + 1], 3.5, hex("#ffffff"));
  }
  c.dot(0, 0, 5, hex("#ff1744"));
  // 100 m scale bar, bottom-left.
  c.line(-half + 40, -half + 40, -half + 140, -half + 40, hex("#ffffff"), 3);
  await c.save("crop_1km.png");
}

console.log("wrote", path.join(OUT, "city.png"), "and", path.join(OUT, "crop_1km.png"));
