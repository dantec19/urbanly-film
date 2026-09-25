// Map seed building ids to rows of the data/ba buildings_* arrays, and check
// the match on geometry, not on ordering: the row's centroid must sit inside
// the demolished footprint the developments export carries for that id, and
// its height, floor area and parcel must agree.
//   npx vite-node .scratch/urbanly-film/data/showcase/buildings-rows.ts [seedID ...]   (from the repo root)
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { decodeBuildingBinary } from "@shared/buildings-gl/BuildingGLBinary";

const SRC = "public/buenosaires";
const BA = ".scratch/urbanly-film/data/ba/";
const OUT = ".scratch/urbanly-film/data/showcase/buildings-rows.json";
const DEV = ".scratch/urbanly-film/data/sim/buenosaires-developments.json";
const ids = process.argv.slice(2).map(Number).filter(Number.isFinite);
const wanted = ids.length ? ids : [12089, 319253, 319254, 368738, 368739, 191249, 191250];

const man = JSON.parse(readFileSync(path.join(SRC, "buildings.bin.manifest.json"), "utf8")) as {
  uncompressedByteLength: number; chunks: { file: string; uncompressedByteLength: number }[];
};
const buf = new ArrayBuffer(man.uncompressedByteLength);
{
  const bytes = new Uint8Array(buf);
  let off = 0;
  for (const c of man.chunks) { const d = gunzipSync(readFileSync(path.join(SRC, c.file))); bytes.set(d, off); off += d.byteLength; }
  if (off !== man.uncompressedByteLength) throw new Error("chunks do not add up");
}
const bd = decodeBuildingBinary(buf);
const rd = <T,>(n: string, T: new (b: ArrayBuffer) => T): T => { const b = readFileSync(BA + n); return new T(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
const bH = rd("buildings_height.f32", Float32Array), bF = rd("buildings_floorspace.f32", Float32Array), bC = rd("buildings_centroid.f32", Float32Array);
const bP = rd("buildings_parcel.u32", Uint32Array), bT = rd("buildings_type.u8", Uint8Array);
const bRS = rd("buildings_ring_start.u32", Uint32Array), bRO = rd("buildings_ring_offsets.u32", Uint32Array), bXY = rd("buildings_xy.f32", Float32Array);
const pID = rd("parcels_id.u32", Uint32Array);
const baMan = JSON.parse(readFileSync(BA + "manifest.json", "utf8"));
const typeCodes = baMan.layers.buildings.typeCodes as { code: number; name: string }[];
if (bH.length !== bd.buildingCount) throw new Error(`data/ba has ${bH.length} buildings, binary ${bd.buildingCount}`);

const dev = JSON.parse(readFileSync(DEV, "utf8")) as { demolitions: { id: number; heightM: number; floorAreaM2: number; units: number; type: string; parcels: number[]; footprint: number[][][] }[] }; // footprint: polygons -> rings -> flat x,y
const demo = new Map(dev.demolitions.map((d) => [d.id, d]));
const inRing = (x: number, y: number, r: number[]) => { let c = false; for (let i = 0, j = r.length / 2 - 1; i < r.length / 2; j = i++) { const xi = r[i*2], yi = r[i*2+1], xj = r[j*2], yj = r[j*2+1]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
const idRow = new Map<number, number>();
for (let s = 0; s < bd.buildingCount; s++) idRow.set(bd.ids[s], s);

const out: Record<string, unknown>[] = [];
for (const id of wanted) {
  const row = idRow.get(id);
  if (row === undefined) { console.log(id, "not in buildings.bin"); continue; }
  const cx = bC[row*2], cy = bC[row*2+1];
  const d = demo.get(id);
  const inside = d ? d.footprint.some((poly) => inRing(cx, cy, poly[0] as unknown as number[])) : null;
  // Mean distance from each vertex of the data/ba ring to the nearest vertex of the export's footprint.
  const rings: number[][] = [];
  for (let r = bRS[row]; r < bRS[row + 1]; r++) rings.push(Array.from(bXY.subarray(bRO[r]*2, bRO[r+1]*2), (v) => Math.round(v * 10) / 10));
  let meanVertexGap: number | null = null;
  if (d) { const flat = d.footprint.flat(2) as unknown as number[]; let s = 0, n = 0; for (const ring of rings) for (let i = 0; i < ring.length; i += 2) { let m = Infinity; for (let k = 0; k < flat.length; k += 2) m = Math.min(m, Math.hypot(flat[k] - ring[i], flat[k+1] - ring[i+1])); s += m; n++; } meanVertexGap = +(s / n).toFixed(2); }
  const rec = {
    seedID: id, row, binaryRowID: bd.ids[row],
    heightM: +bH[row].toFixed(2), floorAreaM2: +bF[row].toFixed(1), type: typeCodes.find((t) => t.code === bT[row])?.name ?? bT[row],
    primaryParcelRow: bP[row], primaryParcelID: bP[row] === 0xffffffff ? null : pID[bP[row]],
    centroid: [+cx.toFixed(2), +cy.toFixed(2)],
    check: d ? { exportHeightM: d.heightM, exportFloorAreaM2: d.floorAreaM2, exportType: d.type, exportUnits: d.units, exportParcels: d.parcels, centroidInsideExportFootprint: inside, meanVertexGapM: meanVertexGap } : null,
    footprint: rings,
  };
  out.push(rec);
  console.log(JSON.stringify({ ...rec, footprint: `${rings.length} ring(s)` }));
}
writeFileSync(OUT, JSON.stringify(out, null, 1));
