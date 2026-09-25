#!/usr/bin/env python3
"""Sanity-check an exported run: per-year counts, a 10x10 grid of where the
new buildings are, height/size distributions, and a PNG map of the footprints
coloured by start year (demolitions in grey).

    python3 check-developments.py <region>-developments.json <region>-totals.json <out.png>
"""
import json
import statistics as st
import sys
from collections import Counter, defaultdict

from PIL import Image, ImageDraw

dev_path, tot_path, png_path = sys.argv[1], sys.argv[2], sys.argv[3]
dev = json.load(open(dev_path))
tot = json.load(open(tot_path))
B, D = dev["buildings"], dev["demolitions"]
y0, y1 = dev["startYear"], dev["endYear"]
print(f"{dev['region']} {y0}-{y1} seed {dev['seed']}: {len(B)} buildings created, {len(D)} demolished")

# --- per-year -----------------------------------------------------------------
kinds = sorted({b["kind"] for b in B})
print("\nStarted per year (pre-run pipeline counted in the first year):")
print("year  " + "  ".join(f"{k[:14]:>14}" for k in kinds) + "   total   units  floorArea_m2  completed  demolished  population  households  jobs")
for row in tot["years"]:
    s = row["started"]
    print(
        f"{row['year']}  "
        + "  ".join(f"{s['byKind'].get(k, {}).get('buildings', 0):>14}" for k in kinds)
        + f"  {s['buildings']:>6}  {s['units']:>6}  {s['floorAreaM2']:>12,}  {row['completed']['buildings']:>9}  {row['demolitions']['buildings']:>10}"
        + f"  {row['populationAtEnd'] or 0:>10,}  {row['householdsAtEnd'] or 0:>10,}  {row['jobs'] or 0:>10,}"
    )
es = [(r["year"], r["engineSummary"]["buildings_created"]) for r in tot["years"]]
print("engine summary buildings_created:", es)

# --- where ---------------------------------------------------------------------
def centroid(fp):
    ring = fp[0][0]
    xs, ys = ring[0::2], ring[1::2]
    return sum(xs) / len(xs), sum(ys) / len(ys)

pts = [(centroid(b["footprint"]), b) for b in B if b["footprint"]]
xs = [p[0][0] for p in pts]
ys = [p[0][1] for p in pts]
minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
print(f"\nCentroid extent (m from origin): x {minx:,.0f} .. {maxx:,.0f}, y {miny:,.0f} .. {maxy:,.0f}")
N = 10
grid = [[0] * N for _ in range(N)]
for (x, y), _ in pts:
    i = min(N - 1, int((x - minx) / (maxx - minx) * N))
    j = min(N - 1, int((y - miny) / (maxy - miny) * N))
    grid[j][i] += 1
print(f"10x10 grid of new-building counts (north at top; cell {(maxx - minx) / N:,.0f} x {(maxy - miny) / N:,.0f} m):")
for j in reversed(range(N)):
    print("  " + " ".join(f"{c:>5}" for c in grid[j]))
for k in kinds:
    g = [[0] * N for _ in range(N)]
    for (x, y), b in pts:
        if b["kind"] != k:
            continue
        i = min(N - 1, int((x - minx) / (maxx - minx) * N))
        j = min(N - 1, int((y - miny) / (maxy - miny) * N))
        g[j][i] += 1
    print(f"  {k}:")
    for j in reversed(range(N)):
        print("    " + " ".join(f"{c:>5}" for c in g[j]))

# --- heights and sizes ------------------------------------------------------------
def q(v, p):
    v = sorted(v)
    return v[min(len(v) - 1, int(p * len(v)))]

print("\nPer kind: count, height m p10/p50/p90/max, storeys p50/max, units p50/p90, floor area m2 p50/p90, footprint m2 p50")
for k in kinds:
    bs = [b for b in B if b["kind"] == k]
    h = [b["heightM"] for b in bs]
    s = [b["stories"] for b in bs]
    u = [b["units"] for b in bs]
    fa = [b["floorAreaM2"] for b in bs]
    fp = [b["footprintAreaM2"] or 0 for b in bs]
    print(
        f"  {k:22} {len(bs):6}  h {q(h, .1):5} {q(h, .5):5} {q(h, .9):5} {max(h):6}  st {q(s, .5):3} {max(s):3}"
        f"  u {q(u, .5):4} {q(u, .9):4}  fa {q(fa, .5):6} {q(fa, .9):6}  fp {q(fp, .5):5}"
    )
m_per_storey = [b["heightM"] / b["stories"] for b in B if b["stories"] > 0]
print(f"height per storey: p10 {q(m_per_storey, .1):.2f}, p50 {q(m_per_storey, .5):.2f}, p90 {q(m_per_storey, .9):.2f}")
bad = [b for b in B if b["heightM"] <= 0 or b["stories"] <= 0 or b["heightM"] > 200]
print(f"implausible heights (<=0 or >200 m): {len(bad)}")
print("footprintFrom:", Counter(b["footprintFrom"] for b in B))
print("types:", Counter((b["kind"], b["type"]) for b in B).most_common())
print("demolition origins:", Counter(d["origin"] for d in D), "types:", Counter(d["type"] for d in D).most_common())
print("demolitions without footprint:", sum(1 for d in D if not d["footprint"]))

# --- map ---------------------------------------------------------------------------
W = 1600
allx = xs + [centroid(d["footprint"])[0] for d in D if d["footprint"]]
ally = ys + [centroid(d["footprint"])[1] for d in D if d["footprint"]]
bx0, bx1, by0, by1 = min(allx) - 300, max(allx) + 300, min(ally) - 300, max(ally) + 300
scale = W / max(bx1 - bx0, by1 - by0)
H = int((by1 - by0) * scale) + 1
img = Image.new("RGB", (int((bx1 - bx0) * scale) + 1, H), (14, 16, 22))
dr = ImageDraw.Draw(img)

def px(ring):
    return [((ring[i] - bx0) * scale, H - (ring[i + 1] - by0) * scale) for i in range(0, len(ring), 2)]

def year_colour(y):
    t = (min(max(y, y0), y1) - y0) / max(1, y1 - y0)
    stops = [(68, 1, 84), (59, 82, 139), (33, 145, 140), (94, 201, 98), (253, 231, 37)]
    f = t * (len(stops) - 1)
    i = min(len(stops) - 2, int(f))
    a, b = stops[i], stops[i + 1]
    u = f - i
    return tuple(int(a[c] + (b[c] - a[c]) * u) for c in range(3))

for d in D:
    for poly in d["footprint"] or []:
        pts_ = px(poly[0])
        if len(pts_) >= 3:
            dr.polygon(pts_, fill=(90, 90, 96))
# fondo-de-lote rows carry the whole lot as footprint but add one small unit:
# draw them as a dot at the lot centroid, everything else as its footprint.
for b in sorted(B, key=lambda b: b["start"]):
    if not b["footprint"]:
        continue
    if b["kind"] == "fondo-de-lote":
        cx, cy = centroid(b["footprint"])
        X, Y = (cx - bx0) * scale, H - (cy - by0) * scale
        dr.ellipse([X - 1.5, Y - 1.5, X + 1.5, Y + 1.5], fill=year_colour(b["start"][0]))
        continue
    for poly in b["footprint"]:
        pts_ = px(poly[0])
        if len(pts_) >= 3:
            dr.polygon(pts_, fill=year_colour(b["start"][0]))
# scale bar 1 km + year legend
dr.line([(40, H - 40), (40 + 1000 * scale, H - 40)], fill=(230, 230, 230), width=3)
dr.text((40, H - 60), "1 km", fill=(230, 230, 230))
for k, y in enumerate(range(y0, y1 + 1)):
    dr.rectangle([40 + k * 60, 30, 90 + k * 60, 50], fill=year_colour(y))
    dr.text((42 + k * 60, 55), str(y), fill=(230, 230, 230))
dr.text((40, 75), "new buildings by construction start year (fondo-de-lote additions as dots at their lot); grey = demolished", fill=(230, 230, 230))
img.save(png_path)
print(f"\nwrote {png_path} ({img.size[0]}x{img.size[1]} px)")
