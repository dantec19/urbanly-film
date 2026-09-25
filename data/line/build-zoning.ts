// The transit-oriented upzone that travels with the film's new line.
//
//   yarn vite-node .scratch/urbanly-film/data/line/build-zoning.ts   (repo root)
//
// Reads line.json (stations) and the region through the CLI's own loaders
// (parcels, base zoning, polygon fences), so it sees exactly the parcel ids and
// zones a `yarn simulate` run sees. Writes, next to this file:
//   zoning-scenario.json   the `--zoning-scenario-file` input
//   zoning-summary.json    what the upzone selects and what it leaves alone
//
// The policy: from START_YEAR, every parcel whose centroid is within
// RADIUS_M of a new station, and whose base zone is one of the Código
// Urbanístico's standard height classes below the corridor's height (USAB,
// USAM, USAA, CM), may build to CORRIDOR_HEIGHT_M, the Corredor Alto height,
// the tallest standard height already allowed along the line's avenues. Only
// maxHeight changes; every other field (LFI coverage, typologies) is the base
// zone's. Left alone: CA (already 38 m); APH (heritage), U and AE (special
// plans whose height is the built stock's, not a legal limit); ND (not
// developable); parcels inside the barrios populares or the grandes-proyectos
// sites (the market developers are fenced out of both). No land-value capture.
// One update per station, each parcel assigned to its nearest station.
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { decodePolygonBinary } from "@shared/polygon-gl/PolygonGLBinary";

import { loadParcels, loadZonings } from "../../../../cli/src/data/cli-loader.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = "public/buenosaires";
const START_YEAR = 2023;
const RADIUS_M = 500;
const CORRIDOR_HEIGHT_M = 38;
const ELIGIBLE = new Set(["USAB", "USAM", "USAA", "CM"]);
const FENCES = ["barrios-populares", "grandes-proyectos"];

interface Station {
  x: number;
  y: number;
  name: string;
}
const line = JSON.parse(readFileSync(path.join(HERE, "line.json"), "utf8")) as {
  origin: { lon0: number; lat0: number; R: number };
  stations: Station[];
};
const { lon0, lat0, R } = line.origin;
const DEG = Math.PI / 180;
const kx = R * DEG * Math.cos(lat0 * DEG);
const ky = R * DEG;

const { parcels } = await loadParcels(DATA_PATH);
const zoning = await loadZonings(DATA_PATH, 2022, 2031, parcels);
const yearRow = START_YEAR - zoning.startYear;
const zoneOffset = yearRow * zoning.parcelIDs.length;
const zoneRowOf = new Map<number, number>();
for (let r = 0; r < zoning.parcelIDs.length; r++) zoneRowOf.set(zoning.parcelIDs[r], r);

const fenced = new Set<number>();
for (const layer of FENCES) {
  const raw = gunzipSync(readFileSync(path.join(DATA_PATH, `${layer}.polygon.bin.gz`)));
  const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
  for (const id of decodePolygonBinary(buf).containedParcelIds) fenced.add(id);
}

const family = (baseZone: string): string => baseZone.replace(/\d.*$/, "").replace(/-$/, "");

const byStation: number[][] = line.stations.map(() => []);
const selectedByFamily: Record<string, number> = {};
const leftAlone: Record<string, number> = {};
const storeysBefore: Record<string, number> = {};
let inCatchment = 0;
for (let i = 0; i < parcels.ids.length; i++) {
  const x = (parcels.lng[i] - lon0) * kx;
  const y = (parcels.lat[i] - lat0) * ky;
  let nearest = -1;
  let nearestD = Infinity;
  for (let s = 0; s < line.stations.length; s++) {
    const d = Math.hypot(x - line.stations[s].x, y - line.stations[s].y);
    if (d < nearestD) {
      nearestD = d;
      nearest = s;
    }
  }
  if (nearestD > RADIUS_M) continue;
  inCatchment++;
  const id = parcels.ids[i];
  const row = zoneRowOf.get(id);
  const zone = row === undefined ? undefined : zoning.zones[zoning.zoneIDs[zoneOffset + row]];
  const why = (reason: string) => {
    leftAlone[reason] = (leftAlone[reason] ?? 0) + 1;
  };
  if (!zone) {
    why("no zone");
    continue;
  }
  const fam = family(zone.baseZone);
  if (fenced.has(id)) {
    why("inside barrios populares / grandes proyectos");
    continue;
  }
  if (!ELIGIBLE.has(fam)) {
    why(`${fam} (${fam === "CA" ? "already 38 m" : "special regime"})`);
    continue;
  }
  if (zone.maxHeight == null || !(zone.maxHeight < CORRIDOR_HEIGHT_M)) {
    why(`${fam} at or above ${CORRIDOR_HEIGHT_M} m`);
    continue;
  }
  byStation[nearest].push(id);
  const k = `${fam} ${zone.maxHeight} m`;
  selectedByFamily[k] = (selectedByFamily[k] ?? 0) + 1;
  const st = String(Math.floor(zone.maxHeight / 3));
  storeysBefore[st] = (storeysBefore[st] ?? 0) + 1;
}

const updates = line.stations
  .map((s, i) => ({
    name: `TOD ${RADIUS_M} m: ${s.name}`,
    startYear: START_YEAR,
    maxHeight: CORRIDOR_HEIGHT_M,
    parcelIDs: byStation[i].sort((a, b) => a - b),
  }))
  .filter((u) => u.parcelIDs.length > 0);
writeFileSync(path.join(HERE, "zoning-scenario.json"), JSON.stringify({ updates }, null, 0));

const total = updates.reduce((n, u) => n + u.parcelIDs.length, 0);
const summary = {
  description:
    `Transit-oriented upzone for the film's new line (line.json): from ${START_YEAR}, parcels whose centroid is within ${RADIUS_M} m of a new station and whose base zone is a standard Código Urbanístico height class below ${CORRIDOR_HEIGHT_M} m (USAB, USAM, USAA, CM) get maxHeight ${CORRIDOR_HEIGHT_M} m (the Corredor Alto height, the tallest standard height along the line's avenues). Only maxHeight changes. No land-value capture. Built by build-zoning.ts from the CLI's own loaders (base zoning of ${START_YEAR}).`,
  startYear: START_YEAR,
  radiusM: RADIUS_M,
  maxHeightM: CORRIDOR_HEIGHT_M,
  parcelsWithin500m: inCatchment,
  parcelsUpzoned: total,
  upzonedByBaseZone: selectedByFamily,
  upzonedByStoreysAllowedBefore: storeysBefore,
  storeysAllowedAfter: Math.floor(CORRIDOR_HEIGHT_M / 3),
  leftAlone,
  perStation: updates.map((u) => ({ station: u.name.replace(/^TOD \d+ m: /, ""), parcels: u.parcelIDs.length })),
};
writeFileSync(path.join(HERE, "zoning-summary.json"), JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary, null, 1));
