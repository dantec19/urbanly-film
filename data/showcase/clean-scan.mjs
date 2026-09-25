// Across ALL ar-multifamily single-parcel builds: which replaced seed buildings
// lie mostly on the lot (>= 50% of footprint) vs on a neighbouring lot, and
// whether the run recorded an earlier failing appraisal (fail-pass.json).
//   node .scratch/urbanly-film/data/showcase/clean-scan.mjs   (from the repo root)
import { readFileSync, writeFileSync } from "node:fs";
const ROOT = ".scratch/urbanly-film/data/";
const rd = (n, T) => { const b = readFileSync(ROOT + "ba/" + n); return new T(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
const pID = rd("parcels_id.u32", Uint32Array), pOff = rd("parcels_ring_offsets.u32", Uint32Array), pXY = rd("parcels_xy.f32", Float32Array), pCent = rd("parcels_centroid.f32", Float32Array);
const rowOf = new Map(); for (let r = 0; r < pID.length; r++) rowOf.set(pID[r], r);
const dev = JSON.parse(readFileSync(ROOT + "sim/buenosaires-developments.json", "utf8"));
const dem = new Map(dev.demolitions.map((d) => [d.id, d]));
const fp = new Map(JSON.parse(readFileSync(ROOT + "showcase/fail-pass.json", "utf8")).map((s) => [s.parcelID, s]));
const barrios = JSON.parse(readFileSync(ROOT + "ba/barrios.json", "utf8"));
const bxy = rd("barrios_xy.f32", Float32Array), boff = rd("barrios_ring_offsets.u32", Uint32Array), bring = rd("barrios_ring_barrio.u8", Uint8Array);
const inR = (r, x, y, s = 0, e = r.length / 2) => { let c = false; for (let i = s, j = e - 1; i < e; j = i++) { const xi = r[i*2], yi = r[i*2+1], xj = r[j*2], yj = r[j*2+1]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
const barrioOf = (x, y) => { for (let r = 0; r < bring.length; r++) if (inR(bxy, x, y, boff[r], boff[r + 1])) return barrios[bring[r]].name; return null; };
function inLot(polys, ring, step = 0.3) {
  let tot = 0, inside = 0;
  for (const poly of polys) { const r = poly[0]; let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < r.length; i += 2) { x0 = Math.min(x0, r[i]); x1 = Math.max(x1, r[i]); y0 = Math.min(y0, r[i+1]); y1 = Math.max(y1, r[i+1]); }
    for (let x = x0 + step / 2; x < x1; x += step) for (let y = y0 + step / 2; y < y1; y += step) { if (!inR(r, x, y)) continue; tot++; if (inR(ring, x, y)) inside++; } }
  return tot ? inside / tot : 0;
}
let n = 0, clean = 0; const rows = [];
for (const b of dev.buildings) {
  if (b.kind !== "ar-multifamily" || b.parcels.length !== 1 || b.replaces.length === 0) continue;
  const r = rowOf.get(b.parcels[0]); if (r === undefined) continue;
  n++;
  const ring = Array.from(pXY.subarray(pOff[r] * 2, pOff[r + 1] * 2));
  const shares = b.replaces.map((id) => inLot(dem.get(id).footprint, ring));
  const isClean = shares.every((s) => s >= 0.5);
  if (isClean) clean++;
  const f = fp.get(b.parcels[0]);
  const hasFail = f ? f.appraisals.some((a) => a.date < f.sold.date && a.residual < a.capitalValue) : false;
  if (isClean) rows.push({ id: b.id, parcelID: b.parcels[0], barrio: barrioOf(pCent[r*2], pCent[r*2+1]), stories: b.stories, units: b.units, lot: b.lotAreaM2, start: b.start, complete: b.complete, after: b.completesAfterRun, olds: b.replaces.map((id, k) => ({ id, h: dem.get(id).heightM, st: dem.get(id).stories, inLot: Math.round(shares[k] * 100) / 100 })), hasFail });
}
console.log(`${n} single-parcel ar-multifamily builds with demolitions; ${clean} demolish only buildings that stand mostly on the lot`);
const st = {}; for (const x of rows) st[x.stories] = (st[x.stories] ?? 0) + 1; console.log("clean by storeys", st);
console.log("clean with recorded fail:", rows.filter((x) => x.hasFail).length);
for (const x of rows.filter((x) => x.stories >= 7)) console.log(JSON.stringify(x));
writeFileSync(ROOT + "showcase/clean-scan.json", JSON.stringify(rows, null, 1));
