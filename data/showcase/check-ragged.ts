// Which index do the buildingsTxSoA ragged columns of the run archive use:
// the log row, or the Created ordinal? Compare offsets lengths and one known row.
//   npx vite-node .scratch/urbanly-film/data/showcase/check-ragged.ts   (from the repo root)
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import { decodeSimulationRun } from "@shared/simulation-run-binary/decode";

const RUN = ".scratch/urbanly-film/data/sim/runs/ba-2022-2031-s123456/run.ccsr";
const bytes = readFileSync(RUN);
const raw = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
const container = new ArrayBuffer(raw.byteLength);
new Uint8Array(container).set(raw);
const decoded = decodeSimulationRun(container);
const s = decoded.sections.get("buildingsTxSoA")!;
const c: Record<string, ArrayLike<number>> = {};
for (const col of s.columns) { c[col.name] = col.data as unknown as ArrayLike<number>; console.log(col.name, (col.data as ArrayLike<number>).length); }
console.log("count", s.count);
let created = 0; const byType = new Map<number, number>();
for (let i = 0; i < s.count; i++) { byType.set(c.eventType[i], (byType.get(c.eventType[i]) ?? 0) + 1); if (c.eventType[i] === 0) created++; }
console.log("eventType counts", [...byType]);
// rows whose scalar buildingID is 1879087424 (the 96520 development per the developments export)
for (let i = 0; i < s.count; i++) if (c.buildingID[i] === 1879087424) console.log("row", i, "eventType", c.eventType[i], "height", c.height[i], "stories", c.totalStories[i], "dev", c.developerID[i], "kind", c.developerKindCode?.[i], "sa", c.startAppraisalID?.[i], "ba", c.buildableAreaID?.[i]);

// Agreement of the scalar unit count with the ragged unit-area list under the
// Created-ordinal hypothesis.
let item = -1, agree = 0, disagree = 0; const firstBad: number[] = [];
const ordinalOfRow = new Map<number, number>();
for (let i = 0; i < s.count; i++) {
  if (c.eventType[i] !== 0) continue;
  item++; ordinalOfRow.set(i, item);
  const len = c.dwellingUnitAreasOff[item + 1] - c.dwellingUnitAreasOff[item];
  if (len === c.dwellingUnitsCount[i]) agree++; else { disagree++; if (firstBad.length < 5) firstBad.push(i); }
}
console.log("ordinal hypothesis: agree", agree, "disagree", disagree, "first bad rows", firstBad);
const o = ordinalOfRow.get(13200)!;
const pr = (k: number) => ({
  parcels: Array.from((c.parcelIDsFlat as Uint32Array).subarray(c.parcelIDsOff[k], c.parcelIDsOff[k + 1])),
  originals: Array.from((c.originalBuildingsIDsFlat as Uint32Array).subarray(c.originalBuildingsIDsOff[k], c.originalBuildingsIDsOff[k + 1])),
  units: c.dwellingUnitAreasOff[k + 1] - c.dwellingUnitAreasOff[k],
});
console.log("row 13200 ordinal", o, pr(o));
for (let k = 0; k < c.parcelIDsOff.length - 1; k++) { const p = pr(k); if (p.parcels.includes(96520)) console.log("ragged item with 96520:", k, p); }
