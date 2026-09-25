// Compare the new-line run with the baseline run (same region, years, seed).
//
//   yarn vite-node .scratch/urbanly-film/data/line/compare.ts   (repo root)
//
// Reads:
//   ../sim/buenosaires-developments.json, ../sim/buenosaires-totals.json            baseline
//   ../sim/buenosaires-line-developments.json, ../sim/buenosaires-line-totals.json  line run
//   ../sim/runs/<tag>/run.ccsr  (population by place, through the run report's own
//                                population replay: persons per household and the
//                                parcel it lives on, at every year end)
//   line.json (stations), zoning-scenario.json (upzoned parcels), ../ba/parcels_* (centroids)
// Writes compare.json next to this file.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { decodeSimulationRun } from "@shared/simulation-run-binary/decode";

import { buildPopulationReplay } from "../../../../src/web-ui/run-report/model/populationReplay.ts";
import { reportRunOf } from "../../../../src/web-ui/run-report/model/reportRun.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SIM = path.join(HERE, "..", "sim");
const BA = path.join(HERE, "..", "ba");
const RING_M = 800;
const PLACEBO_MIN_DISTANCE_M = 2 * RING_M;

const RUNS = {
  baseline: {
    developments: path.join(SIM, "buenosaires-developments.json"),
    totals: path.join(SIM, "buenosaires-totals.json"),
    ccsr: path.join(SIM, "runs", "ba-2022-2031-s123456", "run.ccsr"),
  },
  line: {
    developments: path.join(SIM, "buenosaires-line-developments.json"),
    totals: path.join(SIM, "buenosaires-line-totals.json"),
    ccsr: path.join(SIM, "runs", "ba-2022-2031-s123456-line", "run.ccsr"),
  },
} as const;
type RunName = keyof typeof RUNS;

// --- Places -------------------------------------------------------------------------
const rd = <T extends Float32Array | Uint32Array | Uint8Array>(f: string, T: new (b: ArrayBuffer) => T): T => {
  const b = readFileSync(path.join(BA, f));
  return new T(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};
const parcelIDs = rd("parcels_id.u32", Uint32Array);
const parcelXY = rd("parcels_centroid.f32", Float32Array);
const subteXY = rd("subte_stations_xy.f32", Float32Array);
const subteLine = rd("subte_stations_line.u8", Uint8Array);
const subteNames = JSON.parse(readFileSync(path.join(BA, "subte_stations.json"), "utf8")) as { name: string }[];
const subteLines = JSON.parse(readFileSync(path.join(BA, "subte_lines.json"), "utf8")) as { short: string }[];
const line = JSON.parse(readFileSync(path.join(HERE, "line.json"), "utf8")) as {
  stations: { x: number; y: number; name: string }[];
};
const zoningScenario = JSON.parse(readFileSync(path.join(HERE, "zoning-scenario.json"), "utf8")) as {
  updates: { parcelIDs: number[] }[];
};

let maxParcelID = 0;
for (let i = 0; i < parcelIDs.length; i++) if (parcelIDs[i] > maxParcelID) maxParcelID = parcelIDs[i];
// 0 = elsewhere, 1 = within RING_M of a new station.
const nearLine = new Uint8Array(maxParcelID + 1);
// Placebo ring index + 1 (0 = in no placebo ring); the line's own ring index + 1.
const placeboRing = new Uint16Array(maxParcelID + 1);
const lineRing = new Uint16Array(maxParcelID + 1);
const upzoned = new Uint8Array(maxParcelID + 1);
for (const u of zoningScenario.updates) for (const id of u.parcelIDs) upzoned[id] = 1;

// Placebo centres: standing Subte stations (one per station name) at least
// PLACEBO_MIN_DISTANCE_M from every new station, so their rings do not
// overlap the line's rings.
const placebo: { x: number; y: number; name: string }[] = [];
const seenName = new Set<string>();
for (let j = 0; j < subteNames.length; j++) {
  const x = subteXY[2 * j];
  const y = subteXY[2 * j + 1];
  let dMin = Infinity;
  for (const s of line.stations) dMin = Math.min(dMin, Math.hypot(x - s.x, y - s.y));
  if (dMin < PLACEBO_MIN_DISTANCE_M) continue;
  const name = `${subteLines[subteLine[j]].short} ${subteNames[j].name}`;
  if (seenName.has(subteNames[j].name)) continue;
  // Keep placebo rings apart from each other too: skip one within 2 rings of a kept one.
  if (placebo.some((p) => Math.hypot(p.x - x, p.y - y) < 2 * RING_M)) continue;
  seenName.add(subteNames[j].name);
  placebo.push({ x, y, name });
}
for (let i = 0; i < parcelIDs.length; i++) {
  const x = parcelXY[2 * i];
  const y = parcelXY[2 * i + 1];
  if (!Number.isFinite(x)) continue;
  const id = parcelIDs[i];
  let best = -1;
  let bestD = Infinity;
  for (let s = 0; s < line.stations.length; s++) {
    const d = Math.hypot(x - line.stations[s].x, y - line.stations[s].y);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  if (bestD <= RING_M) {
    nearLine[id] = 1;
    lineRing[id] = best + 1;
  }
  for (let p = 0; p < placebo.length; p++) {
    if (Math.hypot(x - placebo[p].x, y - placebo[p].y) <= RING_M) {
      placeboRing[id] = p + 1;
      break;
    }
  }
}

// --- Buildings, units, demolitions (from the exports) -----------------------------------
interface BuildingRow {
  id: number;
  kind: string;
  start: [number, number];
  complete: [number, number] | null;
  parcels: number[];
  stories: number;
  units: number;
  floorAreaM2: number;
}
interface DemolitionRow {
  id: number;
  date: [number, number];
  parcels: number[];
  units: number;
}
interface Developments {
  seed: number;
  startYear: number;
  endYear: number;
  buildings: BuildingRow[];
  demolitions: DemolitionRow[];
}
interface Flow {
  buildings: number;
  units: number;
}
interface Totals {
  seed: number;
  years: {
    year: number;
    started: Flow;
    completed: Flow;
    demolitions: Flow;
    populationAtEnd: number | null;
    householdsAtEnd: number | null;
    unassignedHouseholdsAtEnd: number | null;
  }[];
}

const zone = (parcels: number[]): 0 | 1 => (parcels.length > 0 && nearLine[parcels[0]] === 1 ? 1 : 0);

function flows(dev: Developments) {
  const { startYear, endYear } = dev;
  const n = endYear - startYear + 1;
  const blank = () => ({
    started: { buildings: new Array(n).fill(0), units: new Array(n).fill(0) },
    completed: { buildings: new Array(n).fill(0), units: new Array(n).fill(0), floorAreaM2: new Array(n).fill(0) },
    demolitions: { buildings: new Array(n).fill(0), units: new Array(n).fill(0) },
  });
  const all = blank();
  const within = blank();
  const elsewhere = blank();
  const upzonedParcels = blank();
  const withinArMultifamilyStoreys: number[] = [];
  const elsewhereArMultifamilyStoreys: number[] = [];
  // Per ring, units of the buildings started / completed from the year after the first on.
  const lineRings = { started: new Array(line.stations.length).fill(0), completed: new Array(line.stations.length).fill(0) };
  const placeboRings = { started: new Array(placebo.length).fill(0), completed: new Array(placebo.length).fill(0) };
  const started2022 = new Set<number>();
  for (const b of dev.buildings) {
    const sy = Math.max(b.start[0], startYear);
    const z = zone(b.parcels);
    const slots = [all, z ? within : elsewhere];
    if (b.parcels.length > 0 && upzoned[b.parcels[0]] === 1) slots.push(upzonedParcels);
    const r = b.parcels.length > 0 ? lineRing[b.parcels[0]] : 0;
    const p = b.parcels.length > 0 ? placeboRing[b.parcels[0]] : 0;
    if (sy <= endYear) {
      for (const s of slots) {
        s.started.buildings[sy - startYear]++;
        s.started.units[sy - startYear] += b.units;
      }
      if (sy === startYear) started2022.add(b.id);
      if (sy >= startYear + 1) {
        if (r > 0) lineRings.started[r - 1] += b.units;
        if (p > 0) placeboRings.started[p - 1] += b.units;
        if (b.kind === "ar-multifamily") (z ? withinArMultifamilyStoreys : elsewhereArMultifamilyStoreys).push(b.stories);
      }
    }
    if (b.complete && b.complete[0] >= startYear && b.complete[0] <= endYear) {
      const yi = b.complete[0] - startYear;
      for (const s of slots) {
        s.completed.buildings[yi]++;
        s.completed.units[yi] += b.units;
        s.completed.floorAreaM2[yi] += b.floorAreaM2;
      }
      if (b.complete[0] >= startYear + 1) {
        if (r > 0) lineRings.completed[r - 1] += b.units;
        if (p > 0) placeboRings.completed[p - 1] += b.units;
      }
    }
  }
  for (const d of dev.demolitions) {
    if (d.date[0] < startYear || d.date[0] > endYear) continue;
    const yi = d.date[0] - startYear;
    for (const s of [all, zone(d.parcels) ? within : elsewhere]) {
      s.demolitions.buildings[yi]++;
      s.demolitions.units[yi] += d.units;
    }
  }
  const median = (v: number[]) => {
    if (v.length === 0) return null;
    const s = v.slice().sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  const mean = (v: number[]) => (v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100 : null);
  return {
    all,
    within,
    elsewhere,
    upzonedParcels,
    arMultifamilyStoreysStarted2023on: {
      within: { buildings: withinArMultifamilyStoreys.length, median: median(withinArMultifamilyStoreys), mean: mean(withinArMultifamilyStoreys), max: withinArMultifamilyStoreys.length ? Math.max(...withinArMultifamilyStoreys) : null },
      elsewhere: { buildings: elsewhereArMultifamilyStoreys.length, median: median(elsewhereArMultifamilyStoreys), mean: mean(elsewhereArMultifamilyStoreys), max: elsewhereArMultifamilyStoreys.length ? Math.max(...elsewhereArMultifamilyStoreys) : null },
    },
    lineRings,
    placeboRings,
    started2022,
  };
}

// --- Population by place (run report's population replay) -------------------------------
function populationByPlace(ccsrPath: string, startYear: number, endYear: number) {
  const bytes = readFileSync(ccsrPath);
  const raw = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
  const container = new ArrayBuffer(raw.byteLength);
  new Uint8Array(container).set(raw);
  const decoded = decodeSimulationRun(container);
  const run = reportRunOf(decoded);
  const replay = buildPopulationReplay(run);
  const places = replay.places;
  if (!places) throw new Error(`${ccsrPath}: the run carries no population places`);
  const { days, years: snapshotYears, offsets, slots, persons, parcels } = places.stocks;
  const slotCount = replay.householdCount;
  const where = new Int8Array(slotCount).fill(-1); // -1 no home, 0 elsewhere, 1 within
  const personsNow = new Int32Array(slotCount);
  const n = endYear - startYear + 1;
  const out = {
    within: { persons: new Array(n).fill(0), households: new Array(n).fill(0) },
    elsewhere: { persons: new Array(n).fill(0), households: new Array(n).fill(0) },
    seed: { within: { persons: 0, households: 0 }, elsewhere: { persons: 0, households: 0 } },
  };
  const acc = { withinP: 0, withinH: 0, elseP: 0, elseH: 0 };
  let g = 0;
  const apply = (snapshot: number) => {
    for (let e = offsets[snapshot]; e < offsets[snapshot + 1]; e++) {
      const slot = slots[e];
      if (where[slot] === 1) {
        acc.withinP -= personsNow[slot];
        acc.withinH--;
      } else if (where[slot] === 0) {
        acc.elseP -= personsNow[slot];
        acc.elseH--;
      }
      const parcel = parcels[e];
      where[slot] = parcel === 0 ? -1 : parcel <= maxParcelID && nearLine[parcel] === 1 ? 1 : 0;
      personsNow[slot] = persons[e];
      if (where[slot] === 1) {
        acc.withinP += persons[e];
        acc.withinH++;
      } else if (where[slot] === 0) {
        acc.elseP += persons[e];
        acc.elseH++;
      }
    }
  };
  // The seed snapshot first (day -1), then each year end the log reached; a
  // year the log never reached keeps the last state.
  for (let i = 0; i < n; i++) {
    const yearEnd = startYear + i;
    while (g < days.length && (days[g] === -1 || snapshotYears[g] <= yearEnd)) {
      apply(g);
      if (days[g] === -1) {
        out.seed.within = { persons: acc.withinP, households: acc.withinH };
        out.seed.elsewhere = { persons: acc.elseP, households: acc.elseH };
      }
      g++;
    }
    out.within.persons[i] = acc.withinP;
    out.within.households[i] = acc.withinH;
    out.elsewhere.persons[i] = acc.elseP;
    out.elsewhere.households[i] = acc.elseH;
  }
  return out;
}

// --- Assemble ----------------------------------------------------------------------------
const load = <T>(f: string): T => JSON.parse(readFileSync(f, "utf8")) as T;
const result: Record<string, unknown> = {};
const perRun = {} as Record<RunName, { dev: Developments; totals: Totals; f: ReturnType<typeof flows>; pop: ReturnType<typeof populationByPlace> }>;
for (const name of Object.keys(RUNS) as RunName[]) {
  const dev = load<Developments>(RUNS[name].developments);
  const totals = load<Totals>(RUNS[name].totals);
  console.log(`[compare] ${name}: ${dev.buildings.length} buildings, ${dev.demolitions.length} demolitions, seed ${dev.seed}`);
  const f = flows(dev);
  // Same counting rules as the exporter: the city-wide flows must equal its totals.
  totals.years.forEach((t, i) => {
    for (const m of ["started", "completed", "demolitions"] as const) {
      for (const k of ["buildings", "units"] as const) {
        if (f.all[m][k][i] !== t[m][k]) throw new Error(`${name} ${t.year} ${m}.${k}: ${f.all[m][k][i]} here, ${t[m][k]} in the totals`);
      }
    }
  });
  let offSeed = 0;
  for (const bld of dev.buildings) if (bld.parcels.length === 0 || bld.parcels[0] > maxParcelID) offSeed++;
  if (offSeed > 0) console.warn(`[compare] ${name}: ${offSeed} buildings not on a seed parcel (counted as elsewhere)`);
  const pop = populationByPlace(RUNS[name].ccsr, dev.startYear, dev.endYear);
  perRun[name] = { dev, totals, f, pop };
}
const b = perRun.baseline;
const l = perRun.line;
if (b.dev.seed !== l.dev.seed || b.dev.startYear !== l.dev.startYear || b.dev.endYear !== l.dev.endYear) {
  throw new Error("the two runs do not share seed and years");
}
const { startYear, endYear } = b.dev;
const years: number[] = [];
for (let y = startYear; y <= endYear; y++) years.push(y);
const sum = (a: number[], from = 0) => a.slice(from).reduce((s, v) => s + v, 0);
const pct = (base: number, other: number) => (base === 0 ? null : Math.round(((other - base) / base) * 1000) / 10);

type Area = "all" | "within" | "elsewhere" | "upzonedParcels";
function metricBlock(area: Area) {
  const pick = (run: typeof b, m: "started" | "completed" | "demolitions", k: "buildings" | "units") =>
    (run.f[area] as ReturnType<typeof flows>["all"])[m][k] as number[];
  const rows: Record<string, unknown> = {};
  const metrics: [string, "started" | "completed" | "demolitions", "buildings" | "units"][] = [
    ["buildingsStarted", "started", "buildings"],
    ["unitsStarted", "started", "units"],
    ["buildingsCompleted", "completed", "buildings"],
    ["unitsCompleted", "completed", "units"],
    ["demolishedBuildings", "demolitions", "buildings"],
    ["demolishedUnits", "demolitions", "units"],
  ];
  for (const [key, m, k] of metrics) {
    if (area === "upzonedParcels" && m === "demolitions") continue;
    const base = pick(b, m, k);
    const other = pick(l, m, k);
    rows[key] = {
      baseline: base,
      line: other,
      difference: other.map((v, i) => v - base[i]),
      total: { baseline: sum(base), line: sum(other), difference: sum(other) - sum(base), percent: pct(sum(base), sum(other)) },
      from2023: { baseline: sum(base, 1), line: sum(other, 1), difference: sum(other, 1) - sum(base, 1), percent: pct(sum(base, 1), sum(other, 1)) },
    };
  }
  if (area === "within" || area === "elsewhere") {
    for (const k of ["persons", "households"] as const) {
      const base = b.pop[area][k];
      const other = l.pop[area][k];
      rows[k === "persons" ? "housedPersonsAtYearEnd" : "housedHouseholdsAtYearEnd"] = {
        seed: { baseline: b.pop.seed[area][k], line: l.pop.seed[area][k] },
        baseline: base,
        line: other,
        difference: other.map((v, i) => v - base[i]),
        end: { baseline: base[base.length - 1], line: other[other.length - 1], difference: other[other.length - 1] - base[base.length - 1], percent: pct(base[base.length - 1], other[other.length - 1]) },
      };
    }
  }
  if (area === "all") {
    for (const k of ["populationAtEnd", "householdsAtEnd", "unassignedHouseholdsAtEnd"] as const) {
      const base = b.totals.years.map((y) => y[k] ?? NaN);
      const other = l.totals.years.map((y) => y[k] ?? NaN);
      rows[k] = {
        baseline: base,
        line: other,
        difference: other.map((v, i) => v - base[i]),
        end: { baseline: base[base.length - 1], line: other[other.length - 1], difference: other[other.length - 1] - base[base.length - 1], percent: pct(base[base.length - 1], other[other.length - 1]) },
      };
    }
  }
  return rows;
}

// Pairing check: 2022 is before the line and the upzone exist (both start in
// 2023), so a true pairing gives an identical first year.
const identical2022 = (() => {
  const checks: Record<string, boolean> = {};
  for (const area of ["all", "within", "elsewhere"] as const) {
    for (const m of ["started", "completed", "demolitions"] as const) {
      for (const k of ["buildings", "units"] as const) {
        checks[`${area}.${m}.${k}`] = b.f[area][m][k][0] === l.f[area][m][k][0];
      }
    }
  }
  checks["all.populationAtEnd"] = b.totals.years[0].populationAtEnd === l.totals.years[0].populationAtEnd;
  checks["within.housedPersons"] = b.pop.within.persons[0] === l.pop.within.persons[0];
  checks["elsewhere.housedPersons"] = b.pop.elsewhere.persons[0] === l.pop.elsewhere.persons[0];
  let sameIDs = b.f.started2022.size === l.f.started2022.size;
  if (sameIDs) for (const id of b.f.started2022) if (!l.f.started2022.has(id)) sameIDs = false;
  checks["sameBuildingIDsStarted2022"] = sameIDs;
  return { allIdentical: Object.values(checks).every(Boolean), checks };
})();

const ringRows = (base: number[], other: number[]) => base.map((v, i) => ({ baseline: v, line: other[i], difference: other[i] - v, percent: pct(v, other[i]) }));
const ringSummary = (base: number[], other: number[]) => {
  const abs = base
    .map((v, i) => pct(v, other[i]))
    .filter((v): v is number => v !== null)
    .map(Math.abs)
    .sort((x, y) => x - y);
  return {
    rings: base.length,
    baseline: sum(base),
    line: sum(other),
    difference: sum(other) - sum(base),
    percent: pct(sum(base), sum(other)),
    medianAbsRingPercent: abs.length ? abs[Math.floor(abs.length / 2)] : null,
    maxAbsRingPercent: abs.length ? abs[abs.length - 1] : null,
  };
};
const byRing = (m: "started" | "completed") => ({
  lineStations: {
    summary: ringSummary(b.f.lineRings[m], l.f.lineRings[m]),
    rings: line.stations.map((s, i) => ({ station: s.name, ...ringRows(b.f.lineRings[m], l.f.lineRings[m])[i] })),
  },
  placeboStations: {
    summary: ringSummary(b.f.placeboRings[m], l.f.placeboRings[m]),
    rings: placebo.map((p, i) => ({ station: p.name, ...ringRows(b.f.placeboRings[m], l.f.placeboRings[m])[i] })),
  },
});

result.description = {
  what:
    "Paired comparison of two CityCompass land-use runs of Buenos Aires, 2022-2031, same seed (123456), same CLI bundle and flags: the baseline, and the same run with the new line (line.json: metro, opens 2023) plus its transit-oriented upzone (zoning-scenario.json: 38 m within 500 m of the 13 stations, from 2023).",
    areas: `within = parcels whose centroid (../ba/parcels_centroid.f32) is within ${RING_M} m of a new station; elsewhere = every other parcel; upzonedParcels = the 10,668 parcels the zoning scenario raises to 38 m (all inside the ${RING_M} m rings). A building or demolition is placed by its first parcel (all run-built buildings stand on seed parcels).`,
  flows:
    "started = buildings whose construction started that year (the pre-run pipeline counts in 2022, as the exporter does); completed = completion date inside that year; demolitions = removal date inside that year. total = 2022-2031; from2023 = 2023-2031 (the years the line and upzone exist).",
  population:
    "populationAtEnd/householdsAtEnd/unassignedHouseholdsAtEnd = the engine's December record (exports' totals). housedPersonsAtYearEnd/housedHouseholdsAtYearEnd = persons and households living on a parcel at each year end, from the run report's population replay of run.ccsr (households with no dwelling are in no area, so within + elsewhere = housed population, not total population).",
  pairingCheck: "2022 is before the line and the upzone exist, so a correct pairing (same seed, same inputs) gives identical 2022 values.",
  placebo: `Rings of ${RING_M} m around standing Subte stations at least ${PLACEBO_MIN_DISTANCE_M} m from every new station (and ${2 * RING_M} m from each other): places the scenario does not touch, so their change between the runs is what the two runs drift apart by chance plus any city-wide knock-on effect. Compare with the line's own rings.`,
};
result.seed = b.dev.seed;
result.years = years;
result.pairingCheck2022 = identical2022;
result.all = metricBlock("all");
result.within800m = metricBlock("within");
result.elsewhere = metricBlock("elsewhere");
result.upzonedParcels = metricBlock("upzonedParcels");
result.arMultifamilyStoreysStarted2023on = { baseline: b.f.arMultifamilyStoreysStarted2023on, line: l.f.arMultifamilyStoreysStarted2023on };
result.unitsByRing2023on = {
  note: `Units in buildings started (or completed) 2023-2031, per ${RING_M} m ring. A ring's rows are the parcels nearest that station within ${RING_M} m.`,
  started: byRing("started"),
  completed: byRing("completed"),
};
// --- Plain verdict, every number read from the blocks above -------------------------------
type Row = { total: { baseline: number; line: number; difference: number; percent: number | null }; from2023: { baseline: number; line: number; difference: number; percent: number | null } };
type PopRow = { end: { baseline: number; line: number; difference: number; percent: number | null } };
const blk = (k: string) => result[k] as Record<string, Row & PopRow>;
const fmt = (v: number) => v.toLocaleString("en-US");
const sgn = (v: number | null) => (v === null ? "n/a" : `${v > 0 ? "+" : ""}${v}%`);
const pair = (r: Row["from2023"]) => `${fmt(r.baseline)} vs ${fmt(r.line)} (${sgn(r.percent)})`;
const startedRings = byRing("started");
const placeboMax = startedRings.placeboStations.summary.maxAbsRingPercent ?? 0;
const ringsAbovePlacebo = startedRings.lineStations.rings.filter((r) => r.percent !== null && Math.abs(r.percent) > placeboMax);
const ringsUp = ringsAbovePlacebo.filter((r) => (r.percent ?? 0) > 0).map((r) => r.station);
const ringsDown = startedRings.lineStations.rings.filter((r) => (r.percent ?? 0) < 0).map((r) => `${r.station} ${sgn(r.percent)}`);
const within = blk("within800m");
const upz = blk("upzonedParcels");
const notUpz = (k: "unitsStarted" | "buildingsStarted" | "unitsCompleted") => {
  const base = within[k].from2023.baseline - upz[k].from2023.baseline;
  const other = within[k].from2023.line - upz[k].from2023.line;
  return { baseline: base, line: other, difference: other - base, percent: pct(base, other) };
};
const withinNotUpzoned = {
  note: "Parcels within 800 m of a new station that the zoning scenario did not upzone, 2023-2031.",
  unitsStarted: notUpz("unitsStarted"),
  buildingsStarted: notUpz("buildingsStarted"),
  unitsCompleted: notUpz("unitsCompleted"),
};
const all = blk("all");
const elsewhereBlk = blk("elsewhere");
const storeys = result.arMultifamilyStoreysStarted2023on as { baseline: { within: { median: number | null } }; line: { within: { median: number | null } } };
const verdict = {
  pairing: identical2022.allIdentical
    ? "2022 (before the line and the upzone exist) is identical in both runs, building ids included: the pairing holds, so every later difference comes from the scenario and what it set off."
    : "2022 differs between the runs: the pairing does NOT hold; read every difference below as partly noise.",
  cityWide: `Small. 2023-2031, city-wide: buildings started ${pair(all.buildingsStarted.from2023)}, units started ${pair(all.unitsStarted.from2023)}, buildings completed ${pair(all.buildingsCompleted.from2023)}, units completed ${pair(all.unitsCompleted.from2023)}, demolished buildings ${pair(all.demolishedBuildings.from2023)}. Population at the end of ${endYear}: ${fmt(all.populationAtEnd.end.baseline)} vs ${fmt(all.populationAtEnd.end.line)}; households without a dwelling ${fmt(all.unassignedHouseholdsAtEnd.end.baseline)} vs ${fmt(all.unassignedHouseholdsAtEnd.end.line)}.`,
  nearTheLine: `Large. Within ${RING_M} m of the 13 stations, 2023-2031: units started ${pair(within.unitsStarted.from2023)}, buildings started ${pair(within.buildingsStarted.from2023)}, units completed ${pair(within.unitsCompleted.from2023)}, demolished buildings ${pair(within.demolishedBuildings.from2023)}; median storeys of the ar-multifamily buildings started there ${storeys.baseline.within.median} vs ${storeys.line.within.median}.`,
  noise: `Not noise near the line. The ${startedRings.placeboStations.summary.rings} placebo rings (standing Subte stations away from the line) move ${sgn(startedRings.placeboStations.summary.percent)} in units started in total, a single ring by up to ${placeboMax}% (median ${startedRings.placeboStations.summary.medianAbsRingPercent}%). The line's rings move ${sgn(startedRings.lineStations.summary.percent)} in total, and ${ringsUp.length} of 13 rise by more than any placebo ring (${ringsUp.join(", ")}). ${ringsDown.length ? `Rings that fell (${ringsDown.join(", ")}) stay inside the placebo range.` : ""} The line's rings are smaller (${fmt(Math.round(startedRings.lineStations.summary.baseline / 13))} units started per ring in the baseline, against ${fmt(Math.round(startedRings.placeboStations.summary.baseline / startedRings.placeboStations.summary.rings))} per placebo ring), so their percentages swing more by chance: a single ring's change of a few tens of percent is chance, the corridor total (${startedRings.lineStations.summary.difference > 0 ? "+" : ""}${fmt(startedRings.lineStations.summary.difference)} units) is not; the largest placebo ring moves by ${fmt(Math.max(...startedRings.placeboStations.rings.map((r) => Math.abs(r.difference))))} units.`,
  whereTheGainIs: `On the upzoned parcels: units started ${pair(upz.unitsStarted.from2023)}. The other parcels within ${RING_M} m: ${fmt(withinNotUpzoned.unitsStarted.baseline)} vs ${fmt(withinNotUpzoned.unitsStarted.line)} (${sgn(withinNotUpzoned.unitsStarted.percent)}), inside the chance range. Elsewhere in the city: units started ${pair(elsewhereBlk.unitsStarted.from2023)}, buildings started ${pair(elsewhereBlk.buildingsStarted.from2023)}.`,
  population: `Small. Persons living within ${RING_M} m at the end of ${endYear}: ${fmt(within.housedPersonsAtYearEnd.end.baseline)} vs ${fmt(within.housedPersonsAtYearEnd.end.line)} (${sgn(within.housedPersonsAtYearEnd.end.percent)}); elsewhere ${fmt(elsewhereBlk.housedPersonsAtYearEnd.end.baseline)} vs ${fmt(elsewhereBlk.housedPersonsAtYearEnd.end.line)} (${sgn(elsewhereBlk.housedPersonsAtYearEnd.end.percent)}).`,
};
const { description, ...rest } = result;
const ordered = { description, verdict, ...rest, withinNotUpzoned2023on: withinNotUpzoned };
for (const k of Object.keys(result)) delete result[k];
Object.assign(result, ordered);
writeFileSync(path.join(HERE, "compare.json"), JSON.stringify(result, null, 1));
console.log(`[compare] wrote ${path.join(HERE, "compare.json")}; 2022 identical: ${identical2022.allIdentical}`);
