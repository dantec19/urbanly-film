/**
 * Film data layers for "Before You Commit": what one land-use run built and
 * tore down, dwelling units per existing building, and a sample of real
 * base-year home -> work pairs, all in the local metres of ../ba.
 *
 *   npx vite-node .scratch/urbanly-film/data/film/export-film.ts   (from the repo root)
 *
 * Inputs: ../ba (the region export, rows = the region binary's rows),
 * ../sim/buenosaires-developments.json (run ba-2022-2031-s123456), and the
 * committed binaries in public/buenosaires (seed building ids and dwelling
 * units, the in-progress pipeline file, the base-year population and
 * employment assignment). Writes this directory's *.f32 / *.u32,
 * manifest.json, summary.json and height_changes.json.
 */
import { decodeEmploymentAssignmentBinary } from "@domain/employment/employmentAssignmentBinary";
import { EmploymentFill } from "@domain/employment/employment";
import { Sector } from "@domain/employment/sector";
import { decodePopulationBinary } from "@domain/population/PopulationBinary";
import { HEADER_BYTES as BLDG_HEADER_BYTES, MAGIC as BLDG_MAGIC } from "@shared/buildings-gl/BuildingGLBinary";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../../..");
const BA = path.join(HERE, "../ba");
const SIM = path.join(HERE, "../sim");
const SRC_REL = "public/buenosaires";
const SRC = path.join(REPO, SRC_REL);
const OUT = HERE;

/** Year 0 of the film clock: T = (year - 2022) + (month - 1) / 12. */
const T0_YEAR = 2022;
/** completeT for a building with no completion date (none in this run). */
const COMPLETE_T_UNKNOWN = 10.5;
/** The region's storey height (defaultStoreyHeight), metres. */
const STOREY_M = 3;
const COMMUTE_SAMPLE = 40_000;
const SAMPLE_SEED = 20220101;
const JITTER_SEED = 20220102;
/** Jitter radius around a parcel centroid: min(MAX, FACTOR * sqrt(area)). */
const JITTER_MAX_M = 5;
const JITTER_FACTOR = 0.3;
/** Street classes that give a lot its street side (../ba classCodes):
 *  trunk, primary, secondary, tertiary, residential, car-free street.
 *  Motorways (often elevated), service ways (driveways, parking aisles),
 *  footways and cycleways are not frontage. */
const FRONTAGE_CLASSES = [2, 3, 4, 5, 6, 13];
/** A lot whose centroid has no frontage street within this radius keeps its centroid. */
const FRONTAGE_SEARCH_M = 60;
/** Ring cleanup: consecutive vertices closer than this are merged, and a
 *  vertex closer than this to the chord of its neighbours is dropped (m). */
const RING_EPS_M = 0.05;
const NONE_U32 = 0xffffffff;

const KIND_CODES = ["in-progress-pipeline", "ar-multifamily", "state-housing", "law-enabled-site", "fondo-de-lote"] as const;
type Kind = (typeof KIND_CODES)[number];
const kindCode = (k: string): number => {
  const c = KIND_CODES.indexOf(k as Kind);
  if (c < 0) throw new Error(`unknown developer kind ${k}`);
  return c;
};

if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1) throw new Error("little-endian platform required");

const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const toAB = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const readBa = <T>(file: string, C: new (b: ArrayBuffer) => T): T => new C(toAB(readFileSync(path.join(BA, file))));
const git = (cmd: string) => {
  try {
    return execSync(cmd, { cwd: REPO, encoding: "utf8" }).trim();
  } catch {
    return "unavailable";
  }
};
const round = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;
const quantile = (sorted: ArrayLike<number>, p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];

/** mulberry32: a small seeded PRNG in [0, 1) (integer arithmetic only). */
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

type TA = Float32Array | Uint32Array;
interface FileEntry {
  file: string;
  dtype: string;
  count: number;
  shape: number[];
  bytes: number;
  meaning: string;
  derived: string;
}
const files: FileEntry[] = [];
// Other film scripts write into this directory too (agents_*, growth_base*):
// never delete here, only overwrite this script's own files.
function writeArray(file: string, a: TA, shape: number[], meaning: string, derived: string) {
  writeFileSync(path.join(OUT, file), new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
  files.push({ file, dtype: a instanceof Float32Array ? "float32" : "uint32", count: a.length, shape, bytes: a.byteLength, meaning, derived });
}

// ---------------------------------------------------------------------------
// 1. ../ba: parcels, buildings, streets
// ---------------------------------------------------------------------------

const pId = readBa("parcels_id.u32", Uint32Array);
const PC = pId.length;
const pRingOff = readBa("parcels_ring_offsets.u32", Uint32Array);
const pXY = readBa("parcels_xy.f32", Float32Array);
const pCent = readBa("parcels_centroid.f32", Float32Array);
const pArea = readBa("parcels_area.f32", Float32Array);
const pZoneMaxH = readBa("parcels_zone_max_height.f32", Float32Array);
const pZone = readBa("parcels_zone.u16", Uint16Array);
const zoneTable = JSON.parse(readFileSync(path.join(BA, "parcels_zones.json"), "utf8")) as { name: string }[];
let maxParcelId = 0;
for (let i = 0; i < PC; i++) if (pId[i] > maxParcelId) maxParcelId = pId[i];
const parcelRowById = new Int32Array(maxParcelId + 1).fill(-1);
for (let i = 0; i < PC; i++) parcelRowById[pId[i]] = i;
const parcelRow = (id: number) => (id >= 0 && id <= maxParcelId ? parcelRowById[id] : -1);

const baHeight = readBa("buildings_height.f32", Float32Array);
const baBldParcel = readBa("buildings_parcel.u32", Uint32Array);
const baBldXY = readBa("buildings_xy.f32", Float32Array);
const baBldRingOff = readBa("buildings_ring_offsets.u32", Uint32Array);
const baBldRingStart = readBa("buildings_ring_start.u32", Uint32Array);
const BR = baHeight.length;

/** Even-odd point-in-polygon on vertices [v0, v1) of an interleaved xy array. */
function inRing(xy: Float32Array, v0: number, v1: number, x: number, y: number): boolean {
  let inside = false;
  for (let i = v0, j = v1 - 1; i < v1; j = i++) {
    const xi = xy[2 * i], yi = xy[2 * i + 1], xj = xy[2 * j], yj = xy[2 * j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const inParcel = (r: number, x: number, y: number) => inRing(pXY, pRingOff[r], pRingOff[r + 1], x, y);

/** Share of ../ba building row b's footprint that lies inside any of the
 *  parcel rows `lots`, measured on a grid of ~4,000 points per ring
 *  (spacing at least 0.5 m). */
function footprintShareOn(b: number, lots: number[]): number {
  let total = 0, inside = 0;
  for (let k = baBldRingStart[b]; k < baBldRingStart[b + 1]; k++) {
    const v0 = baBldRingOff[k], v1 = baBldRingOff[k + 1];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let v = v0; v < v1; v++) {
      x0 = Math.min(x0, baBldXY[2 * v]);
      x1 = Math.max(x1, baBldXY[2 * v]);
      y0 = Math.min(y0, baBldXY[2 * v + 1]);
      y1 = Math.max(y1, baBldXY[2 * v + 1]);
    }
    const step = Math.max(0.5, Math.sqrt(((x1 - x0) * (y1 - y0)) / 4000));
    for (let y = y0 + step / 2; y < y1; y += step) {
      for (let x = x0 + step / 2; x < x1; x += step) {
        if (!inRing(baBldXY, v0, v1, x, y)) continue;
        total++;
        for (const r of lots) {
          if (inParcel(r, x, y)) {
            inside++;
            break;
          }
        }
      }
    }
  }
  return total > 0 ? inside / total : NaN;
}

// ---------------------------------------------------------------------------
// 2. Seed building ids and dwelling units (region binary, chunk 0 only)
// ---------------------------------------------------------------------------
// The per-building attribute columns sit right after the 128-byte header
// (layout documented in src/shared/buildings-gl/BuildingGLBinary.ts: 0x08
// buildingCount, 0x1C ids, 0x28 height, 0x30 dwellingUnitsCount), inside the
// first 32 MiB chunk, so the 826 MB binary is never assembled.

log("seed buildings: reading chunk 0");
const bManifest = JSON.parse(readFileSync(path.join(SRC, "buildings.bin.manifest.json"), "utf8")) as { chunks: { file: string }[] };
const chunk0 = toAB(gunzipSync(readFileSync(path.join(SRC, bManifest.chunks[0].file))));
const hv = new DataView(chunk0, 0, BLDG_HEADER_BYTES);
if (hv.getUint32(0x00, true) !== BLDG_MAGIC) throw new Error("buildings.bin: bad magic");
const BC = hv.getUint32(0x08, true);
const column = <T>(off: number, C: new (b: ArrayBuffer, o: number, n: number) => T): T => {
  if (off + BC * 4 > chunk0.byteLength) throw new Error(`column at ${off} is not inside chunk 0`);
  return new C(chunk0, off, BC);
};
const seedIds = column(hv.getUint32(0x1c, true), Uint32Array);
const seedHeight = column(hv.getUint32(0x28, true), Float32Array);
const seedDwellings = column(hv.getUint32(0x30, true), Float32Array);
if (BC !== BR) throw new Error(`binary has ${BC} buildings, ../ba has ${BR}`);
let heightMismatch = 0;
for (let i = 0; i < BC; i++) if (seedHeight[i] !== baHeight[i]) heightMismatch++;
if (heightMismatch > 0) throw new Error(`${heightMismatch} ../ba rows do not align with the binary rows`);
const seedRowById = new Map<number, number>();
for (let i = 0; i < BC; i++) seedRowById.set(seedIds[i], i);
let idEqualsRow = 0;
for (let i = 0; i < BC; i++) if (seedIds[i] === i) idEqualsRow++;

let dwellingTotal = 0, dwellingZero = 0, dwellingNaN = 0, dwellingMax = 0;
for (let i = 0; i < BC; i++) {
  const u = seedDwellings[i];
  if (!Number.isFinite(u)) dwellingNaN++;
  else {
    dwellingTotal += u;
    if (u === 0) dwellingZero++;
    if (u > dwellingMax) dwellingMax = u;
  }
}
const statsDwellings = (JSON.parse(readFileSync(path.join(BA, "stats.json"), "utf8")) as { numbers: { dwellings: { value: number } } }).numbers.dwellings.value;
if (Math.round(dwellingTotal) !== statsDwellings) throw new Error(`dwelling units ${dwellingTotal} != stats.json ${statsDwellings}`);
log(`seed buildings: ${BC} rows aligned (heights identical), ids equal the row index for ${idEqualsRow}; dwelling units ${dwellingTotal}`);

writeArray(
  "buildings_dwelling_units.f32",
  seedDwellings.slice(),
  [BC],
  "Dwelling units per ../ba building row (row i = ../ba row i). 0 = no dwellings (non-residential or no census share).",
  `dwellingUnitsCount column of public/buenosaires/buildings.bin (read from chunk 0); rows verified aligned with ../ba (all ${BC} heights bit-identical). Total ${dwellingTotal} = ../ba/stats.json dwellings; ${dwellingZero} rows are 0, ${dwellingNaN} NaN, max ${dwellingMax}. Census-anchored: each census radio's INDEC 2022 dwellings spread over its residential buildings by floor area.`,
);

// ---------------------------------------------------------------------------
// 3. The run's buildings
// ---------------------------------------------------------------------------

log("developments: reading");
interface Built {
  id: number;
  kind: string;
  type: string;
  start: [number, number];
  complete: [number, number] | null;
  completesAfterRun: boolean;
  preRun: boolean;
  parcels: number[];
  replaces: number[];
  heightM: number;
  stories: number;
  floorAreaM2: number;
  footprintAreaM2: number | null;
  lotAreaM2: number | null;
  units: number;
  footprint: number[][][] | null;
  demolished: [number, number] | null;
}
interface Demolition {
  id: number;
  origin: string;
  date: [number, number];
  parcels: number[];
  heightM: number;
  units: number;
  floorAreaM2: number;
  replacedBy: number[];
}
const dev = JSON.parse(readFileSync(path.join(SIM, "buenosaires-developments.json"), "utf8")) as {
  seed: number;
  startYear: number;
  endYear: number;
  buildings: Built[];
  demolitions: Demolition[];
};
if (dev.startYear !== T0_YEAR) throw new Error(`run starts in ${dev.startYear}, film clock in ${T0_YEAR}`);
const tOf = (ym: [number, number]) => ym[0] - T0_YEAR + (ym[1] - 1) / 12;
const startTOf = (b: Built) => Math.max(0, tOf(b.start));
const completeTOf = (b: Built) => (b.complete ? tOf(b.complete) : COMPLETE_T_UNKNOWN);
const goneTOf = (b: Built) => (b.demolished ? tOf(b.demolished) : NaN);
const onlyParcelRow = (b: Built) => {
  if (b.parcels.length !== 1) throw new Error(`building ${b.id} stands on ${b.parcels.length} parcels`);
  return parcelRow(b.parcels[0]);
};

// --- 3a. Height rule (in-progress pipeline only) --------------------------------
// The pipeline row's storeys are the loader's estimate, not an observed height
// (inProgressDevelopmentsLoader.ts: max(3, ceil(units / 8)), raised to fit
// the permitted floor area on 85% of the lot, at most 90). Stage 18 derives
// units as floor area / 70 m² (AGC works) or / 48 m² (Microcentro), so the
// estimate is a ~560 m² floor plate whatever the lot: 270 m on a Del Plata
// conversion. Every other kind is built by the engine under the zoning and
// none exceeds its parcel's zone max height (checked below).
interface PipelineProps {
  id_parcels: number;
  total_units: number;
  total_floor_area: number;
  source?: string;
}
const pipelineByParcel = new Map<number, PipelineProps[]>();
for (const f of (JSON.parse(gunzipSync(readFileSync(path.join(SRC, "in-progress-developments.json.gz"))).toString("utf8")) as { features: { properties: PipelineProps }[] }).features) {
  const list = pipelineByParcel.get(f.properties.id_parcels);
  if (list) list.push(f.properties);
  else pipelineByParcel.set(f.properties.id_parcels, [f.properties]);
}
const pipelineSource = (b: Built): string => {
  const c = pipelineByParcel.get(b.parcels[0]) ?? [];
  const m = c.length === 1 ? c : c.filter((p) => p.total_units === b.units);
  if (m.length !== 1) throw new Error(`pipeline building ${b.id}: ${m.length} matching pipeline rows on parcel ${b.parcels[0]}`);
  return m[0].source ?? "unknown";
};

const baFloorspace = readBa("buildings_floorspace.f32", Float32Array);
const zoneName = (r: number) => (pZone[r] === 0xffff ? null : zoneTable[pZone[r]]?.name ?? null);
interface HeightChange {
  newRow: number;
  id: number;
  source: string;
  rule: string;
  parcelRow: number;
  parcelId: number;
  zone: string | null;
  zoneMaxHeightM: number | null;
  units: number;
  floorAreaM2: number;
  footprintAreaM2: number | null;
  before: { heightM: number; stories: number };
  after: { heightM: number; stories: number };
  convertedSeedRow?: number;
}
const heightChanges: HeightChange[] = [];
const overZoneByKind: Record<string, number> = {};
let pipelineZoneZero = 0;

// --- 3b. Assemble --------------------------------------------------------------------
const visible = dev.buildings.filter((b) => b.kind !== "fondo-de-lote");
const NB = visible.length;
const meta = new Float32Array(NB * 8);
const ids = new Uint32Array(NB);
let ringCount = 0, vertexCount = 0, sourceVertices = 0, ringsKeptAsIs = 0;
for (const b of visible) for (const poly of b.footprint ?? []) {
  ringCount++;
  vertexCount += poly[0].length / 2;
}
const ringXY = new Float32Array(vertexCount * 2);
const ringOff = new Uint32Array(ringCount + 1);
const ringBld = new Uint32Array(ringCount);
let nr = 0, nv = 0;
const sx = new Float64Array(4096), sy = new Float64Array(4096);
const signedArea = (xs: Float64Array, ys: Float64Array, n: number) => {
  let a = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) a += xs[j] * ys[i] - xs[i] * ys[j];
  return a / 2;
};
/** Exterior ring -> open, CCW, near-duplicate and near-collinear vertices removed. */
function emitRing(flat: number[], bld: number) {
  let n = flat.length / 2;
  if (n > 1 && flat[0] === flat[2 * n - 2] && flat[1] === flat[2 * n - 1]) n--;
  sourceVertices += n;
  const ccw = (() => {
    let a = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) a += flat[2 * j] * flat[2 * i + 1] - flat[2 * i] * flat[2 * j + 1];
    return a > 0;
  })();
  let m = 0;
  for (let k = 0; k < n; k++) {
    const i = ccw ? k : n - 1 - k;
    const x = flat[2 * i], y = flat[2 * i + 1];
    if (m > 0 && Math.hypot(x - sx[m - 1], y - sy[m - 1]) < RING_EPS_M) continue;
    sx[m] = x;
    sy[m] = y;
    m++;
  }
  while (m > 3 && Math.hypot(sx[0] - sx[m - 1], sy[0] - sy[m - 1]) < RING_EPS_M) m--;
  for (let changed = true; changed && m > 3; ) {
    changed = false;
    for (let i = 0; i < m && m > 3; i++) {
      const p = (i + m - 1) % m, q = (i + 1) % m;
      const cx = sx[q] - sx[p], cy = sy[q] - sy[p];
      const len = Math.hypot(cx, cy);
      if (len === 0 || Math.abs(cx * (sy[i] - sy[p]) - cy * (sx[i] - sx[p])) / len < RING_EPS_M) {
        sx.copyWithin(i, i + 1, m);
        sy.copyWithin(i, i + 1, m);
        m--;
        changed = true;
        i--;
      }
    }
  }
  if (m < 3 || signedArea(sx, sy, m) <= 0.5) {
    // Cleanup would degenerate the ring: keep it as it came, oriented CCW.
    ringsKeptAsIs++;
    m = n;
    for (let k = 0; k < n; k++) {
      const i = ccw ? k : n - 1 - k;
      sx[k] = flat[2 * i];
      sy[k] = flat[2 * i + 1];
    }
  }
  ringOff[nr] = nv;
  ringBld[nr] = bld;
  for (let k = 0; k < m; k++) {
    ringXY[2 * nv] = sx[k];
    ringXY[2 * nv + 1] = sy[k];
    nv++;
  }
  nr++;
}

for (let i = 0; i < NB; i++) {
  const b = visible[i];
  const pr = onlyParcelRow(b);
  if (pr < 0) throw new Error(`building ${b.id}: parcel ${b.parcels[0]} is not in ../ba`);
  const zMax = pZoneMaxH[pr];
  let heightM = b.heightM;
  let stories = b.stories;
  if (Number.isFinite(zMax) && zMax > 0 && b.heightM > zMax + 1e-6) overZoneByKind[b.kind] = (overZoneByKind[b.kind] ?? 0) + 1;
  if (b.kind === "in-progress-pipeline") {
    const source = pipelineSource(b);
    let rule: string | null = null;
    let convertedSeedRow: number | undefined;
    if (source === "microcentro-ley6508") {
      // A conversion keeps its building: the height is the standing seed
      // building it converts = the replaced building whose floor space is
      // closest to the permitted floor area (stage 18: that floor area is
      // the converted envelope, AGIP covered area or seed floor space).
      let best = -1, bestDiff = Infinity;
      for (const old of b.replaces) {
        const r = seedRowById.get(old);
        if (r === undefined) continue;
        const diff = Math.abs(baFloorspace[r] - b.floorAreaM2);
        if (diff < bestDiff) {
          bestDiff = diff;
          best = r;
        }
      }
      if (best < 0) throw new Error(`conversion ${b.id} replaces no seed building`);
      convertedSeedRow = best;
      heightM = baHeight[best];
      stories = Math.max(1, Math.ceil(heightM / STOREY_M - 1e-9));
      rule = "conversion keeps the standing building it converts";
    } else if (Number.isFinite(zMax) && zMax > 0 && b.heightM > zMax + 1e-6) {
      stories = Math.max(1, Math.floor(zMax / STOREY_M + 1e-6));
      heightM = stories * STOREY_M;
      rule = "capped at the parcel's zone max height (whole 3 m storeys)";
    } else if (zMax === 0) {
      pipelineZoneZero++;
    }
    if (rule && (Math.abs(heightM - b.heightM) > 1e-6 || stories !== b.stories)) {
      heightChanges.push({
        newRow: i,
        id: b.id,
        source,
        rule,
        parcelRow: pr,
        parcelId: b.parcels[0],
        zone: zoneName(pr),
        zoneMaxHeightM: Number.isFinite(zMax) ? round(zMax, 2) : null,
        units: b.units,
        floorAreaM2: b.floorAreaM2,
        footprintAreaM2: b.footprintAreaM2,
        before: { heightM: b.heightM, stories: b.stories },
        after: { heightM: round(heightM, 2), stories },
        ...(convertedSeedRow !== undefined ? { convertedSeedRow } : {}),
      });
    }
  }
  const o = i * 8;
  meta[o] = startTOf(b);
  meta[o + 1] = completeTOf(b);
  meta[o + 2] = heightM;
  meta[o + 3] = stories;
  meta[o + 4] = b.units;
  meta[o + 5] = kindCode(b.kind);
  meta[o + 6] = pr;
  meta[o + 7] = goneTOf(b);
  ids[i] = b.id;
  for (const poly of b.footprint ?? []) emitRing(poly[0], i);
}
ringOff[nr] = nv;
for (const k of ["ar-multifamily", "state-housing", "law-enabled-site"]) {
  if (overZoneByKind[k]) throw new Error(`${overZoneByKind[k]} ${k} rows exceed their zone max height; the height rule assumed none`);
}
log(`new buildings: ${NB} (${nr} rings, ${sourceVertices} -> ${nv} vertices); ${heightChanges.length} heights changed`);

writeArray("new_ring_xy.f32", ringXY.slice(0, nv * 2), [nv, 2],
  "Footprint ring vertices (x, y) in metres of the run's new buildings (every kind except fondo-de-lote), all rings concatenated. Exterior rings only, open (first vertex not repeated), counter-clockwise (x east, y north).",
  `The exterior ring of each footprint polygon in ../sim/buenosaires-developments.json (0.1 m precision there; every source ring was clockwise and is reversed here; no source footprint has holes or more than one part). Light cleanup: consecutive vertices closer than ${RING_EPS_M} m merged and vertices within ${RING_EPS_M} m of their neighbours' chord dropped (${sourceVertices} -> ${nv} vertices; ${ringsKeptAsIs} rings kept as they came).`);
writeArray("new_ring_off.u32", ringOff.slice(0, nr + 1), [nr + 1],
  "Ring r owns vertices [o[r], o[r+1]) of new_ring_xy (vertex units).", "Built with new_ring_xy.");
writeArray("new_ring_bld.u32", ringBld.slice(0, nr), [nr],
  "New-building row (index into new_meta / new_id) that owns ring r. Exactly one ring per building in this run.", "Built with new_ring_xy.");
writeArray("new_meta.f32", meta, [NB, 8],
  "Per new building, 8 float32: [0] startT, [1] completeT, [2] heightM, [3] stories, [4] units, [5] kind code (see kindCodes), [6] parcelRow (row in ../ba parcels_*), [7] goneT (NaN = never demolished by the run). T = fractional years since 2022-01-01.",
  `Rows in the order of ../sim/buenosaires-developments.json 'buildings' minus fondo-de-lote. startT = (year - 2022) + (month - 1) / 12 of 'start', clamped to 0 for projects started before the run (the in-progress pipeline). completeT = the same of 'complete' (the building's own completion; for completesAfterRun rows it is its start plus its construction time, so it runs past 10; ${COMPLETE_T_UNKNOWN} if a row had no completion date: none does). heightM/stories are the run's except the ${heightChanges.length} in-progress-pipeline rows listed in height_changes.json (see heightRule). units = dwelling units the building adds. parcelRow = the building's one parcel id mapped through ../ba/parcels_id.u32. goneT = the run's demolition date of this building (none in this run).`);
writeArray("new_id.u32", ids, [NB],
  "Run building id of each new-building row, to join back to ../sim/buenosaires-developments.json and height_changes.json.",
  "The 'id' field of the developments JSON.");

// ---------------------------------------------------------------------------
// 4. Fondo-de-lote additions as points
// ---------------------------------------------------------------------------
// The footprint of a fondo-de-lote row is the whole lot, so the addition is
// drawn as one point: the centroid of the rear half of the lot, the half
// away from its street, else the lot centroid.

log("fondo-de-lote: street index");
const stNodes = readBa("streets_nodes.f32", Float32Array);
const stEdges = readBa("streets_edges.u32", Uint32Array);
const stClass = readBa("streets_edge_class.u8", Uint8Array);
const keepClass = new Uint8Array(256);
for (const c of FRONTAGE_CLASSES) keepClass[c] = 1;
const CELL = 50;
let gx0 = Infinity, gy0 = Infinity, gx1 = -Infinity, gy1 = -Infinity;
for (let i = 0; i < stNodes.length; i += 2) {
  gx0 = Math.min(gx0, stNodes[i]);
  gx1 = Math.max(gx1, stNodes[i]);
  gy0 = Math.min(gy0, stNodes[i + 1]);
  gy1 = Math.max(gy1, stNodes[i + 1]);
}
const GW = Math.floor((gx1 - gx0) / CELL) + 1, GH = Math.floor((gy1 - gy0) / CELL) + 1;
const cellStart = new Uint32Array(GW * GH + 1);
const E = stClass.length;
const forEdgeCells = (e: number, f: (c: number) => void) => {
  const a = stEdges[2 * e], b = stEdges[2 * e + 1];
  const ax = stNodes[2 * a], ay = stNodes[2 * a + 1], bx = stNodes[2 * b], by = stNodes[2 * b + 1];
  const i0 = Math.floor((Math.min(ax, bx) - gx0) / CELL), i1 = Math.floor((Math.max(ax, bx) - gx0) / CELL);
  const j0 = Math.floor((Math.min(ay, by) - gy0) / CELL), j1 = Math.floor((Math.max(ay, by) - gy0) / CELL);
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) f(j * GW + i);
};
for (let e = 0; e < E; e++) if (keepClass[stClass[e]]) forEdgeCells(e, (c) => cellStart[c + 1]++);
for (let c = 0; c < GW * GH; c++) cellStart[c + 1] += cellStart[c];
const cellEdges = new Uint32Array(cellStart[GW * GH]);
const fill = cellStart.slice(0, GW * GH);
for (let e = 0; e < E; e++) if (keepClass[stClass[e]]) forEdgeCells(e, (c) => (cellEdges[fill[c]++] = e));

/** Nearest frontage-street point to (x, y) within FRONTAGE_SEARCH_M, or null. */
function nearestStreet(x: number, y: number): [number, number, number] | null {
  const i0 = Math.max(0, Math.floor((x - FRONTAGE_SEARCH_M - gx0) / CELL)), i1 = Math.min(GW - 1, Math.floor((x + FRONTAGE_SEARCH_M - gx0) / CELL));
  const j0 = Math.max(0, Math.floor((y - FRONTAGE_SEARCH_M - gy0) / CELL)), j1 = Math.min(GH - 1, Math.floor((y + FRONTAGE_SEARCH_M - gy0) / CELL));
  let best = FRONTAGE_SEARCH_M, bx = 0, by = 0, found = false;
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const c = j * GW + i;
    for (let k = cellStart[c]; k < cellStart[c + 1]; k++) {
      const e = cellEdges[k];
      const a = stEdges[2 * e], b = stEdges[2 * e + 1];
      const ax = stNodes[2 * a], ay = stNodes[2 * a + 1], dx = stNodes[2 * b] - ax, dy = stNodes[2 * b + 1] - ay;
      const l2 = dx * dx + dy * dy;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
      const px = ax + t * dx, py = ay + t * dy;
      const dist = Math.hypot(px - x, py - y);
      if (dist <= best) {
        best = dist;
        bx = px;
        by = py;
        found = true;
      }
    }
  }
  return found ? [bx, by, best] : null;
}

const fondo = dev.buildings.filter((b) => b.kind === "fondo-de-lote");
const NF = fondo.length;
const fXY = new Float32Array(NF * 2);
const fMeta = new Float32Array(NF * 4);
const clipX = new Float64Array(8192), clipY = new Float64Array(8192);
const rearCache = new Map<number, [number, number, boolean]>();
let rearHalf = 0, lotCentroid = 0;
/** Centroid of the part of lot r behind the line through its centroid
 *  perpendicular to the direction of its nearest street. */
function rearPoint(r: number): [number, number, boolean] {
  const cached = rearCache.get(r);
  if (cached) return cached;
  const cx = pCent[2 * r], cy = pCent[2 * r + 1];
  let out: [number, number, boolean] = [cx, cy, false];
  const s = nearestStreet(cx, cy);
  if (s && s[2] > 0) {
    const dx = (s[0] - cx) / s[2], dy = (s[1] - cy) / s[2];
    const v0 = pRingOff[r], v1 = pRingOff[r + 1], n = v1 - v0;
    let m = 0;
    for (let k = 0; k < n; k++) {
      const pi = v0 + k, qi = v0 + ((k + 1) % n);
      const px = pXY[2 * pi], py = pXY[2 * pi + 1], qx = pXY[2 * qi], qy = pXY[2 * qi + 1];
      const sp = (px - cx) * dx + (py - cy) * dy, sq = (qx - cx) * dx + (qy - cy) * dy;
      if (sp <= 0) {
        clipX[m] = px;
        clipY[m] = py;
        m++;
      }
      if (sp <= 0 !== sq <= 0) {
        const t = sp / (sp - sq);
        clipX[m] = px + t * (qx - px);
        clipY[m] = py + t * (qy - py);
        m++;
      }
    }
    let a = 0, mx = 0, my = 0;
    for (let i = 0, j = m - 1; i < m; j = i++) {
      const cr = clipX[j] * clipY[i] - clipX[i] * clipY[j];
      a += cr;
      mx += (clipX[j] + clipX[i]) * cr;
      my += (clipY[j] + clipY[i]) * cr;
    }
    a /= 2;
    if (m >= 3 && Math.abs(a) > 0.5) out = [mx / (6 * a), my / (6 * a), true];
  }
  rearCache.set(r, out);
  return out;
}
const fondoLots = new Set<number>();
const fondoPerLot = new Map<number, number>();
for (let i = 0; i < NF; i++) {
  const b = fondo[i];
  const pr = onlyParcelRow(b);
  if (pr < 0) throw new Error(`fondo-de-lote ${b.id}: parcel ${b.parcels[0]} is not in ../ba`);
  const [x, y, rear] = rearPoint(pr);
  if (rear) rearHalf++;
  else lotCentroid++;
  fondoLots.add(pr);
  fondoPerLot.set(pr, (fondoPerLot.get(pr) ?? 0) + 1);
  fXY[2 * i] = x;
  fXY[2 * i + 1] = y;
  fMeta[4 * i] = startTOf(b);
  fMeta[4 * i + 1] = completeTOf(b);
  fMeta[4 * i + 2] = b.units;
  fMeta[4 * i + 3] = pr;
}
let lotsRear = 0;
for (const v of rearCache.values()) if (v[2]) lotsRear++;
const maxPerLot = Math.max(...fondoPerLot.values());
log(`fondo-de-lote: ${NF} points on ${fondoLots.size} lots; rear half ${rearHalf}, lot centroid ${lotCentroid}`);
writeArray("fondo_xy.f32", fXY, [NF, 2],
  "One point (x, y) in metres per fondo-de-lote addition (a one-unit addition on a lot whose buildings keep standing): the centroid of the rear half of its lot, else the lot centroid.",
  `Lot = the ../ba parcel ring of the row's one parcel (the row's own footprint is that whole lot). Street side = direction from the lot centroid to the nearest point of a frontage street (../ba streets of class ${FRONTAGE_CLASSES.join(", ")}: trunk..residential and car-free streets) within ${FRONTAGE_SEARCH_M} m; rear half = the lot clipped to the half-plane behind the line through the centroid perpendicular to that direction. ${rearHalf} points (${lotsRear} lots) use the rear half, ${lotCentroid} (${fondoLots.size - lotsRear} lots) the lot centroid (no frontage street within ${FRONTAGE_SEARCH_M} m, mostly large informal-settlement parcels). Additions on the same lot share one position: ${NF} points on ${fondoLots.size} lots, up to ${maxPerLot} per lot.`);
writeArray("fondo_meta.f32", fMeta, [NF, 4],
  "Per fondo-de-lote point, 4 float32: [0] startT, [1] completeT, [2] units, [3] parcelRow (row in ../ba parcels_*). T = fractional years since 2022-01-01.",
  "Same time rules as new_meta (no fondo-de-lote row starts before the run). Rows in the order of the developments JSON restricted to fondo-de-lote.");

// ---------------------------------------------------------------------------
// 5. Demolitions -> ../ba building rows
// ---------------------------------------------------------------------------
// The run names a seed building by the region binary's id column (the CLI
// loader's seed ids = decoded.ids), which is NOT the row index; ids map to
// rows through that column, and ../ba rows are the binary's rows.

const seedDemolitions = dev.demolitions.filter((d) => d.origin === "seed");
const runDemolitions = dev.demolitions.filter((d) => d.origin !== "seed");
const dRow: number[] = [];
const dT: number[] = [];
const dShare: number[] = [];
const unmatched: number[] = [];
const goneT = new Float32Array(BR).fill(NaN);
const byNewId = new Map(dev.buildings.map((b) => [b.id, b] as const));
let collateral = 0, collateralOver30 = 0, demolishedAtT0 = 0;
const emptyLotByKind: Record<string, number> = {};
const demolitionsByKind: Record<string, number> = {};
const collateralTall: { row: number; heightM: number; replacedBy: number[]; kind: string }[] = [];
for (const d of seedDemolitions) {
  const r = seedRowById.get(d.id);
  if (r === undefined) {
    unmatched.push(d.id);
    continue;
  }
  if (Math.abs(baHeight[r] - d.heightM) > 0.051) throw new Error(`demolition ${d.id}: height ${d.heightM} vs ../ba row ${r} ${baHeight[r]}`);
  const T = tOf(d.date);
  dRow.push(r);
  dT.push(T);
  if (!(goneT[r] <= T)) goneT[r] = T;
  // Is the demolished building's own (centroid) parcel one the replacing building stands on?
  const repl = d.replacedBy.map((id) => byNewId.get(id)!).filter(Boolean);
  const replParcels = new Set(repl.flatMap((b) => b.parcels));
  dShare.push(footprintShareOn(r, [...replParcels].map(parcelRow).filter((p) => p >= 0)));
  const own = baBldParcel[r] === NONE_U32 ? -1 : pId[baBldParcel[r]];
  if (own >= 0 && !replParcels.has(own)) {
    collateral++;
    if (baHeight[r] > 30) {
      collateralOver30++;
      collateralTall.push({ row: r, heightM: round(baHeight[r]), replacedBy: d.replacedBy, kind: repl[0]?.kind ?? "?" });
    }
  }
  const kind = repl[0]?.kind ?? "?";
  demolitionsByKind[kind] = (demolitionsByKind[kind] ?? 0) + 1;
  if (T === 0) demolishedAtT0++;
  const firstStart = Math.min(...repl.map(startTOf));
  if (firstStart - T > 1 / 24) emptyLotByKind[kind] = (emptyLotByKind[kind] ?? 0) + 1;
}
const order = dRow.map((_, i) => i).sort((a, b) => dT[a] - dT[b] || dRow[a] - dRow[b]);
const dRowArr = new Uint32Array(order.map((i) => dRow[i]));
const dTArr = new Float32Array(order.map((i) => dT[i]));
const dShareArr = new Float32Array(order.map((i) => dShare[i]));
const distinctRows = new Set(dRow).size;
const shareBins = { under1pct: 0, "1to10pct": 0, "10to50pct": 0, atLeast50pct: 0, unknown: 0 };
for (const s of dShare) {
  if (!Number.isFinite(s)) shareBins.unknown++;
  else if (s < 0.01) shareBins.under1pct++;
  else if (s < 0.1) shareBins["1to10pct"]++;
  else if (s < 0.5) shareBins["10to50pct"]++;
  else shareBins.atLeast50pct++;
}
log(`demolitions: ${seedDemolitions.length} seed, ${runDemolitions.length} of run buildings; matched ${dRow.length} (${distinctRows} distinct rows), unmatched ${unmatched.length}`);
writeArray("demolitions_row.u32", dRowArr, [dRowArr.length],
  "../ba building row removed by each seed demolition of the run (one row per demolition), sorted by T then row.",
  `Seed building id (developments JSON 'demolitions[].id', origin 'seed') -> row through the region binary's id column; ../ba rows = binary rows. ${dRow.length} of ${seedDemolitions.length} matched (${unmatched.length} unmatched); every match has the same height as its ../ba row. The seed id is not the row index (it equals it for ${idEqualsRow} of ${BC} rows).`);
writeArray("demolitions_t.f32", dTArr, [dTArr.length],
  "Time T of each demolition in demolitions_row (fractional years since 2022-01-01).",
  "T = (year - 2022) + (month - 1) / 12 of the demolition's [year, month].");
writeArray("demolitions_lot_share.f32", dShareArr, [dShareArr.length],
  "Share (0..1) of each demolished building's footprint that lies on the lot of the run building that replaces it, row-aligned with demolitions_row. The engine demolishes every seed building whose footprint touches the redeveloped lot, so a low share marks a neighbour cleared because it overlaps the lot by a sliver.",
  `Grid of ~4,000 points per footprint ring (spacing >= 0.5 m) over the ../ba building rings, counted inside the ../ba parcel ring(s) of the replacing building(s). Distribution: ${shareBins.under1pct} under 1%, ${shareBins["1to10pct"]} 1-10%, ${shareBins["10to50pct"]} 10-50%, ${shareBins.atLeast50pct} at least 50%${shareBins.unknown ? `, ${shareBins.unknown} unknown` : ""}.`);
writeArray("buildings_demolished_t.f32", goneT, [BR],
  "Per ../ba building row: T at which the run demolishes it; NaN = still standing at the end of 2031. Same data as demolitions_row / demolitions_t, aligned to rows.",
  "Scattered from demolitions_row / demolitions_t.");

// ---------------------------------------------------------------------------
// 6. Home -> work pairs (base-year population and employment assignment)
// ---------------------------------------------------------------------------

log("commute: decoding population and employment");
const pop = decodePopulationBinary(toAB(gunzipSync(readFileSync(path.join(SRC, "run-results/population2022.bin.gz")))));
const emp = decodeEmploymentAssignmentBinary(toAB(gunzipSync(readFileSync(path.join(SRC, "run-results/employment-assignment2022.bin.gz")))));
const hh = pop.householdSOA, fam = pop.familySOA, per = pop.personSOA;
const P = per.count;
for (let i = 0; i < P; i++) if (per.personIDs[i] !== i + 1) throw new Error("person ids are not dense (row i = id i + 1)");
const personHH = new Int32Array(P).fill(-1);
for (let h = 0; h < hh.count; h++) {
  const f0 = hh.familyStartIndices[h];
  for (let f = f0; f < f0 + hh.familyCounts[h]; f++) {
    const p0 = fam.personStartIndices[f];
    for (let p = p0; p < p0 + fam.personCounts[f]; p++) personHH[p] = h;
  }
}
let unhousedHouseholds = 0;
for (let h = 0; h < hh.count; h++) if (hh.parcelIDs[h] === 0) unhousedHouseholds++;
const holder = new Uint8Array(P);
let employedInCity = 0, employedOutside = 0, inCityUnhoused = 0, outsideUnhoused = 0, holdersNotInSeed = 0, holdersNotInSeedInCity = 0, jobParcelMissing = 0, doubleHolders = 0;
const frame = new Int32Array(emp.count);
let nFrame = 0;
for (let i = 0; i < emp.count; i++) {
  const p = emp.personIDs[i];
  if (p <= 0 || emp.fills[i] !== EmploymentFill.Resident) continue;
  const inCity = emp.sectors[i] !== Sector.OutCommute;
  if (p > P) {
    holdersNotInSeed++;
    if (inCity) holdersNotInSeedInCity++;
    continue;
  }
  if (holder[p - 1]) doubleHolders++;
  holder[p - 1] = 1;
  const home = parcelRow(hh.parcelIDs[personHH[p - 1]]);
  if (!inCity) {
    employedOutside++;
    if (home < 0) outsideUnhoused++;
    continue;
  }
  employedInCity++;
  if (home < 0) {
    inCityUnhoused++;
    continue;
  }
  if (parcelRow(emp.parcelIDs[i]) < 0) {
    jobParcelMissing++;
    continue;
  }
  frame[nFrame++] = i;
}
if (doubleHolders > 0) throw new Error(`${doubleHolders} persons hold more than one job row`);
const employedResidents = employedInCity + employedOutside;
log(`commute: employed residents ${employedResidents}, in the city ${employedInCity}, frame ${nFrame}`);
// Straight-line home -> job distance (parcel centroids) over the whole frame.
const frameDist = new Float64Array(nFrame);
let frameSameParcel = 0;
for (let k = 0; k < nFrame; k++) {
  const i = frame[k];
  const hr = parcelRow(hh.parcelIDs[personHH[emp.personIDs[i] - 1]]);
  const jr = parcelRow(emp.parcelIDs[i]);
  if (hr === jr) frameSameParcel++;
  frameDist[k] = Math.hypot(pCent[2 * jr] - pCent[2 * hr], pCent[2 * jr + 1] - pCent[2 * hr + 1]);
}
let frameOver5km = 0, frameSum = 0;
for (let k = 0; k < nFrame; k++) {
  frameSum += frameDist[k];
  if (frameDist[k] > 5000) frameOver5km++;
}
frameDist.sort();
const frameKm = {
  p25: round(quantile(frameDist, 0.25) / 1000, 2),
  p50: round(quantile(frameDist, 0.5) / 1000, 2),
  p75: round(quantile(frameDist, 0.75) / 1000, 2),
  p90: round(quantile(frameDist, 0.9) / 1000, 2),
  p99: round(quantile(frameDist, 0.99) / 1000, 2),
  mean: round(frameSum / nFrame / 1000, 2),
  shareOver5km: round(frameOver5km / nFrame, 4),
};

const pick = mulberry32(SAMPLE_SEED);
const NS = Math.min(COMMUTE_SAMPLE, nFrame);
for (let k = 0; k < NS; k++) {
  const j = k + Math.floor(pick() * (nFrame - k));
  const t = frame[k];
  frame[k] = frame[j];
  frame[j] = t;
}
const jit = mulberry32(JITTER_SEED);
let jitterFallback = 0, jitterCentroid = 0;
const jitterInto = (r: number, out: Float32Array, at: number) => {
  const cx = pCent[2 * r], cy = pCent[2 * r + 1];
  const rad = Math.min(JITTER_MAX_M, JITTER_FACTOR * Math.sqrt(pArea[r]));
  for (let k = 0; k < 30; k++) {
    let u: number, v: number;
    do {
      u = 2 * jit() - 1;
      v = 2 * jit() - 1;
    } while (u * u + v * v > 1);
    const x = cx + rad * u, y = cy + rad * v;
    if (inParcel(r, x, y)) {
      out[at] = x;
      out[at + 1] = y;
      return;
    }
  }
  jitterFallback++;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let v = pRingOff[r]; v < pRingOff[r + 1]; v++) {
    x0 = Math.min(x0, pXY[2 * v]);
    x1 = Math.max(x1, pXY[2 * v]);
    y0 = Math.min(y0, pXY[2 * v + 1]);
    y1 = Math.max(y1, pXY[2 * v + 1]);
  }
  for (let k = 0; k < 200; k++) {
    const x = x0 + (x1 - x0) * jit(), y = y0 + (y1 - y0) * jit();
    if (inParcel(r, x, y)) {
      out[at] = x;
      out[at + 1] = y;
      return;
    }
  }
  jitterCentroid++;
  out[at] = cx;
  out[at + 1] = cy;
};
const homeXY = new Float32Array(NS * 2);
const jobXY = new Float32Array(NS * 2);
const dist = new Float64Array(NS);
let sameParcel = 0;
for (let k = 0; k < NS; k++) {
  const i = frame[k];
  const hr = parcelRow(hh.parcelIDs[personHH[emp.personIDs[i] - 1]]);
  const jr = parcelRow(emp.parcelIDs[i]);
  if (hr === jr) sameParcel++;
  jitterInto(hr, homeXY, 2 * k);
  jitterInto(jr, jobXY, 2 * k);
  dist[k] = Math.hypot(pCent[2 * jr] - pCent[2 * hr], pCent[2 * jr + 1] - pCent[2 * hr + 1]);
}
dist.sort();
const commuteDerived = `Frame: base-year job rows (employment-assignment2022) filled by a resident (fill Resident), sector not OutCommute, whose holder is a person of population2022 (dense ids: person id p = row p - 1) living in a household with a parcel; ${nFrame} pairs. Drawn uniformly without replacement (partial Fisher-Yates, mulberry32 seed ${SAMPLE_SEED}); rows are in draw order, so any prefix is itself a uniform sample. Position = the ../ba parcel centroid moved by a uniform offset in a disc of radius min(${JITTER_MAX_M} m, ${JITTER_FACTOR} x sqrt(parcel area)) (mulberry32 seed ${JITTER_SEED}), redrawn until inside the parcel ring (${jitterFallback} of ${NS * 2} points needed a uniform point in the parcel instead, ${jitterCentroid} kept the centroid). The pairing is the model's synthetic base-year matching (weight 1 / (d² + 1) on nearby job-less residents), so it is very local: over the frame ${round((frameSameParcel / nFrame) * 100, 1)}% work on their home parcel and the median straight-line distance is ${frameKm.p50} km.`;
writeArray("commute_home_xy.f32", homeXY, [NS, 2],
  "Home (x, y) in metres of a uniform random sample of employed residents who live and work in the city; row k pairs with commute_job_xy row k.",
  `Home = the household's parcel. ${commuteDerived}`);
writeArray("commute_job_xy.f32", jobXY, [NS, 2],
  "Job (x, y) in metres of the same sampled residents, row-aligned with commute_home_xy.",
  `Job = the parcel of the job row. ${commuteDerived}`);

// ---------------------------------------------------------------------------
// 7. Summary, height changes, manifest
// ---------------------------------------------------------------------------

const years: number[] = [];
for (let y = dev.startYear; y <= dev.endYear; y++) years.push(y);
const perKind: Record<string, { buildings: number; units: number; floorAreaM2: number; completedInRun: number; unitsCompletedInRun: number; completeAfterRun: number; preRun: number }> = {};
const unitsCompleted: Record<string, Record<string, number>> = {};
for (const b of dev.buildings) {
  const k = (perKind[b.kind] ??= { buildings: 0, units: 0, floorAreaM2: 0, completedInRun: 0, unitsCompletedInRun: 0, completeAfterRun: 0, preRun: 0 });
  k.buildings++;
  k.units += b.units;
  k.floorAreaM2 += b.floorAreaM2;
  if (b.preRun) k.preRun++;
  const inRun = !!b.complete && b.complete[0] <= dev.endYear;
  if (inRun) {
    k.completedInRun++;
    k.unitsCompletedInRun += b.units;
  } else k.completeAfterRun++;
  const key = inRun ? String(b.complete![0]) : `after ${dev.endYear}`;
  const row = (unitsCompleted[key] ??= { total: 0, visible: 0, "fondo-de-lote": 0 });
  row.total += b.units;
  row[b.kind === "fondo-de-lote" ? "fondo-de-lote" : "visible"] += b.units;
}
const totalUnits = Object.values(perKind).reduce((s, k) => s + k.units, 0);
const visibleUnits = totalUnits - (perKind["fondo-de-lote"]?.units ?? 0);
const demolishedUnits = seedDemolitions.reduce((s, d) => s + d.units, 0);
const afterRule = Array.from({ length: NB }, (_, i) => ({ i, h: meta[i * 8 + 2] })).sort((a, b) => b.h - a.h);
const tallestAfter = afterRule.slice(0, 8).map(({ i, h }) => ({ newRow: i, id: ids[i], kind: KIND_CODES[meta[i * 8 + 5]], heightM: round(h), stories: meta[i * 8 + 3], units: meta[i * 8 + 4] }));
const slender: { newRow: number; id: number; heightM: number; footprintM2: number; ratio: number }[] = [];
for (let i = 0; i < NB; i++) {
  const fp = visible[i].footprintAreaM2 ?? NaN;
  const h = meta[i * 8 + 2];
  if (fp > 0 && h / Math.sqrt(fp) > 5) slender.push({ newRow: i, id: ids[i], heightM: round(h), footprintM2: fp, ratio: round(h / Math.sqrt(fp), 1) });
}
slender.sort((a, b) => b.ratio - a.ratio);
const changedBySource: Record<string, number> = {};
for (const c of heightChanges) changedBySource[c.source] = (changedBySource[c.source] ?? 0) + 1;

const heightRule = {
  appliesTo: "in-progress-pipeline rows only. Every ar-multifamily, state-housing and law-enabled-site row is at or below its parcel's zone max height already (checked; 0 over), so none is changed.",
  why: "A pipeline row's storeys are the bootstrap loader's estimate, not an observed height: max(3, ceil(units / 8)), raised to fit the permitted floor area on 85% of the lot, at most 90 (inProgressDevelopmentsLoader.ts); stage 18 derives units as floor area / 70 m² (AGC works) or / 48 m² (Microcentro conversions; Del Plata's 720 as reported). The estimate is a fixed floor plate (8 x 70 = 560 m², 8 x 48 = 384 m²) whatever the lot, so large programmes become towers: 270 m / 90 storeys for the Del Plata conversion 800 m west of Plaza de Mayo (a 36.4 m building), 228 m in a district whose height is 9.2 m.",
  rules: [
    "Ley 6508 Microcentro conversions (source 'microcentro-ley6508', 9 rows): the project converts a standing office building, which the loader demolishes and rebuilds. Height := the height of the converted seed building = the building the row replaces whose floor space is closest to the permit's floor area (stage 18: that floor area is the converted envelope). stories := ceil(height / 3 m), the region's seed storey convention. Applied to all 9 even where the estimate was under the zone height.",
    "AGC new works (source 'agc-obras-iniciadas'): where the estimate exceeds the parcel's zone max height (zone max > 0), stories := floor(zoneMax / 3 m) and heightM := 3 x stories, the whole-storey envelope the engine's own developers never exceed. The zone max includes the stock-based fallback of APH/U/AE districts (p75 of the built stock), which CityCompass uses as their height.",
    "Unchanged: rows at or under their zone max, and the 1 row on a zone with max height 0 (non-developable class).",
  ],
  keptAsRun: "units, floor area and the footprint (the loader's synthetic shape: the lot outline scaled by 0.6, 36% of its area) are the run's, so a capped row's drawn volume no longer matches its permitted floor area.",
  changed: heightChanges.length,
  changedBySource,
  list: "height_changes.json",
};

const summary = {
  run: { region: "buenosaires", seed: dev.seed, years: `${dev.startYear}-${dev.endYear}`, source: "../sim/buenosaires-developments.json (run ba-2022-2031-s123456)" },
  newBuildings: {
    total: dev.buildings.length,
    visibleNonFondo: NB,
    fondoDeLotePoints: NF,
    perKind: Object.fromEntries(Object.entries(perKind).map(([k, v]) => [k, { ...v, floorAreaM2: Math.round(v.floorAreaM2) }])),
    totalUnits,
    visibleUnits,
    unitsCompletedPerYear: unitsCompleted,
    unitsCompletedInRun: Object.values(perKind).reduce((s, k) => s + k.unitsCompletedInRun, 0),
    tallestAfterHeightRule: tallestAfter,
  },
  heightRule,
  demolitions: {
    seed: seedDemolitions.length,
    matchedToBaRows: dRow.length,
    matchRate: seedDemolitions.length ? dRow.length / seedDemolitions.length : null,
    unmatched,
    distinctRows,
    footprintShareOnReplacingLot: shareBins,
    ownParcelIsNotTheReplacingLot: collateral,
    runBuildingsDemolished: runDemolitions.length,
    unitsDemolished: demolishedUnits,
    netUnitsAllKinds: totalUnits - demolishedUnits,
  },
  dwellings: { total: dwellingTotal, buildingsWithZero: dwellingZero, max: dwellingMax },
  commute: {
    employedResidents,
    workInsideCity: employedInCity,
    workOutsideCity: employedOutside,
    shareInsideCity: round(employedInCity / employedResidents, 4),
    sampleFrame: nFrame,
    sampled: NS,
    excluded: {
      workInCityNoHome: inCityUnhoused,
      workOutsideNoHome: outsideUnhoused,
      jobRowsWhoseHolderIsNotInThePopulation: holdersNotInSeed,
      ofThoseInCity: holdersNotInSeedInCity,
      jobParcelNotInBa: jobParcelMissing,
    },
    unhousedHouseholds,
    frameStraightLineKm: frameKm,
    frameWorkOnHomeParcel: frameSameParcel,
    frameShareWorkOnHomeParcel: round(frameSameParcel / nFrame, 4),
    sampleStraightLineKm: { p50: round(quantile(dist, 0.5) / 1000, 2), p90: round(quantile(dist, 0.9) / 1000, 2) },
    sampleWorkOnHomeParcel: sameParcel,
    howPairsWereMade: "The base-year assignment is the model's own synthetic matching, not observed commuting: job slots are placed by a uniform draw over zoning-eligible parcels (docs/buenosaires.md, 'Placement parcels'), and each vacancy is filled by a job-less resident from the surrounding 1 km grid rings, drawn with weight 1 / (d² + 1), d in metres (CommuteAwareWorkerMatcher, src/domain/employment/workerMatcher.ts).",
  },
  odd: [
    `Height: ${heightChanges.length} in-progress-pipeline rows changed by the height rule (${Object.entries(changedBySource).map(([k, v]) => `${v} ${k}`).join(", ")}); see heightRule and height_changes.json.`,
    `${slender.length} new buildings are still slender after the rule (height / sqrt(footprint) > 5, up to ${slender[0]?.ratio ?? 0}): pipeline rows on small lots whose footprint is the loader's 36%-of-lot shape (e.g. id ${slender[0]?.id ?? "-"}: ${slender[0]?.heightM ?? "-"} m on ${slender[0]?.footprintM2 ?? "-"} m²). Left as they are.`,
    "Footprints are sites, not always building shapes: ar-multifamily footprints are usually the whole lot (76% of rows; floor plate ~3/4 of it), pipeline footprints are the lot scaled by 0.6. Extruding them draws lot-filling blocks.",
    `${collateral} of ${dRow.length} seed demolitions remove a building whose own (centroid) parcel is not one its replacement stands on: the engine clears every seed building whose footprint touches the redeveloped lot, and ${shareBins.under1pct + shareBins["1to10pct"]} demolished buildings have under 10% of their footprint on it (demolitions_lot_share). ${collateralOver30} of the off-parcel ones are over 30 m (tallest ${collateralTall.sort((a, b) => b.heightM - a.heightM).slice(0, 4).map((c) => `row ${c.row} ${c.heightM} m for ${c.kind}`).join("; ")}). Rendering every demolition opens gaps beside the new buildings; filter on demolitions_lot_share to keep the neighbours standing.`,
    `${demolishedAtT0} demolitions are dated 2022-01 (T = 0); the in-progress pipeline's ${demolitionsByKind["in-progress-pipeline"] ?? 0} are all among them, because the bootstrap clears every pipeline lot at once, including lots whose project starts later (Del Plata starts 2026-01). Demolitions preceding their replacement's start by a month or more, by the replacing kind: ${Object.entries(emptyLotByKind).map(([k, v]) => `${v} ${k}`).join(", ")}; those lots stand empty in between.`,
    `The run demolished none of its own buildings, so new_meta goneT is NaN everywhere.`,
    `fondo-de-lote: ${NF} one-unit additions on only ${fondoLots.size} lots (up to ${maxPerLot} per lot), so points repeat at the same position; ${lotCentroid} points fall back to the lot centroid.`,
    `Commute pairs are very local: over the whole frame, ${round((frameSameParcel / nFrame) * 100, 1)}% of in-city workers work on their home parcel, the median straight-line distance is ${frameKm.p50} km (p90 ${frameKm.p90} km, p99 ${frameKm.p99} km) and ${round(frameKm.shareOver5km * 100, 1)}% go beyond 5 km. That is the base-year matcher's 1 / (d² + 1) weighting (see commute.howPairsWereMade), not observed travel; the pairs will not read as a flow toward the centre.`,
    `Commute: ${holdersNotInSeed} job rows (${holdersNotInSeedInCity} in the city) name a holder id above the population's ${P} persons (a person the run would create), so they have no base-year home; ${inCityUnhoused} in-city workers belong to unhoused households (${unhousedHouseholds} households have no parcel and no building). All are outside the frame.`,
  ],
};
writeFileSync(path.join(OUT, "height_changes.json"), JSON.stringify({ rule: heightRule.rules, changes: heightChanges }, null, 1));
writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 1));

const gitCommit = git("git rev-parse HEAD");
const gitDirty = git(`git status --porcelain -- ${SRC_REL}`);
const manifest = {
  name: "Buenos Aires film data: the run's decade, dwellings, commutes",
  generatedAt: new Date().toISOString(),
  generator: ".scratch/urbanly-film/data/film/export-film.ts",
  rerun: "npx vite-node .scratch/urbanly-film/data/film/export-film.ts   (from the repo root)",
  source: {
    run: { file: ".scratch/urbanly-film/data/sim/buenosaires-developments.json", runDir: ".scratch/urbanly-film/data/sim/runs/ba-2022-2031-s123456", seed: dev.seed, years: `${dev.startYear}-${dev.endYear}` },
    regionExport: ".scratch/urbanly-film/data/ba (rows referenced by every *Row / *_row field)",
    binaries: [`${SRC_REL}/buildings.bin.0.gz`, `${SRC_REL}/in-progress-developments.json.gz`, `${SRC_REL}/run-results/population2022.bin.gz`, `${SRC_REL}/run-results/employment-assignment2022.bin.gz`],
    gitCommit,
    uncommittedChangesInSource: gitDirty === "" ? false : gitDirty,
  },
  projection: "Same as ../ba/manifest.json: local equirectangular metres, x east, y north, origin Plaza de Mayo (lon0 -58.3722, lat0 -34.6083, R 6371008.8).",
  conventions: {
    endianness: "little",
    oneArrayPerFile: true,
    fileExtensions: { ".f32": "Float32Array", ".u32": "Uint32Array", ".json": "UTF-8 JSON" },
    shape: "shape [n, k] = n rows of k interleaved values; count = typed-array elements",
    time: "T = fractional years since 2022-01-01: (year - 2022) + (month - 1) / 12. The run covers T 0..10 (2022-01..2031-12); a completeT above 10 completes after the run.",
    rings: "Ring r owns vertices [o[r], o[r+1]) of the *_xy array (vertex units). Rings are open and counter-clockwise.",
    missing: "Float NaN = none / unknown.",
  },
  kindCodes: KIND_CODES.map((k, code) => ({ code, kind: k, meaning: {
    "in-progress-pipeline": "works already under way or permitted when the run starts (AGC obras iniciadas; Ley 6508 Microcentro conversions), injected at bootstrap",
    "ar-multifamily": "market 'pozo' apartment developer (the engine's developers)",
    "state-housing": "IVC public housing blocks",
    "law-enabled-site": "large special-law sites",
    "fondo-de-lote": "one-unit addition on a lot whose buildings keep standing (points only, fondo_*)",
  }[k] })),
  heightRule,
  notListedHere: "Other scripts write into this directory and are not described here: agents_* (data/agent-paths.mjs: the commute_* pairs routed along the streets) and growth_* (data/growth-points.mjs). This generator never deletes; it overwrites only the files listed below.",
  files,
};
writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 1));
log(`wrote ${files.length} arrays, manifest.json, summary.json, height_changes.json`);
