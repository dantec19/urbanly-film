// Geometry checks (lot frontage/depth, rectangularity, street-facing sides) for
// the clean 8-14 storey builds of clean-scan.json.
//   node .scratch/urbanly-film/data/showcase/check-clean.mjs   (from the repo root)
import { readFileSync, writeFileSync } from "node:fs";
const ROOT = ".scratch/urbanly-film/data/";
const rd = (n, T) => { const b = readFileSync(ROOT + "ba/" + n); return new T(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
const pID = rd("parcels_id.u32", Uint32Array), pOff = rd("parcels_ring_offsets.u32", Uint32Array), pXY = rd("parcels_xy.f32", Float32Array), pCent = rd("parcels_centroid.f32", Float32Array);
const rowOf = new Map(); for (let r = 0; r < pID.length; r++) rowOf.set(pID[r], r);
const sN = rd("streets_nodes.f32", Float32Array), sE = rd("streets_edges.u32", Uint32Array), sC = rd("streets_edge_class.u8", Uint8Array), sName = rd("streets_edge_name.u16", Uint16Array);
const names = JSON.parse(readFileSync(ROOT + "ba/streets_names.json", "utf8"));
const CELL = 50, grid = new Map(), key = (i, j) => i * 100000 + j;
for (let e = 0; e < sC.length; e++) { const c = sC[e]; if (!((c >= 1 && c <= 7) || c === 13)) continue; const a = sE[e*2], b = sE[e*2+1];
  for (let i = Math.floor(Math.min(sN[a*2], sN[b*2]) / CELL); i <= Math.floor(Math.max(sN[a*2], sN[b*2]) / CELL); i++)
    for (let j = Math.floor(Math.min(sN[a*2+1], sN[b*2+1]) / CELL); j <= Math.floor(Math.max(sN[a*2+1], sN[b*2+1]) / CELL); j++) { const k = key(i, j); (grid.get(k) ?? grid.set(k, []).get(k)).push(e); } }
const seg = (px, py, ax, ay, bx, by) => { const dx = bx - ax, dy = by - ay, L = dx*dx + dy*dy; let t = L > 0 ? ((px-ax)*dx + (py-ay)*dy) / L : 0; t = Math.max(0, Math.min(1, t)); return Math.hypot(ax + t*dx - px, ay + t*dy - py); };
function nearest(px, py) { let best = Infinity, be = -1; const ci = Math.floor(px / CELL), cj = Math.floor(py / CELL);
  for (let i = ci - 2; i <= ci + 2; i++) for (let j = cj - 2; j <= cj + 2; j++) for (const e of grid.get(key(i, j)) ?? []) { const a = sE[e*2], b = sE[e*2+1]; const d = seg(px, py, sN[a*2], sN[a*2+1], sN[b*2], sN[b*2+1]); if (d < best) { best = d; be = e; } }
  return { d: best, e: be }; }
function box(ring) { const n = ring.length / 2; let best = null;
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; const ex = ring[j*2] - ring[i*2], ey = ring[j*2+1] - ring[i*2+1], L = Math.hypot(ex, ey); if (L < 1e-6) continue; const ux = ex / L, uy = ey / L;
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity; for (let k = 0; k < n; k++) { const a = ring[k*2]*ux + ring[k*2+1]*uy, b = -ring[k*2]*uy + ring[k*2+1]*ux; a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b); }
    if (!best || (a1-a0)*(b1-b0) < best.area) best = { area: (a1-a0)*(b1-b0), w: a1-a0, h: b1-b0, ux, uy }; }
  return { short: Math.min(best.w, best.h), long: Math.max(best.w, best.h), area: best.area, axis: best.w >= best.h ? [best.ux, best.uy] : [-best.uy, best.ux] }; }
const area = (r) => { let a = 0; const n = r.length / 2; for (let i = 0, j = n - 1; i < n; j = i++) a += r[j*2]*r[i*2+1] - r[i*2]*r[j*2+1]; return Math.abs(a / 2); };
const rows = JSON.parse(readFileSync(ROOT + "showcase/clean-scan.json", "utf8")).filter((x) => x.stories >= 8 && x.stories <= 14 && !x.after && x.complete);
const dev = JSON.parse(readFileSync(ROOT + "sim/buenosaires-developments.json", "utf8"));
const perParcel = new Map(); for (const b of dev.buildings) for (const p of b.parcels) perParcel.set(p, (perParcel.get(p) ?? 0) + 1);
const cent = []; for (const b of dev.buildings) { if (!b.complete || b.completesAfterRun || !b.footprint) continue; const r = b.footprint[0][0]; let sx = 0, sy = 0; for (let i = 0; i < r.length; i += 2) { sx += r[i]; sy += r[i+1]; } cent.push([sx / (r.length/2), sy / (r.length/2), b.kind]); }
const seen = new Set(); const out = [];
for (const x of rows) {
  if (seen.has(x.parcelID)) continue; seen.add(x.parcelID);
  const r = rowOf.get(x.parcelID); const ring = Array.from(pXY.subarray(pOff[r]*2, pOff[r+1]*2)); const bx = box(ring);
  const n = ring.length / 2; const facing = [];
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; const ax = ring[i*2], ay = ring[i*2+1], bx2 = ring[j*2], by = ring[j*2+1]; const L = Math.hypot(bx2-ax, by-ay); if (L < 2) continue;
    const { d, e } = nearest((ax+bx2)/2, (ay+by)/2); const cos = Math.abs(((bx2-ax)*bx.axis[0] + (by-ay)*bx.axis[1]) / L); if (d < 14) facing.push({ len: +L.toFixed(1), d: +d.toFixed(1), long: cos > 0.7, street: names[sName[e]] }); }
  const cx = pCent[r*2], cy = pCent[r*2+1]; let mf = 0, all = 0; for (const [px, py, k] of cent) { const dd = Math.hypot(px - cx, py - cy); if (dd <= 500) { all++; if (k === "ar-multifamily") mf++; } }
  const o = { ...x, row: r, frontage: +bx.short.toFixed(1), depth: +bx.long.toFixed(1), rect: +(area(ring) / bx.area).toFixed(2), midBlock: facing.length >= 1 && facing.every((f) => !f.long), facing, newOnParcel: perParcel.get(x.parcelID), mf500: mf, all500: all };
  out.push(o);
  console.log(`${x.parcelID} ${x.barrio} ${x.stories}st ${x.units}u lot ${x.lot} ${o.frontage}x${o.depth} rect ${o.rect} mid ${o.midBlock} new/parcel ${o.newOnParcel} mf500 ${mf} olds ${x.olds.map((q) => q.h + "m").join(",")} ${x.start.join("-")}->${x.complete.join("-")} front ${facing.map((f) => `${f.street}@${f.d}${f.long ? "L" : "S"}`).join(" / ")}`);
}
writeFileSync(ROOT + "showcase/clean-geometry.json", JSON.stringify(out, null, 1));
