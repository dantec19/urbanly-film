// For each candidate: share of each demolished building's footprint that lies
// inside the lot, and share of the lot the new footprint covers (grid sampling,
// 0.2 m). Reads candidates.json + the film exports; prints a table.
//   node .scratch/urbanly-film/data/showcase/footprint-overlap.mjs   (from the repo root)
import { readFileSync, writeFileSync } from "node:fs";
const ROOT = ".scratch/urbanly-film/data/";
const rd = (n, T) => { const b = readFileSync(ROOT + "ba/" + n); return new T(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
const pOff = rd("parcels_ring_offsets.u32", Uint32Array), pXY = rd("parcels_xy.f32", Float32Array);
const dev = JSON.parse(readFileSync(ROOT + "sim/buenosaires-developments.json", "utf8"));
const dem = new Map(dev.demolitions.map((d) => [d.id, d]));
const byId = new Map(dev.buildings.map((b) => [b.id, b]));
const cands = JSON.parse(readFileSync(ROOT + "showcase/candidates.json", "utf8"));
const inRing = (r, x, y) => { let c = false; const n = r.length / 2; for (let i = 0, j = n - 1; i < n; j = i++) { const xi = r[i*2], yi = r[i*2+1], xj = r[j*2], yj = r[j*2+1]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
const inPoly = (poly, x, y) => inRing(poly[0], x, y) && !poly.slice(1).some((h) => inRing(h, x, y));
function share(polys, ring, step = 0.2) {
  let tot = 0, inside = 0;
  for (const poly of polys) {
    const r = poly[0]; let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < r.length; i += 2) { x0 = Math.min(x0, r[i]); x1 = Math.max(x1, r[i]); y0 = Math.min(y0, r[i+1]); y1 = Math.max(y1, r[i+1]); }
    for (let x = x0 + step / 2; x < x1; x += step) for (let y = y0 + step / 2; y < y1; y += step) {
      if (!inPoly(poly, x, y)) continue; tot++; if (inRing(ring, x, y)) inside++;
    }
  }
  return { area: Math.round(tot * step * step), inLot: tot ? Math.round((inside / tot) * 100) / 100 : null };
}
const out = [];
for (const c of cands) {
  const ring = Array.from(pXY.subarray(pOff[c.parcelRow] * 2, pOff[c.parcelRow + 1] * 2));
  const olds = c.old.map((o) => ({ id: o.id, ...share(dem.get(o.id).footprint, ring) }));
  const nb = byId.get(c.id);
  const nw = share(nb.footprint, ring);
  out.push({ id: c.id, parcelID: c.parcelID, barrio: c.barrio, olds, newInLot: nw.inLot, newArea: nw.area, lot: c.lot.areaM2 });
  console.log(c.parcelID, c.barrio, "lot", c.lot.areaM2, "| old", olds.map((o) => `${o.id}:${o.area}m2 in-lot ${o.inLot}`).join(", "), "| new", nw.area, "m2 in-lot", nw.inLot);
}
writeFileSync(ROOT + "showcase/footprint-overlap.json", JSON.stringify(out, null, 1));
