// List the sections and columns a run archive carries.
//   npx vite-node .scratch/urbanly-film/data/showcase/inspect-run.ts   (from the repo root)
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import { decodeSimulationRun } from "@shared/simulation-run-binary/decode";

const RUN = ".scratch/urbanly-film/data/sim/runs/ba-2022-2031-s123456/run.ccsr";
const bytes = readFileSync(RUN);
const raw = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
const container = new ArrayBuffer(raw.byteLength);
new Uint8Array(container).set(raw);
const decoded = decodeSimulationRun(container);
console.log("metadata", JSON.stringify(decoded.metadata).slice(0, 400));
console.log("missingSections", decoded.missingSections);
console.log("unknownSections", decoded.unknownSections);
for (const [name, s] of decoded.sections) {
  console.log(`${name}: ${s.count} rows; columns ${s.columns.map((c) => c.name).join(", ")}`);
}
console.log("proformaParcelIDsFlat", decoded.proformaParcelIDsFlat.length);
const mc = decoded.runMetadata.modelConfig as Record<string, unknown>;
console.log("modelConfig keys", Object.keys(mc).join(", "));
