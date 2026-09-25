// Pull what the run RECORDED about each candidate parcel: every appraisal the
// engine computed on it (`proforma` section), the appraisal each start used
// (`startAppraisals`), every land-auction close (`landAuctionCloses`) and the
// Created rows of the buildings log (with their startAppraisalID link).
//   npx vite-node .scratch/urbanly-film/data/showcase/extract-recorded.ts [parcelID ...]   (from the repo root)
// Default parcels: every candidate in candidates.json. Writes recorded.json.
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import { decodeSimulationRun } from "@shared/simulation-run-binary/decode";

const DIR = ".scratch/urbanly-film/data/showcase/";
const RUN = ".scratch/urbanly-film/data/sim/runs/ba-2022-2031-s123456/run.ccsr";
const cli = process.argv.slice(2).map(Number).filter(Number.isFinite);
const candidates = JSON.parse(readFileSync(DIR + "candidates.json", "utf8")) as { parcelID: number; id: number }[];
const wanted = new Set<number>(cli.length ? cli : candidates.map((c) => c.parcelID));

const bytes = readFileSync(RUN);
const raw = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
const container = new ArrayBuffer(raw.byteLength);
new Uint8Array(container).set(raw);
const decoded = decodeSimulationRun(container);

type Cols = Record<string, ArrayLike<number>>;
function cols(name: string): { count: number; c: Cols } {
  const s = decoded.sections.get(name);
  if (!s) throw new Error(`run has no ${name} section`);
  const c: Cols = {};
  for (const col of s.columns) c[col.name] = col.data as unknown as ArrayLike<number>;
  return { count: s.count, c };
}
const ROI = [null, "market-higher", "roi-achievable", "gap-too-large"];
const LAND_OUTCOME = ["Unknown", "Sold", "ReserveUnmet", "WinnerFailedBudget", "NoLayout", "MasterplanFinalizationFailed", "WinnerUnknown"];
const r2 = (v: number) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

// --- proforma observations ---------------------------------------------------
const pf = cols("proforma");
const pfFlat = decoded.proformaParcelIDsFlat;
const pfOff = decoded.proformaParcelIDsOffsets;
const PF_FIELDS = [
  "buildableAreaID", "buildingType", "developerID", "acquisitionCost", "salePrice", "constructionCost", "demolitionCost",
  "designPlanningManagementFees", "legalAndSurveyCosts", "fundingCost", "developmentContributionsCost",
  "waterIGCsAndConnectionCost", "landValueCaptureCost", "result", "floorspace", "height", "dwellingUnits",
  "buildingFootprintArea", "buildableAreaTotalArea", "landValue", "existingBuildingsValue", "existingBuildingsFloorspace",
  "proformaMode", "targetROI", "marketSalePrice", "roiSalePrice", "roiPriceDecision", "timestampMs", "year", "month",
];
const byParcel = new Map<number, Record<string, unknown>[]>();
const push = (pid: number, key: string, row: Record<string, unknown>) => {
  let l = byParcel.get(pid) as unknown as Record<string, Record<string, unknown>[]> | undefined;
  if (!l) byParcel.set(pid, (l = { proforma: [], startAppraisals: [], landAuctionCloses: [], created: [] } as never) as never);
  (l[key] ??= []).push(row);
};
for (let i = 0; i < pf.count; i++) {
  const s = pfOff[i], e = pfOff[i + 1];
  let hit = -1;
  for (let k = s; k < e; k++) if (wanted.has(pfFlat[k])) { hit = pfFlat[k]; break; }
  if (hit < 0) continue;
  const row: Record<string, unknown> = { proformaRow: i, parcelIDs: Array.from(pfFlat.subarray(s, e)) };
  for (const f of PF_FIELDS) row[f] = r2(pf.c[f][i]);
  row.roiPriceDecision = ROI[pf.c.roiPriceDecision[i]] ?? null;
  row.proformaMode = [null, "market-price", "roi-based"][pf.c.proformaMode[i]] ?? null;
  push(hit, "proforma", row);
}

// --- start appraisals -----------------------------------------------------------
const sa = cols("startAppraisals");
const SA_FIELDS = [
  "appraisalID", "developerID", "buildableAreaID", "timestampMs", "acquisitionCost", "salePrice", "constructionCost",
  "demolitionCost", "designPlanningManagementFees", "floorspace", "height", "dwellingUnits", "legalAndSurveyCosts",
  "fundingCost", "developmentContributionsCost", "waterIGCsAndConnectionCost", "landValueCaptureCost", "result",
];
const saByID = new Map<number, Record<string, unknown>>();
for (let i = 0; i < sa.count; i++) {
  const s = sa.c.parcelIDsOff[i], e = sa.c.parcelIDsOff[i + 1];
  const pids: number[] = [];
  for (let k = s; k < e; k++) pids.push(sa.c.parcelIDsFlat[k]);
  const hit = pids.find((p) => wanted.has(p));
  if (hit === undefined) continue;
  const row: Record<string, unknown> = { row: i, parcelIDs: pids };
  for (const f of SA_FIELDS) row[f] = r2(sa.c[f][i]);
  row.date = new Date(sa.c.timestampMs[i]).toISOString();
  saByID.set(sa.c.appraisalID[i], row);
  push(hit, "startAppraisals", row);
}

// --- land auction closes ------------------------------------------------------------
const lac = cols("landAuctionCloses");
for (let i = 0; i < lac.count; i++) {
  const pid = lac.c.parcelID[i];
  if (!wanted.has(pid)) continue;
  const row: Record<string, unknown> = { row: i };
  for (const f of Object.keys(lac.c)) row[f] = r2(lac.c[f][i]);
  row.outcome = LAND_OUTCOME[lac.c.outcome[i]];
  push(pid, "landAuctionCloses", row);
}

// --- Created rows of the buildings log -------------------------------------------------
// The ragged columns (parcel ids, replaced ids, unit areas) are indexed by the
// Created row's ORDINAL among Created rows, not by the log row
// (buildingsTxSoA.ts, `_raggedItemIndex`).
const bt = cols("buildingsTxSoA");
let item = -1;
for (let i = 0; i < bt.count; i++) {
  if (bt.c.eventType[i] !== 0) continue;
  item++;
  const s = bt.c.parcelIDsOff[item], e = bt.c.parcelIDsOff[item + 1];
  let hit = -1;
  for (let k = s; k < e; k++) if (wanted.has(bt.c.parcelIDsFlat[k])) { hit = bt.c.parcelIDsFlat[k]; break; }
  if (hit < 0) continue;
  const o0 = bt.c.originalBuildingsIDsOff[item], o1 = bt.c.originalBuildingsIDsOff[item + 1];
  const u0 = bt.c.dwellingUnitAreasOff[item], u1 = bt.c.dwellingUnitAreasOff[item + 1];
  const row: Record<string, unknown> = {
    row: i,
    monthIndex: bt.c.monthIndex[i],
    buildingID: bt.c.buildingID[i],
    buildingType: bt.c.buildingType[i],
    height: r2(bt.c.height[i]),
    floorspace: r2(bt.c.floorspace[i]),
    footprintArea: r2(bt.c.footprintArea[i]),
    totalStories: bt.c.totalStories[i],
    dwellingUnitsCount: bt.c.dwellingUnitsCount[i],
    developerID: bt.c.developerID[i],
    startDate: new Date(bt.c.startDateMs[i]).toISOString(),
    constructionDate: new Date(bt.c.constructionDateMs[i]).toISOString(),
    proformaConstructionCost: r2(bt.c.proformaConstructionCost[i]),
    proformaDemolitionCost: r2(bt.c.proformaDemolitionCost[i]),
    proformaDesignPlanningManagementFees: r2(bt.c.proformaDesignPlanningManagementFees[i]),
    proformaLegalAndSurveyCosts: r2(bt.c.proformaLegalAndSurveyCosts[i]),
    proformaFundingCost: r2(bt.c.proformaFundingCost[i]),
    proformaDevelopmentContributionsCost: r2(bt.c.proformaDevelopmentContributionsCost[i]),
    parcelIDs: Array.from({ length: e - s }, (_, k) => bt.c.parcelIDsFlat[s + k]),
    originalBuildingsIDs: Array.from({ length: o1 - o0 }, (_, k) => bt.c.originalBuildingsIDsFlat[o0 + k]),
    unitAreas: Array.from({ length: u1 - u0 }, (_, k) => r2(bt.c.dwellingUnitAreasFlat[u0 + k])),
    startAppraisalID: bt.c.startAppraisalID?.[i] ?? null,
    buildableAreaID: bt.c.buildableAreaID?.[i] ?? null,
    developerKindCode: bt.c.developerKindCode?.[i] ?? null,
  };
  push(hit, "created", row);
}

const out: Record<string, unknown> = {};
for (const pid of wanted) out[pid] = byParcel.get(pid) ?? null;
writeFileSync(DIR + "recorded.json", JSON.stringify(out, null, 1));
for (const pid of wanted) {
  const l = byParcel.get(pid) as unknown as Record<string, Record<string, unknown>[]> | undefined;
  if (!l) { console.log(pid, "nothing recorded"); continue; }
  const pfs = l.proforma ?? [];
  const months = new Set(pfs.map((r) => `${r.year}-${r.month}`));
  console.log(
    `${pid}: proforma ${pfs.length} rows in months [${[...months].join(" ")}], heights {${[...new Set(pfs.map((r) => r.height))].join(",")}}; ` +
      `starts ${(l.startAppraisals ?? []).length}; closes ${(l.landAuctionCloses ?? []).map((r) => `${r.year}-${r.month}:${r.outcome}(${r.bidderCount})`).join(",")}; ` +
      `created ${(l.created ?? []).map((r) => `${r.buildingID}@${r.monthIndex} sa${r.startAppraisalID}`).join(",")}`,
  );
}
