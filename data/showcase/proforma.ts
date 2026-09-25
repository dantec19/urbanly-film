// Re-run the engine's own pro forma (ProformaComputer.computeFromInputs, the
// compute-only build the proforma workers use) on the showcase site, with the
// run's own configuration, cost tables and keyed random draws.
//
// 1. REPRODUCE the appraisals the run recorded (109670 at 2027-12, and the
//    recorded fail/pass pair on 96520) and compare every line to the archive.
// 2. COMPUTE lower-rise alternatives on 109670: the same site, month,
//    developer and owner's ask, the engine's apartment layout rule
//    (apartment.ts) with the height capped at n storeys, the same flats.
// The bid rule (usaMultifamily/agent.ts bidAmount + computeBidFor) is private
// to the agent, so it is reproduced here line for line.
//   npx vite-node .scratch/urbanly-film/data/showcase/proforma.ts   (from the repo root)
// Writes proforma.json.
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import { Building, BuildingType } from "@domain/building";
import {
  buildComputeOnlyProformaComputer,
  type ProformaComputeConfigDTO,
  type ProformaLayoutInputs,
  type ProformaWorldInputs,
} from "@domain/proforma/computer";
import {
  keyedProformaRandom,
  monthTick,
  PROFORMA_DRAW_ACQUISITION,
  PROFORMA_DRAW_CONSTRUCTION,
  PROFORMA_DRAW_SALE_PRICE,
  setProformaSeed,
} from "@domain/proforma/proformaRandoms";
import {
  parseDemolitionCostRaw,
  parseLegalSurveyAndFundingCostsRaw,
} from "@domain/simulation-input/transforms";
import {
  buildConstructionCostLookup,
  getConstructionCostYears,
  parseConstructionCostParams,
} from "@shared/constructionCost/parametricConstructionCost";
import { PriceIndex } from "@shared/economics/priceIndex";
import { decodeSimulationRun } from "@shared/simulation-run-binary/decode";

import { bootstrapDeterministicMath } from "../../../../src/wasm/deterministic-math/bootstrap.ts";

const DIR = ".scratch/urbanly-film/data/showcase/";
const RUN = ".scratch/urbanly-film/data/sim/runs/ba-2022-2031-s123456/run.ccsr";
const REGION = "public/buenosaires/";
const RESIDUAL_RETURN = 0.15; // BuenosairesRegionConfig.ts:69, :246 (residualBidReturnOnCost)
const LAND_BID_PREMIUM = 0.05; // BuenosairesRegionConfig.ts:256 (landBidPremiumOverAsk)
const STOREY_M = 3; // BuenosairesRegionConfig.ts:1046 (defaultStoreyHeight)

// The legal/funding calculator reads dMath.log (build months); the CLI boots it
// the same way (cli/simulate/simulate-main.ts:728).
await bootstrapDeterministicMath();

// --- the run -------------------------------------------------------------------
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
const mc = decoded.runMetadata.modelConfig as unknown as {
  startYear: number;
  endYear: number;
  proformaMode: "roi-based" | "market-price";
  targetROI: number;
  newBuildSalePremium: Record<string, number>;
  dwellingPriceBasis: "all-in" | "improvement";
  designFeeStoriesBasis: "layout" | "zoning";
  designFeeShareOfConstruction: Record<string, number>;
  saleCostsShareOfRevenue: number;
  applyDevelopmentContributionCosts?: boolean;
  nonResidentialTypologyFallback?: never;
  macroEconomy: ProformaComputeConfigDTO["macroEconomy"];
  hyperparameters: { props: { roiMarketGapThreshold: number } };
};
setProformaSeed(decoded.runMetadata.randomSeed as number);

// --- the engine's config, built as marketCore.ts:383-410 builds the worker DTO --
const priceIndex = new PriceIndex(mc.macroEconomy.inflation);
const ccParams = parseConstructionCostParams(
  JSON.parse(gunzipSync(readFileSync(REGION + "construction-costs-lut.json.gz")).toString("utf8")),
);
// construction-cost-loader.ts:32-49 (the "file" basis, BuenosairesRegionConfig.ts:578);
// region horizon 2022-2032 (BuenosairesRegionConfig.ts:124-125) -> LUT years 2013-2032.
const constructionCostLookup = buildConstructionCostLookup(
  ccParams,
  getConstructionCostYears(2022, 2032, ccParams.baseYear),
  priceIndex,
);
const demolitionCostLookup = parseDemolitionCostRaw(
  JSON.parse(readFileSync(REGION + "demolition-costs-lut.json", "utf8")),
);
const { legalAndSurveyCostsPercentageLookup } = parseLegalSurveyAndFundingCostsRaw(
  JSON.parse(gunzipSync(readFileSync(REGION + "simulation/legal-survey-and-funding-costs-lut.json.gz")).toString("utf8")),
);
const dto: ProformaComputeConfigDTO = {
  pricingPolicy: {
    dwellingPriceBasis: mc.dwellingPriceBasis,
    designFeeStoriesBasis: mc.designFeeStoriesBasis,
    saleCostsShareOfRevenue: mc.saleCostsShareOfRevenue,
    designFeeShareOfConstruction: mc.designFeeShareOfConstruction as never,
  },
  constructionCostLookup,
  nonResidentialTypologyFallback: mc.nonResidentialTypologyFallback,
  demolitionCostLookup,
  legalAndSurveyCostsPercentageLookup,
  macroEconomy: mc.macroEconomy,
  startYear: mc.startYear,
  defaultStoreyHeight: STOREY_M,
  proformaMode: mc.proformaMode,
  targetROI: mc.targetROI,
  roiMarketGapThreshold: mc.hyperparameters.props.roiMarketGapThreshold,
  applyDevelopmentContributionCosts: mc.applyDevelopmentContributionCosts ?? false,
};
const computer = buildComputeOnlyProformaComputer(dto);

// newBuildPremiumFn (marketCore.ts:598-615): the last listed year holds after it.
function newBuildPremium(year: number): number {
  const years = Object.keys(mc.newBuildSalePremium).map(Number).sort((a, b) => a - b);
  let v = mc.newBuildSalePremium[String(years[0])];
  for (const y of years) if (y <= year) v = mc.newBuildSalePremium[String(y)];
  return v;
}

// --- recorded rows -------------------------------------------------------------
const pf = cols("proforma");
const lac = cols("landAuctionCloses");
const bt = cols("buildingsTxSoA");
const FIELDS = [
  "acquisitionCost", "salePrice", "marketSalePrice", "roiSalePrice", "constructionCost", "demolitionCost",
  "designPlanningManagementFees", "legalAndSurveyCosts", "fundingCost", "developmentContributionsCost",
  "waterIGCsAndConnectionCost", "landValueCaptureCost", "result",
] as const;
const ROI = [null, "market-higher", "roi-achievable", "gap-too-large"];
function recordedRow(i: number): Record<string, number | string | null> {
  const o: Record<string, number | string | null> = {};
  for (const f of [...FIELDS, "floorspace", "height", "dwellingUnits", "buildingFootprintArea", "buildableAreaTotalArea", "landValue", "existingBuildingsValue", "existingBuildingsFloorspace", "developerID", "buildableAreaID", "timestampMs"]) {
    o[f] = pf.c[f][i];
  }
  o.roiPriceDecision = ROI[pf.c.roiPriceDecision[i]] ?? null;
  return o;
}
function closeFor(parcelID: number, ms: number): number {
  for (let i = 0; i < lac.count; i++) if (lac.c.parcelID[i] === parcelID && lac.c.timestampMs[i] === ms) return i;
  return -1;
}
function unitAreaOf(buildingID: number): number {
  let item = -1;
  for (let i = 0; i < bt.count; i++) {
    if (bt.c.eventType[i] !== 0) continue;
    item++;
    if (bt.c.buildingID[i] === buildingID) return bt.c.dwellingUnitAreasFlat[bt.c.dwellingUnitAreasOff[item]];
  }
  throw new Error(`no Created row for ${buildingID}`);
}

// --- one pro forma + the agent's bid rule --------------------------------------
interface Standing { id: number; heightM: number; floorAreaM2: number; type: BuildingType }
interface Case {
  label: string;
  parcelID: number;
  agentID: number;
  dateMs: number;
  baseZone: string;
  standing: Standing[];
  parcelArea: number;
  landValue: number;
  existingBuildingsValue: number;
  // layout
  stories: number;
  footprintArea: number;
  floorspace: number;
  units: number;
  unitArea: number;
  // price per m² of dwelling floor the prices surface returned (all-in USD)
  dwellingPricePerM2: number;
  reserve: number;
}
function run(k: Case) {
  const date = new Date(k.dateMs);
  const year = date.getUTCFullYear();
  const layout: ProformaLayoutInputs = {
    buildingType: BuildingType.Apartment,
    buildingHeight: k.stories * STOREY_M,
    areaID: k.parcelID,
    layoutTotalFloorspace: k.floorspace,
    layoutDwellingUnits: k.units,
    maximumStories: k.stories,
    footprintArea: k.footprintArea,
    parcelsIDs: [k.parcelID],
    salesLocationCategory: "1" as never, // file-basis LUT: same cost for every category (parametricConstructionCost.ts:199-202)
    costsFloorspace: k.floorspace,
    costsDwellingUnits: k.units,
    dwellingUnitsFloorspace: k.units * k.unitArea,
  };
  const world: ProformaWorldInputs = {
    parcelID: k.parcelID,
    parcelArea: k.parcelArea,
    landValuePerSQM: k.landValue / k.parcelArea,
    landValueCaptureLandValuePerSQM: 0,
    existingBuildings: k.standing.map((b) => ({ ID: b.id, height: b.heightM, floorspace: b.floorAreaM2, buildingType: b.type, dwellingUnits: [], footprint: null }) as unknown as Building),
    existingBuildingsValue: k.existingBuildingsValue,
    baseZone: k.baseZone as never,
    zoningMaxStories: k.stories,
    dwellingSalePrice: k.dwellingPricePerM2 * k.units * k.unitArea,
    salePriceMultiplierValue: newBuildPremium(year),
    landValueCaptureExtraBuildableM2: 0,
  };
  const r = computer.computeFromInputs(layout, world, date, k.agentID);
  if (!r) throw new Error(`${k.label}: computeFromInputs returned null`);
  const a = r.proformaArgs;
  const m = r.transactionMetadata as unknown as Record<string, number | string>;
  const costsExcl = a.constructionCost + a.demolitionCost + a.designPlanningManagementFees + a.legalAndSurveyCosts +
    a.fundingCost + a.developmentContributionsCost + a.waterIGCsAndConnectionCost + a.landValueCaptureCost;
  const result = a.salePrice - a.acquisitionCost - costsExcl; // proforma.ts:48-61
  // bidAmount (usaMultifamily/agent.ts:614-621) and computeBidFor (:517-541, :595-597)
  const market = Math.min(a.salePrice, a.uncappedMarketSalePrice ?? a.salePrice);
  const maxLandBid = market / (1 + RESIDUAL_RETURN) - costsExcl;
  const bids = maxLandBid > 0 && maxLandBid >= k.reserve;
  const offered = bids ? Math.min(maxLandBid, k.reserve * (1 + LAND_BID_PREMIUM)) : null;
  const tick = monthTick(date);
  return {
    label: k.label,
    stories: k.stories,
    heightM: k.stories * STOREY_M,
    residentialStories: Math.round(k.floorspace / k.footprintArea),
    floorspaceM2: k.floorspace,
    units: k.units,
    unitAreaM2: k.unitArea,
    draws: {
      tick,
      acquisition: 0.98 + keyedProformaRandom(k.agentID, k.parcelID, tick, PROFORMA_DRAW_ACQUISITION) * 0.04,
      construction: 0.95 + keyedProformaRandom(k.agentID, k.parcelID, tick, PROFORMA_DRAW_CONSTRUCTION) * 0.1,
      salePrice: 0.97 + keyedProformaRandom(k.agentID, k.parcelID, tick, PROFORMA_DRAW_SALE_PRICE) * 0.06,
      newBuildPremium: newBuildPremium(year),
    },
    proforma: {
      acquisitionCost: a.acquisitionCost,
      salePrice: a.salePrice,
      marketSalePrice: m.marketSalePrice as number,
      roiSalePrice: m.roiSalePrice as number,
      roiPriceDecision: m.roiPriceDecision as string,
      constructionCost: a.constructionCost,
      demolitionCost: a.demolitionCost,
      designPlanningManagementFees: a.designPlanningManagementFees,
      legalAndSurveyCosts: a.legalAndSurveyCosts,
      fundingCost: a.fundingCost,
      developmentContributionsCost: a.developmentContributionsCost,
      waterIGCsAndConnectionCost: a.waterIGCsAndConnectionCost,
      landValueCaptureCost: a.landValueCaptureCost,
      result,
      landValue: m.landValue as number,
      existingBuildingsValue: m.existingBuildingsValue as number,
    },
    bid: {
      revenueForBid: market,
      costsExcludingLand: costsExcl,
      maxLandBid,
      ownersAsk: k.reserve,
      verdict: bids ? "PASS" : "FAIL",
      shortfall: bids ? 0 : k.reserve - maxLandBid,
      offered,
      profitAtPricePaid: offered === null ? null : market - offered - costsExcl,
      returnOnCostAtPricePaid: offered === null ? null : (market - offered - costsExcl) / (offered + costsExcl),
    },
  };
}
function compare(label: string, got: ReturnType<typeof run>, rec: Record<string, number | string | null>) {
  const rows: Record<string, { recorded: number | string | null; recomputed: number | string; diff: number | null }> = {};
  let worst = 0;
  for (const f of FIELDS) {
    const g = (got.proforma as Record<string, number | string>)[f];
    const r = rec[f];
    const diff = typeof r === "number" && typeof g === "number" ? g - r : null;
    if (diff !== null) worst = Math.max(worst, Math.abs(diff));
    rows[f] = { recorded: r, recomputed: g, diff };
  }
  rows.roiPriceDecision = { recorded: rec.roiPriceDecision, recomputed: got.proforma.roiPriceDecision, diff: null };
  console.log(`${label}: largest |recomputed - recorded| = ${worst.toExponential(2)} USD; decision ${got.proforma.roiPriceDecision} vs ${rec.roiPriceDecision}`);
  return { maxAbsDiffUSD: worst, fields: rows };
}
// Back the dwelling price per m² out of the recorded market sale price: the one
// input the archive does not carry (the prices surface at that month).
function pricePerM2(rec: Record<string, number | string | null>, agentID: number, parcelID: number, units: number, unitArea: number) {
  const date = new Date(rec.timestampMs as number);
  const tick = monthTick(date);
  const saleVar = 0.97 + keyedProformaRandom(agentID, parcelID, tick, PROFORMA_DRAW_SALE_PRICE) * 0.06;
  const market = rec.marketSalePrice as number;
  return market / (saleVar * newBuildPremium(date.getUTCFullYear()) * (1 - mc.saleCostsShareOfRevenue)) / (units * unitArea);
}

// --- 109670, Caballito: the showcase -------------------------------------------
const SHOW = { parcelID: 109670, proformaRow: 53358, buildingID: 1879098124 };
const recS = recordedRow(SHOW.proformaRow);
const closeS = closeFor(SHOW.parcelID, recS.timestampMs as number);
const reserveS = lac.c.reservePrice[closeS];
const unitAreaS = unitAreaOf(SHOW.buildingID);
const unitsS = recS.dwellingUnits as number;
const agentS = recS.developerID as number;
const baseS = {
  parcelID: SHOW.parcelID,
  agentID: agentS,
  dateMs: recS.timestampMs as number,
  baseZone: "CM-4", // parcels_zones.json index 8 (data/ba), zoning/zonings.json
  standing: [{ id: 12089, heightM: 8.4, floorAreaM2: recS.existingBuildingsFloorspace as number, type: BuildingType.Terrace }],
  parcelArea: recS.buildableAreaTotalArea as number,
  landValue: recS.landValue as number,
  existingBuildingsValue: recS.existingBuildingsValue as number,
  footprintArea: recS.buildingFootprintArea as number,
  unitArea: unitAreaS,
  dwellingPricePerM2: pricePerM2(recS, agentS, SHOW.parcelID, unitsS, unitAreaS),
  reserve: reserveS,
};
const unitsPerFloor = unitsS / ((recS.floorspace as number) / (recS.buildingFootprintArea as number));
const built = run({ ...baseS, label: "built: 10 storeys (recorded appraisal reproduced)", stories: recS.height as number / STOREY_M, floorspace: recS.floorspace as number, units: unitsS });
const builtCheck = compare("109670 built", built, recS);
const ladder = [];
for (let n = 3; n <= 10; n++) {
  const residential = n - 1; // apartment.ts:127 "First floor is not residential"
  ladder.push(run({ ...baseS, label: `${n} storeys`, stories: n, floorspace: baseS.footprintArea * residential, units: unitsPerFloor * residential }));
}
for (const l of ladder) console.log(`  ${l.label}: revenue ${l.bid.revenueForBid.toFixed(0)} costs ${l.bid.costsExcludingLand.toFixed(0)} max land bid ${l.bid.maxLandBid.toFixed(0)} vs ask ${l.bid.ownersAsk.toFixed(0)} -> ${l.bid.verdict}`);

// --- 96520, Colegiales: the recorded fail/pass pair, reproduced ------------------
const repro96520 = [];
for (const row of [4765, 13924]) {
  const rec = recordedRow(row);
  const agent = rec.developerID as number;
  const units = rec.dwellingUnits as number;
  const unitArea = ((rec.floorspace as number) * 0.9) / units; // fallback (agent.ts:824,843) and apartment layouts both sell 0.9 x floor area
  const close = closeFor(96520, 1693526400000);
  const k: Case = {
    label: `96520 ${new Date(rec.timestampMs as number).toISOString().slice(0, 7)}`,
    parcelID: 96520, agentID: agent, dateMs: rec.timestampMs as number, baseZone: "CM-4",
    standing: [
      { id: 368738, heightM: 8.4, floorAreaM2: 524.4000244140625, type: BuildingType.NonResidential },
      { id: 368739, heightM: 5.599999904632568, floorAreaM2: (rec.existingBuildingsFloorspace as number) - 524.4000244140625, type: BuildingType.Terrace },
    ],
    parcelArea: rec.buildableAreaTotalArea as number, landValue: rec.landValue as number,
    existingBuildingsValue: rec.existingBuildingsValue as number,
    stories: (rec.height as number) / STOREY_M, footprintArea: rec.buildingFootprintArea as number,
    floorspace: rec.floorspace as number, units, unitArea,
    dwellingPricePerM2: pricePerM2(rec, agent, 96520, units, unitArea),
    // 2022-09: no close; the ask then was the listing's undecayed reserve (see showcase.json).
    reserve: row === 13924 ? lac.c.reservePrice[close] : lac.c.reservePrice[close] / Math.pow(0.997, 8),
  };
  const got = run(k);
  repro96520.push({ proformaRow: row, ...got, check: compare(k.label, got, rec) });
}

writeFileSync(DIR + "proforma.json", JSON.stringify({
  note: "recomputed with ProformaComputer.computeFromInputs (compute-only build) from the run's own config; see proforma.ts",
  config: {
    randomSeed: decoded.runMetadata.randomSeed,
    proformaMode: mc.proformaMode, targetROI: mc.targetROI, roiMarketGapThreshold: dto.roiMarketGapThreshold,
    saleCostsShareOfRevenue: mc.saleCostsShareOfRevenue, dwellingPriceBasis: mc.dwellingPriceBasis,
    designFeeShareOfConstruction: mc.designFeeShareOfConstruction, newBuildSalePremium: mc.newBuildSalePremium,
    inflation: mc.macroEconomy.inflation, constructionLoan: mc.macroEconomy.constructionLoan,
    constructionCostParams: ccParams, apartmentCostPerM2: Object.fromEntries([2022, 2023, 2026, 2027].map((y) => [y, constructionCostLookup[`Apartment:Medium:1:false:${y}`]])),
    demolitionCM4: demolitionCostLookup["CM-4" as never],
    legalApartmentCM4: legalAndSurveyCostsPercentageLookup["Apartment:CM-4"],
    residualBidReturnOnCost: RESIDUAL_RETURN, landBidPremiumOverAsk: LAND_BID_PREMIUM,
  },
  showcase: {
    parcelID: SHOW.parcelID, proformaRow: SHOW.proformaRow, landAuctionCloseRow: closeS,
    dwellingPricePerM2BackedOut: baseS.dwellingPricePerM2, unitsPerFloor, unitArea: unitAreaS,
    built: { ...built, check: builtCheck },
    ladder,
  },
  colegiales96520: repro96520,
}, null, 1));
console.log("wrote proforma.json");
