// Pure vector math: SVG path parsing, transforms, flattening. No DOM.
//
// Paths are normalised to a list of absolute commands:
//   { c: 'M', p: [x, y] }   { c: 'L', p: [x, y] }
//   { c: 'C', p: [x1, y1, x2, y2, x, y] }   { c: 'Q', p: [x1, y1, x, y] }   { c: 'Z' }
// Arcs are converted to cubics so any affine transform can be baked in exactly.

export const IDENTITY = [1, 0, 0, 1, 0, 0];

const NUM_RE = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y;
const SEP_RE = /[\s,]/;

export function parsePathData(d) {
  const out = [];
  const n = d.length;
  let i = 0;

  const skip = () => { while (i < n && SEP_RE.test(d[i])) i++; };
  const num = () => {
    skip();
    NUM_RE.lastIndex = i;
    const m = NUM_RE.exec(d);
    if (!m) throw new Error(`Bad path data near "${d.slice(i, i + 12)}"`);
    i = NUM_RE.lastIndex;
    return +m[0];
  };
  // Arc flags may be packed without separators ("a1 1 0 01 5 5").
  const flag = () => {
    skip();
    const ch = d[i++];
    if (ch !== '0' && ch !== '1') throw new Error('Bad arc flag in path data');
    return ch === '1';
  };
  const more = () => { skip(); return i < n && /[-+.\d]/.test(d[i]); };

  let x = 0, y = 0, sx = 0, sy = 0;
  let pcx = 0, pcy = 0, prev = ''; // last control point, for S/T reflection

  for (;;) {
    skip();
    if (i >= n) break;
    const cmd = d[i++];
    if (!/[a-zA-Z]/.test(cmd)) throw new Error(`Unexpected "${cmd}" in path data`);
    const C = cmd.toUpperCase();
    const rel = cmd !== C;

    if (C === 'Z') {
      out.push({ c: 'Z' });
      x = sx; y = sy; prev = 'Z';
      continue;
    }

    let first = true;
    do {
      const ox = rel ? x : 0, oy = rel ? y : 0;
      switch (C) {
        case 'M':
          x = ox + num(); y = oy + num();
          if (first) { out.push({ c: 'M', p: [x, y] }); sx = x; sy = y; }
          else out.push({ c: 'L', p: [x, y] });
          prev = 'L';
          break;
        case 'L':
          x = ox + num(); y = oy + num();
          out.push({ c: 'L', p: [x, y] }); prev = 'L';
          break;
        case 'H':
          x = ox + num();
          out.push({ c: 'L', p: [x, y] }); prev = 'L';
          break;
        case 'V':
          y = oy + num();
          out.push({ c: 'L', p: [x, y] }); prev = 'L';
          break;
        case 'C': {
          const x1 = ox + num(), y1 = oy + num(), x2 = ox + num(), y2 = oy + num();
          x = ox + num(); y = oy + num();
          out.push({ c: 'C', p: [x1, y1, x2, y2, x, y] });
          pcx = x2; pcy = y2; prev = 'C';
          break;
        }
        case 'S': {
          const x1 = prev === 'C' ? 2 * x - pcx : x, y1 = prev === 'C' ? 2 * y - pcy : y;
          const x2 = ox + num(), y2 = oy + num();
          x = ox + num(); y = oy + num();
          out.push({ c: 'C', p: [x1, y1, x2, y2, x, y] });
          pcx = x2; pcy = y2; prev = 'C';
          break;
        }
        case 'Q': {
          const x1 = ox + num(), y1 = oy + num();
          x = ox + num(); y = oy + num();
          out.push({ c: 'Q', p: [x1, y1, x, y] });
          pcx = x1; pcy = y1; prev = 'Q';
          break;
        }
        case 'T': {
          const x1 = prev === 'Q' ? 2 * x - pcx : x, y1 = prev === 'Q' ? 2 * y - pcy : y;
          x = ox + num(); y = oy + num();
          out.push({ c: 'Q', p: [x1, y1, x, y] });
          pcx = x1; pcy = y1; prev = 'Q';
          break;
        }
        case 'A': {
          const rx = num(), ry = num(), rot = num(), large = flag(), sweep = flag();
          const ex = ox + num(), ey = oy + num();
          out.push(...arcToCubics(x, y, rx, ry, rot, large, sweep, ex, ey));
          x = ex; y = ey; prev = 'A';
          break;
        }
        default:
          throw new Error(`Unknown path command "${cmd}"`);
      }
      first = false;
    } while (more());
  }
  return out;
}

// SVG spec F.6.5: endpoint -> center parameterisation, then ≤90° cubic pieces.
function arcToCubics(x1, y1, rx, ry, phiDeg, large, sweep, x2, y2) {
  if (x1 === x2 && y1 === y2) return [];
  rx = Math.abs(rx); ry = Math.abs(ry);
  if (!rx || !ry) return [{ c: 'L', p: [x2, y2] }];

  const phi = (phiDeg * Math.PI) / 180;
  const cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy, y1p = -sin * dx + cos * dy;

  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) { const s = Math.sqrt(lambda); rx *= s; ry *= s; }

  const rx2 = rx * rx, ry2 = ry * ry;
  const numer = Math.max(0, rx2 * ry2 - rx2 * y1p * y1p - ry2 * x1p * x1p);
  let coef = Math.sqrt(numer / (rx2 * y1p * y1p + ry2 * x1p * x1p));
  if (large === sweep) coef = -coef;
  const cxp = (coef * rx * y1p) / ry, cyp = (-coef * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;

  const angle = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const ux = (x1p - cxp) / rx, uy = (y1p - cyp) / ry;
  const th1 = angle(1, 0, ux, uy);
  let dth = angle(ux, uy, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dth > 0) dth -= 2 * Math.PI;
  else if (sweep && dth < 0) dth += 2 * Math.PI;

  const segs = Math.max(1, Math.ceil(Math.abs(dth) / (Math.PI / 2) - 1e-9));
  const delta = dth / segs;
  const t = (4 / 3) * Math.tan(delta / 4);
  const map = (u, v) => [cx + rx * u * cos - ry * v * sin, cy + rx * u * sin + ry * v * cos];

  const out = [];
  let th = th1;
  for (let k = 0; k < segs; k++) {
    const c1 = Math.cos(th), s1 = Math.sin(th);
    const c2 = Math.cos(th + delta), s2 = Math.sin(th + delta);
    const end = k === segs - 1 ? [x2, y2] : map(c2, s2);
    out.push({ c: 'C', p: [...map(c1 - t * s1, s1 + t * c1), ...map(c2 + t * s2, s2 - t * c2), ...end] });
    th += delta;
  }
  return out;
}

// ---------- transforms ----------

export function multiply(A, B) {
  return [
    A[0] * B[0] + A[2] * B[1],
    A[1] * B[0] + A[3] * B[1],
    A[0] * B[2] + A[2] * B[3],
    A[1] * B[2] + A[3] * B[3],
    A[0] * B[4] + A[2] * B[5] + A[4],
    A[1] * B[4] + A[3] * B[5] + A[5],
  ];
}

export function parseTransform(str) {
  let m = IDENTITY;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let match;
  while ((match = re.exec(str))) {
    const a = (match[2].match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || []).map(Number);
    const rad = (deg) => (deg * Math.PI) / 180;
    let t;
    switch (match[1]) {
      case 'matrix': t = a.length === 6 ? a : IDENTITY; break;
      case 'translate': t = [1, 0, 0, 1, a[0] || 0, a[1] || 0]; break;
      case 'scale': t = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0]; break;
      case 'rotate': {
        const r = rad(a[0] || 0), c = Math.cos(r), s = Math.sin(r);
        const cx = a[1] || 0, cy = a[2] || 0;
        t = [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy];
        break;
      }
      case 'skewX': t = [1, 0, Math.tan(rad(a[0] || 0)), 1, 0, 0]; break;
      case 'skewY': t = [1, Math.tan(rad(a[0] || 0)), 0, 1, 0, 0]; break;
    }
    m = multiply(m, t);
  }
  return m;
}

export function transformCmds(cmds, m) {
  const [a, b, c, d, e, f] = m;
  return cmds.map((cmd) => {
    if (!cmd.p) return cmd;
    const p = new Array(cmd.p.length);
    for (let i = 0; i < p.length; i += 2) {
      const x = cmd.p[i], y = cmd.p[i + 1];
      p[i] = a * x + c * y + e;
      p[i + 1] = b * x + d * y + f;
    }
    return { c: cmd.c, p };
  });
}

export const fmt = (n) => {
  const s = (Math.round(n * 100) / 100).toString();
  return s === '-0' ? '0' : s;
};

export function cmdsToD(cmds) {
  let d = '';
  for (const cmd of cmds) d += cmd.c + (cmd.p ? cmd.p.map(fmt).join(' ') : '');
  return d;
}

// ---------- SVG primitives -> path data ----------

export function elementToPathData(tag, attr) {
  const num = (name) => parseFloat(attr(name)) || 0;
  switch (tag) {
    case 'path':
      return attr('d') || null;
    case 'line':
      return `M${num('x1')} ${num('y1')}L${num('x2')} ${num('y2')}`;
    case 'polyline':
    case 'polygon': {
      const v = (attr('points') || '').trim().split(/[\s,]+/).map(Number).filter((x) => !Number.isNaN(x));
      if (v.length < 2) return null;
      let d = `M${v[0]} ${v[1]}`;
      for (let i = 2; i + 1 < v.length; i += 2) d += `L${v[i]} ${v[i + 1]}`;
      return tag === 'polygon' ? d + 'Z' : d;
    }
    case 'rect': {
      const x = num('x'), y = num('y'), w = num('width'), h = num('height');
      if (w <= 0 || h <= 0) return null;
      let rx = attr('rx') != null ? num('rx') : null;
      let ry = attr('ry') != null ? num('ry') : null;
      if (rx == null) rx = ry ?? 0;
      if (ry == null) ry = rx;
      rx = Math.min(Math.max(rx, 0), w / 2);
      ry = Math.min(Math.max(ry, 0), h / 2);
      if (!rx || !ry) return `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
      const arc = (ex, ey) => `A${rx} ${ry} 0 0 1 ${ex} ${ey}`;
      return (
        `M${x + rx} ${y}H${x + w - rx}${arc(x + w, y + ry)}V${y + h - ry}${arc(x + w - rx, y + h)}` +
        `H${x + rx}${arc(x, y + h - ry)}V${y + ry}${arc(x + rx, y)}Z`
      );
    }
    case 'circle':
    case 'ellipse': {
      const cx = num('cx'), cy = num('cy');
      const rx = tag === 'circle' ? num('r') : num('rx');
      const ry = tag === 'circle' ? num('r') : num('ry');
      if (rx <= 0 || ry <= 0) return null;
      return `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`;
    }
    default:
      return null;
  }
}

// ---------- flattening ----------

// Turns commands into polylines; curves are sampled every `step` units (approx).
export function flatten(cmds, step) {
  const polys = [];
  let cur = null, x = 0, y = 0, sx = 0, sy = 0;
  const start = () => { if (!cur) { cur = [[x, y]]; polys.push(cur); } };

  for (const { c, p } of cmds) {
    if (c === 'M') {
      x = sx = p[0]; y = sy = p[1];
      cur = [[x, y]]; polys.push(cur);
    } else if (c === 'L') {
      start();
      x = p[0]; y = p[1];
      cur.push([x, y]);
    } else if (c === 'C') {
      start();
      const len = Math.hypot(p[0] - x, p[1] - y) + Math.hypot(p[2] - p[0], p[3] - p[1]) + Math.hypot(p[4] - p[2], p[5] - p[3]);
      const n = Math.max(1, Math.min(1000, Math.ceil(len / step)));
      for (let k = 1; k <= n; k++) {
        const t = k / n, u = 1 - t;
        const a = u * u * u, b = 3 * u * u * t, cc = 3 * u * t * t, d = t * t * t;
        cur.push([a * x + b * p[0] + cc * p[2] + d * p[4], a * y + b * p[1] + cc * p[3] + d * p[5]]);
      }
      x = p[4]; y = p[5];
    } else if (c === 'Q') {
      start();
      const len = Math.hypot(p[0] - x, p[1] - y) + Math.hypot(p[2] - p[0], p[3] - p[1]);
      const n = Math.max(1, Math.min(1000, Math.ceil(len / step)));
      for (let k = 1; k <= n; k++) {
        const t = k / n, u = 1 - t;
        cur.push([u * u * x + 2 * u * t * p[0] + t * t * p[2], u * u * y + 2 * u * t * p[1] + t * t * p[3]]);
      }
      x = p[2]; y = p[3];
    } else if (c === 'Z') {
      if (cur) cur.push([sx, sy]);
      cur = null; x = sx; y = sy;
    }
  }
  // A lone "M" draws nothing.
  return polys.filter((poly) => poly.length > 1);
}

// Douglas–Peucker.
export function simplify(poly, tol) {
  if (poly.length <= 2) return poly;
  const keep = new Uint8Array(poly.length);
  keep[0] = keep[poly.length - 1] = 1;
  const stack = [[0, poly.length - 1]];
  const tol2 = tol * tol;
  while (stack.length) {
    const [i0, i1] = stack.pop();
    let best = -1, bestD = tol2;
    for (let i = i0 + 1; i < i1; i++) {
      const d = pointSegDist2(poly[i][0], poly[i][1], poly[i0][0], poly[i0][1], poly[i1][0], poly[i1][1]);
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([i0, best], [best, i1]);
    }
  }
  return poly.filter((_, i) => keep[i]);
}

export function pointSegDist2(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const l = vx * vx + vy * vy;
  let t = l ? ((px - ax) * vx + (py - ay) * vy) / l : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = ax + t * vx - px, ey = ay + t * vy - py;
  return ex * ex + ey * ey;
}

export function segSegDist(ax, ay, bx, by, cx, cy, dx, dy) {
  const o1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const o2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  const o3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const o4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  if (o1 * o2 < 0 && o3 * o4 < 0) return 0;
  return Math.sqrt(Math.min(
    pointSegDist2(ax, ay, cx, cy, dx, dy),
    pointSegDist2(bx, by, cx, cy, dx, dy),
    pointSegDist2(cx, cy, ax, ay, bx, by),
    pointSegDist2(dx, dy, ax, ay, bx, by),
  ));
}

// ---------- shapes ----------

// Centers a shape's geometry on the bounding box of its actual vector data
// (the file's viewBox / width / height are ignored).
export function prepareShape(name, cmds) {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const { p } of cmds) {
    if (!p) continue;
    for (let i = 0; i < p.length; i += 2) {
      minx = Math.min(minx, p[i]); maxx = Math.max(maxx, p[i]);
      miny = Math.min(miny, p[i + 1]); maxy = Math.max(maxy, p[i + 1]);
    }
  }
  if (!Number.isFinite(minx)) return null;
  const step = Math.max(maxx - minx, maxy - miny, 1e-6) / 300;
  let polys = flatten(cmds, step);
  if (!polys.length) return null;

  minx = miny = Infinity; maxx = maxy = -Infinity;
  for (const poly of polys) for (const [x, y] of poly) {
    minx = Math.min(minx, x); maxx = Math.max(maxx, x);
    miny = Math.min(miny, y); maxy = Math.max(maxy, y);
  }
  const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2;
  polys = polys.map((poly) => poly.map(([x, y]) => [x - cx, y - cy]));
  let rad = 0;
  for (const poly of polys) for (const [x, y] of poly) rad = Math.max(rad, Math.hypot(x, y));

  return {
    name,
    cmds: transformCmds(cmds, [1, 0, 0, 1, -cx, -cy]),
    polys,
    rad,
    width: maxx - minx,
    height: maxy - miny,
  };
}
