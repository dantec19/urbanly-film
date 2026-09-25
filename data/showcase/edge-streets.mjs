// Per lot edge: length, nearest drivable street (name, distance from the edge
// midpoint) and the angle between the edge and that street segment. A frontage
// edge runs parallel to its street; a corner lot has a short AND a long edge
// parallel to streets.
//   node .scratch/urbanly-film/data/showcase/edge-streets.mjs <parcelID> ...   (from the repo root)
import { readFileSync } from "node:fs";
const ROOT = ".scratch/urbanly-film/data/ba/";
const rd = (n, T) => { const b = readFileSync(ROOT + n); return new T(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
const pID = rd("parcels_id.u32", Uint32Array), pOff = rd("parcels_ring_offsets.u32", Uint32Array), pXY = rd("parcels_xy.f32", Float32Array);
const sN = rd("streets_nodes.f32", Float32Array), sE = rd("streets_edges.u32", Uint32Array), sC = rd("streets_edge_class.u8", Uint8Array), sName = rd("streets_edge_name.u16", Uint16Array);
const names = JSON.parse(readFileSync(ROOT + "streets_names.json", "utf8"));
const rowOf = new Map(); for (let r = 0; r < pID.length; r++) rowOf.set(pID[r], r);
const segD = (px, py, ax, ay, bx, by) => { const dx = bx - ax, dy = by - ay, L = dx*dx + dy*dy; let t = L > 0 ? ((px-ax)*dx + (py-ay)*dy) / L : 0; t = Math.max(0, Math.min(1, t)); return Math.hypot(ax + t*dx - px, ay + t*dy - py); };
for (const pid of process.argv.slice(2).map(Number)) {
  const r = rowOf.get(pid); const ring = pXY.subarray(pOff[r]*2, pOff[r+1]*2); const n = ring.length / 2;
  console.log(`== ${pid} row ${r}`);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, ax = ring[i*2], ay = ring[i*2+1], bx = ring[j*2], by = ring[j*2+1], L = Math.hypot(bx-ax, by-ay);
    const mx = (ax+bx)/2, my = (ay+by)/2; let best = []; 
    for (let e = 0; e < sC.length; e++) { const a = sE[e*2], b = sE[e*2+1]; const d = segD(mx, my, sN[a*2], sN[a*2+1], sN[b*2], sN[b*2+1]); if (d < 40) best.push([d, e]); }
    best.sort((p, q) => p[0] - q[0]);
    const out = best.slice(0, 3).map(([d, e]) => { const a = sE[e*2], b = sE[e*2+1]; const ex = sN[b*2]-sN[a*2], ey = sN[b*2+1]-sN[a*2+1]; const cos = Math.abs(((bx-ax)*ex + (by-ay)*ey) / (L * Math.hypot(ex, ey))); return `${names[sName[e]] || "(unnamed)"} c${sC[e]} ${d.toFixed(1)}m ${(Math.acos(Math.min(1, cos)) * 180 / Math.PI).toFixed(0)}deg`; });
    console.log(`  edge ${i} len ${L.toFixed(1)}: ${out.join(" | ")}`);
  }
}
