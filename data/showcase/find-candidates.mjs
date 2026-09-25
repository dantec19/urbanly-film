// Rank ar-multifamily developments of the BA run as showcase candidates.
//   node .scratch/urbanly-film/data/showcase/find-candidates.mjs   (from the repo root)
// Reads only the film exports (data/ba, data/sim/buenosaires-developments.json).
// Writes data/showcase/candidates.json.
import { readFileSync, writeFileSync } from "node:fs";

const ROOT = ".scratch/urbanly-film/data/";
const BA = ROOT + "ba/";
const read = (name) => {
  const b = readFileSync(BA + name);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};
const f32 = (n) => new Float32Array(read(n));
const u32 = (n) => new Uint32Array(read(n));
const u16 = (n) => new Uint16Array(read(n));
const u8 = (n) => new Uint8Array(read(n));
const json = (n) => JSON.parse(readFileSync(BA + n, "utf8"));

const dev = JSON.parse(readFileSync(ROOT + "sim/buenosaires-developments.json", "utf8"));
const demolitionByID = new Map(dev.demolitions.map((d) => [d.id, d]));

// Parcels
const pID = u32("parcels_id.u32");
const pOff = u32("parcels_ring_offsets.u32");
const pXY = f32("parcels_xy.f32");
const pArea = f32("parcels_area.f32");
const pCent = f32("parcels_centroid.f32");
const pZone = u16("parcels_zone.u16");
const pZMaxH = f32("parcels_zone_max_height.f32");
const pZCov = f32("parcels_zone_max_coverage.f32");
const pLand = f32("parcels_land_value.f32");
const pApt = f32("parcels_apartment_price.f32");
const zones = json("parcels_zones.json");
const rowByParcelID = new Map();
for (let r = 0; r < pID.length; r++) rowByParcelID.set(pID[r], r);

// Streets (vehicular classes 1..7 plus car-free 13; footways/cycleways out)
const sN = f32("streets_nodes.f32");
const sE = u32("streets_edges.u32");
const sC = u8("streets_edge_class.u8");
const sName = u16("streets_edge_name.u16");
const streetNames = json("streets_names.json");
const CELL = 50;
const grid = new Map();
const key = (i, j) => i * 100000 + j;
for (let e = 0; e < sC.length; e++) {
  const c = sC[e];
  if (!((c >= 1 && c <= 7) || c === 13)) continue;
  const a = sE[e * 2], b = sE[e * 2 + 1];
  const x0 = Math.min(sN[a * 2], sN[b * 2]), x1 = Math.max(sN[a * 2], sN[b * 2]);
  const y0 = Math.min(sN[a * 2 + 1], sN[b * 2 + 1]), y1 = Math.max(sN[a * 2 + 1], sN[b * 2 + 1]);
  for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++)
    for (let j = Math.floor(y0 / CELL); j <= Math.floor(y1 / CELL); j++) {
      const k = key(i, j);
      let l = grid.get(k);
      if (!l) grid.set(k, (l = []));
      l.push(e);
    }
}
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const L = dx * dx + dy * dy;
  let t = L > 0 ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx - px, qy = ay + t * dy - py;
  return Math.hypot(qx, qy);
}
function nearestStreet(px, py, radius = 60) {
  let best = Infinity, bestE = -1;
  const r = Math.ceil(radius / CELL);
  const ci = Math.floor(px / CELL), cj = Math.floor(py / CELL);
  for (let i = ci - r; i <= ci + r; i++)
    for (let j = cj - r; j <= cj + r; j++) {
      const l = grid.get(key(i, j));
      if (!l) continue;
      for (const e of l) {
        const a = sE[e * 2], b = sE[e * 2 + 1];
        const d = segDist(px, py, sN[a * 2], sN[a * 2 + 1], sN[b * 2], sN[b * 2 + 1]);
        if (d < best) { best = d; bestE = e; }
      }
    }
  return { d: best, e: bestE };
}

// Barrios
const barrios = json("barrios.json");
const bxy = f32("barrios_xy.f32");
const boff = u32("barrios_ring_offsets.u32");
const bring = u8("barrios_ring_barrio.u8");
function inRing(xy, s, e, x, y) {
  let inside = false;
  for (let i = s, j = e - 1; i < e; j = i++) {
    const xi = xy[i * 2], yi = xy[i * 2 + 1], xj = xy[j * 2], yj = xy[j * 2 + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function barrioOf(x, y) {
  for (let r = 0; r < bring.length; r++) if (inRing(bxy, boff[r], boff[r + 1], x, y)) return barrios[bring[r]].name;
  return null;
}

// Minimum-area oriented rectangle of a ring (edge-aligned; exact for convex, fine for lots).
function orientedBox(ring) {
  const n = ring.length / 2;
  let best = null;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ex = ring[j * 2] - ring[i * 2], ey = ring[j * 2 + 1] - ring[i * 2 + 1];
    const L = Math.hypot(ex, ey);
    if (L < 1e-6) continue;
    const ux = ex / L, uy = ey / L;
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (let k = 0; k < n; k++) {
      const x = ring[k * 2], y = ring[k * 2 + 1];
      const a = x * ux + y * uy, b = -x * uy + y * ux;
      a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b);
    }
    const w = a1 - a0, h = b1 - b0;
    if (!best || w * h < best.area) best = { area: w * h, w, h, ux, uy };
  }
  const short = Math.min(best.w, best.h), long = Math.max(best.w, best.h);
  return { short, long, boxArea: best.area, longAxis: best.w >= best.h ? [best.ux, best.uy] : [-best.uy, best.ux] };
}
function ringArea(ring) {
  let a = 0;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) a += ring[j * 2] * ring[i * 2 + 1] - ring[i * 2] * ring[j * 2 + 1];
  return a / 2;
}
function parcelRing(r) {
  return Array.from(pXY.subarray(pOff[r] * 2, pOff[r + 1] * 2));
}

// Street-facing edges of a lot: edges >= 2 m whose midpoint is within FRONT_M of
// a vehicular street centreline. Mid-block = exactly one street-facing side, and it
// is a short side (the frontage).
const FRONT_M = 14;
function frontage(ring, longAxis) {
  const n = ring.length / 2;
  const facing = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = ring[i * 2], ay = ring[i * 2 + 1], bx = ring[j * 2], by = ring[j * 2 + 1];
    const L = Math.hypot(bx - ax, by - ay);
    if (L < 2) continue;
    const { d, e } = nearestStreet((ax + bx) / 2, (ay + by) / 2);
    // Edge direction vs long axis: |cos| > 0.7 means a long side.
    const cos = Math.abs(((bx - ax) * longAxis[0] + (by - ay) * longAxis[1]) / L);
    if (d < FRONT_M) facing.push({ edge: i, len: Math.round(L * 10) / 10, dist: Math.round(d * 10) / 10, longSide: cos > 0.7, street: streetNames[sName[e]] ?? "" });
  }
  return facing;
}


const inRingArr = (r, x, y) => { let c = false; const n = r.length / 2; for (let i = 0, j = n - 1; i < n; j = i++) { const xi = r[i*2], yi = r[i*2+1], xj = r[j*2], yj = r[j*2+1]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
function inLotShare(polys, ring, step = 0.25) {
  let tot = 0, inside = 0;
  for (const poly of polys) {
    const r = poly[0]; let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < r.length; i += 2) { x0 = Math.min(x0, r[i]); x1 = Math.max(x1, r[i]); y0 = Math.min(y0, r[i+1]); y1 = Math.max(y1, r[i+1]); }
    for (let x = x0 + step / 2; x < x1; x += step) for (let y = y0 + step / 2; y < y1; y += step) {
      if (!inRingArr(r, x, y) || poly.slice(1).some((h) => inRingArr(h, x, y))) continue;
      tot++; if (inRingArr(ring, x, y)) inside++;
    }
  }
  return tot ? Math.round((inside / tot) * 100) / 100 : 0;
}
const devs = dev.buildings;
const complete = devs.filter((b) => b.complete && !b.completesAfterRun);
function centroidOfFootprint(fp) {
  const ring = fp[0][0];
  let a = 0, cx = 0, cy = 0;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const f = ring[j * 2] * ring[i * 2 + 1] - ring[i * 2] * ring[j * 2 + 1];
    a += f; cx += (ring[j * 2] + ring[i * 2]) * f; cy += (ring[j * 2 + 1] + ring[i * 2 + 1]) * f;
  }
  return [cx / (3 * a), cy / (3 * a)];
}
const devCentroids = complete.map((b) => ({ id: b.id, kind: b.kind, c: b.footprint ? centroidOfFootprint(b.footprint) : null }));

const PREFERRED = ["Palermo", "Villa Crespo", "Almagro", "Caballito", "Colegiales", "Belgrano", "Nuñez", "Nunez", "Saavedra", "Villa Urquiza", "Chacarita", "Coghlan", "Villa Ortuzar", "Recoleta", "Villa Devoto", "Flores"];
const reasons = {};
const bump = (r) => (reasons[r] = (reasons[r] ?? 0) + 1);
const out = [];
for (const b of devs) {
  if (b.kind !== "ar-multifamily") continue;
  bump("ar-multifamily");
  if (b.parcels.length !== 1) { bump("multi-parcel"); continue; }
  if (b.replaces.length < 1) { bump("replaces-nothing"); continue; }
  const allOlds = b.replaces.map((id) => demolitionByID.get(id));
  if (allOlds.some((d) => !d || d.origin !== "seed")) { bump("replaces-not-seed"); continue; }
  if (b.stories < 8 || b.stories > 14) { bump("stories-out"); continue; }
  if (!b.complete || b.completesAfterRun) { bump("not-complete"); continue; }
  const r = rowByParcelID.get(b.parcels[0]);
  if (r === undefined) { bump("no-parcel-row"); continue; }
  const ring = parcelRing(r);
  // A replaced seed building counts as ON the lot when at least half its
  // footprint lies inside the lot; the rest are neighbours whose footprint
  // only overlaps the lot's edge (the engine demolishes every building linked
  // to the parcel).
  for (const d of allOlds) d.inLot = inLotShare(d.footprint, ring);
  const olds = allOlds.filter((d) => d.inLot >= 0.5);
  const neighbours = allOlds.filter((d) => d.inLot < 0.5);
  if (olds.length < 1 || olds.length > 2) { bump("on-lot-replaced-not-1-2"); continue; }
  if (!olds.every((d) => d.stories <= 2 || d.heightM <= 8)) { bump("old-too-tall"); continue; }
  const box = orientedBox(ring);
  if (box.short < 8 || box.short > 11 || box.long < 25 || box.long > 45) { bump("lot-shape"); continue; }
  const rect = Math.abs(ringArea(ring)) / box.boxArea;
  if (rect < 0.85) { bump("not-rectangular"); continue; }
  const facing = frontage(ring, box.longAxis);
  const midBlock = facing.length >= 1 && facing.every((f) => !f.longSide);
  if (!midBlock) { bump("not-mid-block"); continue; }
  const cx = pCent[r * 2], cy = pCent[r * 2 + 1];
  const barrio = barrioOf(cx, cy);
  let n250 = 0, n500 = 0, mf250 = 0, mf500 = 0;
  for (const d of devCentroids) {
    if (!d.c || d.id === b.id) continue;
    const dd = Math.hypot(d.c[0] - cx, d.c[1] - cy);
    if (dd <= 500) { n500++; if (d.kind === "ar-multifamily") mf500++; }
    if (dd <= 250) { n250++; if (d.kind === "ar-multifamily") mf250++; }
  }
  const z = pZone[r] !== 0xffff ? zones[pZone[r]] : null;
  out.push({
    id: b.id,
    barrio,
    preferred: PREFERRED.includes(barrio),
    parcelID: b.parcels[0],
    parcelRow: r,
    centroid: [Math.round(cx * 10) / 10, Math.round(cy * 10) / 10],
    lot: { areaM2: Math.round(pArea[r]), frontageM: Math.round(box.short * 10) / 10, depthM: Math.round(box.long * 10) / 10, rectangularity: Math.round(rect * 100) / 100 },
    facing,
    zone: z ? { name: z.name, baseZone: z.baseZone, maxHeight: pZMaxH[r], maxCoverage: Number.isNaN(pZCov[r]) ? null : pZCov[r] } : null,
    landValue: Math.round(pLand[r]),
    aptPrice: Math.round(pApt[r]),
    old: olds.map((d) => ({ id: d.id, type: d.type, heightM: d.heightM, stories: d.stories, floorAreaM2: d.floorAreaM2, units: d.units, date: d.date, inLot: d.inLot })),
    neighboursDemolished: neighbours.map((d) => ({ id: d.id, type: d.type, heightM: d.heightM, stories: d.stories, inLot: d.inLot })),
    newBuildingsOnParcel: devs.filter((x) => x.parcels.includes(b.parcels[0])).length,
    new: { stories: b.stories, heightM: b.heightM, units: b.units, floorAreaM2: b.floorAreaM2, footprintAreaM2: b.footprintAreaM2, start: b.start, complete: b.complete },
    nearby: { all250: n250, all500: n500, mf250, mf500 },
  });
}
out.sort((a, b) => (a.neighboursDemolished.length - b.neighboursDemolished.length) || (a.newBuildingsOnParcel - b.newBuildingsOnParcel) || (b.preferred - a.preferred) || (b.nearby.mf500 - a.nearby.mf500));
console.log("funnel", reasons);
console.log(`${out.length} candidates; preferred barrios: ${out.filter((o) => o.preferred).length}`);
const byBarrio = {};
for (const o of out) byBarrio[o.barrio] = (byBarrio[o.barrio] ?? 0) + 1;
console.log("by barrio", byBarrio);
for (const o of out.slice(0, 40)) {
  console.log(
    `${o.id} ${o.barrio} p${o.parcelID} row${o.parcelRow} lot ${o.lot.frontageM}x${o.lot.depthM} (${o.lot.areaM2} m2, rect ${o.lot.rectangularity}) ` +
      `old ${o.old.map((d) => `${d.id}:${d.heightM}m/${d.stories}st`).join(",")} new ${o.new.stories}st ${o.new.units}u ${o.new.floorAreaM2}m2 ` +
      `${o.new.start.join("-")}->${o.new.complete.join("-")} near mf500 ${o.nearby.mf500} all500 ${o.nearby.all500} zone ${o.zone?.name} ${o.zone?.maxHeight}m ` +
      `front ${o.facing.map((f) => `${f.street}@${f.dist}`).join("/")}`,
  );
}
writeFileSync(ROOT + "showcase/candidates.json", JSON.stringify(out, null, 1));
