// Visual check of line.json over the street network and the standing Subte.
//
//   node .scratch/urbanly-film/data/line/check-line.mjs   (from the repo root;
//   sharp comes from the repo's node_modules)
//
// Writes check/line.png (the whole corridor) and check/line-north.png (Callao
// and Las Heras, closer).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BA = path.join(HERE, "..", "ba");
const OUT = path.join(HERE, "check");
fs.mkdirSync(OUT, { recursive: true });
const rd = (f, T) => {
  const b = fs.readFileSync(path.join(BA, f));
  return new T(b.buffer, b.byteOffset, b.byteLength / T.BYTES_PER_ELEMENT);
};
const nodes = rd("streets_nodes.f32", Float32Array);
const edges = rd("streets_edges.u32", Uint32Array);
const eflags = rd("streets_edge_flags.u8", Uint8Array);
const eclass = rd("streets_edge_class.u8", Uint8Array);
const subteXY = rd("subte_lines_xy.f32", Float32Array);
const subteOff = rd("subte_lines_offsets.u32", Uint32Array);
const subteLineOf = rd("subte_lines_line.u8", Uint8Array);
const subteLines = JSON.parse(fs.readFileSync(path.join(BA, "subte_lines.json"), "utf8"));
const stXY = rd("subte_stations_xy.f32", Float32Array);
const stLine = rd("subte_stations_line.u8", Uint8Array);
const line = JSON.parse(fs.readFileSync(path.join(HERE, "line.json"), "utf8"));

function render(file, [x0, y0, x1, y1], widthPx, labelSize) {
  const s = widthPx / (x1 - x0);
  const W = widthPx;
  const H = Math.round((y1 - y0) * s);
  const X = (x) => ((x - x0) * s).toFixed(1);
  const Y = (y) => ((y1 - y) * s).toFixed(1);
  const inside = (x, y) => x > x0 - 50 && x < x1 + 50 && y > y0 - 50 && y < y1 + 50;
  let minor = "";
  let major = "";
  for (let e = 0; e < edges.length / 2; e++) {
    const a = edges[2 * e];
    const b = edges[2 * e + 1];
    const ax = nodes[2 * a], ay = nodes[2 * a + 1], bx = nodes[2 * b], by = nodes[2 * b + 1];
    if (!inside(ax, ay) && !inside(bx, by)) continue;
    const c = eclass[e];
    if (c === 8 || c === 9) continue;
    const seg = `M${X(ax)} ${Y(ay)}L${X(bx)} ${Y(by)}`;
    if ((eflags[e] & 2) !== 0 || c <= 4) major += seg;
    else minor += seg;
  }
  let subte = "";
  for (let k = 0; k + 1 < subteOff.length; k++) {
    let d = "";
    for (let v = subteOff[k]; v < subteOff[k + 1]; v++) d += `${v === subteOff[k] ? "M" : "L"}${X(subteXY[2 * v])} ${Y(subteXY[2 * v + 1])}`;
    subte += `<path d="${d}" stroke="${subteLines[subteLineOf[k]].color}" stroke-width="3" fill="none" opacity="0.9"/>`;
  }
  for (let i = 0; i < stLine.length; i++) {
    const x = stXY[2 * i], y = stXY[2 * i + 1];
    if (!inside(x, y)) continue;
    subte += `<circle cx="${X(x)}" cy="${Y(y)}" r="3" fill="#fff" stroke="${subteLines[stLine[i]].color}" stroke-width="1.5"/>`;
  }
  const d = line.polyline.map(([x, y], i) => `${i ? "L" : "M"}${X(x)} ${Y(y)}`).join("");
  let stations = "";
  for (const st of line.stations) {
    stations += `<circle cx="${X(st.x)}" cy="${Y(st.y)}" r="5" fill="#fff" stroke="#e5007d" stroke-width="2.5"/>`;
    stations += `<text x="${(Number(X(st.x)) + 9).toFixed(1)}" y="${(Number(Y(st.y)) + 4).toFixed(1)}" font-family="Helvetica" font-size="${labelSize}" fill="#111" stroke="#fff" stroke-width="3" paint-order="stroke">${st.name} (${st.alongLineM} m)</text>`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="100%" height="100%" fill="#f4f1ea"/>
<path d="${minor}" stroke="#c9c4b8" stroke-width="0.6" fill="none"/>
<path d="${major}" stroke="#8d8676" stroke-width="1.4" fill="none"/>
${subte}
<path d="${d}" stroke="#e5007d" stroke-width="4" fill="none" stroke-linejoin="round" opacity="0.85"/>
${stations}
</svg>`;
  return sharp(Buffer.from(svg)).png().toFile(path.join(OUT, file));
}

await render("line.png", [-5200, -5200, 200, 3600], 1400, 13);
await render("line-north.png", [-4700, 700, -1000, 3300], 1600, 14);
console.log("wrote", OUT);
