// Build the film's new metro line (the corridor of the planned Subte Línea F)
// from the real avenue centrelines in the film's Buenos Aires street export.
//
//   node .scratch/urbanly-film/data/line/build-line.mjs
//
// Reads ../ba/streets_* and ../ba/subte_stations* (see ../ba/manifest.json).
// Writes, next to this file:
//   line.json              polyline (local metres), stations, length, legs
//   transit-scenario.json  the `yarn simulate --transit-scenario-file` input
//
// Method. The line is the shortest path over the street graph in four legs,
// each leg priced so that edges named as its avenue cost their length and any
// other edge costs 30x its length (so a leg only leaves its avenue to bridge a
// gap, and the report says whether it did):
//   Av. Vélez Sársfield  from Av. General Iriarte (Barracas) to Av. Caseros
//   Av. Entre Ríos       from Av. Caseros to Av. Rivadavia (Congreso)
//   Av. Callao           from Av. Rivadavia to Av. General Las Heras
//   Av. Gral. Las Heras  from Av. Callao to Plaza Italia
// Stations are chosen among the path's intersections with major streets
// (OSM class primary/secondary/tertiary, or an 'Avenida'), plus both ends, by a
// dynamic programme that keeps every gap inside 650-1000 m, aims at 800 m, and
// prefers interchanges with a standing Subte station (within 250 m) and
// avenues. A station's name is its cross street.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BA = path.join(HERE, "..", "ba");
const rd = (f, T) => {
  const b = fs.readFileSync(path.join(BA, f));
  return new T(b.buffer, b.byteOffset, b.byteLength / T.BYTES_PER_ELEMENT);
};
const names = JSON.parse(fs.readFileSync(path.join(BA, "streets_names.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(BA, "manifest.json"), "utf8"));
const nodes = rd("streets_nodes.f32", Float32Array);
const edges = rd("streets_edges.u32", Uint32Array);
const ename = rd("streets_edge_name.u16", Uint16Array);
const eflags = rd("streets_edge_flags.u8", Uint8Array);
const eclass = rd("streets_edge_class.u8", Uint8Array);
const elen = rd("streets_edge_length.f32", Float32Array);
const subteXY = rd("subte_stations_xy.f32", Float32Array);
const subteLine = rd("subte_stations_line.u8", Uint8Array);
const subteNames = JSON.parse(fs.readFileSync(path.join(BA, "subte_stations.json"), "utf8"));
const subteLines = JSON.parse(fs.readFileSync(path.join(BA, "subte_lines.json"), "utf8"));

const { lon0, lat0, R } = manifest.projection;
const DEG = Math.PI / 180;
const kx = R * DEG * Math.cos(lat0 * DEG);
const ky = R * DEG;
const toLngLat = (x, y) => [lon0 + x / kx, lat0 + y / ky];

const NODE_COUNT = nodes.length / 2;
const EDGE_COUNT = ename.length;
const CLASS_FOOTWAY = 8;
const CLASS_CYCLEWAY = 9;
const CLASS_SERVICE = 7;
const FLAG_AVENUE = 2;

const nameID = (n) => {
  const i = names.indexOf(n);
  if (i < 0) throw new Error(`no street named "${n}"`);
  return i;
};
const VS = nameID("Avenida Vélez Sársfield");
const ER = nameID("Avenida Entre Ríos");
const CALLAO = nameID("Avenida Callao");
const LH = nameID("Avenida General Las Heras");
const IRIARTE = nameID("Avenida General Iriarte");

// --- Undirected adjacency (CSR) ---------------------------------------------
const degree = new Uint32Array(NODE_COUNT + 1);
for (let e = 0; e < EDGE_COUNT; e++) {
  degree[edges[2 * e]]++;
  degree[edges[2 * e + 1]]++;
}
const adjStart = new Uint32Array(NODE_COUNT + 1);
for (let k = 0; k < NODE_COUNT; k++) adjStart[k + 1] = adjStart[k] + degree[k];
const adjEdge = new Uint32Array(adjStart[NODE_COUNT]);
const fill = adjStart.slice(0, NODE_COUNT);
for (let e = 0; e < EDGE_COUNT; e++) {
  adjEdge[fill[edges[2 * e]]++] = e;
  adjEdge[fill[edges[2 * e + 1]]++] = e;
}
const other = (e, k) => (edges[2 * e] === k ? edges[2 * e + 1] : edges[2 * e]);
const nx = (k) => nodes[2 * k];
const ny = (k) => nodes[2 * k + 1];

function nodesNamed(id) {
  const out = new Set();
  for (let e = 0; e < EDGE_COUNT; e++) {
    if (ename[e] === id) {
      out.add(edges[2 * e]);
      out.add(edges[2 * e + 1]);
    }
  }
  return out;
}
function sharedNodes(a, b) {
  const A = nodesNamed(a);
  return [...nodesNamed(b)].filter((k) => A.has(k));
}

// --- Dijkstra with a binary heap ---------------------------------------------
function shortestPath(from, to, legName) {
  const dist = new Float64Array(NODE_COUNT).fill(Infinity);
  const prevEdge = new Int32Array(NODE_COUNT).fill(-1);
  const heapK = [];
  const heapD = [];
  const push = (k, d) => {
    heapK.push(k);
    heapD.push(d);
    let i = heapK.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapD[p] <= heapD[i]) break;
      [heapK[p], heapK[i]] = [heapK[i], heapK[p]];
      [heapD[p], heapD[i]] = [heapD[i], heapD[p]];
      i = p;
    }
  };
  const pop = () => {
    const k = heapK[0];
    const d = heapD[0];
    const lk = heapK.pop();
    const ld = heapD.pop();
    if (heapK.length > 0) {
      heapK[0] = lk;
      heapD[0] = ld;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heapK.length && heapD[l] < heapD[m]) m = l;
        if (r < heapK.length && heapD[r] < heapD[m]) m = r;
        if (m === i) break;
        [heapK[m], heapK[i]] = [heapK[i], heapK[m]];
        [heapD[m], heapD[i]] = [heapD[i], heapD[m]];
        i = m;
      }
    }
    return [k, d];
  };
  dist[from] = 0;
  push(from, 0);
  while (heapK.length > 0) {
    const [k, d] = pop();
    if (d > dist[k]) continue;
    if (k === to) break;
    for (let a = adjStart[k]; a < adjStart[k + 1]; a++) {
      const e = adjEdge[a];
      const w = elen[e] * (ename[e] === legName ? 1 : 30);
      const o = other(e, k);
      if (d + w < dist[o]) {
        dist[o] = d + w;
        prevEdge[o] = e;
        push(o, d + w);
      }
    }
  }
  if (!Number.isFinite(dist[to])) throw new Error(`leg ${names[legName]}: unreachable`);
  const seq = [to];
  const offAvenue = [];
  let k = to;
  while (k !== from) {
    const e = prevEdge[k];
    if (ename[e] !== legName) offAvenue.push({ edge: e, name: names[ename[e]], lengthM: elen[e] });
    k = other(e, k);
    seq.push(k);
  }
  seq.reverse();
  return { seq, offAvenue };
}

// --- Leg endpoints -------------------------------------------------------------
const pickSouth = (ks) => ks.slice().sort((a, b) => ny(a) - ny(b))[0];
const start = pickSouth(sharedNodes(VS, IRIARTE));
const vsEr = sharedNodes(VS, ER);
const erCallao = sharedNodes(ER, CALLAO);
const callaoLh = sharedNodes(CALLAO, LH);
if (vsEr.length !== 1 || erCallao.length !== 1 || callaoLh.length !== 1) {
  throw new Error(`junctions not unique: ${vsEr} / ${erCallao} / ${callaoLh}`);
}
// Plaza Italia: the Las Heras node nearest the Line D station of that name.
let plazaItaliaD = -1;
for (let i = 0; i < subteNames.length; i++) {
  if (subteNames[i].name === "Plaza Italia") plazaItaliaD = i;
}
const pix = subteXY[2 * plazaItaliaD];
const piy = subteXY[2 * plazaItaliaD + 1];
let end = -1;
let endD = Infinity;
for (const k of nodesNamed(LH)) {
  const d = Math.hypot(nx(k) - pix, ny(k) - piy);
  if (d < endD) {
    endD = d;
    end = k;
  }
}

const legs = [
  { avenue: VS, from: start, to: vsEr[0] },
  { avenue: ER, from: vsEr[0], to: erCallao[0] },
  { avenue: CALLAO, from: erCallao[0], to: callaoLh[0] },
  { avenue: LH, from: callaoLh[0], to: end },
];
const pathNodes = [];
const pathAvenue = [];
const legReport = [];
for (const leg of legs) {
  const { seq, offAvenue } = shortestPath(leg.from, leg.to, leg.avenue);
  let lengthM = 0;
  for (let i = 1; i < seq.length; i++) lengthM += Math.hypot(nx(seq[i]) - nx(seq[i - 1]), ny(seq[i]) - ny(seq[i - 1]));
  legReport.push({
    avenue: names[leg.avenue],
    from: [Math.round(nx(leg.from)), Math.round(ny(leg.from))],
    to: [Math.round(nx(leg.to)), Math.round(ny(leg.to))],
    lengthM: Math.round(lengthM),
    vertices: seq.length,
    offAvenueEdges: offAvenue.length,
    offAvenueM: Math.round(offAvenue.reduce((s, o) => s + o.lengthM, 0)),
  });
  for (let i = pathNodes.length === 0 ? 0 : 1; i < seq.length; i++) {
    pathNodes.push(seq[i]);
    pathAvenue.push(leg.avenue);
  }
}

// --- The raw path as points, with distance along it --------------------------
const P = pathNodes.map((k) => [nx(k), ny(k)]);
function alongOf(points) {
  const a = new Float64Array(points.length);
  for (let i = 1; i < points.length; i++) {
    a[i] = a[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  return a;
}
const along = alongOf(P);
const lengthM = along[along.length - 1];

// --- Station candidates: named cross streets within 20 m of the line ---------
// Street nodes near the path, not only the path's own vertices: where an avenue
// has two carriageways the path follows one, and a cross street may meet only
// the other.
const NEAR_M = 20;
const CELL = 50;
const grid = new Map();
for (let k = 0; k < NODE_COUNT; k++) {
  const key = `${Math.floor(nx(k) / CELL)},${Math.floor(ny(k) / CELL)}`;
  let list = grid.get(key);
  if (!list) grid.set(key, (list = []));
  list.push(k);
}
const nearNode = new Map(); // node -> { s, d, px, py, seg }
for (let i = 0; i + 1 < P.length; i++) {
  const [ax, ay] = P[i];
  const [bx, by] = P[i + 1];
  const segLen = Math.hypot(bx - ax, by - ay);
  const x0 = Math.floor((Math.min(ax, bx) - NEAR_M) / CELL);
  const x1 = Math.floor((Math.max(ax, bx) + NEAR_M) / CELL);
  const y0 = Math.floor((Math.min(ay, by) - NEAR_M) / CELL);
  const y1 = Math.floor((Math.max(ay, by) + NEAR_M) / CELL);
  for (let gx = x0; gx <= x1; gx++) {
    for (let gy = y0; gy <= y1; gy++) {
      const list = grid.get(`${gx},${gy}`);
      if (!list) continue;
      for (const k of list) {
        const px = nx(k);
        const py = ny(k);
        let t = segLen === 0 ? 0 : ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / (segLen * segLen);
        t = Math.max(0, Math.min(1, t));
        const qx = ax + t * (bx - ax);
        const qy = ay + t * (by - ay);
        const d = Math.hypot(px - qx, py - qy);
        if (d > NEAR_M) continue;
        const prevHit = nearNode.get(k);
        if (!prevHit || d < prevHit.d) nearNode.set(k, { s: along[i] + t * segLen, d, px: qx, py: qy, seg: i, t });
      }
    }
  }
}
const shortName = (n) => n.replace(/^Avenida /, "Av. ");
const lineAvenues = new Set([VS, ER, CALLAO, LH]);
const observations = [];
for (const [k, hit] of nearNode) {
  for (let a = adjStart[k]; a < adjStart[k + 1]; a++) {
    const e = adjEdge[a];
    const n = ename[e];
    if (n === 0 || lineAvenues.has(n)) continue;
    const c = eclass[e];
    if (c === CLASS_FOOTWAY || c === CLASS_CYCLEWAY || c === CLASS_SERVICE) continue;
    observations.push({ name: names[n], cls: c, avenue: (eflags[e] & FLAG_AVENUE) !== 0, ...hit });
  }
}
// One intersection per cross street: observations of the same name within
// 80 m along the line (two carriageways, or both sides of a dual avenue).
observations.sort((a, b) => a.s - b.s);
const clusters = [];
for (const o of observations) {
  const c = clusters.find((q) => q.name === o.name && Math.abs(o.s - q.sMax) <= 80);
  if (c) {
    c.obs.push(o);
    c.sMax = Math.max(c.sMax, o.s);
    c.cls = Math.min(c.cls, o.cls);
    c.avenue = c.avenue || o.avenue;
  } else {
    clusters.push({ name: o.name, cls: o.cls, avenue: o.avenue, sMax: o.s, obs: [o] });
  }
}
function interchangesNear(x, y, radius) {
  const out = [];
  for (let j = 0; j < subteNames.length; j++) {
    const d = Math.hypot(subteXY[2 * j] - x, subteXY[2 * j + 1] - y);
    if (d <= radius) {
      out.push({ line: subteLines[subteLine[j]].short, station: subteNames[j].name, distanceM: Math.round(d) });
    }
  }
  return out.sort((a, b) => a.distanceM - b.distanceM);
}
// The station point: the path point where the cross street's first-met
// carriageway crosses the line.
const candidates = clusters.map((c) => {
  const first = c.obs.reduce((m, o) => (o.s < m.s ? o : m), c.obs[0]);
  return {
    name: c.name,
    cls: c.cls,
    avenue: c.avenue,
    s: first.s,
    seg: first.seg,
    t: first.t,
    x: first.px,
    y: first.py,
    interchanges: interchangesNear(first.px, first.py, 250),
  };
});
candidates.sort((a, b) => a.s - b.s);
const tier = (c) => (c.avenue || c.cls <= 4 ? "avenue" : c.cls === 5 ? "tertiary" : "local");

// The corner where the line turns from Callao onto Las Heras is an
// intersection too, and Av. Callao is its cross street for the Las Heras stretch.
const turnIndex = pathNodes.indexOf(callaoLh[0]);
candidates.push({
  name: "Callao y Las Heras",
  cls: 4,
  avenue: true,
  s: along[turnIndex],
  seg: turnIndex,
  t: 0,
  x: P[turnIndex][0],
  y: P[turnIndex][1],
  interchanges: interchangesNear(P[turnIndex][0], P[turnIndex][1], 250),
  turn: true,
});
candidates.sort((a, b) => a.s - b.s);

// --- Choose the stations ----------------------------------------------------------
const first = { name: "Avenida General Iriarte", cls: 4, avenue: true, s: 0, seg: 0, t: 0, x: P[0][0], y: P[0][1], end: true };
first.interchanges = interchangesNear(first.x, first.y, 250);
const lastSeg = P.length - 2;
const last = {
  name: "Plaza Italia",
  cls: 4,
  avenue: true,
  s: lengthM,
  seg: lastSeg,
  t: 1,
  x: P[P.length - 1][0],
  y: P[P.length - 1][1],
  end: true,
};
last.interchanges = interchangesNear(last.x, last.y, 250);
const pool = [first, ...candidates.filter((c) => c.s > 250 && c.s < lengthM - 250), last];

const TARGET = 800;
const env = (k, d) => (process.env[k] === undefined ? d : Number(process.env[k]));
const MIN_GAP = env("MIN_GAP", 500);
const MAX_GAP = env("MAX_GAP", 1100);
const LOCAL_COST = env("LOCAL_COST", 10);
const TERTIARY_COST = env("TERTIARY_COST", 0.5);
const INTERCHANGE_BONUS = env("INTERCHANGE_BONUS", 4);
const gapCost = (g) => ((g - TARGET) / 100) ** 2;
const nodeCost = (c) =>
  (tier(c) === "local" ? LOCAL_COST : tier(c) === "tertiary" ? TERTIARY_COST : 0) -
  (c.interchanges.length > 0 ? INTERCHANGE_BONUS : 0);
const best = new Float64Array(pool.length).fill(Infinity);
const prev = new Int32Array(pool.length).fill(-1);
best[0] = 0;
for (let j = 1; j < pool.length; j++) {
  for (let i = 0; i < j; i++) {
    if (!Number.isFinite(best[i])) continue;
    const g = pool[j].s - pool[i].s;
    if (g < MIN_GAP || g > MAX_GAP) continue;
    const v = best[i] + gapCost(g) + nodeCost(pool[j]);
    if (v < best[j]) {
      best[j] = v;
      prev[j] = i;
    }
  }
}
if (!Number.isFinite(best[pool.length - 1])) throw new Error("no station set fits the spacing");
const chosen = [];
for (let j = pool.length - 1; j >= 0; j = prev[j]) {
  chosen.push(pool[j]);
  if (j === 0) break;
}
chosen.reverse();

// --- Insert the station points as path vertices -------------------------------------
// Each station is placed exactly on the path, so the snapped stop the replay
// derives (`stopsAlong`: nearest point on the path) is the station itself.
const inserts = new Map(); // seg -> [{t, station}]
for (const c of chosen) {
  if (c.end) continue;
  let list = inserts.get(c.seg);
  if (!list) inserts.set(c.seg, (list = []));
  list.push(c);
}
const Q = [];
const isStation = [];
const avenueOfQ = [];
for (let i = 0; i < P.length; i++) {
  Q.push(P[i]);
  isStation.push(i === 0 || i === P.length - 1);
  avenueOfQ.push(pathAvenue[Math.max(0, i - 1)]);
  const list = inserts.get(i);
  if (!list) continue;
  list.sort((a, b) => a.t - b.t);
  for (const c of list) {
    const segLen = Math.hypot(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]);
    if (c.t * segLen < 0.5) {
      isStation[Q.length - 1] = true;
      c.q = Q.length - 1;
      continue;
    }
    if ((1 - c.t) * segLen < 0.5) {
      c.snapNext = true;
      continue;
    }
    Q.push([c.x, c.y]);
    isStation.push(true);
    avenueOfQ.push(pathAvenue[i]);
    c.q = Q.length - 1;
  }
}
for (const c of chosen) {
  if (c.snapNext) {
    const idx = Q.findIndex((p) => p[0] === P[c.seg + 1][0] && p[1] === P[c.seg + 1][1]);
    isStation[idx] = true;
    c.q = idx;
  }
}
chosen[0].q = 0;
chosen[chosen.length - 1].q = Q.length - 1;
const alongQ = alongOf(Q);

// --- Simplify the polyline, keeping every station vertex -----------------------
const keep = new Uint8Array(Q.length);
for (let i = 0; i < Q.length; i++) if (isStation[i]) keep[i] = 1;
function douglasPeucker(a, b, tol) {
  let maxD = -1;
  let idx = -1;
  const [ax, ay] = Q[a];
  const [bx, by] = Q[b];
  const L = Math.hypot(bx - ax, by - ay);
  for (let i = a + 1; i < b; i++) {
    const [px, py] = Q[i];
    const d = L === 0 ? Math.hypot(px - ax, py - ay) : Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / L;
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }
  if (maxD > tol) {
    keep[idx] = 1;
    douglasPeucker(a, idx, tol);
    douglasPeucker(idx, b, tol);
  }
}
const anchors = [];
for (let i = 0; i < Q.length; i++) if (keep[i]) anchors.push(i);
for (let a = 0; a + 1 < anchors.length; a++) douglasPeucker(anchors[a], anchors[a + 1], 2.0);
const kept = [];
for (let i = 0; i < Q.length; i++) if (keep[i]) kept.push(i);

const round1 = (v) => Math.round(v * 10) / 10;
const polyline = kept.map((i) => [round1(Q[i][0]), round1(Q[i][1])]);
const polyAlong = alongOf(polyline);
const simplifiedLength = polyAlong[polyAlong.length - 1];
const keptIndexOf = new Map(kept.map((q, n) => [q, n]));

const stations = chosen.map((c) => {
  const v = keptIndexOf.get(c.q);
  return {
    x: polyline[v][0],
    y: polyline[v][1],
    name: shortName(c.name),
    along: shortName(names[avenueOfQ[c.q]]),
    alongLineM: Math.round(polyAlong[v]),
    vertex: v,
    crossStreetClass: tier(c),
    interchanges: c.interchanges,
  };
});
stations[0].along = shortName(names[VS]);
stations[stations.length - 1].along = shortName(names[LH]);
for (let n = 0; n < stations.length; n++) {
  stations[n].gapFromPreviousM = n === 0 ? null : stations[n].alongLineM - stations[n - 1].alongLineM;
}

const gaps = stations.slice(1).map((s) => s.gapFromPreviousM);
const line = {
  description: {
    what:
      "A new metro line for the film, on the corridor of the planned Subte Línea F: Barracas (Av. Vélez Sársfield) -> Av. Entre Ríos -> Av. Callao -> Av. General Las Heras -> Plaza Italia. Built from the real street centrelines of the region's street network (../ba/streets_*), not drawn by hand.",
    coordinates: `Local equirectangular metres, x east, y north, origin Plaza de Mayo: x = R*(lon-lon0)*(pi/180)*cos(lat0*pi/180), y = R*(lat-lat0)*(pi/180), R = ${R}, lon0 = ${lon0}, lat0 = ${lat0} (same frame as ../ba and ../sim exports). 0.1 m precision.`,
    polyline: "The line's centreline, south (Barracas) to north (Plaza Italia), simplified with Douglas-Peucker at 2 m; every station is a vertex (stations[i].vertex).",
    stations:
      "name = the cross street at the station (Plaza Italia: the plaza); along = the avenue the line runs under there; alongLineM = distance from the southern terminus along the polyline; crossStreetClass = avenue (an 'Avenida', or OSM primary/secondary) | tertiary | local; interchanges = standing Subte stations within 250 m.",
    method:
      "Shortest path over the street graph in four legs, each leg's own avenue at its length and every other edge at 30x (legs[].offAvenueM reports any bridge; all 0). Station candidates: named cross streets meeting street nodes within 20 m of the path, plus the Callao/Las Heras corner. Stations: both ends plus a subset chosen by dynamic programming with every gap in 500-1100 m, cost ((gap-800)/100)^2, +10 for a local cross street, +0.5 for a tertiary one, -4 for a Subte interchange within 250 m. The avenues cross the line every ~500 m between Av. Brasil and Av. Santa Fe, so a strict 700-900 m spacing at avenues only has no solution; the spacing this yields is reported in spacingM. The corner where the line turns from Av. Callao onto Av. General Las Heras is named 'Callao y Las Heras' (its cross street is the line's own other avenue).",
    rerun: "node .scratch/urbanly-film/data/line/build-line.mjs (from the repo root)",
  },
  name: "Línea F",
  origin: { lon0, lat0, R },
  lengthKm: Math.round(simplifiedLength / 10) / 100,
  rawPathLengthKm: Math.round(lengthM / 10) / 100,
  stationCount: stations.length,
  spacingM: { min: Math.min(...gaps), max: Math.max(...gaps), mean: Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) },
  legs: legReport,
  polyline,
  stations,
};

fs.writeFileSync(path.join(HERE, "line.json"), JSON.stringify(line, null, 1));

// --- The transit scenario file ---------------------------------------------------
const lngLat6 = (x, y) => toLngLat(x, y).map((v) => Math.round(v * 1e7) / 1e7);
const scenario = {
  lines: [
    {
      name: "Línea F",
      type: "metro",
      startYear: Number(process.env.LINE_START_YEAR ?? 2023),
      speedKph: Number(process.env.LINE_SPEED_KPH ?? 24.4),
      path: kept.map((i) => lngLat6(Q[i][0], Q[i][1])),
      stops: chosen.map((c) => lngLat6(Q[c.q][0], Q[c.q][1])),
    },
  ],
};
fs.writeFileSync(path.join(HERE, "transit-scenario.json"), JSON.stringify(scenario, null, 1));

console.log(`legs: ${JSON.stringify(legReport, null, 1)}`);
console.log(`length ${line.lengthKm} km (raw ${line.rawPathLengthKm} km), ${polyline.length} vertices, ${stations.length} stations`);
for (const s of stations) {
  console.log(
    `${String(s.alongLineM).padStart(6)} m  gap ${String(s.gapFromPreviousM ?? "-").padStart(5)}  ${s.along} / ${s.name}` +
      (s.interchanges.length ? `  [${s.interchanges.map((t) => `${t.line} ${t.station} ${t.distanceM} m`).join(", ")}]` : ""),
  );
}
console.log("all cross-street candidates:");
for (const c of candidates) {
  console.log(`  ${Math.round(c.s)} m ${shortName(c.name)} (${tier(c)})` + (c.interchanges.length ? ` [${c.interchanges.map((t) => t.line + " " + t.station).join(", ")}]` : ""));
}
