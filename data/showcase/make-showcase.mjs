// Assemble showcase.json: the chosen development (parcel 109670, Caballito),
// its old and new buildings, the pro forma of the built option (recorded by
// the run) and of a rejected option (recomputed with the engine), the receipt
// lines, and the two runners-up.
//   node .scratch/urbanly-film/data/showcase/make-showcase.mjs   (from the repo root)
// Inputs: data/ba arrays, sim/buenosaires-developments.json, and in this folder
// recorded.json (extract-recorded.ts), buildings-rows.json (buildings-rows.ts),
// proforma.json (proforma.ts), candidates.json / clean-geometry.json.
import { readFileSync, writeFileSync } from "node:fs";

const ROOT = ".scratch/urbanly-film/data/";
const DIR = ROOT + "showcase/";
const J = (p) => JSON.parse(readFileSync(p, "utf8"));
const rd = (n, T) => { const b = readFileSync(ROOT + "ba/" + n); return new T(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };

const man = J(ROOT + "ba/manifest.json");
const { lon0, lat0, R } = man.projection;
const DEG = Math.PI / 180;
const lonLat = ([x, y]) => [+(lon0 + x / (R * Math.cos(lat0 * DEG) * DEG)).toFixed(6), +(lat0 + y / (R * DEG)).toFixed(6)];
const r1 = (v) => Math.round(v * 10) / 10, r2 = (v) => Math.round(v * 100) / 100;

const pID = rd("parcels_id.u32", Uint32Array), pOff = rd("parcels_ring_offsets.u32", Uint32Array), pXY = rd("parcels_xy.f32", Float32Array);
const pCent = rd("parcels_centroid.f32", Float32Array), pArea = rd("parcels_area.f32", Float32Array);
const pZone = rd("parcels_zone.u16", Uint16Array), pMaxH = rd("parcels_zone_max_height.f32", Float32Array), pCov = rd("parcels_zone_max_coverage.f32", Float32Array), pFar = rd("parcels_zone_far.f32", Float32Array);
const pLand = rd("parcels_land_value.f32", Float32Array), pApt = rd("parcels_apartment_price.f32", Float32Array), pBuilt = rd("parcels_built_floor_area.f32", Float32Array);
const zones = J(ROOT + "ba/parcels_zones.json");
const rowOf = new Map(); for (let r = 0; r < pID.length; r++) rowOf.set(pID[r], r);

const dev = J(ROOT + "sim/buenosaires-developments.json");
const devByID = new Map(dev.buildings.map((b) => [b.id, b]));
const demoByID = new Map(dev.demolitions.map((d) => [d.id, d]));
const recorded = J(DIR + "recorded.json");
const bRows = new Map(J(DIR + "buildings-rows.json").map((b) => [b.seedID, b]));
const pf = J(DIR + "proforma.json");
const geo = new Map(J(DIR + "clean-geometry.json").map((g) => [g.parcelID, g]));
const cand = new Map(J(DIR + "candidates.json").map((c) => [c.parcelID, c]));

function parcel(pid) {
  const row = rowOf.get(pid);
  const c = [pCent[row * 2], pCent[row * 2 + 1]];
  const z = zones[pZone[row]];
  return {
    row, parcelID: pid,
    areaM2: r2(pArea[row]),
    centroidM: c.map(r2), lonLat: lonLat(c),
    ringM: Array.from(pXY.subarray(pOff[row] * 2, pOff[row + 1] * 2), r2),
    zone: {
      name: z.name, baseZone: z.baseZone,
      maxHeightM: r2(pMaxH[row]),
      maxCoverage: Number.isNaN(pCov[row]) ? null : r2(pCov[row]),
      maxCoverageNote: Number.isNaN(pCov[row]) ? "none stated: the engine builds on the whole lot (apartment.ts:77-83)" : undefined,
      far: Number.isNaN(pFar[row]) ? null : pFar[row],
    },
    landValueUSDperM2_2022: r2(pLand[row]),
    apartmentPriceUSDperM2_2022: r2(pApt[row]),
    builtFloorAreaM2: r1(pBuilt[row]),
  };
}
function oldBuilding(id) {
  const b = bRows.get(id), d = demoByID.get(id);
  return {
    seedID: id, row: b.row, type: d.type, typeInBaData: b.type, heightM: b.heightM, stories: d.stories,
    floorAreaM2: b.floorAreaM2, units: d.units, primaryParcelRow: b.primaryParcelRow, primaryParcelID: b.primaryParcelID,
    parcelsTouched: d.parcels, demolished: d.date,
    rowVerification: `buildings.bin id ${b.binaryRowID} at source row ${b.row}; data/ba row ${b.row} ring matches the export's demolished footprint (mean vertex gap ${b.check.meanVertexGapM} m), its centroid lies inside it, and height ${b.heightM} m / floor area ${b.floorAreaM2} m2 / type agree`,
    ringM: b.footprint,
  };
}
function newBuilding(id) {
  const b = devByID.get(id);
  return {
    id, kind: b.kind, type: b.type, heightM: b.heightM, stories: b.stories, units: b.units, floorAreaM2: b.floorAreaM2,
    footprintAreaM2: b.footprintAreaM2, lotAreaM2: b.lotAreaM2, start: b.start, complete: b.complete,
    replaces: b.replaces, footprintRingsM: b.footprint,
  };
}

// ---------------------------------------------------------------- the showcase
const P = 109670;
const rec = recorded[P];
const created = rec.created[0], sa = rec.startAppraisals[0], close = rec.landAuctionCloses[0], pfRow = rec.proforma[0];
const S = pf.showcase, B = S.built, A = S.ladder.find((l) => l.stories === 3), L4 = S.ladder.find((l) => l.stories === 4);
const lotParcel = parcel(P);
const g = geo.get(P);

function items(o) {
  const p = o.proforma, b = o.bid;
  return {
    salesRevenueNetOfSaleCosts: r2(p.marketSalePrice),
    salesBuildUp: {
      soldFloorAreaM2: r2(o.units * o.unitAreaM2),
      dwellingPriceUSDperM2: r2(S.dwellingPricePerM2BackedOut),
      newBuildPremium: o.draws.newBuildPremium,
      salePriceDraw: +o.draws.salePrice.toFixed(6),
      saleCostsShare: pf.config.saleCostsShareOfRevenue,
    },
    constructionCost: r2(p.constructionCost),
    constructionBuildUp: { floorAreaM2: r2(o.floorspaceM2), costUSDperM2: r2(pf.config.apartmentCostPerM2["2027"]), constructionDraw: +o.draws.construction.toFixed(6) },
    demolitionCost: r2(p.demolitionCost),
    demolitionBuildUp: "573.9 m2 x 200 USD/m2 (CM-4, 2+ storeys, 2022 USD) x 1.873213 (price index 2022->2027)",
    designPlanningManagementFees: r2(p.designPlanningManagementFees),
    legalAndSurveyCosts: r2(p.legalAndSurveyCosts),
    fundingCost: r2(p.fundingCost),
    developmentContributions_water_landValueCapture: r2(p.developmentContributionsCost + p.waterIGCsAndConnectionCost + p.landValueCaptureCost),
    costsExcludingLand: r2(b.costsExcludingLand),
    proformaSiteValue: {
      acquisitionCost: r2(p.acquisitionCost),
      note: "the pro forma's own site cost: max(standing buildings' value, land value) x acquisition draw; not what the developer pays",
      standingBuildingsValue: r2(p.existingBuildingsValue), landValue: r2(p.landValue), acquisitionDraw: +o.draws.acquisition.toFixed(6),
    },
    roi: { roiSalePrice: r2(p.roiSalePrice), decision: p.roiPriceDecision, salePriceUsed: r2(p.salePrice) },
    proformaProfit: r2(p.result),
    proformaMarginOnCost: +(p.result / (p.acquisitionCost + b.costsExcludingLand)).toFixed(4),
    hurdle: {
      rule: "max land bid = market sales / (1 + 0.15) - costs excluding land; bid only if max land bid >= owner's ask; offer = min(max land bid, ask x 1.05)",
      developersReturnAtMaxBid: r2(b.revenueForBid - b.revenueForBid / 1.15),
      maxLandBid: r2(b.maxLandBid),
      ownersAsk: r2(b.ownersAsk),
      verdict: b.verdict,
      shortfall: b.verdict === "FAIL" ? r2(b.shortfall) : 0,
      landPricePaid: b.offered === null ? null : r2(b.offered),
      profitAtPricePaid: b.profitAtPricePaid === null ? null : r2(b.profitAtPricePaid),
      returnOnCostAtPricePaid: b.returnOnCostAtPricePaid === null ? null : +b.returnOnCostAtPricePaid.toFixed(4),
    },
  };
}
const receipt = (o, title, source) => {
  const b = o.bid;
  const margin = b.revenueForBid - b.revenueForBid / 1.15;
  return {
    title, source,
    note: "usd is exact to the cent; usdK is rounded to thousands and the lines add up in that unit (whole dollars can be off by 1 from rounding)",
    lines: [
      { label: `Sale of ${o.units} flats, after 8.75% selling costs`, usd: r2(b.revenueForBid) },
      { label: "Build: construction, demolition, fees, legal", usd: -r2(b.costsExcludingLand) },
      { label: "Developer's 15% return on cost", usd: -r2(margin) },
      { label: "Left to pay for the land", usd: r2(b.maxLandBid) },
      { label: "Owner's asking price", usd: r2(b.ownersAsk) },
      b.verdict === "PASS"
        ? { label: "Pencils out: buys the lot at the ask + 5%", usd: r2(b.offered), verdict: "PASS" }
        : { label: "Does not pencil out: short by", usd: r2(b.shortfall), verdict: "FAIL" },
    ].map((l) => ({ ...l, usdK: Math.round(l.usd / 1000) })),
  };
};

const showcase = {
  developmentID: created.buildingID,
  barrio: "Caballito",
  street: "Avenida José María Moreno (mid-block; front edge 13.7 m from the avenue's centreline, back edge has no street within 40 m)",
  parcel: {
    ...lotParcel,
    frontageM: g.frontage, depthM: g.depth,
    buildableAreaM2InRun: r2(pfRow.buildableAreaTotalArea),
    landValueUSDperM2_2027_12_inRun: r2(pfRow.landValue / pfRow.buildableAreaTotalArea),
    apartmentPriceUSDperM2_2027_12_inProforma: {
      value: r2(S.dwellingPricePerM2BackedOut),
      note: "price of a 142.3 m2 flat on this lot at 2027-12, before the new-build premium; backed out of the recorded sale price (the archive does not store the price surface)",
    },
  },
  oldBuildings: [{ ...oldBuilding(12089), inLotShare: g.olds[0].inLot }],
  newBuilding: {
    ...newBuilding(created.buildingID),
    residentialStories: 9,
    unitAreaM2: r2(S.unitArea),
    floorAreaM2Exact: r2(created.floorspace),
    floorAreaNote: "the engine counts 9 floors x 316.19 m2: the ground floor is not residential and is not counted or costed (apartment.ts:127, :145)",
    developerID: created.developerID,
    footprintNote: "the run's footprint ring is the lot polygon (no coverage limit in this zone), so the building fills the dashed envelope: 10 storeys x 3 m = 30 m under the 31.2 m cap",
  },
  nearby: { completedInRunWithin500m: g.all500, arMultifamilyWithin500m: g.mf500 },
  runRecords: {
    proformaRow: pfRow.proformaRow, startAppraisalsRow: sa.row, appraisalID: sa.appraisalID,
    landAuctionClosesRow: close.row, listingID: close.listingID, bidders: close.bidderCount, outcome: close.outcome,
    reservePrice: close.reservePrice, winningOffer: close.winningOffer, buildingsTxRow: created.row,
  },
  proforma: {
    when: "2027-12 (tick 24335), developer 79 (ar-multifamily), site 109670, owner's ask 1,066,851.43",
    optionB_built: {
      product: "10 storeys, 18 flats of 142.29 m2, 2,845.70 m2 counted floor area",
      status: "RECORDED by the run (proforma row 53358 = start appraisal 14651; auction close row 4150), and reproduced with ProformaComputer.computeFromInputs to within 2e-9 USD on every line",
      ...items(B),
    },
    optionA_rejected: {
      product: "3 storeys, 4 flats of 142.29 m2, 632.38 m2 counted floor area (the old house has 573.9 m2)",
      status: "RECOMPUTED, not in the run: computeFromInputs on the same site, month, developer, random draws and ask; layout = the engine's apartment rule (apartment.ts) with the height capped at 3 storeys, same flats (2 per floor); dwelling price per m2 = the one backed out of option B (same flat size, so the same price)",
      why3storeys: "3 storeys is the smallest apartment building the engine's layout rule produces (apartment.ts:107-110 declines under 3 storeys; :131-132 needs >= 4 flats); its floor area is the closest the rule gets to the old house's",
      ...items(A),
    },
    breakEven: `4 storeys already pencils out (max land bid ${r2(L4.bid.maxLandBid)} >= ask); 3 does not`,
    ladder: S.ladder.map((l) => ({ stories: l.stories, units: l.units, floorAreaM2: r2(l.floorspaceM2), sales: r2(l.bid.revenueForBid), costsExcludingLand: r2(l.bid.costsExcludingLand), maxLandBid: r2(l.bid.maxLandBid), verdict: l.bid.verdict })),
  },
  receipt: {
    optionA: receipt(A, "Option 1 · 3 floors · 4 flats", "recomputed with the engine's pro forma"),
    optionB: receipt(B, "Option 2 · 10 floors · 18 flats", "recorded by the run"),
  },
};

// ---------------------------------------------------------------- runners-up
const rec57800 = recorded[57800];
const p57800 = rec57800.proforma[0], c57800 = rec57800.landAuctionCloses[0], n57800 = rec57800.created[0];
const bid = (row, reserve) => {
  const costs = row.constructionCost + row.demolitionCost + row.designPlanningManagementFees + row.legalAndSurveyCosts + row.fundingCost;
  const market = Math.min(row.salePrice, row.marketSalePrice ?? row.salePrice);
  const maxBid = market / 1.15 - costs;
  return { sales: r2(market), costsExcludingLand: r2(costs), maxLandBid: r2(maxBid), ownersAsk: r2(reserve), verdict: maxBid >= reserve ? "PASS" : "FAIL" };
};
const col = pf.colegiales96520;
const runnersUp = [
  {
    rank: 2, parcelID: 57800, barrio: "Belgrano", street: "Avenida del Libertador (mid-block, on the avenue's service lane)",
    ...(({ row, centroidM, lonLat, areaM2, zone, landValueUSDperM2_2022, apartmentPriceUSDperM2_2022 }) => ({ row, centroidM, lonLat, areaM2, zone, landValueUSDperM2_2022, apartmentPriceUSDperM2_2022 }))(parcel(57800)),
    frontageM: geo.get(57800).frontage, depthM: geo.get(57800).depth,
    oldBuildings: [oldBuilding(319253), oldBuilding(319254)].map(({ ringM, rowVerification, ...o }) => ({ ...o, inLotShare: geo.get(57800).olds.find((x) => x.id === o.seedID).inLot })),
    newBuilding: (({ footprintRingsM, ...o }) => ({ ...o, footprintRingsM }))(newBuilding(n57800.buildingID)),
    nearby: { completedInRunWithin500m: geo.get(57800).all500, arMultifamilyWithin500m: geo.get(57800).mf500 },
    recordedPass: { month: "2026-12", developerID: p57800.developerID, proformaRow: p57800.proformaRow, ...bid(p57800, c57800.reservePrice), landPricePaid: c57800.winningOffer },
    why: "clean teardown of two low terraces standing on the lot, 12 storeys on a 10 x 36.8 m lot, 30 ar-multifamily completions within 500 m",
    againstIt: "only the winning appraisal is recorded (a failing option would have to be recomputed); the run's footprint is the whole 368 m2 lot while the zone caps coverage at 80% and the floor area uses 294.5 m2 per floor, so the building overflows the envelope on screen",
  },
  {
    rank: 3, parcelID: 96520, barrio: "Colegiales", street: "Avenida Federico Lacroze (mid-block)",
    ...(({ row, centroidM, lonLat, areaM2, zone, landValueUSDperM2_2022, apartmentPriceUSDperM2_2022 }) => ({ row, centroidM, lonLat, areaM2, zone, landValueUSDperM2_2022, apartmentPriceUSDperM2_2022 }))(parcel(96520)),
    frontageM: cand.get(96520).lot.frontageM, depthM: cand.get(96520).lot.depthM,
    oldBuildings: [oldBuilding(368738), oldBuilding(368739)].map(({ ringM, rowVerification, ...o }) => o),
    newBuilding: newBuilding(1879087424),
    nearby: { completedInRunWithin500m: cand.get(96520).nearby.all500, arMultifamilyWithin500m: cand.get(96520).nearby.mf500 },
    recordedFailThenPass: col.map((c) => ({
      month: new Date(recorded[96520].proforma.find((r) => r.proformaRow === c.proformaRow).timestampMs).toISOString().slice(0, 7),
      proformaRow: c.proformaRow, developerID: recorded[96520].proforma.find((r) => r.proformaRow === c.proformaRow).developerID,
      product: `${c.stories} storeys, ${c.units} flats, ${r2(c.floorspaceM2)} m2${c.stories === 6 ? " (the fallback walk-up: the apartment layout rule gave nothing)" : ""}`,
      sales: r2(c.bid.revenueForBid), costsExcludingLand: r2(c.bid.costsExcludingLand), maxLandBid: r2(c.bid.maxLandBid),
      ownersAsk: r2(c.bid.ownersAsk), verdict: c.bid.verdict, landPricePaid: c.bid.offered === null ? null : r2(c.bid.offered),
      reproducedWithin: `${c.check.maxAbsDiffUSD.toExponential(1)} USD`,
    })),
    askNote: "2022-09 ask = 2,371,610.06, the listing's undecayed reserve (2023-09 recorded reserve 2,315,285.49 / 0.997^8); it equals the pro forma's standing-buildings value that month",
    why: "the only candidate whose run RECORDS both a failing option (2022-09, 6-storey walk-up, no bid) and the passing one (2023-09, 10 storeys, bought at the ask + 5%)",
    againstIt: "the model 'replaces' two buildings: 368738 on the lot is a 'cultura y culto' (culture/worship) building, not a house, and 368739 stands on the NEIGHBOURING lot 96521 (4% of it on 96520). The neighbour's building puts 936 m2 into the owner's ask and into the demolition cost, which is what sinks the 6-storey option; the run also demolishes it. The run's footprint is the whole lot while the zone caps coverage at 60%.",
  },
];

const out = {
  about: "Showcase development for the 'Developers build only what pencils out' scene. Every number comes from run ba-2022-2031-s123456 (run.ccsr) or from the engine's own pro forma code run on it (proforma.ts). USD, all-in (land included in dwelling prices).",
  coordinates: "local equirectangular metres (x east, y north), origin Plaza de Mayo, lon0 -58.3722, lat0 -34.6083 (ba/manifest.json); rings open and counter-clockwise; lonLat = [lon, lat]",
  ranking: [
    { rank: 1, parcelID: P, barrio: "Caballito", centroidM: lotParcel.centroidM, lonLat: lotParcel.lonLat, summary: "10 storeys / 18 flats, 2027-12 -> 2031-01, replaces one 2-storey terrace house on an 8.8 x 36.3 m mid-block lot" },
    { rank: 2, parcelID: 57800, barrio: "Belgrano", centroidM: runnersUp[0].centroidM, lonLat: runnersUp[0].lonLat, summary: "12 storeys / 33 flats, 2026-12 -> 2029-11, replaces two low terraces on a 10 x 36.8 m lot" },
    { rank: 3, parcelID: 96520, barrio: "Colegiales", centroidM: runnersUp[1].centroidM, lonLat: runnersUp[1].lonLat, summary: "10 storeys / 18 flats, 2023-09 -> 2027-01; recorded fail then pass, but the fail rests on a neighbour's building" },
  ],
  showcase,
  runnersUp,
  citations: {
    engineCall: "src/domain/proforma/computer.ts:1270-1300 buildComputeOnlyProformaComputer; :502-612 computeFromInputs; DTO fields as src/models/land-use-simulation/engine/bootstrap/marketCore.ts:383-410",
    landValue: "computer.ts:513 (area x land value per m2)",
    siteValue: "computer.ts:528-533 all-in: max(standing buildings' value, land value); :559-563 x (0.98 + draw x 0.04)",
    standingValue: "src/domain/land-use-simulation/buildableAreas/existingBuildingsSummary.ts:55-92 (sum of unit area x dwelling price per m2)",
    salesRevenue: "computer.ts:548-558 and :750-770: dwelling sale price x (0.97 + draw x 0.06) x new-build premium x (1 - 0.0875)",
    newBuildPremium: "src/config/region/buenosaires/BuenosairesRegionConfig.ts:719-725 (2026: 1.373, held for 2027 by marketCore.ts:598-615)",
    saleCosts: "BuenosairesRegionConfig.ts:1013 saleCostsShareOfRevenue 0.0875",
    allInPrices: "BuenosairesRegionConfig.ts:736 dwellingPriceBasis all-in",
    construction: "computer.ts:655-672 (LUT x floor area x (0.95 + draw x 0.1)); src/domain/land-use-simulation/costs/constructionCostCalculator.ts:27-47 (medium size, :34); src/shared/constructionCost/parametricConstructionCost.ts:156-158 (base x size x price index); public/buenosaires/construction-costs-lut.json.gz (Apartment 1,403 USD/m2 in 2026); BuenosairesRegionConfig.ts:578 (file basis)",
    priceIndex: "run modelConfig.macroEconomy.inflation = BuenosairesRegionConfig.ts:588-596 (2022-2026) + src/config/region/macro-economy/argentinaUsdMacroEconomy.ts:41 (2027: 5.5%)",
    demolition: "computer.ts:674-682; src/domain/land-use-simulation/costs/demolitionCostCalculator.ts:14-31 (storeys = round(height / 3)), :48; public/buenosaires/demolition-costs-lut.json (CM-4: 108 USD/m2 one storey, 200 two or more, 2022 USD)",
    designFees: "computer.ts:684-700; BuenosairesRegionConfig.ts:93 (BA_PROFESSIONAL_FEES_SHARE 0.1), :741-745",
    legalSurvey: "src/domain/land-use-simulation/costs/legalSurveyAndFundingCostCalculator.ts:80; public/buenosaires/simulation/legal-survey-and-funding-costs-lut.json.gz (Apartment:CM-4 1.5%)",
    funding: "legalSurveyAndFundingCostCalculator.ts:72; BuenosairesRegionConfig.ts:621-624 (loanToCost 0: no construction loan, so 0)",
    roiPrice: "computer.ts:927-949 (target = (site + costs) x 1.15; market-higher / gap-too-large above 1.2 x market / roi-achievable); targetROI BuenosairesRegionConfig.ts:142; roiMarketGapThreshold 1.2 from the run's hyperparameters",
    profit: "src/domain/proforma/proforma.ts:48-61 (sale - site - costs); :35-46 costs excluding site",
    bidRule: "src/domain/land-use-simulation/market/real-estate/developers/usaMultifamily/agent.ts:614-621 (max land bid = min(sale, market) / 1.15 - costs), :520-541 (no bid if <= 0 or under the ask), :595-597 (offer = min(bid, ask x 1.05)); BuenosairesRegionConfig.ts:69, :246 (0.15), :256 (0.05)",
    layoutChoice: "usaMultifamily/agent.ts:726-730 (score = profit x 0.5 + demand x 0.5, run hyperparameters)",
    apartmentLayoutRule: "src/domain/site-layout/generator/apartment.ts:65-73 (storeys = floor(max height / 3)), :77-83 (coverage), :107-110 (at least 3 storeys), :121-124 (flats per floor), :127 (ground floor not residential), :129-160",
    fallbackLayout: "usaMultifamily/agent.ts:741-870; BuenosairesRegionConfig.ts:294-298 (60% coverage, 6 storeys, 55 m2 flats, 8-40 flats)",
    ownersAsk: "src/domain/land-use-simulation/market/real-estate/buildable-areas-auctions-system/listings.ts:712-775 (first ask = max(standing dwellings' value, land value)), :512-543 (decay), BuenosairesRegionConfig.ts:688-692 (0.997 a month after 12 months, floor 85% of the first ask)",
    keyedDraws: "src/domain/proforma/proformaRandoms.ts:22-24, :34-50 (draws keyed by run seed 123456, month, developer, site)",
  },
  caveats: [
    "Option 1 (3 storeys) is not in the run archive. It is computed with the engine's own pro forma function on the same site, month, developer, draws and ask, holding the flats fixed; only the height changes. 4 storeys would already pass, so the fail/pass line sits between 3 and 4 storeys.",
    "The owner's ask (1,066,851.43) is below the site's 2027 land value (1,790,289.13). It is consistent with a listing that opened in 2022 at 1,255,119.33 (ask / 0.85) and decayed to the 85% floor: the house's 2027 standing value (1,372,523.59) deflated by the run's sale-price index 2022->2027 (x1.0935) gives the same figure to within a dollar. The archive does not record when the listing opened, so this is an inference. It is why the built option clears the 15% hurdle by far: 78.5% return on cost at the price paid.",
    "The land value per m2 of this lot rose from 3,368.51 (2022 seed) to 5,662.06 in the run by 2027-12 (+68%).",
    "The pro forma counts 9 floors of floor area for a 10-storey, 30 m building: the ground floor is neither sold nor costed.",
    "The dwelling price per m2 used for both options is backed out of the recorded sale price; it is the only pro forma input the archive does not store.",
    "The new-build premium schedule stops at 2026; the engine holds 1.373 for 2027.",
    "The old house 12089 touches four parcel polygons in the export, but 93% of its footprint and its primary parcel are 109670.",
    "data/ba gives the lot 316.13 m2; the run's buildable area measures 316.19 m2.",
  ],
};
writeFileSync(DIR + "showcase.json", JSON.stringify(out, null, 1));
console.log("wrote showcase.json");
console.log(JSON.stringify(out.showcase.receipt, null, 1));
console.log(JSON.stringify(out.ranking));
