// Find ar-multifamily sites whose RECORDED history holds a failed appraisal
// before the one that won: an appraisal the engine computed (proforma
// section) that led to no bid, followed later by the appraisal a start used.
//   npx vite-node .scratch/urbanly-film/data/showcase/scan-fail-pass.ts   (from the repo root)
// Writes fail-pass.json (one row per single-parcel ar-multifamily site that has
// an earlier appraisal by an ar-multifamily developer).
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import { decodeSimulationRun } from "@shared/simulation-run-binary/decode";

const DIR = ".scratch/urbanly-film/data/showcase/";
const RUN = ".scratch/urbanly-film/data/sim/runs/ba-2022-2031-s123456/run.ccsr";
const RETURN = 0.15; // BuenosairesRegionConfig.ts:69 (residualBidReturnOnCost, :246)
const AR_MULTIFAMILY = 9; // kinds.ts DEVELOPER_KIND_CODE

const bytes = readFileSync(RUN);
const raw = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
const container = new ArrayBuffer(raw.byteLength);
new Uint8Array(container).set(raw);
const decoded = decodeSimulationRun(container);
type Cols = Record<string, ArrayLike<number>>;
function cols(name: string): { count: number; c: Cols } {
  const s = decoded.sections.get(name)!;
  const c: Cols = {};
  for (const col of s.columns) c[col.name] = col.data as unknown as ArrayLike<number>;
  return { count: s.count, c };
}

// ar-multifamily developers and the single-parcel sites they started.
const bt = cols("buildingsTxSoA");
const arDevs = new Set<number>();
const sites = new Map<number, { buildings: number[]; startAppraisalIDs: number[] }>();
let item = -1;
for (let i = 0; i < bt.count; i++) {
  if (bt.c.eventType[i] !== 0) continue;
  item++;
  if (bt.c.developerKindCode[i] !== AR_MULTIFAMILY) continue;
  arDevs.add(bt.c.developerID[i]);
  const s = bt.c.parcelIDsOff[item], e = bt.c.parcelIDsOff[item + 1];
  if (e - s !== 1) continue;
  const pid = bt.c.parcelIDsFlat[s];
  let site = sites.get(pid);
  if (!site) sites.set(pid, (site = { buildings: [], startAppraisalIDs: [] }));
  site.buildings.push(bt.c.buildingID[i]);
  site.startAppraisalIDs.push(bt.c.startAppraisalID[i]);
}

// Sold closes per parcel.
const lac = cols("landAuctionCloses");
const soldByParcel = new Map<number, number>();
const closesByParcel = new Map<number, number[]>();
for (let i = 0; i < lac.count; i++) {
  const pid = lac.c.parcelID[i];
  if (!sites.has(pid)) continue;
  (closesByParcel.get(pid) ?? closesByParcel.set(pid, []).get(pid)!).push(i);
  if (lac.c.outcome[i] === 1) soldByParcel.set(pid, i);
}

// Appraisals by ar-multifamily developers on those parcels.
const pf = cols("proforma");
const flat = decoded.proformaParcelIDsFlat, off = decoded.proformaParcelIDsOffsets;
const rowsByParcel = new Map<number, number[]>();
for (let i = 0; i < pf.count; i++) {
  if (off[i + 1] - off[i] !== 1) continue;
  const pid = flat[off[i]];
  if (!sites.has(pid) || !arDevs.has(pf.c.developerID[i])) continue;
  (rowsByParcel.get(pid) ?? rowsByParcel.set(pid, []).get(pid)!).push(i);
}
const costsExcl = (i: number) =>
  pf.c.constructionCost[i] + pf.c.demolitionCost[i] + pf.c.designPlanningManagementFees[i] +
  pf.c.legalAndSurveyCosts[i] + pf.c.fundingCost[i] + pf.c.developmentContributionsCost[i] +
  pf.c.waterIGCsAndConnectionCost[i] + pf.c.landValueCaptureCost[i];
const market = (i: number) => Math.min(pf.c.salePrice[i], Number.isNaN(pf.c.marketSalePrice[i]) ? pf.c.salePrice[i] : pf.c.marketSalePrice[i]);
const residual = (i: number) => market(i) / (1 + RETURN) - costsExcl(i);
const r0 = (v: number) => Math.round(v);

const out: unknown[] = [];
for (const [pid, rows] of rowsByParcel) {
  const sold = soldByParcel.get(pid);
  if (sold === undefined) continue;
  const soldMs = lac.c.timestampMs[sold];
  const earlier = rows.filter((i) => pf.c.timestampMs[i] < soldMs);
  if (earlier.length === 0) continue;
  const at = rows.filter((i) => pf.c.timestampMs[i] === soldMs);
  const d = (ms: number) => new Date(ms).toISOString().slice(0, 7);
  out.push({
    parcelID: pid,
    buildings: sites.get(pid)!.buildings,
    sold: {
      date: d(soldMs),
      reservePrice: r0(lac.c.reservePrice[sold]),
      winningOffer: r0(lac.c.winningOffer[sold]),
      winner: lac.c.winnerDeveloperID[sold],
      bidders: lac.c.bidderCount[sold],
    },
    closes: (closesByParcel.get(pid) ?? []).map((k) => ({ date: d(lac.c.timestampMs[k]), outcome: lac.c.outcome[k], reserve: r0(lac.c.reservePrice[k]) })),
    appraisals: [...earlier, ...at].map((i) => ({
      row: i,
      date: d(pf.c.timestampMs[i]),
      dev: pf.c.developerID[i],
      height: pf.c.height[i],
      units: pf.c.dwellingUnits[i],
      floorspace: r0(pf.c.floorspace[i]),
      market: r0(market(i)),
      costsExcl: r0(costsExcl(i)),
      residual: r0(residual(i)),
      capitalValue: r0(Math.max(pf.c.existingBuildingsValue[i], pf.c.landValue[i])),
      landValue: r0(pf.c.landValue[i]),
      existingBuildingsValue: r0(pf.c.existingBuildingsValue[i]),
    })),
  });
}
writeFileSync(DIR + "fail-pass.json", JSON.stringify(out, null, 1));
console.log(`${arDevs.size} ar-multifamily developers; ${sites.size} single-parcel sites; ${out.length} with an earlier appraisal`);
