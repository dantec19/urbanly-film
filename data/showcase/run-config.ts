// Print the run's own configuration values the pro forma and the bid depend on.
//   npx vite-node .scratch/urbanly-film/data/showcase/run-config.ts   (from the repo root)
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import { decodeSimulationRun } from "@shared/simulation-run-binary/decode";

const RUN = ".scratch/urbanly-film/data/sim/runs/ba-2022-2031-s123456/run.ccsr";
const bytes = readFileSync(RUN);
const raw = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
const container = new ArrayBuffer(raw.byteLength);
new Uint8Array(container).set(raw);
const decoded = decodeSimulationRun(container);
const meta = decoded.runMetadata as unknown as Record<string, unknown>;
console.log("runMetadata keys", Object.keys(meta).join(", "));
const find = (o: unknown, path: string, depth = 0): void => {
  if (!o || typeof o !== "object" || depth > 6) return;
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    const p = `${path}.${k}`;
    if (/roiMarketGapThreshold|economicScoreWeight|demandScoreWeight|proformaMode|targetROI|saleCostsShare|newBuildSalePremium|dwellingPriceBasis|designFee|macroEconomy|constructionLoan|interestRate|landBidPremium|residualBid|listingPrice|reserve|Reserve|startYear|endYear|seed$/i.test(k)) {
      console.log(p, JSON.stringify(v)?.slice(0, 700));
    }
    if (v && typeof v === "object" && !ArrayBuffer.isView(v)) find(v, p, depth + 1);
  }
};
find(meta, "meta");
