// growth-points.mjs: one point per building a run completed, for the film's yearly tiles.
//   node data/growth-points.mjs data/sim/buenosaires-developments.json data/film/growth_base
// Writes <out>.f32 (N×4: x, y, completeT = years since 2022-01-01, units) and <out>.json (counts per year).
// Buildings that complete after the run are left out; fondo-de-lote units sit at their lot's centroid.
import { readFileSync, writeFileSync } from 'node:fs';

const [src, out] = process.argv.slice(2);
const d = JSON.parse(readFileSync(src, 'utf8'));
const y0 = d.startYear;
const rows = [], perYear = {};
for (const b of d.buildings) {
  if (b.completesAfterRun || !b.complete) continue;
  const T = b.complete[0] - y0 + (b.complete[1] - 1) / 12;
  if (T < 0 || T > d.endYear - y0 + 1) continue;
  // area-weighted centroid of the outer rings
  let A = 0, cx = 0, cy = 0;
  for (const poly of b.footprint) {
    const r = poly[0], n = r.length / 2;
    for (let i = 0; i < n; i++) {
      const x0 = r[i * 2], y0_ = r[i * 2 + 1], x1 = r[((i + 1) % n) * 2], y1 = r[((i + 1) % n) * 2 + 1];
      const c = x0 * y1 - x1 * y0_;
      A += c; cx += (x0 + x1) * c; cy += (y0_ + y1) * c;
    }
  }
  if (Math.abs(A) < 1e-6) { const r = b.footprint[0][0]; cx = r[0]; cy = r[1]; } else { cx /= 3 * A; cy /= 3 * A; }
  rows.push(cx, cy, T, b.units || 0);
  const k = String(b.complete[0]);
  perYear[k] = perYear[k] || { buildings: 0, units: 0 };
  perYear[k].buildings++; perYear[k].units += b.units || 0;
}
writeFileSync(out + '.f32', Buffer.from(new Float32Array(rows).buffer));
writeFileSync(out + '.json', JSON.stringify({ source: src, startYear: y0, endYear: d.endYear, points: rows.length / 4, perYear }, null, 1));
console.log(`${out}: ${rows.length / 4} completed buildings`, perYear);
