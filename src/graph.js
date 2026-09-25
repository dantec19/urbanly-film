// graph.js: shortest paths over the street graph (Dijkstra with a binary heap), for the growth of the city
// from its founding point and for travel-time wavefronts.

export function adjacency(nNodes, edges, weights) {
  const deg = new Uint32Array(nNodes + 1);
  const m = edges.length / 2;
  for (let e = 0; e < m; e++) { deg[edges[e * 2] + 1]++; deg[edges[e * 2 + 1] + 1]++; }
  for (let i = 0; i < nNodes; i++) deg[i + 1] += deg[i];
  const nbr = new Uint32Array(m * 2), w = new Float32Array(m * 2), eid = new Uint32Array(m * 2);
  const fill = deg.slice(0, nNodes);
  for (let e = 0; e < m; e++) {
    const a = edges[e * 2], b = edges[e * 2 + 1];
    nbr[fill[a]] = b; w[fill[a]] = weights[e]; eid[fill[a]++] = e;
    nbr[fill[b]] = a; w[fill[b]] = weights[e]; eid[fill[b]++] = e;
  }
  return { start: deg, nbr, w, eid, n: nNodes };
}

// multi-source Dijkstra: sources = [[node, initialCost], ...]; edgeCost(e, baseWeight) may override weights
export function dijkstra(adj, sources, edgeCost = null, pred = null) {
  const dist = new Float32Array(adj.n).fill(Infinity);
  if (pred) pred.fill(-1);
  const cap = adj.nbr.length + adj.n + 16;
  const heapN = new Uint32Array(cap), heapD = new Float32Array(cap);
  let size = 0;
  const push = (node, d) => {
    let i = size++;
    while (i > 0) { const p = (i - 1) >> 1; if (heapD[p] <= d) break; heapN[i] = heapN[p]; heapD[i] = heapD[p]; i = p; }
    heapN[i] = node; heapD[i] = d;
  };
  const pop = () => {
    const n = heapN[0], d = heapD[0]; const ln = heapN[--size], ld = heapD[size];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1; if (c >= size) break;
      if (c + 1 < size && heapD[c + 1] < heapD[c]) c++;
      if (heapD[c] >= ld) break;
      heapN[i] = heapN[c]; heapD[i] = heapD[c]; i = c;
    }
    heapN[i] = ln; heapD[i] = ld;
    return [n, d];
  };
  for (const [s, d0] of sources) { if (d0 < dist[s]) { dist[s] = d0; push(s, d0); } }
  while (size) {
    const [u, d] = pop();
    if (d > dist[u]) continue;
    for (let k = adj.start[u]; k < adj.start[u + 1]; k++) {
      const v = adj.nbr[k], c = edgeCost ? edgeCost(adj.eid[k], adj.w[k]) : adj.w[k];
      const nd = d + c;
      if (nd < dist[v]) { dist[v] = nd; if (pred) pred[v] = u; push(v, nd); }
    }
  }
  return dist;
}

export function nearestNode(nodes, x, y) {
  let best = -1, bd = Infinity;
  for (let i = 0; i < nodes.length / 2; i++) { const d = (nodes[i * 2] - x) ** 2 + (nodes[i * 2 + 1] - y) ** 2; if (d < bd) { bd = d; best = i; } }
  return best;
}

// uniform grid over node positions, for nearest-node lookups of many points
export function nodeGrid(nodes, cell = 100) {
  const n = nodes.length / 2;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) { const x = nodes[i * 2], y = nodes[i * 2 + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const gw = Math.ceil((x1 - x0) / cell) + 1, gh = Math.ceil((y1 - y0) / cell) + 1;
  const start = new Uint32Array(gw * gh + 1), of = i => Math.floor((nodes[i * 2 + 1] - y0) / cell) * gw + Math.floor((nodes[i * 2] - x0) / cell);
  for (let i = 0; i < n; i++) start[of(i) + 1]++;
  for (let c = 0; c < gw * gh; c++) start[c + 1] += start[c];
  const items = new Uint32Array(n), fill = start.slice(0, gw * gh);
  for (let i = 0; i < n; i++) items[fill[of(i)]++] = i;
  // nearest node to (x, y) searching rings of cells; returns [node, distance] (node -1 when none within maxR cells)
  function nearest(x, y, maxR = 8, ok = null) {
    const cx = Math.floor((x - x0) / cell), cy = Math.floor((y - y0) / cell);
    let best = -1, bd = Infinity;
    for (let r = 0; r <= maxR; r++) {
      for (let j = cy - r; j <= cy + r; j++) for (let i = cx - r; i <= cx + r; i++) {
        if (i < 0 || j < 0 || i >= gw || j >= gh || (Math.abs(i - cx) !== r && Math.abs(j - cy) !== r)) continue;
        for (let k = start[j * gw + i]; k < start[j * gw + i + 1]; k++) {
          const v = items[k]; if (ok && !ok(v)) continue;
          const d = (nodes[v * 2] - x) ** 2 + (nodes[v * 2 + 1] - y) ** 2;
          if (d < bd) { bd = d; best = v; }
        }
      }
      if (best >= 0 && Math.sqrt(bd) < r * cell) break;
    }
    return [best, Math.sqrt(bd)];
  }
  return { nearest };
}
