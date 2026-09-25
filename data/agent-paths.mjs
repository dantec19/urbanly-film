// agent-paths.mjs: routes home→work pairs over the film's street graph (A*, straight-line heuristic) and
// writes the paths as polylines the film can animate.
//   node data/agent-paths.mjs [--home=data/film/commute_home_xy.f32 --job=data/film/commute_job_xy.f32] [--out=data/film/agents]
// Output: <out>_xy.f32 (x, y per vertex), <out>_off.u32 (path p owns vertices [o[p], o[p+1])), <out>_len.f32 (metres),
//         <out>_meta.json (counts, unreachable pairs).
import { readFileSync, writeFileSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const DIR = 'data/ba/';
const f32 = f => { const b = readFileSync(DIR + f); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); };
const u32 = f => { const b = readFileSync(DIR + f); return new Uint32Array(b.buffer, b.byteOffset, b.byteLength / 4); };
const u8 = f => new Uint8Array(readFileSync(DIR + f));
const rd = (p, T) => { const b = readFileSync(p); return new T(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };

// the same street set the film draws: vehicular ways and car-free streets inside the city
const nodes = f32('streets_nodes.f32'), edges = u32('streets_edges.u32'), cls = u8('streets_edge_class.u8'), flags = u8('streets_edge_flags.u8'), len = f32('streets_edge_length.f32');
const nN = nodes.length / 2, keep = [];
for (let e = 0; e < cls.length; e++) { const c = cls[e]; if (((c >= 1 && c <= 6) || c === 13) && (flags[e] & 4) && c !== 1) keep.push(e); }
// adjacency (undirected: people walk and ride both ways)
const deg = new Uint32Array(nN + 1);
for (const e of keep) { deg[edges[e * 2] + 1]++; deg[edges[e * 2 + 1] + 1]++; }
for (let i = 0; i < nN; i++) deg[i + 1] += deg[i];
const nbr = new Uint32Array(keep.length * 2), w = new Float32Array(keep.length * 2), fill = deg.slice(0, nN);
for (const e of keep) {
  const a = edges[e * 2], b = edges[e * 2 + 1];
  // avenues are a little cheaper, so paths gather on them the way traffic does
  const k = cls[e] <= 4 || (flags[e] & 2) ? .8 : 1;
  nbr[fill[a]] = b; w[fill[a]++] = len[e] * k;
  nbr[fill[b]] = a; w[fill[b]++] = len[e] * k;
}
const onGraph = new Uint8Array(nN); for (const e of keep) { onGraph[edges[e * 2]] = 1; onGraph[edges[e * 2 + 1]] = 1; }

// grid index for snapping points to the nearest graph node
const G = 100, gx0 = -16000, gy0 = -12000, GW = 210, GH = 230;
const cellStart = new Uint32Array(GW * GH + 1), cellOf = i => Math.floor((nodes[i * 2 + 1] - gy0) / G) * GW + Math.floor((nodes[i * 2] - gx0) / G);
for (let i = 0; i < nN; i++) if (onGraph[i]) cellStart[cellOf(i) + 1]++;
for (let c = 0; c < GW * GH; c++) cellStart[c + 1] += cellStart[c];
const cellItems = new Uint32Array(cellStart[GW * GH]), cf = cellStart.slice(0, GW * GH);
for (let i = 0; i < nN; i++) if (onGraph[i]) cellItems[cf[cellOf(i)]++] = i;
function snap(x, y) {
  const cx = Math.floor((x - gx0) / G), cy = Math.floor((y - gy0) / G);
  let best = -1, bd = Infinity;
  for (let r = 0; r < 6 && best < 0; r++) {
    for (let j = cy - r; j <= cy + r; j++) for (let i = cx - r; i <= cx + r; i++) {
      if (i < 0 || j < 0 || i >= GW || j >= GH) continue;
      for (let k = cellStart[j * GW + i]; k < cellStart[j * GW + i + 1]; k++) {
        const n = cellItems[k], d = (nodes[n * 2] - x) ** 2 + (nodes[n * 2 + 1] - y) ** 2;
        if (d < bd) { bd = d; best = n; }
      }
    }
  }
  return best;
}

// A* with stamps (no per-query clearing)
const gScore = new Float32Array(nN), stamp = new Uint32Array(nN), closed = new Uint32Array(nN), pred = new Int32Array(nN);
const heapN = new Uint32Array(keep.length * 2 + nN), heapF = new Float32Array(keep.length * 2 + nN);
let q = 0;
function astar(s, t) {
  q++;
  const tx = nodes[t * 2], ty = nodes[t * 2 + 1], H = i => .8 * Math.hypot(nodes[i * 2] - tx, nodes[i * 2 + 1] - ty);
  let size = 0;
  const push = (n, f) => { let i = size++; while (i > 0) { const p = (i - 1) >> 1; if (heapF[p] <= f) break; heapN[i] = heapN[p]; heapF[i] = heapF[p]; i = p; } heapN[i] = n; heapF[i] = f; };
  const pop = () => { const n = heapN[0]; const ln = heapN[--size], lf = heapF[size]; let i = 0; for (;;) { let c = 2 * i + 1; if (c >= size) break; if (c + 1 < size && heapF[c + 1] < heapF[c]) c++; if (heapF[c] >= lf) break; heapN[i] = heapN[c]; heapF[i] = heapF[c]; i = c; } heapN[i] = ln; heapF[i] = lf; return n; };
  gScore[s] = 0; stamp[s] = q; pred[s] = -1; push(s, H(s));
  while (size) {
    const u = pop();
    if (closed[u] === q) continue;
    closed[u] = q;
    if (u === t) return true;
    const gu = gScore[u];
    for (let k = deg[u]; k < deg[u + 1]; k++) {
      const v = nbr[k], ng = gu + w[k];
      if (stamp[v] !== q || ng < gScore[v]) { stamp[v] = q; gScore[v] = ng; pred[v] = u; push(v, ng + H(v)); }
    }
  }
  return false;
}

const home = rd(args.home || 'data/film/commute_home_xy.f32', Float32Array), job = rd(args.job || 'data/film/commute_job_xy.f32', Float32Array);
const P = home.length / 2, out = args.out || 'data/film/agents';
const XY = [], OFF = [0], LEN = [];
let unreachable = 0, same = 0; const t0 = Date.now();
for (let p = 0; p < P; p++) {
  const s = snap(home[p * 2], home[p * 2 + 1]), t = snap(job[p * 2], job[p * 2 + 1]);
  let n = 0, L = 0;
  if (s >= 0 && t >= 0 && s !== t && astar(t, s)) {
    // walk the predecessor chain from home back to work: the path runs work → home (the evening trip)
    const pts = []; for (let v = s; v >= 0; v = pred[v]) pts.push(v);
    pts.reverse();
    // drop vertices on straight runs (keeps corners)
    let px = null, py = null, dx0 = 0, dy0 = 0;
    for (let k = 0; k < pts.length; k++) {
      const x = nodes[pts[k] * 2], y = nodes[pts[k] * 2 + 1];
      if (k > 0 && k < pts.length - 1) {
        const nx = nodes[pts[k + 1] * 2], ny = nodes[pts[k + 1] * 2 + 1];
        const ax = x - px, ay = y - py, bx = nx - x, by = ny - y;
        const cr = Math.abs(ax * by - ay * bx) / (Math.hypot(ax, ay) * Math.hypot(bx, by) + 1e-9);
        if (cr < .02 && ax * bx + ay * by > 0) continue;
      }
      if (px !== null) L += Math.hypot(x - px, y - py);
      XY.push(x, y); n++; px = x; py = y;
    }
  } else if (s === t) same++; else unreachable++;
  OFF.push(XY.length / 2); LEN.push(L);
  if ((p + 1) % 5000 === 0) console.log(`${p + 1}/${P}  ${((Date.now() - t0) / (p + 1)).toFixed(2)} ms/pair`);
}
writeFileSync(out + '_xy.f32', Buffer.from(new Float32Array(XY).buffer));
writeFileSync(out + '_off.u32', Buffer.from(new Uint32Array(OFF).buffer));
writeFileSync(out + '_len.f32', Buffer.from(new Float32Array(LEN).buffer));
writeFileSync(out + '_meta.json', JSON.stringify({ pairs: P, vertices: XY.length / 2, unreachable, sameNode: same, note: 'A* over vehicular + car-free streets inside the city (motorways excluded), avenues weighted 0.8; paths run work → home; straight runs simplified.' }, null, 1));
console.log(`wrote ${out}_*: ${P} pairs, ${XY.length / 2} vertices, ${unreachable} unreachable, ${same} same-node, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
