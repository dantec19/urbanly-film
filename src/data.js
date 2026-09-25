// data.js: loads the exported Buenos Aires layers (data/ba/, see data/ba/manifest.json) into typed arrays.
const DIR = 'data/ba/';

async function bin(name, Type) {
  const r = await fetch(DIR + name); if (!r.ok) throw new Error(name + ' ' + r.status);
  return new Type(await r.arrayBuffer());
}
const json = name => fetch(DIR + name).then(r => r.json());
const F = Float32Array, U32 = Uint32Array, U16 = Uint16Array, U8 = Uint8Array;

// Douglas–Peucker on an open ring (closed implicitly), in place into out[]; keeps shapes, drops jitter
function simplifyRing(xy, o0, m, tol, out) {
  if (m <= 4) { for (let k = 0; k < m; k++) out.push(xy[(o0 + k) * 2], xy[(o0 + k) * 2 + 1]); return m; }
  const keep = new Uint8Array(m + 1); keep[0] = keep[m] = 1;
  const X = k => xy[(o0 + (k % m)) * 2], Y = k => xy[(o0 + (k % m)) * 2 + 1];
  const stack = [[0, m]];
  const t2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = X(a), ay = Y(a), bx = X(b), by = Y(b), dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    let best = -1, bd = t2;
    for (let k = a + 1; k < b; k++) {
      const px = X(k) - ax, py = Y(k) - ay;
      let d2;
      if (L2 < 1e-9) d2 = px * px + py * py;
      else { const c = px * dy - py * dx; d2 = c * c / L2; }
      if (d2 > bd) { bd = d2; best = k; }
    }
    if (best >= 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  let n = 0;
  for (let k = 0; k < m; k++) if (keep[k]) { out.push(X(k), Y(k)); n++; }
  if (n < 3) { out.length -= n * 2; for (let k = 0; k < m; k++) out.push(X(k), Y(k)); return m; }
  return n;
}

export async function loadWorld() {
  const [nodes, edges, ecls, eflags, elen,
    bxy, boff, bstart, bh, btype, bcen, bpar, bfs,
    pxy, poff, pcen, parea, puse, pbfar, pbmaxh, pzmaxh, pland, papt, pzcov, penv,
    sxy, soff, sline, stxy, stline, bdxy, bdoff, brxy, broff, brb,
    tcxy, tcn, stats, subteLines, stations, barrios] = await Promise.all([
    bin('streets_nodes.f32', F), bin('streets_edges.u32', U32), bin('streets_edge_class.u8', U8), bin('streets_edge_flags.u8', U8), bin('streets_edge_length.f32', F),
    bin('buildings_xy.f32', F), bin('buildings_ring_offsets.u32', U32), bin('buildings_ring_start.u32', U32), bin('buildings_height.f32', F), bin('buildings_type.u8', U8), bin('buildings_centroid.f32', F), bin('buildings_parcel.u32', U32), bin('buildings_floorspace.f32', F),
    bin('parcels_xy.f32', F), bin('parcels_ring_offsets.u32', U32), bin('parcels_centroid.f32', F), bin('parcels_area.f32', F), bin('parcels_use.u8', U8), bin('parcels_built_far.f32', F), bin('parcels_building_max_height.f32', F), bin('parcels_zone_max_height.f32', F), bin('parcels_land_value.f32', F), bin('parcels_apartment_price.f32', F), bin('parcels_zone_max_coverage.f32', F), bin('parcels_zone_envelope_derived.f32', F),
    bin('subte_lines_xy.f32', F), bin('subte_lines_offsets.u32', U32), bin('subte_lines_line.u8', U8), bin('subte_stations_xy.f32', F), bin('subte_stations_line.u8', U8), bin('boundary_xy.f32', F), bin('boundary_ring_offsets.u32', U32), bin('barrios_xy.f32', F), bin('barrios_ring_offsets.u32', U32), bin('barrios_ring_barrio.u8', U8),
    bin('trees_cell_xy.f32', F), bin('trees_cell_count.u8', U8), json('stats.json'), json('subte_lines.json'), json('subte_stations.json'), json('barrios.json'),
  ]);

  // ---- streets: vehicular ways and car-free streets; no footways, cycleways or service aisles ----
  const nE = ecls.length, keepE = [];
  for (let e = 0; e < nE; e++) { const c = ecls[e]; if (((c >= 1 && c <= 6) || c === 13) && (eflags[e] & 4)) keepE.push(e); }
  const E = new U32(keepE.length * 2), C = new U8(keepE.length), L = new F(keepE.length), FL = new U8(keepE.length);
  keepE.forEach((e, i) => {
    E[i * 2] = edges[e * 2]; E[i * 2 + 1] = edges[e * 2 + 1]; L[i] = elen[e]; FL[i] = eflags[e];
    const c = ecls[e], av = eflags[e] & 2;
    C[i] = c <= 3 ? 2 : (c <= 5 || av) ? 1 : 0;
  });

  // ---- buildings: exterior rings, lightly simplified (0.35 m) ----
  const nB = bh.length, nR = boff.length - 1;
  const ringB = new U32(nR);
  for (let b = 0; b < nB; b++) for (let r = bstart[b]; r < bstart[b + 1]; r++) ringB[r] = b;
  const out = [], roff = [0], rbld = [];
  for (let r = 0; r < nR; r++) {
    const o0 = boff[r], m = boff[r + 1] - o0;
    if (m < 3) continue;
    const n = simplifyRing(bxy, o0, m, .35, out);
    roff.push(out.length / 2); rbld.push(ringB[r]);
  }
  const rings = { xy: new F(out), off: new U32(roff), bld: new U32(rbld) };
  const cx = new F(nB), cy = new F(nB);
  for (let b = 0; b < nB; b++) { cx[b] = bcen[b * 2]; cy[b] = bcen[b * 2 + 1]; }

  return {
    streets: { nodes, edges: E, cls: C, len: L, flags: FL },
    buildings: { rings, h: bh, type: btype, cx, cy, parcel: bpar, floorspace: bfs },
    parcels: { xy: pxy, off: poff, cen: pcen, area: parea, use: puse, builtFar: pbfar, maxBuiltH: pbmaxh, zoneMaxH: pzmaxh, land: pland, apt: papt, zoneCov: pzcov, envelope: penv },
    subte: { xy: sxy, off: soff, line: sline, stXY: stxy, stLine: stline, lines: subteLines, stations },
    boundary: { xy: bdxy, off: bdoff },
    barrios: { xy: brxy, off: broff, ring: brb, list: barrios },
    trees: { cellXY: tcxy, count: tcn },
    stats: {
      streetKm: stats.numbers.streetKm.value, parcels: stats.numbers.parcels.value, buildings: stats.numbers.buildings.value,
      persons: stats.numbers.persons.value, households: stats.numbers.households.value, jobs: stats.numbers.jobs.value,
      dwellings: stats.numbers.dwellings.value, trees: stats.numbers.trees.value, stations: stats.numbers.subteStations.value,
    },
  };
}
