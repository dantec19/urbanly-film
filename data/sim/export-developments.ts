// Export what a land-use run built, year by year, for the promo film.
//
//   yarn vite-node .scratch/urbanly-film/data/sim/export-developments.ts \
//     --run-dir .scratch/urbanly-film/data/sim/runs/<tag> \
//     --data-path public/buenosaires \
//     --out-dir .scratch/urbanly-film/data/sim \
//     [--lon0 -58.3722 --lat0 -34.6083]
//
// Reads <run-dir>/run.ccsr (the `yarn simulate --export-run` file) through
// the same CityContext read path the simulate command uses
// (buildCliCityContext + iterateCreated / iterateDemolished), plus the run's
// own run-summary.json and demographic-flows.json. Writes
// <out-dir>/<region>-developments.json and <out-dir>/<region>-totals.json.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";

import { BuildingOrigin } from "@domain/building";
import {
  composeEmploymentLogs,
  EmploymentQueryServiceImpl,
} from "@domain/city-context/employmentQueryServiceImpl";
import { EmploymentTxSoA } from "@domain/city-context/employmentTxSoA";
import { ParcelsQueryServiceImpl } from "@domain/city-context/parcelsQueryServiceImpl";
import { SECTOR_COUNT } from "@domain/employment/sector";
import { enrichSeedTypology } from "@domain/land-use-simulation/seedTypologyEnrichment";
import { BUILDING_TYPE_NAMES } from "@domain/land-use-simulation/transactions";
import { renumberLegacyRunPopulationIDs } from "@domain/simulation-output/legacyRunPopulationIDs";
import { populationRunProductFromDecoded } from "@domain/simulation-output/populationRunSections";
import { decodeSimulationRun } from "@shared/simulation-run-binary/decode";
import type { Geometry, Position } from "geojson";

import {
  buildCliCityContext,
  iterateCreated,
  iterateDemolished,
} from "../../../../cli/src/city-context/cliCityContext.ts";
import {
  loadParcelIdIndex,
  loadParcelRings,
  loadParcels,
  loadSeedBuildingColumns,
} from "../../../../cli/src/data/cli-loader.ts";
import { rebuildBuildingLog } from "../../../../src/main/runs/rebuildBuildingLog.ts";
import { rebuildEmploymentLogWire } from "../../../../src/main/runs/rebuildEmploymentLog.ts";
import { rebuildInitialStateSnapshot } from "../../../../src/main/runs/rebuildInitialState.ts";
import { bootstrapDeterministicMath } from "../../../../src/wasm/deterministic-math/bootstrap.ts";

const { values: args } = parseArgs({
  options: {
    "run-dir": { type: "string" },
    "data-path": { type: "string" },
    "out-dir": { type: "string" },
    lon0: { type: "string" },
    lat0: { type: "string" },
    "storey-height": { type: "string", default: "3" },
  },
});
if (!args["run-dir"] || !args["data-path"] || !args["out-dir"]) {
  throw new Error(
    "usage: export-developments.ts --run-dir <dir> --data-path public/<region> --out-dir <dir> [--lon0 x --lat0 y]",
  );
}
const runDir = args["run-dir"];
const dataPath = args["data-path"];
const outDir = args["out-dir"];

await bootstrapDeterministicMath();

// --- The run ------------------------------------------------------------------
const bytes = readFileSync(join(runDir, "run.ccsr"));
const raw = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
const container = new ArrayBuffer(raw.byteLength);
new Uint8Array(container).set(raw);
const decoded = decodeSimulationRun(container);
renumberLegacyRunPopulationIDs(decoded);
const { startYear, endYear } = decoded.metadata;
const region = (decoded.metadata as { regionName?: string }).regionName ??
  dataPath.replace(/\/+$/, "").split("/").pop()!;
const runSummary = JSON.parse(readFileSync(join(runDir, "run-summary.json"), "utf8"));
const flows = JSON.parse(readFileSync(join(runDir, "demographic-flows.json"), "utf8")) as Array<{
  year: number;
  populationAtEnd: number;
  householdsAtEnd: number;
  unassignedAtEnd: number;
  births: number;
  deaths: number;
  immigrantPersons: number;
  emigrantPersons: number;
}>;
const seed: number = runSummary.seed;
console.log(`[export] ${region} ${startYear}-${endYear} seed ${seed}`);

const { buildingLog, dwellingLog } = rebuildBuildingLog(decoded);
if (!buildingLog || !dwellingLog) throw new Error("run file carries no building/dwelling log");
const seedCols = await loadSeedBuildingColumns(dataPath, startYear, Number(args["storey-height"]));
// The seed rows' typology is derived from the households linked to each
// building, as the simulate loader does; the run file carries the population
// the run started from.
const population = populationRunProductFromDecoded(decoded);
if (!population) throw new Error("run file carries no population");
enrichSeedTypology(seedCols, population.seedSOA.householdSOA.buildingIDs);
const ctx = buildCliCityContext(seedCols, buildingLog, dwellingLog, startYear, 1);

// --- Local metres ----------------------------------------------------------------
// Origin: given, else the centroid of the study area's parcel centroids.
const { parcels, useCode, useNames } = await loadParcels(dataPath);
let lon0: number;
let lat0: number;
if (args.lon0 !== undefined && args.lat0 !== undefined) {
  lon0 = Number(args.lon0);
  lat0 = Number(args.lat0);
} else {
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < parcels.ids.length; i++) {
    sx += parcels.lng[i];
    sy += parcels.lat[i];
  }
  lon0 = sx / parcels.ids.length;
  lat0 = sy / parcels.ids.length;
}
// Seed parcel areas by id, for the lot a building stands on (a parcel the
// run created is not in the seed table and reads as unknown).
const parcelAreaByID = new Map<number, number>();
for (let i = 0; i < parcels.ids.length; i++) parcelAreaByID.set(parcels.ids[i], parcels.area[i]);
const lotAreaOf = (ids: ArrayLike<number>): number | null => {
  let sum = 0;
  for (let i = 0; i < ids.length; i++) {
    const a = parcelAreaByID.get(ids[i]);
    if (a === undefined) return null;
    sum += a;
  }
  return ids.length > 0 ? Math.round(sum) : null;
};
const R = 6371008.8;
const DEG = Math.PI / 180;
const kx = R * DEG * Math.cos(lat0 * DEG);
const ky = R * DEG;
const round1 = (v: number): number => Math.round(v * 10) / 10;

/** Polygon | MultiPolygon (lng/lat, closed rings) → polygons → rings → flat
 *  [x0,y0,x1,y1,…] in metres, 0.1 m, open (closing vertex dropped). */
function toLocal(geom: Geometry | null | undefined): number[][][] | null {
  if (!geom) return null;
  let polys: Position[][][];
  if (geom.type === "Polygon") polys = [geom.coordinates];
  else if (geom.type === "MultiPolygon") polys = geom.coordinates;
  else return null;
  const out: number[][][] = [];
  for (const poly of polys) {
    const rings: number[][] = [];
    for (const ring of poly) {
      let n = ring.length;
      if (n > 1 && ring[0][0] === ring[n - 1][0] && ring[0][1] === ring[n - 1][1]) n--;
      if (n < 3) continue;
      const flat = new Array<number>(n * 2);
      for (let v = 0; v < n; v++) {
        flat[v * 2] = round1((ring[v][0] - lon0) * kx);
        flat[v * 2 + 1] = round1((ring[v][1] - lat0) * ky);
      }
      rings.push(flat);
    }
    if (rings.length > 0) out.push(rings);
  }
  return out.length > 0 ? out : null;
}

// Parcel rings, only for a building that carries no footprint of its own.
let parcelsRead: ParcelsQueryServiceImpl | null = null;
async function parcelPolygon(parcelID: number): Promise<Geometry | null> {
  if (!parcelsRead) {
    const idIndex = await loadParcelIdIndex(dataPath, parcels);
    if (!idIndex) throw new Error(`${dataPath} has no parcels-id-index`);
    parcelsRead = new ParcelsQueryServiceImpl(
      { ids: parcels.ids, lat: parcels.lat, lng: parcels.lng, area: parcels.area, useCode, useNames, idIndex },
      await loadParcelRings(dataPath),
      [],
      startYear,
    );
  }
  try {
    return parcelsRead.polygonByID(parcelID, startYear);
  } catch {
    return null;
  }
}

const ym = (d: Date | null | undefined): [number, number] | null =>
  d ? [d.getUTCFullYear(), d.getUTCMonth() + 1] : null;
const runEnd = Date.UTC(endYear, 11, 31, 23, 59, 59);

// --- Buildings the run created ------------------------------------------------------
interface BuildingRow {
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
  footprintFrom: "building" | "parcel" | "none";
  footprint: number[][][] | null;
  demolished: [number, number] | null;
}
const built: BuildingRow[] = [];
const needParcelRing: number[] = [];
// Works already under way when the run starts (the observed pipeline the
// bootstrap injects, #5631) carry no developer kind in the log, and the
// `in-progress-development` tag that marks them in the live run does not
// travel in the .ccsr (idsTagged answers empty on a rebuilt log). So a
// Created row with no kind is read as pipeline, and the count is checked
// against the "[in-progress] injected N" line the run printed.
const injected = (() => {
  try {
    const m = /\[in-progress\] injected (\d+) of (\d+) projects/.exec(
      readFileSync(join(runDir, "stdout.log"), "utf8"),
    );
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
})();
let noKindCount = 0;
for (const b of iterateCreated(ctx, endYear)) {
  const start = ym(b.startDate)!;
  const completion = b.constructionDate ?? null;
  const fp = toLocal(b.footprint);
  const row: BuildingRow = {
    id: b.ID,
    kind: b.developerKind ?? (noKindCount++, "in-progress-pipeline"),
    type: BUILDING_TYPE_NAMES[b.buildingType] ?? String(b.buildingType),
    start,
    complete: ym(completion),
    completesAfterRun: completion ? completion.getTime() > runEnd : true,
    preRun: start[0] < startYear,
    parcels: Array.from(b.originalParcelsIDs),
    replaces: Array.from(b.originalBuildingsIDs),
    heightM: round1(b.height),
    stories: b.stories,
    floorAreaM2: Math.round(b.floorspace),
    footprintAreaM2: b.footprintArea === null ? null : Math.round(b.footprintArea),
    lotAreaM2: lotAreaOf(b.originalParcelsIDs),
    units: b.dwellingUnitsCount,
    footprintFrom: fp ? "building" : "none",
    footprint: fp,
    demolished: b.demolishYear === null ? null : (ym(b.demolishDate ?? null) ?? [b.demolishYear, 0]),
  };
  if (!fp) needParcelRing.push(built.length);
  built.push(row);
}
for (const i of needParcelRing) {
  const row = built[i];
  const polys: number[][][] = [];
  for (const pid of row.parcels) {
    const local = toLocal(await parcelPolygon(pid));
    if (local) polys.push(...local);
  }
  if (polys.length > 0) {
    row.footprint = polys;
    row.footprintFrom = "parcel";
  }
}
console.log(
  `[export] ${built.length} buildings created; ${needParcelRing.length} without their own footprint; ` +
    `${noKindCount} with no developer kind vs ${injected} pipeline projects injected`,
);
if (injected !== null && noKindCount !== injected) {
  console.warn("[export] WARNING: rows with no developer kind are not exactly the injected pipeline");
}

// --- Demolitions ----------------------------------------------------------------------
interface DemolitionRow {
  id: number;
  origin: string;
  date: [number, number];
  type: string;
  parcels: number[];
  heightM: number;
  stories: number;
  floorAreaM2: number;
  units: number;
  footprint: number[][][] | null;
  replacedBy: number[];
}
const replacedBy = new Map<number, number[]>();
for (const row of built) {
  for (const old of row.replaces) {
    const list = replacedBy.get(old);
    if (list) list.push(row.id);
    else replacedBy.set(old, [row.id]);
  }
}
const demolished: DemolitionRow[] = [];
for (const b of iterateDemolished(ctx, endYear)) {
  demolished.push({
    id: b.ID,
    origin: b.origin === BuildingOrigin.Seed ? "seed" : "simulated",
    date: ym(b.demolishDate ?? null) ?? [b.demolishYear!, 0],
    type: BUILDING_TYPE_NAMES[b.buildingType] ?? b.typeName ?? String(b.buildingType),
    parcels: Array.from(b.originalParcelsIDs),
    heightM: round1(b.height),
    stories: b.stories,
    floorAreaM2: Math.round(b.floorspace),
    units: b.dwellingUnitsCount,
    footprint: toLocal(b.footprint),
    replacedBy: replacedBy.get(b.ID) ?? [],
  });
}
// A seed row's flyweight carries no geometry; its rings come from the
// composed seed rings, one footprintByID per demolished building (after the
// sweep, so the lookup never runs inside the flyweight iteration).
let demolishedWithoutFootprint = 0;
for (const d of demolished) {
  if (d.footprint) continue;
  d.footprint = toLocal(ctx.buildings.footprintByID(d.id, endYear, { includeDemolished: true }));
  if (!d.footprint) demolishedWithoutFootprint++;
}
console.log(
  `[export] ${demolished.length} demolitions; ${demolishedWithoutFootprint} without a footprint`,
);

// --- Jobs per year (seed + the run's employment log) ----------------------------------
const jobsByYear = new Map<number, { jobs: number }>();
const initialState = rebuildInitialStateSnapshot(decoded);
let employmentEvents = 0;
if (initialState?.employmentSeedJobs) {
  const log = new EmploymentTxSoA();
  const wire = rebuildEmploymentLogWire(decoded);
  if (wire) {
    log.appendBatch(wire);
    employmentEvents = wire.count;
  }
  const employment = new EmploymentQueryServiceImpl(
    initialState.employmentSeedJobs,
    composeEmploymentLogs(log),
    startYear,
  );
  for (let y = startYear - 1; y <= endYear; y++) {
    const counts = employment.stateAt(y).countsBySector();
    let jobs = 0;
    for (let s = 0; s < SECTOR_COUNT; s++) jobs += counts[s];
    jobsByYear.set(y, { jobs });
  }
}

// --- Start-of-run population (the seed the run starts from) ---------------------------
const seedPersons = population.seedSOA.personSOA.count;
const seedHouseholds = population.seedSOA.householdSOA.count;
const seedFamilies = population.seedSOA.familySOA.count;

// --- Per-year totals --------------------------------------------------------------------
const years: number[] = [];
for (let y = startYear; y <= endYear; y++) years.push(y);
const zero = () => ({ buildings: 0, units: 0, floorAreaM2: 0 });
const perYear = years.map((year) => ({
  year,
  started: { ...zero(), byKind: {} as Record<string, ReturnType<typeof zero>> },
  completed: { ...zero(), byKind: {} as Record<string, ReturnType<typeof zero>> },
  demolitions: { buildings: 0, units: 0, floorAreaM2: 0 },
}));
const yi = (y: number) => y - startYear;
const add = (
  slot: { buildings: number; units: number; floorAreaM2: number; byKind: Record<string, ReturnType<typeof zero>> },
  row: BuildingRow,
) => {
  slot.buildings++;
  slot.units += row.units;
  slot.floorAreaM2 += row.floorAreaM2;
  const k = (slot.byKind[row.kind] ??= zero());
  k.buildings++;
  k.units += row.units;
  k.floorAreaM2 += row.floorAreaM2;
};
let preRunCount = 0;
for (const row of built) {
  // Pre-run pipeline projects count in the first run year, as the engine's
  // own summary does.
  const sy = Math.max(row.start[0], startYear);
  if (row.preRun) preRunCount++;
  if (sy <= endYear) add(perYear[yi(sy)].started, row);
  if (row.complete && row.complete[0] >= startYear && row.complete[0] <= endYear) {
    add(perYear[yi(row.complete[0])].completed, row);
  }
}
for (const d of demolished) {
  if (d.date[0] < startYear || d.date[0] > endYear) continue;
  const slot = perYear[yi(d.date[0])].demolitions;
  slot.buildings++;
  slot.units += d.units;
  slot.floorAreaM2 += d.floorAreaM2;
}
const series = runSummary.summary.series as Record<string, number[]>;
const summaryYears = runSummary.summary.years as number[];
const fromSummary = (key: string, year: number): number | null => {
  const i = summaryYears.indexOf(year);
  const v = i >= 0 ? series[key]?.[i] : undefined;
  return v === undefined || v === null ? null : v;
};
const totals = {
  description: {
    what: "Per-year totals of one headless CityCompass land-use run (the model's own output).",
    started:
      "Buildings whose construction STARTED that year (the year the run created them). The pre-run pipeline (projects already under way on 1 Jan of the first year, injected at bootstrap) counts in the first year, as the engine's own summary does.",
    completed: "Buildings whose construction was COMPLETED that year (completion date inside the run).",
    demolitions: "Buildings removed that year (seed buildings torn down, plus run buildings removed).",
    population:
      "populationAtEnd / householdsAtEnd / unassignedHouseholdsAtEnd: the engine's December PopulationChange record (demographic-flows.json). unassigned = households without a dwelling.",
    jobs: "Jobs located in the study area at the end of the year (seed base-year assignment folded with the run's employment log). outCommuters = residents working outside the study area (engine summary). employmentLogEvents counts the run's employment log rows: when it is ~0 the job count does not change over the run.",
    engineSummary:
      "The engine's own run-summary.json series for the same year, for cross-checking (buildings_created is bucketed by the month the Created row was written).",
    start: "State the run starts from: the population seed (persons, households, families) and the base-year jobs.",
  },
  region,
  seed,
  startYear,
  endYear,
  start: {
    persons: seedPersons,
    households: seedHouseholds,
    families: seedFamilies,
    jobs: jobsByYear.get(startYear - 1)?.jobs ?? null,
  },
  employmentLogEvents: employmentEvents,
  years: perYear.map((p) => {
    const f = flows.find((r) => r.year === p.year);
    const j = jobsByYear.get(p.year);
    return {
      ...p,
      populationAtEnd: f?.populationAtEnd ?? null,
      householdsAtEnd: f?.householdsAtEnd ?? null,
      unassignedHouseholdsAtEnd: f?.unassignedAtEnd ?? null,
      births: f?.births ?? null,
      deaths: f?.deaths ?? null,
      immigrants: f?.immigrantPersons ?? null,
      emigrants: f?.emigrantPersons ?? null,
      jobs: j?.jobs ?? null,
      outCommuters: fromSummary("out_commuters", p.year),
      engineSummary: {
        buildings_created: fromSummary("buildings_created", p.year),
        dwelling_units_created: fromSummary("dwelling_units_created", p.year),
        floorspace_created_sqm: fromSummary("floorspace_created_sqm", p.year),
        buildings_demolished: fromSummary("buildings_demolished", p.year),
        population: fromSummary("population", p.year),
        households: fromSummary("households", p.year),
        jobs_stock: fromSummary("jobs_stock", p.year),
        out_commuters: fromSummary("out_commuters", p.year),
      },
    };
  }),
};

// --- What a footprint polygon is, per kind (measured on this run) -------------------------------
// The engine stores the SITE of a layout as the building's footprint for
// some kinds, so footprint vs lot vs floor plate is reported per kind.
const median = (v: number[]): number | null => {
  if (v.length === 0) return null;
  const s = v.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const footprintStats: Record<string, unknown> = {};
for (const kind of [...new Set(built.map((b) => b.kind))].sort()) {
  const rows = built.filter((b) => b.kind === kind);
  const withLot = rows.filter((b) => b.lotAreaM2 && b.footprintAreaM2);
  const ratio = withLot.map((b) => b.footprintAreaM2! / b.lotAreaM2!);
  const plate = rows.filter((b) => b.footprintAreaM2 && b.stories > 0).map((b) => b.floorAreaM2 / b.stories / b.footprintAreaM2!);
  footprintStats[kind] = {
    buildings: rows.length,
    medianFootprintM2: median(rows.map((b) => b.footprintAreaM2 ?? 0)),
    maxFootprintM2: rows.reduce((m, b) => Math.max(m, b.footprintAreaM2 ?? 0), 0),
    medianFootprintOverLot: ratio.length ? Math.round(median(ratio)! * 100) / 100 : null,
    shareFootprintIsWholeLot: ratio.length ? Math.round((ratio.filter((r) => r > 0.95 && r < 1.05).length / ratio.length) * 100) / 100 : null,
    medianFloorPlateOverFootprint: plate.length ? Math.round(median(plate)! * 100) / 100 : null,
  };
}

// --- Write ----------------------------------------------------------------------------------
const developments = {
  description: {
    what: `Every building one headless CityCompass land-use run created in ${region}, ${startYear}-${endYear} (seed ${seed}), and every building it demolished. Real model output, read from the run's building log through CityContext.`,
    coordinates: `Local equirectangular metres, x east, y north: x = R*(lon-lon0)*(pi/180)*cos(lat0*pi/180), y = R*(lat-lat0)*(pi/180), R = ${R}, lon0 = ${lon0}, lat0 = ${lat0}. 0.1 m precision.`,
    footprint:
      "Array of polygons; each polygon is an array of rings (first = outer, rest = holes); each ring is a flat [x0,y0,x1,y1,...] list, open (the last vertex joins the first).",
    buildings: {
      id: "building id (unique in the run)",
      kind: "who built it: ar-multifamily (market 'pozo' apartment developer), fondo-de-lote (informal/family additions: one storey or one unit added on a standing dwelling, mostly inside the barrios populares), state-housing (IVC public housing blocks), law-enabled-site (large law-enabled sites), in-progress-pipeline (works already under way when the run starts, from the observed permit/works record, injected at bootstrap), ...",
      type: "building typology (use): Apartment | House | Terrace | Non-Residential. All run-built typologies here are residential.",
      start: "[year, month] construction started",
      complete: "[year, month] construction completed (may fall after the run's last year)",
      completesAfterRun: "true when completion is after 31 Dec of the last run year",
      preRun: "true for projects already under way when the run starts (the in-progress pipeline injected at bootstrap; start is before the first run year)",
      parcels: "parcel id(s) the building stands on",
      replaces: "ids of the buildings it replaced (demolished for it)",
      heightM: "building height, metres (the engine builds in whole storeys of 3 m, the region's storey height, so heightM = 3 x stories)",
      stories: "number of storeys",
      floorAreaM2: "gross floor area, m²",
      footprintAreaM2: "area of the footprint polygon, m²",
      lotAreaM2: "summed area of the parcels it stands on (seed parcel table), m²; null when a parcel was created by the run",
      units: "dwelling units",
      footprintFrom: "'building' = its own footprint; 'parcel' = no footprint of its own, the parcel ring is used; 'none' = no geometry",
      fondoDeLoteNote:
        "A fondo-de-lote row adds to a lot whose buildings keep standing (replaces is empty, nothing is demolished). Its footprint is the whole lot (see footprintNote), and floorAreaM2/units are only what was added. Two flows: a storey raised on a dwelling in a barrio popular (46 m2, one unit; stories/heightM = the lot's lowest standing storeys plus one, 2-4 storeys), and a one-storey family unit in the yard of a house in the formal city (55 m2 or less, one unit).",
      demolished: "[year, month] if the run later removed this building, else null",
    },
    footprintNote:
      "What a footprint polygon is depends on the kind (numbers in footprintStats, measured on this run). ar-multifamily: usually the whole lot (76% of rows); its floor plate, floorAreaM2/stories, is about 3/4 of the polygon. fondo-de-lote: the whole lot the addition went on, which can be a multi-hectare informal-settlement parcel, while the added mass is only floorAreaM2 (46 m2, one unit) - draw these as small additions, not as lot-sized blocks; the same lot can receive several additions over the years. in-progress-pipeline: a synthetic shape (the lot outline scaled by 0.6, i.e. 36% of its area), and its storeys are the loader's estimate from the unit count (units/8, at least 3), not an observed height, so the few rows over 100 m (up to 270 m / 90 storeys) are that estimate, not real towers. state-housing and law-enabled-site: building footprints inside large sites.",
    tallest: "The five tallest rows, for a quick plausibility check (see counts.tallest).",
    footprintStats:
      "Per kind, measured on this run: how the footprint polygon relates to the lot (footprint/lot area; share of rows whose footprint IS the whole lot) and to the floor plate (floorAreaM2/stories over footprint area). The engine stores a layout's SITE as the footprint for some kinds, so a footprint can be the whole lot rather than the built mass.",
    demolitions: {
      id: "building id",
      origin: "'seed' = existing building in the base year; 'simulated' = built by the run",
      date: "[year, month] removed",
      replacedBy: "ids of run buildings that list it in `replaces`",
    },
  },
  region,
  seed,
  startYear,
  endYear,
  origin: { lon0, lat0, R },
  counts: {
    buildings: built.length,
    demolitions: demolished.length,
    preRun: preRunCount,
    tallest: built
      .slice()
      .sort((a, b) => b.heightM - a.heightM)
      .slice(0, 5)
      .map((b) => ({ id: b.id, kind: b.kind, heightM: b.heightM, stories: b.stories, units: b.units, start: b.start })),
  },
  footprintStats,
  buildings: built,
  demolitions: demolished,
};
const devPath = join(outDir, `${region}-developments.json`);
const totPath = join(outDir, `${region}-totals.json`);
writeFileSync(devPath, JSON.stringify(developments));
writeFileSync(totPath, JSON.stringify(totals, null, 1));
console.log(`[export] wrote ${devPath} and ${totPath}`);
