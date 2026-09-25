/**
 * A second sample of base-year home -> work pairs for scene two, drawn only from the pairs that touch the
 * neighbourhood the camera watches (Caballito, around the showcase lot) and are long enough to be seen moving.
 * Same frame, positions and jitter rule as export-film.ts section 6; only the filter and the sample size differ.
 *
 *   npx vite-node .scratch/urbanly-film/data/film/export-commute-near.ts   (from the repo root)
 *
 * Writes commute_near_home_xy.f32, commute_near_job_xy.f32 and commute_near.json next to this file.
 */
import { decodeEmploymentAssignmentBinary } from "@domain/employment/employmentAssignmentBinary";
import { EmploymentFill } from "@domain/employment/employment";
import { Sector } from "@domain/employment/sector";
import { decodePopulationBinary } from "@domain/population/PopulationBinary";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../../..");
const BA = path.join(HERE, "../ba");
const SRC = path.join(REPO, "public/buenosaires");

/** The watched neighbourhood: scene two's FOCUS (src/s2.js), metres. */
const FOCUS = [-5645.4, -1450.3];
/** A pair qualifies when its home or its job lies within R of FOCUS, or its straight line passes within R / 2. */
const R = 1300;
/** Pairs shorter than this barely move on screen. */
const MIN_M = 300;
const SAMPLE = 30_000;
const SAMPLE_SEED = 20220111;
const JITTER_SEED = 20220112;
const JITTER_MAX_M = 5;
const JITTER_FACTOR = 0.3;

const toAB = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const readBa = <T>(file: string, C: new (b: ArrayBuffer) => T): T => new C(toAB(readFileSync(path.join(BA, file))));
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pId = readBa("parcels_id.u32", Uint32Array);
const pRingOff = readBa("parcels_ring_offsets.u32", Uint32Array);
const pXY = readBa("parcels_xy.f32", Float32Array);
const pCent = readBa("parcels_centroid.f32", Float32Array);
const pArea = readBa("parcels_area.f32", Float32Array);
let maxParcelId = 0;
for (let i = 0; i < pId.length; i++) if (pId[i] > maxParcelId) maxParcelId = pId[i];
const parcelRowById = new Int32Array(maxParcelId + 1).fill(-1);
for (let i = 0; i < pId.length; i++) parcelRowById[pId[i]] = i;
const parcelRow = (id: number) => (id >= 0 && id <= maxParcelId ? parcelRowById[id] : -1);
function inRing(xy: Float32Array, v0: number, v1: number, x: number, y: number): boolean {
  let inside = false;
  for (let i = v0, j = v1 - 1; i < v1; j = i++) {
    const xi = xy[2 * i], yi = xy[2 * i + 1], xj = xy[2 * j], yj = xy[2 * j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const inParcel = (r: number, x: number, y: number) => inRing(pXY, pRingOff[r], pRingOff[r + 1], x, y);

const pop = decodePopulationBinary(toAB(gunzipSync(readFileSync(path.join(SRC, "run-results/population2022.bin.gz")))));
const emp = decodeEmploymentAssignmentBinary(toAB(gunzipSync(readFileSync(path.join(SRC, "run-results/employment-assignment2022.bin.gz")))));
const hh = pop.householdSOA, fam = pop.familySOA, per = pop.personSOA;
const P = per.count;
const personHH = new Int32Array(P).fill(-1);
for (let h = 0; h < hh.count; h++) {
  const f0 = hh.familyStartIndices[h];
  for (let f = f0; f < f0 + hh.familyCounts[h]; f++) {
    const p0 = fam.personStartIndices[f];
    for (let p = p0; p < p0 + fam.personCounts[f]; p++) personHH[p] = h;
  }
}

// the frame of export-film.ts: residents holding an in-city job, housed on a parcel, job on a parcel
const segDist = (ax: number, ay: number, bx: number, by: number, px: number, py: number) => {
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  const k = L2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
  return Math.hypot(ax + k * dx - px, ay + k * dy - py);
};
const cand: number[] = [];
let nFrame = 0;
for (let i = 0; i < emp.count; i++) {
  const p = emp.personIDs[i];
  if (p <= 0 || p > P || emp.fills[i] !== EmploymentFill.Resident || emp.sectors[i] === Sector.OutCommute) continue;
  const hr = parcelRow(hh.parcelIDs[personHH[p - 1]]), jr = parcelRow(emp.parcelIDs[i]);
  if (hr < 0 || jr < 0) continue;
  nFrame++;
  const hx = pCent[2 * hr], hy = pCent[2 * hr + 1], jx = pCent[2 * jr], jy = pCent[2 * jr + 1];
  const d = Math.hypot(jx - hx, jy - hy);
  if (d < MIN_M) continue;
  const near = Math.hypot(hx - FOCUS[0], hy - FOCUS[1]) < R || Math.hypot(jx - FOCUS[0], jy - FOCUS[1]) < R || segDist(hx, hy, jx, jy, FOCUS[0], FOCUS[1]) < R / 2;
  if (near) cand.push(i);
}
const pick = mulberry32(SAMPLE_SEED);
const NS = Math.min(SAMPLE, cand.length);
for (let k = 0; k < NS; k++) {
  const j = k + Math.floor(pick() * (cand.length - k));
  const t = cand[k]; cand[k] = cand[j]; cand[j] = t;
}
const jit = mulberry32(JITTER_SEED);
const jitterInto = (r: number, out: Float32Array, at: number) => {
  const cx = pCent[2 * r], cy = pCent[2 * r + 1], rad = Math.min(JITTER_MAX_M, JITTER_FACTOR * Math.sqrt(pArea[r]));
  for (let k = 0; k < 30; k++) {
    let u: number, v: number;
    do { u = 2 * jit() - 1; v = 2 * jit() - 1; } while (u * u + v * v > 1);
    if (inParcel(r, cx + rad * u, cy + rad * v)) { out[at] = cx + rad * u; out[at + 1] = cy + rad * v; return; }
  }
  out[at] = cx; out[at + 1] = cy;
};
const homeXY = new Float32Array(NS * 2), jobXY = new Float32Array(NS * 2);
const dists: number[] = [];
for (let k = 0; k < NS; k++) {
  const i = cand[k];
  const hr = parcelRow(hh.parcelIDs[personHH[emp.personIDs[i] - 1]]), jr = parcelRow(emp.parcelIDs[i]);
  jitterInto(hr, homeXY, 2 * k);
  jitterInto(jr, jobXY, 2 * k);
  dists.push(Math.hypot(pCent[2 * jr] - pCent[2 * hr], pCent[2 * jr + 1] - pCent[2 * hr + 1]));
}
dists.sort((a, b) => a - b);
writeFileSync(path.join(HERE, "commute_near_home_xy.f32"), new Uint8Array(homeXY.buffer));
writeFileSync(path.join(HERE, "commute_near_job_xy.f32"), new Uint8Array(jobXY.buffer));
const info = {
  about: "Home -> work pairs touching scene two's neighbourhood, for the film's agents. Same frame and jitter as export-film.ts section 6.",
  focus: FOCUS, radiusM: R, minStraightLineM: MIN_M, frame: nFrame, qualifying: cand.length, sampled: NS,
  straightLineKm: { p50: +(dists[Math.floor(NS * .5)] / 1000).toFixed(2), p90: +(dists[Math.floor(NS * .9)] / 1000).toFixed(2) },
  seeds: { sample: SAMPLE_SEED, jitter: JITTER_SEED },
};
writeFileSync(path.join(HERE, "commute_near.json"), JSON.stringify(info, null, 1));
console.log(info);
