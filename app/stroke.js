// Rough strokes: a path drawn as a chain of overlapping filled circles of slightly varied
// size, instead of a regular stroke. Pure JS, no DOM.
//
//   size     radius varies by ± size × r
//   spacing  distance between circle centers, × stroke width (1 = circles just touch)
//   wobble   circles shift sideways off the path by up to ± wobble × r
//
// No circle reaches further than roughExtent(r, opts) from the path, which is what the
// packer uses as the shape's stroke radius so the safe zone still holds.

const MAX_CIRCLES = 5000; // per sub-path, in case of a huge shape with a hairline stroke

export function roughExtent(r, { size, wobble }) {
  return r * (1 + size + wobble);
}

// Circles along `polys` (polylines, transformed by the affine matrix `m`) as a flat array
// [cx, cy, radius, cx, cy, radius, …]. `rng` returns numbers in [0, 1).
export function roughCircles(polys, m, r, { size, spacing, wobble }, rng) {
  const [a, b, c, d, e, f] = m;
  const step = Math.max(0.25, spacing * 2 * r);
  const out = [];
  const circle = (x, y, nx, ny) => {
    const shift = wobble * r * (rng() * 2 - 1);
    out.push(x + nx * shift, y + ny * shift, Math.max(0.05, r * (1 + size * (rng() * 2 - 1))));
  };

  for (const poly of polys) {
    const pts = poly.map(([x, y]) => [a * x + c * y + e, b * x + d * y + f]);
    let total = 0;
    for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    const n = Math.min(MAX_CIRCLES, Math.max(1, Math.round(total / step)));
    const gap = total / n;

    // Walk the polyline, dropping a circle every `gap` (± a quarter), ends included.
    let seg = 1, segStart = 0, next = 0;
    for (let k = 0; k <= n; k++) {
      const t = k === 0 ? 0 : k === n ? total : next;
      while (seg < pts.length - 1 && segStart + segLen(pts, seg) < t) segStart += segLen(pts, seg++);
      const [x0, y0] = pts[seg - 1], [x1, y1] = pts[seg];
      const len = segLen(pts, seg);
      const u = len > 0 ? Math.min(1, Math.max(0, (t - segStart) / len)) : 0;
      const nx = len > 0 ? -(y1 - y0) / len : 0, ny = len > 0 ? (x1 - x0) / len : 0;
      circle(x0 + (x1 - x0) * u, y0 + (y1 - y0) * u, nx, ny);
      next = (k + 1) * gap + gap * 0.5 * (rng() - 0.5);
    }
  }
  return out;
}

const segLen = (pts, i) => Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);

// One path with a sub-path per circle, offset by (dx, dy). Overlaps union under nonzero fill.
export function circlesToD(circles, dx = 0, dy = 0) {
  const r2 = (v) => Math.round(v * 100) / 100;
  let s = '';
  for (let i = 0; i < circles.length; i += 3) {
    const x = circles[i] + dx, y = circles[i + 1] + dy, r = r2(circles[i + 2]);
    s += `M${r2(x - r)} ${r2(y)}a${r} ${r} 0 1 0 ${r2(2 * r)} 0a${r} ${r} 0 1 0 ${r2(-2 * r)} 0`;
  }
  return s;
}
