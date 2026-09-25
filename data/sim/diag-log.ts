// Diagnostic: compare the raw building-log rows with what the CityContext
// fold yields, to explain count differences.
//   yarn vite-node .scratch/urbanly-film/data/sim/diag-log.ts --run-dir <dir>
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";

import { BuildingLogEventType } from "@domain/city-context/buildingsTxSoA";
import { DEVELOPER_KIND_BY_CODE } from "@domain/land-use-simulation/market/real-estate/developers/kinds";
import { decodeSimulationRun, getColumnFromSection } from "@shared/simulation-run-binary/decode";

const { values: args } = parseArgs({ options: { "run-dir": { type: "string" } } });
const bytes = readFileSync(join(args["run-dir"]!, "run.ccsr"));
const raw = gunzipSync(bytes);
const container = new ArrayBuffer(raw.byteLength);
new Uint8Array(container).set(raw);
const decoded = decodeSimulationRun(container);
const { startYear, endYear } = decoded.metadata;
const sec = decoded.sections.get("buildingsTxSoA")!;
const g = <T,>(n: string) => getColumnFromSection(sec, n) as unknown as T;
const eventType = g<Uint8Array>("eventType");
const buildingID = g<Uint32Array>("buildingID");
const monthIndex = g<Int32Array>("monthIndex");
const startDateMs = g<Float64Array>("startDateMs");
const developerID = g<Int32Array>("developerID");
const hasKind = sec.columns.some((c) => c.name === "developerKindCode");
const kindCode = hasKind ? g<Uint8Array>("developerKindCode") : null;
console.log("columns:", sec.columns.map((c) => c.name).join(","));
console.log(`rows ${sec.count}, run ${startYear}-${endYear}`);

const byType = new Map<number, number>();
const createdIDs = new Map<number, number>();
const byKind = new Map<string, number>();
const byStartYear = new Map<number, number>();
const byMonthYear = new Map<number, number>();
let devIDzero = 0;
const devIDsNoKind = new Set<number>();
for (let i = 0; i < sec.count; i++) {
  const et = eventType[i];
  byType.set(et, (byType.get(et) ?? 0) + 1);
  if (et !== BuildingLogEventType.Created) continue;
  createdIDs.set(buildingID[i], (createdIDs.get(buildingID[i]) ?? 0) + 1);
  const k = kindCode ? (DEVELOPER_KIND_BY_CODE[kindCode[i]] ?? `code${kindCode[i]}`) : "n/a";
  byKind.set(k, (byKind.get(k) ?? 0) + 1);
  if (kindCode && kindCode[i] === 0) devIDsNoKind.add(developerID[i]);
  if (developerID[i] === 0) devIDzero++;
  const sy = new Date(startDateMs[i]).getUTCFullYear();
  const key = sy * 1000 + (kindCode ? kindCode[i] : 0);
  byStartYear.set(key, (byStartYear.get(key) ?? 0) + 1);
  const my = startYear + Math.floor(monthIndex[i] / 12);
  byMonthYear.set(my, (byMonthYear.get(my) ?? 0) + 1);
}
let dupIDs = 0;
let dupRows = 0;
for (const v of createdIDs.values()) if (v > 1) { dupIDs++; dupRows += v; }
console.log("rows by eventType", Object.fromEntries(byType));
console.log(`created rows ${[...createdIDs.values()].reduce((a, b) => a + b, 0)}, distinct ids ${createdIDs.size}, ids created more than once ${dupIDs} (${dupRows} rows)`);
console.log("created by kind", Object.fromEntries(byKind));
console.log("created by start year / kind", [...byStartYear].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${Math.floor(k / 1000)}:${DEVELOPER_KIND_BY_CODE[k % 1000] ?? "code" + (k % 1000)}=${v}`).join("  "));
console.log("created by monthIndex year", Object.fromEntries([...byMonthYear].sort((a, b) => a[0] - b[0])));
console.log(`developerID 0 rows ${devIDzero}; developer ids with kind code 0: ${devIDsNoKind.size} e.g. ${[...devIDsNoKind].slice(0, 10).join(",")}`);
