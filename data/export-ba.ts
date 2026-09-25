/**
 * Buenos Aires geometry export for the CityCompass promotional film.
 *
 * Re-run from the repository root (/Users/dantec/Developer/citycompass):
 *
 *   npx vite-node .scratch/urbanly-film/data/export-ba.ts
 *
 * and then the visual check (reads only the exported files):
 *
 *   node .scratch/urbanly-film/data/check-ba.mjs
 *
 * Reads the committed region data in public/buenosaires/ through the repo's own
 * decoders (vite-node resolves the @shared/@domain/@main aliases) and writes
 * little-endian raw typed arrays, one array per file, plus manifest.json and
 * stats.json, into .scratch/urbanly-film/data/ba/. Nothing outside that folder
 * is written.
 *
 * Every coordinate is local equirectangular metres around Plaza de Mayo:
 *   x = R·(lon−lon0)·(π/180)·cos(lat0·π/180),  y = R·(lat−lat0)·(π/180)
 *   lon0 = −58.3722, lat0 = −34.6083, R = 6371008.8, x east, y north.
 * Buildings and parcels are stored in the binaries as origin-relative
 * normalised Web Mercator; they go mercator → lon/lat → metres in Float64 and
 * are rounded to Float32 once, at the end.
 */
import { decodeEmploymentAssignmentBinary } from "@domain/employment/employmentAssignmentBinary";
import { EmploymentFill } from "@domain/employment/employment";
import { Sector } from "@domain/employment/sector";
import { decodePopulationBinary } from "@domain/population/PopulationBinary";
import {
  STREET_CLASS_LOG_CODES,
  canonicalStreetClass,
  encodeLogStreetClass,
} from "@domain/streets/streetClass";
import { StreetDirection } from "@domain/streets/streetDirection";
import { decodeStreetsBinary } from "@domain/streets/streetsBinary";
import { decodeRasterGrid } from "@main/green-access/gridBinary";
import { decodeBuildingBinary } from "@shared/buildings-gl/BuildingGLBinary";
import { decodeParcelBinary } from "@shared/parcel-gl/ParcelGLBinary";
import { decodePolygonBinary } from "@shared/polygon-gl/PolygonGLBinary";
import { execSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

// ---------------------------------------------------------------------------
// Paths, projection, output helpers
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const SRC = path.join(REPO, "public/buenosaires");
const OUT = path.join(HERE, "ba");
const SRC_REL = "public/buenosaires";

const LON0 = -58.3722;
const LAT0 = -34.6083;
const R_EARTH = 6371008.8;
const DEG = Math.PI / 180;
const KX = R_EARTH * DEG * Math.cos(LAT0 * DEG);
const KY = R_EARTH * DEG;
const lonToX = (lon: number) => KX * (lon - LON0);
const latToY = (lat: number) => KY * (lat - LAT0);

/** Snap radius for street nodes (m). */
const SNAP_M = 0.5;
/** Consecutive ring vertices closer than this (m, per axis) are duplicates. */
const DUP_EPS_M = 1e-3;
/** A ring with |area| below this (m²) is degenerate. */
const MIN_RING_AREA_M2 = 0.01;
/** Raster cell for the tree placement masks (m). */
const MASK_CELL_M = 2;
/** Storey height used for the derived zoning envelope (region defaultStoreyHeight). */
const STOREY_M = 3;
const NONE_U32 = 0xffffffff;
const NONE_U16 = 0xffff;

if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1) {
  throw new Error("this export writes platform-endian arrays and assumes little-endian");
}

const t0 = Date.now();
const log = (...a: unknown[]) =>
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

const toAB = (b: Buffer) =>
  b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const readGz = (rel: string) => toAB(gunzipSync(readFileSync(path.join(SRC, rel))));
const readGzJson = <T>(rel: string): T =>
  JSON.parse(gunzipSync(readFileSync(path.join(SRC, rel))).toString("utf8")) as T;
const readJson = <T>(rel: string): T =>
  JSON.parse(readFileSync(path.join(SRC, rel), "utf8")) as T;

type TA = Float32Array | Uint32Array | Uint16Array | Uint8Array;
interface FileEntry {
  file: string;
  layer: string;
  dtype: string;
  count: number;
  shape: number[];
  bytes: number;
  meaning: string;
}
const files: FileEntry[] = [];
const dtypeOf = (a: TA) =>
  a instanceof Float32Array
    ? "float32"
    : a instanceof Uint32Array
      ? "uint32"
      : a instanceof Uint16Array
        ? "uint16"
        : "uint8";

function writeArray(file: string, layer: string, a: TA, shape: number[], meaning: string) {
  const n = shape.reduce((p, q) => p * q, 1);
  if (n !== a.length) throw new Error(`${file}: shape ${shape} != length ${a.length}`);
  writeFileSync(path.join(OUT, file), Buffer.from(a.buffer, a.byteOffset, a.byteLength));
  files.push({ file, layer, dtype: dtypeOf(a), count: a.length, shape, bytes: a.byteLength, meaning });
}
function writeJson(file: string, layer: string, value: unknown, meaning: string) {
  const text = JSON.stringify(value);
  writeFileSync(path.join(OUT, file), text);
  files.push({ file, layer, dtype: "json", count: Array.isArray(value) ? value.length : 1, shape: [], bytes: Buffer.byteLength(text), meaning });
}

type BBox = [number, number, number, number];
function bboxOf(xy: Float32Array): BBox {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < xy.length; i += 2) {
    const x = xy[i], y = xy[i + 1];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1].map((v) => Math.round(v * 10) / 10) as BBox;
}

function quantiles(values: Float32Array): { min: number; median: number; p95: number; max: number; mean: number } {
  const s = Float32Array.from(values).sort();
  let sum = 0;
  for (let i = 0; i < s.length; i++) sum += s[i];
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return { min: r2(s[0]), median: r2(q(0.5)), p95: r2(q(0.95)), max: r2(s[s.length - 1]), mean: r2(sum / s.length) };
}

// ---------------------------------------------------------------------------
// Ring helpers (scratch-array based; no per-vertex allocation)
// ---------------------------------------------------------------------------

let SX = new Float64Array(1 << 16);
let SY = new Float64Array(1 << 16);
function ensureScratch(n: number) {
  if (n <= SX.length) return;
  let m = SX.length;
  while (m < n) m *= 2;
  const nx = new Float64Array(m), ny = new Float64Array(m);
  nx.set(SX);
  ny.set(SY);
  SX = nx;
  SY = ny;
}

/**
 * Appends one origin-relative mercator ring to the scratch arrays at `at`,
 * projected to metres, rounded to Float32, duplicate consecutive vertices
 * (and the closing duplicate) removed. Returns the kept vertex count.
 */
function loadMercRing(rv: Float32Array, v0: number, vc: number, ox: number, oy: number, at: number): number {
  ensureScratch(at + vc);
  let n = 0;
  for (let k = 0; k < vc; k++) {
    const mx = rv[(v0 + k) * 2] + ox;
    const my = rv[(v0 + k) * 2 + 1] + oy;
    const lon = (mx - 0.5) * 360;
    const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) / DEG;
    const x = Math.fround(lonToX(lon));
    const y = Math.fround(latToY(lat));
    if (n > 0 && Math.abs(x - SX[at + n - 1]) < DUP_EPS_M && Math.abs(y - SY[at + n - 1]) < DUP_EPS_M) continue;
    SX[at + n] = x;
    SY[at + n] = y;
    n++;
  }
  while (n > 1 && Math.abs(SX[at + n - 1] - SX[at]) < DUP_EPS_M && Math.abs(SY[at + n - 1] - SY[at]) < DUP_EPS_M) n--;
  return n;
}

/** Same as loadMercRing for a GeoJSON [lon, lat][] ring. */
function loadLonLatRing(ring: number[][], at: number): number {
  ensureScratch(at + ring.length);
  let n = 0;
  for (let k = 0; k < ring.length; k++) {
    const x = Math.fround(lonToX(ring[k][0]));
    const y = Math.fround(latToY(ring[k][1]));
    if (n > 0 && Math.abs(x - SX[at + n - 1]) < DUP_EPS_M && Math.abs(y - SY[at + n - 1]) < DUP_EPS_M) continue;
    SX[at + n] = x;
    SY[at + n] = y;
    n++;
  }
  while (n > 1 && Math.abs(SX[at + n - 1] - SX[at]) < DUP_EPS_M && Math.abs(SY[at + n - 1] - SY[at]) < DUP_EPS_M) n--;
  return n;
}

/** Signed shoelace area (m²) of scratch ring [s, s+n); > 0 = counter-clockwise. */
function signedArea(s: number, n: number): number {
  let a = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) a += SX[s + j] * SY[s + i] - SX[s + i] * SY[s + j];
  return a / 2;
}

/** Area centroid of scratch ring [s, s+n) given its signed area. */
function ringCentroid(s: number, n: number, area: number): [number, number] {
  let cx = 0, cy = 0;
  // Subtract the first vertex to keep the products small (numerical stability).
  const bx = SX[s], by = SY[s];
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xj = SX[s + j] - bx, yj = SY[s + j] - by, xi = SX[s + i] - bx, yi = SY[s + i] - by;
    const c = xj * yi - xi * yj;
    cx += (xj + xi) * c;
    cy += (yj + yi) * c;
  }
  return [bx + cx / (6 * area), by + cy / (6 * area)];
}

function pointInScratchRing(px: number, py: number, s: number, n: number): boolean {
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const yi = SY[s + i], yj = SY[s + j];
    if (yi > py !== yj > py) {
      const xc = SX[s + i] + ((py - yi) * (SX[s + j] - SX[s + i])) / (yj - yi);
      if (px < xc) inside = !inside;
    }
  }
  return inside;
}

/** Majority vote over up to 7 vertices and 7 edge midpoints of ring A. */
function scratchRingInside(aS: number, aN: number, bS: number, bN: number): boolean {
  const m = Math.min(aN, 7);
  let votes = 0, total = 0;
  for (let t = 0; t < m; t++) {
    const k = Math.floor((t * aN) / m);
    const k2 = (k + 1) % aN;
    if (pointInScratchRing(SX[aS + k], SY[aS + k], bS, bN)) votes++;
    const mx = (SX[aS + k] + SX[aS + k2]) / 2, my = (SY[aS + k] + SY[aS + k2]) / 2;
    if (pointInScratchRing(mx, my, bS, bN)) votes++;
    total += 2;
  }
  return votes * 2 > total;
}

/** Copies scratch ring [s, s+n) into dst at vertex offset `at`, reversed if asked. */
function emitScratchRing(dst: Float32Array, at: number, s: number, n: number, reverse: boolean) {
  for (let k = 0; k < n; k++) {
    const src = reverse ? s + n - 1 - k : s + k;
    dst[(at + k) * 2] = SX[src];
    dst[(at + k) * 2 + 1] = SY[src];
  }
}

// A flat raster (row 0 = south) used for the tree placement masks and the
// inside-the-city test of street edges.
interface Mask {
  x0: number;
  y0: number;
  cs: number;
  w: number;
  h: number;
  data: Uint8Array;
}
const XS = new Float64Array(1 << 16);
/** ORs `bit` into every cell whose centre lies inside ring [v0, v1) of `xy` (even-odd). */
function fillRing(g: Mask, xy: Float32Array, v0: number, v1: number, bit: number) {
  let minY = Infinity, maxY = -Infinity;
  for (let i = v0; i < v1; i++) {
    const y = xy[i * 2 + 1];
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const r0 = Math.max(0, Math.ceil((minY - g.y0) / g.cs - 0.5));
  const r1 = Math.min(g.h - 1, Math.floor((maxY - g.y0) / g.cs - 0.5));
  for (let r = r0; r <= r1; r++) {
    const yc = g.y0 + (r + 0.5) * g.cs;
    let k = 0;
    for (let i = v0, j = v1 - 1; i < v1; j = i++) {
      const yi = xy[i * 2 + 1], yj = xy[j * 2 + 1];
      if (yi > yc !== yj > yc) {
        const xi = xy[i * 2], xj = xy[j * 2];
        XS[k++] = xi + ((yc - yi) * (xj - xi)) / (yj - yi);
      }
    }
    if (k < 2) continue;
    const xs = XS.subarray(0, k).sort();
    const base = r * g.w;
    for (let m = 0; m + 1 < k; m += 2) {
      const c0 = Math.max(0, Math.ceil((xs[m] - g.x0) / g.cs - 0.5));
      const c1 = Math.min(g.w - 1, Math.floor((xs[m + 1] - g.x0) / g.cs - 0.5));
      for (let c = c0; c <= c1; c++) g.data[base + c] |= bit;
    }
  }
}
function maskAt(g: Mask, x: number, y: number): number {
  const c = Math.floor((x - g.x0) / g.cs), r = Math.floor((y - g.y0) / g.cs);
  if (c < 0 || r < 0 || c >= g.w || r >= g.h) return -1;
  return g.data[r * g.w + c];
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

mkdirSync(OUT, { recursive: true });
for (const f of readdirSync(OUT)) {
  if (/\.(f32|u32|u16|u8|json)$/.test(f)) unlinkSync(path.join(OUT, f));
}
const git = (cmd: string) => {
  try {
    return execSync(cmd, { cwd: REPO, encoding: "utf8" }).trim();
  } catch {
    return "unavailable";
  }
};
const gitCommit = git("git rev-parse HEAD");
const gitDirty = git(`git status --porcelain -- ${SRC_REL}`);

// ---------------------------------------------------------------------------
// 1. Streets → graph
// ---------------------------------------------------------------------------

log("streets: decoding");
const st = decodeStreetsBinary(readGz("streets.bin.gz"));
const pointCount = st.coords.length / 2;

let nodeCount = 0;
const nodeX = new Float64Array(pointCount);
const nodeY = new Float64Array(pointCount);
const pointNode = new Uint32Array(pointCount);
{
  const cells = new Map<number, number[]>();
  const key = (ix: number, iy: number) => (ix + 1_000_000) * 2_000_000 + (iy + 1_000_000);
  for (let i = 0; i < pointCount; i++) {
    const x = lonToX(st.coords[i * 2]);
    const y = latToY(st.coords[i * 2 + 1]);
    const ix = Math.floor(x / SNAP_M), iy = Math.floor(y / SNAP_M);
    let best = -1, bestD2 = SNAP_M * SNAP_M;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const list = cells.get(key(ix + dx, iy + dy));
        if (!list) continue;
        for (let k = 0; k < list.length; k++) {
          const n = list[k];
          const ex = nodeX[n] - x, ey = nodeY[n] - y;
          const d2 = ex * ex + ey * ey;
          if (d2 <= bestD2) {
            bestD2 = d2;
            best = n;
          }
        }
      }
    }
    if (best < 0) {
      best = nodeCount++;
      nodeX[best] = x;
      nodeY[best] = y;
      const k = key(ix, iy);
      const list = cells.get(k);
      if (list) list.push(best);
      else cells.set(k, [best]);
    }
    pointNode[i] = best;
  }
}

const AVENUE_RE = /^(Avenida|Av\.|Avda\.?)\s/i;
// Duplicate segments keep the more major class: rank by canonical code, with
// the car-free street (13) ranked between service (7) and footway (8).
const CLASS_RANK = [99, 1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 8];
const maxEdges = pointCount;
const eA = new Uint32Array(maxEdges);
const eB = new Uint32Array(maxEdges);
const eClass = new Uint8Array(maxEdges);
const eOsm = new Uint8Array(maxEdges);
const eFlags = new Uint8Array(maxEdges);
const eName = new Uint16Array(maxEdges);
const eLen = new Float32Array(maxEdges);
const wayEdges = new Uint32Array(st.streetCount + 1);
let E = 0, dupEdges = 0, zeroEdges = 0, backwardWays = 0;
if (st.names.length + 1 > NONE_U16) throw new Error("too many street names for uint16");
{
  const pairIndex = new Map<number, number>();
  for (let f = 0; f < st.streetCount; f++) {
    wayEdges[f] = E;
    const osm = st.classCodes[f];
    const cls = encodeLogStreetClass(canonicalStreetClass(osm ? st.classNames[osm - 1] : undefined));
    const dir = st.directions[f];
    if (dir === StreetDirection.Backward) backwardWays++;
    const oneway = dir !== StreetDirection.TwoWay;
    const name = st.nameCodes[f];
    const avenue = name > 0 && AVENUE_RE.test(st.names[name - 1]);
    for (let p = st.featurePartOffsets[f]; p < st.featurePartOffsets[f + 1]; p++) {
      for (let i = st.partOffsets[p]; i + 1 < st.partOffsets[p + 1]; i++) {
        let a = pointNode[i], b = pointNode[i + 1];
        if (a === b) {
          zeroEdges++;
          continue;
        }
        if (dir === StreetDirection.Backward) {
          const t = a;
          a = b;
          b = t;
        }
        const pk = Math.min(a, b) * 4_194_304 + Math.max(a, b);
        const prev = pairIndex.get(pk);
        if (prev !== undefined) {
          dupEdges++;
          if (CLASS_RANK[cls] < CLASS_RANK[eClass[prev]]) {
            eClass[prev] = cls;
            eOsm[prev] = osm;
            eName[prev] = name;
            eFlags[prev] = (eFlags[prev] & ~2) | (avenue ? 2 : 0);
          }
          // Two ways over one segment: one-way only if both agree on a→b.
          if (!(oneway && (eFlags[prev] & 1) && eA[prev] === a)) eFlags[prev] &= ~1;
          continue;
        }
        pairIndex.set(pk, E);
        eA[E] = a;
        eB[E] = b;
        eClass[E] = cls;
        eOsm[E] = osm;
        eName[E] = name;
        eFlags[E] = (oneway ? 1 : 0) | (avenue ? 2 : 0);
        eLen[E] = Math.hypot(nodeX[b] - nodeX[a], nodeY[b] - nodeY[a]);
        E++;
      }
    }
  }
  wayEdges[st.streetCount] = E;
}
log(`streets: ${st.streetCount} ways, ${pointCount} vertices -> ${nodeCount} nodes, ${E} edges (${dupEdges} duplicate segments merged, ${zeroEdges} zero-length after snapping)`);

// ---------------------------------------------------------------------------
// 2. Parcels
// ---------------------------------------------------------------------------

log("parcels: decoding");
const pb = decodeParcelBinary(readGz("parcels.bin.gz"));
const PC = pb.parcelCount;
const pXY = new Float32Array(pb.ringVertexCount * 2);
const pRingOff = new Uint32Array(PC + 1);
const pId = new Uint32Array(PC);
const pCent = new Float32Array(PC * 2);
const pArea = new Float32Array(PC);
const pUse = new Uint8Array(PC);
let maxParcelId = 0;
for (let i = 0; i < PC; i++) if (pb.ids[i] > maxParcelId) maxParcelId = pb.ids[i];
const parcelRowById = new Int32Array(maxParcelId + 1).fill(-1);
let np = 0, npv = 0, parcelsDropped = 0, parcelExtraParts = 0;
const parcelAreaRatio = new Float32Array(PC);
{
  const { x: ox, y: oy } = pb.origin;
  for (let i = 0; i < PC; i++) {
    const r0 = pb.parcelRingIndex[i * 2], rc = pb.parcelRingIndex[i * 2 + 1];
    if (rc === 0) {
      parcelsDropped++;
      continue;
    }
    if (rc > 1) parcelExtraParts += rc - 1;
    // Ring 0 is the parcel's largest exterior part (ParcelGLBinary contract).
    const n = loadMercRing(pb.ringVertices, pb.ringIndex[r0 * 2], pb.ringIndex[r0 * 2 + 1], ox, oy, 0);
    const a = n >= 3 ? signedArea(0, n) : 0;
    if (n < 3 || Math.abs(a) < MIN_RING_AREA_M2) {
      parcelsDropped++;
      continue;
    }
    emitScratchRing(pXY, npv, 0, n, a < 0);
    const [cx, cy] = ringCentroid(0, n, a);
    pRingOff[np] = npv;
    npv += n;
    pId[np] = pb.ids[i];
    pCent[np * 2] = cx;
    pCent[np * 2 + 1] = cy;
    pArea[np] = pb.area[i];
    pUse[np] = pb.useCode[i];
    parcelAreaRatio[np] = Math.abs(a) / pb.area[i];
    parcelRowById[pb.ids[i]] = np;
    np++;
  }
  pRingOff[np] = npv;
}
log(`parcels: ${PC} -> ${np} exported (${parcelsDropped} dropped, ${parcelExtraParts} secondary parts not exported); ring area / binary area median ${quantiles(parcelAreaRatio.subarray(0, np)).median}`);

// ---------------------------------------------------------------------------
// 3. Buildings
// ---------------------------------------------------------------------------

log("buildings: assembling chunks");
const bManifest = readJson<{
  origin: { x: number; y: number };
  uncompressedByteLength: number;
  chunks: { file: string; uncompressedByteLength: number }[];
}>("buildings.bin.manifest.json");
const bBuf = new ArrayBuffer(bManifest.uncompressedByteLength);
{
  const bytes = new Uint8Array(bBuf);
  let off = 0;
  for (const c of bManifest.chunks) {
    const d = gunzipSync(readFileSync(path.join(SRC, c.file)));
    if (d.byteLength !== c.uncompressedByteLength) throw new Error(`${c.file}: ${d.byteLength} bytes, manifest says ${c.uncompressedByteLength}`);
    bytes.set(d, off);
    off += d.byteLength;
  }
  if (off !== bManifest.uncompressedByteLength) throw new Error("building chunks do not add up to the manifest length");
}
const bd = decodeBuildingBinary(bBuf);
const BC = bd.buildingCount;
log(`buildings: decoded ${BC} buildings, ${bd.ringCount} rings`);

const bXY = new Float32Array(bd.ringVertexCount * 2);
const bRingOff = new Uint32Array(bd.ringCount + 1);
const bRingStart = new Uint32Array(BC + 1);
const hXY = new Float32Array(bd.ringVertexCount * 2);
const hRingOff = new Uint32Array(bd.ringCount + 1);
const hOwner = new Uint32Array(bd.ringCount);
const bHeight = new Float32Array(BC);
const bType = new Uint8Array(BC);
const bCent = new Float32Array(BC * 2);
const bParcel = new Uint32Array(BC);
const bFloor = new Float32Array(BC);
const bSrcRow = new Uint32Array(BC);
let nb = 0, nr = 0, nv = 0, nh = 0, nhv = 0;
const bStats = {
  buildingsDropped: 0,
  degenerateRings: 0,
  exteriorRings: 0,
  holeRings: 0,
  multiPartBuildings: 0,
  exteriorCCWInSource: 0,
  exteriorCWInSource: 0,
  holeCCWInSource: 0,
  holeCWInSource: 0,
  noParcel: 0,
};
{
  const { x: ox, y: oy } = bManifest.origin;
  const ringS = new Int32Array(4096), ringN = new Int32Array(4096);
  const ringA = new Float64Array(4096);
  const ringHole = new Uint8Array(4096);
  for (let b = 0; b < BC; b++) {
    const r0 = bd.buildingRingIndex[b * 2], rc = bd.buildingRingIndex[b * 2 + 1];
    if (rc > ringS.length) throw new Error(`building ${b} has ${rc} rings`);
    // Load every ring; keep the non-degenerate ones.
    let at = 0, k = 0;
    for (let r = 0; r < rc; r++) {
      const vs = bd.ringIndex[(r0 + r) * 2], vc = bd.ringIndex[(r0 + r) * 2 + 1];
      const n = loadMercRing(bd.ringVertices, vs, vc, ox, oy, at);
      const a = n >= 3 ? signedArea(at, n) : 0;
      if (n < 3 || Math.abs(a) < MIN_RING_AREA_M2) {
        bStats.degenerateRings++;
        continue;
      }
      ringS[k] = at;
      ringN[k] = n;
      ringA[k] = a;
      at += n;
      k++;
    }
    // Exterior vs hole: the binary lists each polygon's rings (exterior then
    // holes) with no flag, and winding is not normalised, so classify by
    // nesting parity inside the building (odd depth = hole).
    for (let i = 0; i < k; i++) {
      let depth = 0;
      if (k > 1) {
        for (let j = 0; j < k; j++) {
          if (j === i || Math.abs(ringA[j]) <= Math.abs(ringA[i])) continue;
          if (scratchRingInside(ringS[i], ringN[i], ringS[j], ringN[j])) depth++;
        }
      }
      ringHole[i] = depth & 1;
    }
    const firstRing = nr;
    let sumA = 0, sx = 0, sy = 0, parts = 0;
    for (let i = 0; i < k; i++) {
      if (ringHole[i]) continue;
      if (ringA[i] > 0) bStats.exteriorCCWInSource++;
      else bStats.exteriorCWInSource++;
      emitScratchRing(bXY, nv, ringS[i], ringN[i], ringA[i] < 0);
      bRingOff[nr++] = nv;
      nv += ringN[i];
      const aa = Math.abs(ringA[i]);
      const [cx, cy] = ringCentroid(ringS[i], ringN[i], ringA[i]);
      sumA += aa;
      sx += cx * aa;
      sy += cy * aa;
      parts++;
    }
    if (parts === 0) {
      bStats.buildingsDropped++;
      continue;
    }
    if (parts > 1) bStats.multiPartBuildings++;
    bStats.exteriorRings += parts;
    for (let i = 0; i < k; i++) {
      if (!ringHole[i]) continue;
      if (ringA[i] > 0) bStats.holeCCWInSource++;
      else bStats.holeCWInSource++;
      emitScratchRing(hXY, nhv, ringS[i], ringN[i], ringA[i] > 0);
      hRingOff[nh] = nhv;
      hOwner[nh] = nb;
      nhv += ringN[i];
      nh++;
      bStats.holeRings++;
    }
    bRingStart[nb] = firstRing;
    bHeight[nb] = bd.height[b];
    bType[nb] = bd.buildingTypeCode[b];
    bCent[nb * 2] = sx / sumA;
    bCent[nb * 2 + 1] = sy / sumA;
    const pid = bd.parcelIDs[b];
    const row = pid > 0 && pid <= maxParcelId ? parcelRowById[pid] : -1;
    bParcel[nb] = row >= 0 ? row : NONE_U32;
    if (row < 0) bStats.noParcel++;
    bFloor[nb] = bd.floorspace[b];
    bSrcRow[nb] = b;
    nb++;
  }
  bRingStart[nb] = nr;
  bRingOff[nr] = nv;
  hRingOff[nh] = nhv;
}
log(`buildings: ${BC} -> ${nb} exported, ${nr} exterior rings, ${nh} hole rings`, bStats);

// Dwelling units total (stats only), over the source rows.
let dwellingUnits = 0;
for (let b = 0; b < BC; b++) if (Number.isFinite(bd.dwellingUnitsCount[b])) dwellingUnits += bd.dwellingUnitsCount[b];

// ---------------------------------------------------------------------------
// 4. Parcel attributes: built stock, zoning, land value, prices
// ---------------------------------------------------------------------------

log("parcels: attributes");
const pBuilt = new Float32Array(np);
const pFar = new Float32Array(np);
const pBMaxH = new Float32Array(np);
let buildingsWithoutFloorspace = 0;
for (let i = 0; i < nb; i++) {
  const row = bParcel[i];
  if (row === NONE_U32) continue;
  if (Number.isFinite(bFloor[i])) pBuilt[row] += bFloor[i];
  else buildingsWithoutFloorspace++;
  if (bHeight[i] > pBMaxH[row]) pBMaxH[row] = bHeight[i];
}
for (let i = 0; i < np; i++) pFar[i] = pArea[i] > 0 ? pBuilt[i] / pArea[i] : 0;

interface ZoningDTO {
  id: number;
  name: string;
  baseZone: string;
  use: string;
  maxHeight?: number | null;
  maximumCoverage?: number;
  floorAreaRatio?: number;
  allowedTypologies: string[];
}
const zonings = readGzJson<ZoningDTO[]>("zoning/zonings.json.gz");
if (zonings.length >= NONE_U16) throw new Error("too many zones for uint16");
const zoneRowById = new Map<number, number>();
zonings.forEach((z, k) => zoneRowById.set(z.id, k));
const pZone = new Uint16Array(np).fill(NONE_U16);
const pZMaxH = new Float32Array(np).fill(NaN);
const pZCov = new Float32Array(np).fill(NaN);
const pZFar = new Float32Array(np).fill(NaN);
const pZEnv = new Float32Array(np).fill(NaN);
let parcelsWithZone = 0;
for (const { parcelId, zoningId } of readGzJson<{ parcelId: number; zoningId: number }[]>("zoning/parcel_zoning.json.gz")) {
  const row = parcelId <= maxParcelId ? parcelRowById[parcelId] : -1;
  const zr = zoneRowById.get(zoningId);
  if (row < 0 || zr === undefined) continue;
  const z = zonings[zr];
  parcelsWithZone++;
  pZone[row] = zr;
  if (z.maxHeight != null) pZMaxH[row] = z.maxHeight;
  if (z.maximumCoverage != null) pZCov[row] = z.maximumCoverage;
  if (z.floorAreaRatio != null) pZFar[row] = z.floorAreaRatio;
  const area = pArea[row];
  if (z.allowedTypologies.length === 0) pZEnv[row] = 0;
  else if (z.floorAreaRatio != null) pZEnv[row] = z.floorAreaRatio * area;
  else if (z.maxHeight != null) pZEnv[row] = area * (z.maximumCoverage ?? 1) * Math.floor(z.maxHeight / STOREY_M + 1e-9);
}

const landValues = readGzJson<{ pricesYear: number; prices: Record<string, number> }>("real-estate/seeding-land-value-per-sqm.json.gz");
const pLand = new Float32Array(np).fill(NaN);
let parcelsWithLand = 0;
for (const [id, v] of Object.entries(landValues.prices)) {
  const row = Number(id) <= maxParcelId ? parcelRowById[Number(id)] : -1;
  if (row >= 0 && Number.isFinite(v)) {
    pLand[row] = v;
    parcelsWithLand++;
  }
}
// BuildingType.Apartment = 0, DwellingUnitSize.Medium = 1 (src/domain/building.ts).
const dwellingPrices = readGzJson<{ pricesYear: number; prices: Record<string, Record<string, Record<string, number>>> }>("real-estate/seeding-price-per-sqm.json.gz");
const pApt = new Float32Array(np).fill(NaN);
let parcelsWithApt = 0;
for (const [id, byType] of Object.entries(dwellingPrices.prices)) {
  const row = Number(id) <= maxParcelId ? parcelRowById[Number(id)] : -1;
  const v = byType?.["0"]?.["1"];
  if (row >= 0 && Number.isFinite(v)) {
    pApt[row] = v;
    parcelsWithApt++;
  }
}
log(`parcels: zone ${parcelsWithZone}, land value ${parcelsWithLand}, apartment price ${parcelsWithApt} of ${np}`);

// ---------------------------------------------------------------------------
// 5. Boundaries: study area, barrios
// ---------------------------------------------------------------------------

type GJ = { features: { properties: Record<string, unknown>; geometry: { type: string; coordinates: any } }[] };
const polygonsOf = (g: { type: string; coordinates: any }): number[][][][] =>
  g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];

function exportPolygonLayer(features: { geometry: { type: string; coordinates: any } }[]) {
  let total = 0;
  for (const f of features) for (const poly of polygonsOf(f.geometry)) for (const r of poly) total += r.length;
  const xy = new Float32Array(total * 2), off: number[] = [], owner: number[] = [];
  const hxy = new Float32Array(total * 2), hoff: number[] = [], howner: number[] = [];
  const holeAreas: number[] = [];
  const areas: number[] = [];
  let v = 0, hv = 0;
  features.forEach((f, fi) => {
    let area = 0;
    for (const poly of polygonsOf(f.geometry)) {
      poly.forEach((ring, ri) => {
        const n = loadLonLatRing(ring, 0);
        const a = n >= 3 ? signedArea(0, n) : 0;
        if (n < 3 || Math.abs(a) < MIN_RING_AREA_M2) return;
        if (ri === 0) {
          emitScratchRing(xy, v, 0, n, a < 0);
          off.push(v);
          owner.push(fi);
          v += n;
          area += Math.abs(a);
        } else {
          emitScratchRing(hxy, hv, 0, n, a > 0);
          hoff.push(hv);
          howner.push(fi);
          hv += n;
          area -= Math.abs(a);
          holeAreas.push(Math.abs(a));
        }
      });
    }
    areas.push(area);
  });
  off.push(v);
  hoff.push(hv);
  return { xy: xy.subarray(0, v * 2), off: Uint32Array.from(off), owner, hxy: hxy.subarray(0, hv * 2), hoff: Uint32Array.from(hoff), howner, holeAreas, areas };
}

log("boundaries");
const studyArea = readGzJson<GJ>("study-area.geojson.gz");
const sa = exportPolygonLayer(studyArea.features);
log(`study area: ${sa.off.length - 1} exterior rings, holes (m²): ${sa.holeAreas.map((a) => a.toFixed(1)).join(", ")}; area ${(sa.areas[0] / 1e6).toFixed(2)} km²`);

const barriosGj = readGzJson<GJ>("barrios.geojson.gz");
const ba = exportPolygonLayer(barriosGj.features);
const barrioLabels = new Map<string, [number, number]>();
{
  const poly = decodePolygonBinary(readGz("barrios.polygon.bin.gz"));
  const dec = new TextDecoder();
  for (let i = 0; i < poly.ids.length; i++) {
    const name = dec.decode(poly.captionData.subarray(poly.captionOffsets[i], poly.captionOffsets[i + 1]));
    const mx = poly.labelXY[i * 2], my = poly.labelXY[i * 2 + 1];
    const lon = (mx - 0.5) * 360, lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) / DEG;
    barrioLabels.set(name, [Math.round(lonToX(lon) * 10) / 10, Math.round(latToY(lat) * 10) / 10]);
  }
}
const barrios = barriosGj.features.map((f, i) => {
  const name = String(f.properties.nombre);
  return { index: i, name, comuna: Number(f.properties.comuna), label: barrioLabels.get(name) ?? null, areaKm2: Math.round(ba.areas[i] / 1e4) / 100 };
});
const missingLabels = barrios.filter((b) => !b.label).map((b) => b.name);
log(`barrios: ${barrios.length}, exterior rings ${ba.off.length - 1}, hole rings ${ba.hoff.length - 1}; labels missing: ${missingLabels.join(", ") || "none"}`);

// ---------------------------------------------------------------------------
// 6. Masks: buildings, parcels, sidewalk band, inside-the-city
// ---------------------------------------------------------------------------

const treesRaw = readGz("trees.bin.gz");
const tg = decodeRasterGrid(treesRaw, 0x54524744 /* 'TRGD' */);
if (!tg) throw new Error("trees.bin.gz did not decode as a TRGD grid");
const treesMeta = readJson<{ treeCount: number; cellM: number; source: string; builtAt: string }>("trees.meta.json");

log("masks: rasterising");
const BIT_BUILDING = 1, BIT_PARCEL = 2, BIT_D1 = 4, BIT_D2 = 8, BIT_CITY = 16;
const mask: Mask = (() => {
  // Union of the tree grid, the street nodes and the parcels, plus a margin.
  let x0 = lonToX(tg.minLng), y0 = latToY(tg.minLat);
  let x1 = lonToX(tg.minLng + tg.width * tg.stepLng), y1 = latToY(tg.minLat + tg.height * tg.stepLat);
  for (let i = 0; i < nodeCount; i++) {
    if (nodeX[i] < x0) x0 = nodeX[i];
    if (nodeX[i] > x1) x1 = nodeX[i];
    if (nodeY[i] < y0) y0 = nodeY[i];
    if (nodeY[i] > y1) y1 = nodeY[i];
  }
  const pb2 = bboxOf(pXY.subarray(0, npv * 2));
  x0 = Math.floor(Math.min(x0, pb2[0]) - 50);
  y0 = Math.floor(Math.min(y0, pb2[1]) - 50);
  x1 = Math.max(x1, pb2[2]) + 50;
  y1 = Math.max(y1, pb2[3]) + 50;
  const w = Math.ceil((x1 - x0) / MASK_CELL_M), h = Math.ceil((y1 - y0) / MASK_CELL_M);
  return { x0, y0, cs: MASK_CELL_M, w, h, data: new Uint8Array(w * h) };
})();
for (let r = 0; r < nr; r++) fillRing(mask, bXY, bRingOff[r], bRingOff[r + 1], BIT_BUILDING);
for (let p = 0; p < np; p++) fillRing(mask, pXY, pRingOff[p], pRingOff[p + 1], BIT_PARCEL);
for (let r = 0; r + 1 < sa.off.length; r++) fillRing(mask, sa.xy, sa.off[r], sa.off[r + 1], BIT_CITY);
{
  // Chebyshev dilation of the parcel bit by 1 and 2 cells (separable max filter).
  const { w, h, data } = mask;
  const tmp = new Uint8Array(w * h);
  for (let r = 0; r < h; r++) {
    const base = r * w;
    for (let c = 0; c < w; c++) {
      let d1 = 0, d2 = 0;
      for (let k = -2; k <= 2; k++) {
        const cc = c + k;
        if (cc < 0 || cc >= w || !(data[base + cc] & BIT_PARCEL)) continue;
        d2 = 2;
        if (k >= -1 && k <= 1) d1 = 1;
      }
      tmp[base + c] = d1 | d2;
    }
  }
  for (let r = 0; r < h; r++) {
    for (let k = -2; k <= 2; k++) {
      const rr = r + k;
      if (rr < 0 || rr >= h) continue;
      const src = rr * w, dst = r * w;
      const near = k >= -1 && k <= 1;
      for (let c = 0; c < w; c++) {
        const t = tmp[src + c];
        if (t === 0) continue;
        if (t & 2) data[dst + c] |= BIT_D2;
        if (t & 1 && near) data[dst + c] |= BIT_D1;
      }
    }
  }
}
log(`masks: ${mask.w} x ${mask.h} cells of ${MASK_CELL_M} m`);

// Street edges: inside-the-city flag (edge midpoint in the study area).
for (let e = 0; e < E; e++) {
  const mx = (nodeX[eA[e]] + nodeX[eB[e]]) / 2, my = (nodeY[eA[e]] + nodeY[eB[e]]) / 2;
  const m = maskAt(mask, mx, my);
  if (m > 0 && m & BIT_CITY) eFlags[e] |= 4;
}

// ---------------------------------------------------------------------------
// 7. Trees: cell counts (real) → one synthetic point per tree
// ---------------------------------------------------------------------------

log("trees: placing");
let cellCount = 0, treeTotal = 0;
for (let i = 0; i < tg.width * tg.height; i++) {
  if (tg.values[i] > 0) {
    cellCount++;
    treeTotal += tg.values[i];
  }
}
const tCellXY = new Float32Array(cellCount * 2);
const tCellCount = new Uint8Array(cellCount);
const tXY = new Float32Array(treeTotal * 2);
const placeClass = [0, 0, 0, 0];
{
  // mulberry32, seeded per cell so a re-run reproduces every position.
  let seed = 0;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const classOf = (x: number, y: number) => {
    const m = maskAt(mask, x, y);
    if (m < 0) return 1;
    if (m & BIT_BUILDING) return 3;
    if (m & BIT_PARCEL) return 2;
    if (m & BIT_D2 && !(m & BIT_D1)) return 0;
    return 1;
  };
  const MIN_SPACING2 = 3 * 3;
  const CANDIDATES = 32;
  let k = 0, t = 0;
  for (let cy = 0; cy < tg.height; cy++) {
    for (let cx = 0; cx < tg.width; cx++) {
      const count = tg.values[cy * tg.width + cx];
      if (count === 0) continue;
      const xa = lonToX(tg.minLng + cx * tg.stepLng), xb = lonToX(tg.minLng + (cx + 1) * tg.stepLng);
      const ya = latToY(tg.minLat + cy * tg.stepLat), yb = latToY(tg.minLat + (cy + 1) * tg.stepLat);
      tCellXY[k * 2] = (xa + xb) / 2;
      tCellXY[k * 2 + 1] = (ya + yb) / 2;
      tCellCount[k] = count;
      seed = Math.imul(cy * tg.width + cx + 1, 0x9e3779b1) ^ 0x1f123bb5;
      const first = t;
      for (let n = 0; n < count; n++) {
        let bestScore = Infinity, bx = 0, by = 0, bc = 0;
        for (let c = 0; c < CANDIDATES && bestScore > 0; c++) {
          const x = xa + rand() * (xb - xa), y = ya + rand() * (yb - ya);
          const cls = classOf(x, y);
          let crowded = 0;
          for (let q = first; q < t; q++) {
            const dx = tXY[q * 2] - x, dy = tXY[q * 2 + 1] - y;
            if (dx * dx + dy * dy < MIN_SPACING2) {
              crowded = 1;
              break;
            }
          }
          const score = cls * 2 + crowded;
          if (score < bestScore) {
            bestScore = score;
            bx = x;
            by = y;
            bc = cls;
          }
        }
        tXY[t * 2] = bx;
        tXY[t * 2 + 1] = by;
        placeClass[bc]++;
        t++;
      }
      k++;
    }
  }
}
log(`trees: ${treeTotal} trees in ${cellCount} cells; placed on sidewalk band ${placeClass[0]}, other public space ${placeClass[1]}, unbuilt parcel land ${placeClass[2]}, roofs (no free spot) ${placeClass[3]}`);

// ---------------------------------------------------------------------------
// 8. Subte lines and stations
// ---------------------------------------------------------------------------

log("subte");
const lineGj = readGzJson<GJ>("subte-lineas.geojson.gz");
const stationGj = readGzJson<GJ>("subte-estaciones.geojson.gz");
const lineParts: { line: number; xs: Float64Array; ys: Float64Array; len: number }[] = [];
const stationsByRoute = new Map<string, [number, number][]>();
for (const f of stationGj.features) {
  const [lon, lat] = f.geometry.coordinates as number[];
  const rid = f.properties.route_id as string;
  if (!stationsByRoute.has(rid)) stationsByRoute.set(rid, []);
  stationsByRoute.get(rid)!.push([lonToX(lon), latToY(lat)]);
}
const droppedSubteParts: string[] = [];
const subteLines = lineGj.features.map((f, li) => {
  const props = f.properties;
  const parts = (f.geometry.type === "LineString" ? [f.geometry.coordinates] : f.geometry.coordinates) as number[][][];
  const cand = parts.map((p) => {
    const xs = Float64Array.from(p, (c) => lonToX(c[0]));
    const ys = Float64Array.from(p, (c) => latToY(c[1]));
    let len = 0;
    for (let i = 1; i < xs.length; i++) len += Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
    return { line: li, xs, ys, len };
  });
  cand.sort((a, b) => b.len - a.len);
  const kept: typeof cand = [];
  const segDist = (px: number, py: number, q: (typeof cand)[number]) => {
    let best = Infinity;
    for (let i = 1; i < q.xs.length; i++) {
      const ax = q.xs[i - 1], ay = q.ys[i - 1], dx = q.xs[i] - ax, dy = q.ys[i] - ay;
      const l2 = dx * dx + dy * dy;
      const u = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
      best = Math.min(best, Math.hypot(px - ax - u * dx, py - ay - u * dy));
    }
    return best;
  };
  // A part must run along its own line: at least half of the line's stations
  // within 150 m. (The source attaches a copy of line E's track to line A.)
  const own = stationsByRoute.get(props.gtfs_route_id as string) ?? [];
  const supported = cand.filter((c) => {
    const near = own.filter(([sx, sy]) => segDist(sx, sy, c) < 150).length;
    if (own.length > 0 && near * 2 < own.length) {
      droppedSubteParts.push(`${props.name}: a ${Math.round(c.len)} m part passing only ${near} of its ${own.length} stations`);
      return false;
    }
    return true;
  });
  // Parts are per-direction/per-trip shapes of the same track: drop a part
  // when 90% of its vertices lie within 25 m of a longer kept part.
  for (const c of supported) {
    let near = 0;
    for (let i = 0; i < c.xs.length; i++) if (kept.some((q) => segDist(c.xs[i], c.ys[i], q) < 25)) near++;
    if (kept.length === 0 || near < 0.9 * c.xs.length) kept.push(c);
  }
  for (const k of kept) lineParts.push(k);
  const name = String(props.name);
  return {
    index: li,
    name,
    short: name.replace(/^Subte\s+/, "").replace(/^Premetro\s+/, ""),
    color: props.color ?? null,
    gtfsRouteId: props.gtfs_route_id ?? null,
    mode: props.mode ?? null,
    sourceParts: parts.length,
    polylines: [] as number[],
    lengthKm: Math.round(kept.reduce((s, q) => s + q.len, 0) / 10) / 100,
    stations: 0,
  };
});
const lvTotal = lineParts.reduce((s, q) => s + q.xs.length, 0);
const sLineXY = new Float32Array(lvTotal * 2);
const sLineOff = new Uint32Array(lineParts.length + 1);
const sLineLine = new Uint8Array(lineParts.length);
{
  let v = 0;
  lineParts.forEach((q, i) => {
    sLineOff[i] = v;
    sLineLine[i] = q.line;
    subteLines[q.line].polylines.push(i);
    for (let k = 0; k < q.xs.length; k++) {
      sLineXY[(v + k) * 2] = q.xs[k];
      sLineXY[(v + k) * 2 + 1] = q.ys[k];
    }
    v += q.xs.length;
  });
  sLineOff[lineParts.length] = v;
}
const lineByRoute = new Map(subteLines.map((l) => [l.gtfsRouteId, l.index]));
const S = stationGj.features.length;
const sStXY = new Float32Array(S * 2);
const sStLine = new Uint8Array(S);
const subteStations = stationGj.features.map((f, i) => {
  const [lon, lat] = f.geometry.coordinates as number[];
  sStXY[i * 2] = lonToX(lon);
  sStXY[i * 2 + 1] = latToY(lat);
  const line = lineByRoute.get(f.properties.route_id as string);
  if (line === undefined) throw new Error(`station ${f.properties.name}: unknown route ${f.properties.route_id}`);
  sStLine[i] = line;
  subteLines[line].stations++;
  return { index: i, name: String(f.properties.name), line, routeId: f.properties.route_id };
});
log(`subte: dropped ${droppedSubteParts.length} off-line part(s): ${droppedSubteParts.join("; ") || "none"}`);
log(`subte: ${subteLines.length} lines -> ${lineParts.length} polylines (from ${lineGj.features.reduce((s, f) => s + (f.geometry.coordinates as unknown[]).length, 0)} source parts), ${S} stations`);

// ---------------------------------------------------------------------------
// 9. Population and employment (counts for stats.json)
// ---------------------------------------------------------------------------

log("population / employment");
const pop = decodePopulationBinary(readGz("run-results/population2022.bin.gz"));
const emp = decodeEmploymentAssignmentBinary(readGz("run-results/employment-assignment2022.bin.gz"));
const empView = new DataView(readGz("run-results/employment-assignment2022.bin.gz"), 0, 16);
const employerRows = empView.getUint32(0x08, true);
let jobsInCity = 0, jobsVacant = 0, jobsResident = 0, jobsExternal = 0, outCommute = 0;
const jobParcels = new Set<number>();
for (let i = 0; i < emp.count; i++) {
  if (emp.sectors[i] === Sector.OutCommute) {
    outCommute++;
    continue;
  }
  jobsInCity++;
  jobParcels.add(emp.parcelIDs[i]);
  if (emp.fills[i] === EmploymentFill.Vacant) jobsVacant++;
  else if (emp.fills[i] === EmploymentFill.Resident) jobsResident++;
  else if (emp.fills[i] === EmploymentFill.External) jobsExternal++;
}
const controlTotals = readGzJson<{ scenarios: Record<string, Record<string, Record<string, number>>> }>("employment/employment-control-totals.json.gz");
const control2022 = Object.fromEntries(
  Object.entries(controlTotals.scenarios).map(([k, secs]) => [k, Object.values(secs).reduce((s, v) => s + (v["2022"] ?? 0), 0)]),
);

// ---------------------------------------------------------------------------
// 10. Write arrays
// ---------------------------------------------------------------------------

log("writing");
const f32xy = (x: Float64Array, y: Float64Array, n: number) => {
  const a = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    a[i * 2] = x[i];
    a[i * 2 + 1] = y[i];
  }
  return a;
};
const nodesXY = f32xy(nodeX, nodeY, nodeCount);
const edges = new Uint32Array(E * 2);
for (let e = 0; e < E; e++) {
  edges[e * 2] = eA[e];
  edges[e * 2 + 1] = eB[e];
}
writeArray("streets_nodes.f32", "streets", nodesXY, [nodeCount, 2], "Street graph node positions (x, y) in metres. Source vertices within 0.5 m were snapped to one node, so shared intersections are one node.");
writeArray("streets_edges.u32", "streets", edges, [E, 2], "Edge (a, b) node indices into streets_nodes. One straight segment between consecutive source vertices of a way. For one-way edges (flags bit0) traffic runs a -> b; two-way edges keep the source drawing order.");
writeArray("streets_edge_class.u8", "streets", eClass.subarray(0, E), [E], "Canonical street class code per edge (see layers.streets.classCodes; CityCompass StreetClass log codes).");
writeArray("streets_edge_osm.u8", "streets", eOsm.subarray(0, E), [E], "Raw OSM highway value per edge: index into layers.streets.osmClasses (0 = none).");
writeArray("streets_edge_length.f32", "streets", eLen.subarray(0, E), [E], "Edge length in metres (between the snapped nodes).");
writeArray("streets_edge_flags.u8", "streets", eFlags.subarray(0, E), [E], "Bit flags: bit0 (1) one-way a->b; bit1 (2) the street's name starts with 'Avenida'/'Av.' (a Buenos Aires avenue); bit2 (4) edge midpoint inside the city boundary (study area).");
writeArray("streets_edge_name.u16", "streets", eName.subarray(0, E), [E], "Street name per edge: index into streets_names.json (0 = unnamed).");
writeArray("streets_way_edges.u32", "streets", wayEdges, [st.streetCount + 1], "CSR over source ways (OSM-like street features, in streets.bin order): way w owns edges [o[w], o[w+1]), in drawing order. Useful to animate a street as one stroke.");
writeJson("streets_names.json", "streets", ["", ...st.names], "Street names; streets_edge_name indexes this array directly (entry 0 is the empty 'unnamed' name).");

writeArray("buildings_xy.f32", "buildings", bXY.subarray(0, nv * 2), [nv, 2], "Building exterior footprint ring vertices (x, y) in metres, all rings concatenated. Rings are open (no closing duplicate) and counter-clockwise.");
writeArray("buildings_ring_offsets.u32", "buildings", bRingOff.subarray(0, nr + 1), [nr + 1], "Ring r owns vertices [o[r], o[r+1]) of buildings_xy (vertex units, not float units).");
writeArray("buildings_ring_start.u32", "buildings", bRingStart.subarray(0, nb + 1), [nb + 1], "Building b owns exterior rings [s[b], s[b+1]) (most buildings have exactly one; multi-part footprints have several).");
writeArray("buildings_height.f32", "buildings", bHeight.subarray(0, nb), [nb], "Building height in metres (tejido-urbano photogrammetry 2021, max member volume).");
writeArray("buildings_type.u8", "buildings", bType.subarray(0, nb), [nb], "Building use/type code: index into layers.buildings.typeCodes (255 = none).");
writeArray("buildings_centroid.f32", "buildings", bCent.subarray(0, nb * 2), [nb, 2], "Area-weighted centroid (x, y) of the building's exterior rings, metres.");
writeArray("buildings_parcel.u32", "buildings", bParcel.subarray(0, nb), [nb], "Row index into the parcels_* arrays of the building's primary (centroid) parcel; 0xFFFFFFFF = no parcel.");
writeArray("buildings_floorspace.f32", "buildings", bFloor.subarray(0, nb), [nb], "Gross floor area in m² from the region binary (prism integral of the member volumes x storeys); NaN when unknown.");
writeArray("buildings_hole_xy.f32", "buildings", hXY.subarray(0, nhv * 2), [nhv, 2], "OPTIONAL: interior rings (light wells >= 5 m²) of building footprints, metres, open and clockwise.");
writeArray("buildings_hole_ring_offsets.u32", "buildings", hRingOff.subarray(0, nh + 1), [nh + 1], "OPTIONAL: hole ring h owns vertices [o[h], o[h+1]) of buildings_hole_xy.");
writeArray("buildings_hole_building.u32", "buildings", hOwner.subarray(0, nh), [nh], "OPTIONAL: building row that owns hole ring h.");

writeArray("parcels_xy.f32", "parcels", pXY.subarray(0, npv * 2), [npv, 2], "Parcel outline ring vertices (x, y) in metres; one ring per parcel, open and counter-clockwise.");
writeArray("parcels_ring_offsets.u32", "parcels", pRingOff.subarray(0, np + 1), [np + 1], "Parcel p owns vertices [o[p], o[p+1]) of parcels_xy.");
writeArray("parcels_id.u32", "parcels", pId.subarray(0, np), [np], "Source parcel id (the id in parcels.bin, zoning and price files; population/employment reference parcels by this id).");
writeArray("parcels_centroid.f32", "parcels", pCent.subarray(0, np * 2), [np, 2], "Area centroid (x, y) of the parcel ring, metres.");
writeArray("parcels_area.f32", "parcels", pArea.subarray(0, np), [np], "Parcel area in m² (from parcels.bin).");
writeArray("parcels_use.u8", "parcels", pUse.subarray(0, np), [np], "Land-use code: index into layers.parcels.useCodes (dominant ground-floor use, 2017 land-use survey).");
writeArray("parcels_built_floor_area.f32", "parcels", pBuilt, [np], "Existing built floor area in m²: sum of buildings_floorspace of the buildings whose primary parcel is this one (0 = no building).");
writeArray("parcels_built_far.f32", "parcels", pFar, [np], "Existing built FAR = parcels_built_floor_area / parcels_area.");
writeArray("parcels_building_max_height.f32", "parcels", pBMaxH, [np], "Height (m) of the tallest building on the parcel (0 = no building).");
writeArray("parcels_zone.u16", "parcels", pZone, [np], "Zone: index into parcels_zones.json (0xFFFF = no zone).");
writeArray("parcels_zone_max_height.f32", "parcels", pZMaxH, [np], "Zoning maximum height in metres (Código Urbanístico; 0 on non-developable classes; NaN = no zone).");
writeArray("parcels_zone_max_coverage.f32", "parcels", pZCov, [np], "Zoning maximum site coverage 0..1 (L.F.I. band variants); NaN when the zone states none, which CityCompass reads as full coverage.");
writeArray("parcels_zone_far.f32", "parcels", pZFar, [np], "Zoning floor-area ratio; NaN for all but the two special-law zones that state one.");
writeArray("parcels_zone_envelope_derived.f32", "parcels", pZEnv, [np], "DERIVED, not stored in the data: zoned floor-area envelope in m² = FAR x area when the zone states a FAR, else area x (max coverage, or 1) x floor(max height / 3 m); 0 on non-developable zones; NaN without zone. A simple envelope, not the CityCompass site-layout result (no setbacks or typology rules).");
writeArray("parcels_land_value.f32", "parcels", pLand, [np], "Land value, USD per m² of land, 2022 (real-estate/seeding-land-value-per-sqm: KNN of 2020 land offers, calibrated to Dec-2022).");
writeArray("parcels_apartment_price.f32", "parcels", pApt, [np], "Apartment asking price, USD per m² of floor, 2022, medium-size unit (real-estate/seeding-price-per-sqm); NaN when absent.");
writeJson("parcels_zones.json", "parcels", zonings.map((z, k) => ({ index: k, id: z.id, name: z.name, baseZone: z.baseZone, use: z.use, maxHeight: z.maxHeight ?? null, maximumCoverage: z.maximumCoverage ?? null, floorAreaRatio: z.floorAreaRatio ?? null, allowedTypologies: z.allowedTypologies })), "Zone table (zoning/zonings.json): parcels_zone indexes this array.");

writeArray("trees_xy.f32", "trees", tXY, [treeTotal, 2], "One point per censused tree (x, y) in metres. The COUNT per 20 m cell is real; the position inside the cell is SYNTHETIC (deterministic): preferring a 2-5 m band just outside the parcel line (the sidewalk), then other open public space, then unbuilt parcel land, never a roof unless the cell has no free spot. Trees of cell k are rows [sum(count[<k]), +count[k]).");
writeArray("trees_cell_xy.f32", "trees", tCellXY, [cellCount, 2], "Centre (x, y) of each occupied 20 m tree-census cell, metres (row-major, south to north).");
writeArray("trees_cell_count.u8", "trees", tCellCount, [cellCount], "Number of censused trees in each occupied cell (the real data).");

writeArray("subte_lines_xy.f32", "subte", sLineXY, [lvTotal, 2], "Subte / Premetro track polylines (x, y) in metres.");
writeArray("subte_lines_offsets.u32", "subte", sLineOff, [lineParts.length + 1], "Polyline k owns vertices [o[k], o[k+1]) of subte_lines_xy.");
writeArray("subte_lines_line.u8", "subte", sLineLine, [lineParts.length], "Line of polyline k: index into subte_lines.json.");
writeJson("subte_lines.json", "subte", subteLines, "Subte lines: name, short letter, colour as in the data (GTFS route colour), GTFS route id, polylines, length, station count.");
writeArray("subte_stations_xy.f32", "subte", sStXY, [S, 2], "Station positions (x, y) in metres; one row per station-line (a transfer complex appears once per line).");
writeArray("subte_stations_line.u8", "subte", sStLine, [S], "Line of station row i: index into subte_lines.json.");
writeJson("subte_stations.json", "subte", subteStations, "Station names aligned with subte_stations_xy rows.");

writeArray("boundary_xy.f32", "boundary", sa.xy, [sa.xy.length / 2, 2], "City boundary (study area = CABA perimeter) exterior rings (x, y) in metres, open and counter-clockwise.");
writeArray("boundary_ring_offsets.u32", "boundary", sa.off, [sa.off.length], "Boundary ring r owns vertices [o[r], o[r+1]) of boundary_xy.");
writeArray("barrios_xy.f32", "barrios", ba.xy, [ba.xy.length / 2, 2], "Barrio (neighbourhood) exterior rings (x, y) in metres, open and counter-clockwise.");
writeArray("barrios_ring_offsets.u32", "barrios", ba.off, [ba.off.length], "Barrio ring r owns vertices [o[r], o[r+1]) of barrios_xy.");
writeArray("barrios_ring_barrio.u8", "barrios", Uint8Array.from(ba.owner), [ba.owner.length], "Barrio of ring r: index into barrios.json.");
writeArray("barrios_hole_xy.f32", "barrios", ba.hxy, [ba.hxy.length / 2, 2], "Barrio interior rings (Puerto Madero's dock basins), metres, clockwise.");
writeArray("barrios_hole_ring_offsets.u32", "barrios", ba.hoff, [ba.hoff.length], "Hole ring h owns vertices [o[h], o[h+1]) of barrios_hole_xy.");
writeArray("barrios_hole_barrio.u8", "barrios", Uint8Array.from(ba.howner), [ba.howner.length], "Barrio of hole ring h: index into barrios.json.");
writeJson("barrios.json", "barrios", barrios, "Barrios: name (as published, accents dropped by the source), comuna, label anchor (x, y) = the repo's pole-of-inaccessibility from barrios.polygon.bin, area km².");

// ---------------------------------------------------------------------------
// 11. Stats, layer summaries, manifest
// ---------------------------------------------------------------------------

const km = (m: number) => Math.round(m / 100) / 10;
const kmByClass: Record<string, number> = {};
const kmByClassInCity: Record<string, number> = {};
let totalM = 0, inCityM = 0, vehicularM = 0, vehicularInCityM = 0;
const VEHICULAR = new Set([1, 2, 3, 4, 5, 6]);
for (let e = 0; e < E; e++) {
  const name = STREET_CLASS_LOG_CODES[eClass[e]] ?? "unknown";
  kmByClass[name] = (kmByClass[name] ?? 0) + eLen[e];
  totalM += eLen[e];
  if (VEHICULAR.has(eClass[e])) vehicularM += eLen[e];
  if (eFlags[e] & 4) {
    kmByClassInCity[name] = (kmByClassInCity[name] ?? 0) + eLen[e];
    inCityM += eLen[e];
    if (VEHICULAR.has(eClass[e])) vehicularInCityM += eLen[e];
  }
}
for (const k of Object.keys(kmByClass)) kmByClass[k] = km(kmByClass[k]);
for (const k of Object.keys(kmByClassInCity)) kmByClassInCity[k] = km(kmByClassInCity[k]);

const heightQ = quantiles(bHeight.subarray(0, nb));
const typeNames = bd.buildingTypeNames;
const TYPE_EN: Record<string, string> = {
  apartment: "apartment building",
  terrace: "attached low-rise housing (model 'terrace' typology)",
  "comercio y servicios": "commerce and services",
  house: "house",
  industria: "industry",
  gastronomía: "food and drink",
  school: "school",
  depósito: "warehouse / storage",
  sport_center: "sports centre",
  green_areas: "green area structure",
  oficinas: "offices",
  "en obra": "under construction",
  hospital: "hospital",
  baldío: "vacant lot",
  garage: "garage / parking",
  "cultura y culto": "culture and worship",
  abandonado: "abandoned",
  "sin datos": "no data",
  hotelería: "hotel",
};
const USE_EN: Record<string, string> = {
  "Comercio y servicios": "commerce and services",
  "Sin datos": "no data",
  Salud: "health",
  Residencial: "residential",
  Industria: "industry",
  Garage: "garage / parking",
  Gastronomía: "food and drink",
  green_areas: "green areas",
  Depósito: "warehouse / storage",
  "Cultura y culto": "culture and worship",
  Oficinas: "offices",
  "En obra": "under construction",
  Baldío: "vacant lot",
  Educación: "education",
  Deportivo: "sports",
  Abandonado: "abandoned",
  Hotelería: "hotels",
};
const countCodes = (codes: Uint8Array, n: number) => {
  const c = new Map<number, number>();
  for (let i = 0; i < n; i++) c.set(codes[i], (c.get(codes[i]) ?? 0) + 1);
  return c;
};
const bTypeCounts = countCodes(bType, nb);
const pUseCounts = countCodes(pUse, np);
const edgeClassCounts = countCodes(eClass, E);
const CLASS_NOTES: Record<string, string> = {
  motorway: "autopistas (OSM motorway, motorway_link)",
  trunk: "trunk roads (trunk, trunk_link)",
  primary: "primary roads, most major avenues (primary, primary_link)",
  secondary: "secondary roads, avenues (secondary, secondary_link)",
  tertiary: "tertiary roads (tertiary, tertiary_link)",
  residential: "local streets (residential, unclassified, living_street, road)",
  service: "service ways (service, track, busway)",
  footway: "walkways, not streets (footway, path, steps, bridleway, corridor, platform)",
  cycleway: "cycle paths",
  rail: "rail",
  waterway: "waterway",
  non_road: "construction / proposed",
  pedestrian_street: "car-free streets (OSM pedestrian), e.g. Florida, Lavalle",
};

const stats = {
  region: "Ciudad Autónoma de Buenos Aires (CityCompass region 'buenosaires')",
  baseYear: 2022,
  generatedAt: new Date().toISOString(),
  sourceCommit: gitCommit,
  numbers: {
    parcels: {
      value: np,
      source: `${SRC_REL}/parcels.bin.gz (parcelCount ${PC})`,
      note: "Cadastral parcels, BA Data 'parcelas' (catastro 2026-07 vintage) as cleaned by the region pipeline.",
    },
    buildings: {
      value: nb,
      source: `${SRC_REL}/buildings.bin.manifest.json + buildings.bin.*.gz (buildingCount ${BC})`,
      note: "Footprints from BA Data 'tejido-urbano' photogrammetry, 2021 vintage (post-2021 construction absent); volumes clustered per parcel, plus informal-settlement houses.",
    },
    streetKm: {
      value: km(vehicularInCityM),
      unit: "km",
      definition: "Centre-line length of vehicular ways (motorway..residential) whose segment midpoint lies inside the city boundary. Dual carriageways count once per carriageway.",
      source: `${SRC_REL}/streets.bin.gz (OSM-derived seed street network), summed straight segments; boundary from study-area.geojson.gz`,
      alternatives: {
        vehicularAllWays: km(vehicularM),
        allWaysInCity: km(inCityM),
        allWaysIncludingBeyondBoundary: km(totalM),
      },
    },
    trees: {
      value: treesMeta.treeCount,
      source: `${SRC_REL}/trees.meta.json (treeCount); equals the sum of the trees.bin.gz 20 m grid (${treeTotal})`,
      note: "Official GCBA census: street trees 2017-2018 (354,835) + trees in green spaces (51,489).",
    },
    subteStations: {
      value: subteLines.filter((l) => !String(l.name).startsWith("Premetro")).reduce((s, l) => s + l.stations, 0),
      definition: "Station-line entries on Subte lines A, B, C, D, E, H (a transfer complex counts once per line).",
      withPremetro: S,
      uniqueNames: new Set(subteStations.map((s) => s.name)).size,
      source: `${SRC_REL}/subte-estaciones.geojson.gz`,
    },
    persons: {
      value: pop.personSOA.count,
      source: `${SRC_REL}/run-results/population2022.bin.gz (synthetic population; totals equal INDEC Censo 2022)`,
    },
    households: {
      value: pop.householdSOA.count,
      source: `${SRC_REL}/run-results/population2022.bin.gz (equals INDEC Censo 2022)`,
    },
    jobs: {
      value: jobsInCity,
      definition: "Job slots located in the city in the base-year seed (ISIC sections A-U), filled or vacant.",
      source: `${SRC_REL}/run-results/employment-assignment2022.bin.gz`,
      breakdown: { filledByResidents: jobsResident, inCommuterSlots: jobsVacant, filledExternal: jobsExternal, onParcels: jobParcels.size, residentsWorkingOutsideCity: outCommute, rowsInFile: emp.count },
      breakdownNote: "inCommuterSlots are stored vacant in the seed; their count equals the model's in-commuter count, jobs - round((1 - inCommuteShare) x jobs) with inCommuteShare 0.3711 (employment/matching-config.json, src/domain/employment/commute.ts). residentsWorkingOutsideCity are OutCommute rows, not jobs in the city.",
      observedWorkplaceJobs2022: {
        value: control2022.medium,
        source: `${SRC_REL}/employment/employment-control-totals.json.gz, scenario 'medium', year 2022, summed over sectors (IDECBA/EPH 'puestos de trabajo ocupados', observed)`,
        scenarioEnvelope: control2022,
      },
    },
    firms: {
      value: null,
      reason: `Not in the data: the base-year employment seed carries ${employerRows} employer rows. CityCompass creates employers synthetically at run time (target ~12 jobs per employer, employment/employment-parameters.json.gz), so any firm count would be a model artefact, not a real number.`,
    },
    dwellings: {
      value: Math.round(dwellingUnits),
      source: `${SRC_REL}/buildings.bin.* dwellingUnitsCount, summed`,
      note: "Census-anchored: each census radio's INDEC 2022 dwellings spread over its residential buildings by floor area (docs/buenosaires.md, 'Dwelling units').",
    },
  },
};
writeFileSync(path.join(OUT, "stats.json"), JSON.stringify(stats, null, 2));

const layers = {
  streets: {
    counts: { ways: st.streetCount, sourceVertices: pointCount, nodes: nodeCount, edges: E, duplicateSegmentsMerged: dupEdges, zeroLengthSegmentsDropped: zeroEdges, oneWayEdges: [...eFlags.subarray(0, E)].filter((f) => f & 1).length, avenueEdges: [...eFlags.subarray(0, E)].filter((f) => f & 2).length },
    bbox: bboxOf(nodesXY),
    km: { total: km(totalM), insideCity: km(inCityM), vehicularInsideCity: km(vehicularInCityM), byClass: kmByClass, byClassInsideCity: kmByClassInCity },
    classCodes: STREET_CLASS_LOG_CODES.map((c, i) => ({ code: i, class: c ?? "unknown", meaning: c ? CLASS_NOTES[c] ?? c : "no class in the source", edges: edgeClassCounts.get(i) ?? 0 })).filter((c) => c.code === 0 || c.edges > 0),
    osmClasses: ["", ...st.classNames],
    notes: [
      "Source: streets.bin.gz, OSM-derived (highway tag), includes the far side of Av. General Paz and a few ways just beyond the city limit; use flags bit2 to keep only edges inside the boundary.",
      "Class code order is the CityCompass canonical StreetClass log-code table (src/domain/streets/streetClass.ts): 1 is most major; 13 (car-free street) is out of sequence.",
      `Widths are absent for ${Math.round((100 * [...st.widths].filter(Number.isNaN).length) / st.streetCount)}% of ways in the source, so none are exported.`,
      `${backwardWays} source ways are tagged oneway=-1; their edges were flipped so every one-way edge points a -> b.`,
    ],
  },
  buildings: {
    counts: { source: BC, exported: nb, exteriorRings: nr, vertices: nv, holeRings: nh, ...bStats, floorspaceUnknown: [...bFloor.subarray(0, nb)].filter(Number.isNaN).length, floorspaceUnknownOnLinkedParcel: buildingsWithoutFloorspace },
    bbox: bboxOf(bXY.subarray(0, nv * 2)),
    heightM: heightQ,
    typeCodes: typeNames.map((n, i) => ({ code: i, name: n, meaning: TYPE_EN[n] ?? n, buildings: bTypeCounts.get(i) ?? 0 })),
    notes: [
      "Height is known for every building (min 3 m, the pipeline floor; capped at 250 m at source). The data has no storey count: the source 'altos' field is empty, and the pipeline itself uses storeys = ceil(height / 3 m). No floors array is exported.",
      "Exterior vs hole was classified by nesting parity inside each building because the binary does not flag holes and its winding is inconsistent (4% of single-ring buildings are wound the other way). Holes (light wells) are exported separately and are optional.",
      "noParcel buildings (parcel 0 in the source) include every building with unknown floorspace: schools, sports centres and hospitals added from point data.",
      "Degenerate rings (<3 distinct vertices or |area| < 0.01 m²) and duplicate consecutive vertices (< 1 mm) were removed; nothing else was simplified. The committed binary already dropped holes < 5 m² (2026-09-23 re-simplification).",
    ],
  },
  parcels: {
    counts: { source: PC, exported: np, withZone: parcelsWithZone, withLandValue: parcelsWithLand, withApartmentPrice: parcelsWithApt, withBuildings: [...pBuilt].filter((v) => v > 0).length },
    bbox: bboxOf(pXY.subarray(0, npv * 2)),
    areaM2: quantiles(pArea.subarray(0, np)),
    landValueUsdPerM2: quantiles(pLand.filter(Number.isFinite)),
    apartmentPriceUsdPerM2: quantiles(pApt.filter(Number.isFinite)),
    useCodes: pb.useNames.map((n, i) => ({ code: i, name: n, meaning: USE_EN[n] ?? n, parcels: pUseCounts.get(i) ?? 0 })),
    notes: [
      "Zoning is the Código Urbanístico as of 31-Dec-2024 (maxHeight = the legal height; APH/U/AE districts use a fallback height = p75 of built stock). FAR is stated only by two special-law zones; 'capacity' is not stored anywhere, so parcels_zone_envelope_derived is computed here (formula in its file entry).",
      "Prices are 2022 USD asking-price surfaces from 2020 offers calibrated to Dec-2022; apartments are the base series, house/terrace are ratio copies and are not exported.",
      "The use code is the dominant ground-floor use from the 2017 land-use survey; 'Sin datos' (no data) is the second-largest class.",
    ],
  },
  trees: {
    counts: { trees: treeTotal, occupiedCells: cellCount, placedOnSidewalkBand: placeClass[0], placedOnOtherPublicSpace: placeClass[1], placedOnUnbuiltParcelLand: placeClass[2], placedOnRoofNoFreeSpot: placeClass[3] },
    bbox: bboxOf(tXY),
    grid: { cellMetres: treesMeta.cellM, width: tg.width, height: tg.height, minLng: tg.minLng, minLat: tg.minLat, stepLng: tg.stepLng, stepLat: tg.stepLat },
    notes: [
      `trees.bin.gz stores only a count per ~20 m cell (max ${tCellCount.reduce((m, v) => (v > m ? v : m), 0)} in one cell, where the census geocoded many trees to one address point). The census height and diameter are NOT in the committed data, so no height or canopy radius is exported.`,
      "trees_xy positions inside each cell are synthetic (seeded per cell, reproducible), see the file entry. Use trees_cell_xy + trees_cell_count for the exact data.",
      `Source: ${treesMeta.source}`,
    ],
  },
  subte: {
    counts: { lines: subteLines.length, polylines: lineParts.length, stations: S },
    bbox: bboxOf(sLineXY),
    notes: [
      "Colours are the dataset's GTFS route colours (A #A5C8FF, B #FF0000, C #0000FF, D #00AC67, E #8300BB, H #FFF300, Premetro #FFBD33), not an official brand palette.",
      "Each source line carries one shape per direction/trip pattern; parts that retrace a longer kept part (90% of vertices within 25 m) were dropped, leaving one polyline per track.",
      `Source defect handled: a part must pass within 150 m of at least half of its own line's stations. Dropped: ${droppedSubteParts.join("; ") || "none"} (subte-lineas.geojson.gz gives line A an exact copy of line E's track).`,
    ],
  },
  boundary: {
    counts: { exteriorRings: sa.off.length - 1, vertices: sa.xy.length / 2, droppedHoleAreasM2: sa.holeAreas.map((a) => Math.round(a * 10) / 10) },
    bbox: bboxOf(sa.xy),
    areaKm2: Math.round(sa.areas.reduce((s, a) => s + a, 0) / 1e4) / 100,
    notes: ["study-area.geojson.gz (BA Data 'perimetro'). Its two interior rings are tiny slivers and are not exported."],
  },
  barrios: {
    counts: { barrios: barrios.length, exteriorRings: ba.off.length - 1, holeRings: ba.hoff.length - 1 },
    bbox: bboxOf(ba.xy),
  },
};

const manifest = {
  name: "Buenos Aires film data",
  generatedAt: new Date().toISOString(),
  generator: ".scratch/urbanly-film/data/export-ba.ts",
  rerun: "npx vite-node .scratch/urbanly-film/data/export-ba.ts   (from the repo root)",
  source: { region: "buenosaires", directory: SRC_REL, gitCommit, uncommittedChangesInSource: gitDirty === "" ? false : gitDirty },
  projection: {
    kind: "local equirectangular",
    lon0: LON0,
    lat0: LAT0,
    R: R_EARTH,
    x: "R*(lon-lon0)*(pi/180)*cos(lat0*pi/180)  (east, metres)",
    y: "R*(lat-lat0)*(pi/180)  (north, metres)",
    origin: "Plaza de Mayo",
    note: "Buildings and parcels are stored as origin-relative normalised Web Mercator in the binaries and were converted mercator -> lon/lat -> metres in float64; streets, trees and GeoJSON layers are lon/lat at source.",
  },
  conventions: {
    endianness: "little",
    oneArrayPerFile: true,
    fileExtensions: { ".f32": "Float32Array", ".u32": "Uint32Array", ".u16": "Uint16Array", ".u8": "Uint8Array", ".json": "UTF-8 JSON" },
    shape: "shape [n, 2] means n interleaved (x, y) pairs; count is the number of typed-array elements",
    rings: "A ring is a run of vertices in an *_xy array; *_ring_offsets has (rings + 1) entries in VERTEX units: ring r = vertices [o[r], o[r+1]). Rings are open (the first vertex is not repeated). Exterior rings are counter-clockwise (positive area with x east / y north), holes clockwise.",
    missing: "Float NaN = unknown; 0xFFFFFFFF (u32) / 0xFFFF (u16) / 255 (u8 codes) = none",
    load: "const a = new Float32Array(await (await fetch('ba/buildings_xy.f32')).arrayBuffer())",
  },
  layers,
  files,
  totalBytes: files.reduce((s, f) => s + f.bytes, 0),
};
writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));

log(`done: ${files.length} files, ${(manifest.totalBytes / 1e6).toFixed(1)} MB`);
console.log(JSON.stringify({ streetKm: layers.streets.km, heights: heightQ, stats: stats.numbers }, null, 2));
