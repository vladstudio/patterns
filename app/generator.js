// Pattern packer. Pure JS, no DOM.
//
// Every placed shape is a set of capsules (polyline segments + round-cap stroke radius).
// Each shape also owns a "ghost" stroke of width (strokeWidth + safe). A new shape's real
// stroke may not touch any existing ghost, and its own ghost may not touch any existing
// real stroke — so every shape's safe zone is honoured regardless of placement order.
//
// Phase 1 grows the pattern outward from a seed: a random shape starts just outside a
// random "active" neighbour and slides toward it (sphere tracing on the exact clearance)
// until it touches a ghost, so shapes sit snugly. Phase 2 sweeps the canvas and drops
// shapes into any hole that is still large enough.

import { segSegDist, pointSegDist2, simplify, transformCmds, cmdsToD, fmt } from './geometry.js';
import { roughExtent, roughCircles, circlesToD } from './stroke.js';

const TILE_OFFSETS = [];
for (const ox of [-1, 0, 1]) for (const oy of [-1, 0, 1]) TILE_OFFSETS.push([ox, oy]);

const PHASE1_SHARE = 0.6; // share of the progress bar given to phase 1 (roughly its share of the time)
const EPS = 0.25; // px: how close a sliding shape gets before it is considered "touching"

export function makeRng(seed) {
  let h = 1779033703 ^ String(seed).length;
  for (const ch of String(seed)) {
    h = Math.imul(h ^ ch.charCodeAt(0), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cellKey = (cx, cy) => (cx + 32768) * 65536 + (cy + 32768);

export class Packer {
  /**
   * @param shapes  prepared shapes (see prepareShape)
   * @param P       { width, height, edge: 'clip'|'inside'|'tile', colors: string[],
   *                  strokeWidth, strokeWidthRand, safe, safeRand, angle, angleRand, scale, scaleRand,
   *                  stroke: 'normal'|'rough', rough: { spacing, size, wobble } (fractions, see stroke.js) }
   */
  constructor(shapes, P, seed) {
    this.P = P;
    this.W = P.width;
    this.H = P.height;
    this.seed = seed;
    this.rng = makeRng(seed);
    this.rough = P.stroke === 'rough' ? P.rough : null;

    const swMin = Math.max(0.1, P.strokeWidth - P.strokeWidthRand);
    const swMax = Math.max(0.1, P.strokeWidth + P.strokeWidthRand);
    const safeMax = Math.max(0, P.safe + P.safeRand);
    const scaleMax = Math.max(0.01, P.scale + P.scaleRand);
    const tol = 0.2 / scaleMax; // simplify to ~0.2px at the largest scale

    this.shapes = shapes.map((s) => {
      const segs = [], lines = [];
      for (const poly of s.polys) {
        const q = simplify(poly, tol);
        lines.push(q);
        for (let i = 0; i + 1 < q.length; i++) segs.push(q[i][0], q[i][1], q[i + 1][0], q[i + 1][1]);
      }
      return { ...s, segs, lines };
    });

    this.minR = this.strokeRadius(swMin);
    this.maxG = this.strokeRadius(swMax) + safeMax / 2;
    this.maxRad = Math.max(...this.shapes.map((s) => s.rad)) * scaleMax;
    this.cap = Math.max(2, this.maxG * 2); // max sphere-tracing step
    this.cell = Math.max(4, this.maxG * 2 + this.cap);
    this.margin = this.maxRad + 2 * this.maxG + this.cap + 2;

    this.grid = new Map();
    this.sx1 = []; this.sy1 = []; this.sx2 = []; this.sy2 = [];
    this.sr = []; this.sg = []; this.stamp = [];
    this.qid = 0;
    this.placed = [];

    // Progress (0..1). Phase 1 is measured by how many cells of a coarse grid contain a
    // shape's center; phase 2 by how far the gap-filling sweep has got.
    this.progress = 0;
    this.covSize = Math.max(8, 2 * (this.maxRad + this.maxG));
    this.covCols = Math.ceil(this.W / this.covSize);
    this.covered = new Uint8Array(this.covCols * Math.ceil(this.H / this.covSize));
    this.coveredCount = 0;
  }

  // How far a stroke of width `sw` reaches from the path: half its width, or for a rough
  // stroke its largest possible (grown and shifted) circle.
  strokeRadius(sw) {
    return this.rough ? roughExtent(sw / 2, this.rough) : sw / 2;
  }

  jitter(base, spread) {
    return base + (this.rng() * 2 - 1) * spread;
  }

  randomSpec() {
    const P = this.P;
    const si = Math.floor(this.rng() * this.shapes.length);
    const sw = Math.max(0.1, this.jitter(P.strokeWidth, P.strokeWidthRand));
    const safe = Math.max(0, this.jitter(P.safe, P.safeRand));
    const angle = this.jitter(P.angle, P.angleRand);
    const scale = Math.max(0.01, this.jitter(P.scale, P.scaleRand));
    const color = P.colors[Math.floor(this.rng() * P.colors.length)];

    const a = (angle * Math.PI) / 180;
    const cos = Math.cos(a) * scale, sin = Math.sin(a) * scale;
    const src = this.shapes[si].segs;
    const local = new Float64Array(src.length);
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (let i = 0; i < src.length; i += 2) {
      const x = src[i] * cos - src[i + 1] * sin;
      const y = src[i] * sin + src[i + 1] * cos;
      local[i] = x; local[i + 1] = y;
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
    }
    const r = this.strokeRadius(sw);
    return {
      si, sw, safe, angle, scale, color, local, minx, miny, maxx, maxy,
      r,
      g: r + safe / 2,
      rad: this.shapes[si].rad * scale,
    };
  }

  // Smallest clearance between the candidate and everything placed (capped at `limit`).
  // Negative means the candidate is illegal. Moving the candidate by less than the
  // returned value in any direction can never cause a collision.
  slack(sp, x, y, limit) {
    let s = limit;
    const L = sp.local, cell = this.cell, grid = this.grid;
    const { sx1, sy1, sx2, sy2, sr, sg, stamp } = this;
    const reach = sp.g + limit;

    for (let i = 0; i < L.length; i += 4) {
      const ax = L[i] + x, ay = L[i + 1] + y, bx = L[i + 2] + x, by = L[i + 3] + y;
      const q = ++this.qid;
      const cx0 = Math.floor((Math.min(ax, bx) - reach) / cell), cx1 = Math.floor((Math.max(ax, bx) + reach) / cell);
      const cy0 = Math.floor((Math.min(ay, by) - reach) / cell), cy1 = Math.floor((Math.max(ay, by) + reach) / cell);
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cy = cy0; cy <= cy1; cy++) {
          const arr = grid.get(cellKey(cx, cy));
          if (!arr) continue;
          for (let k = 0; k < arr.length; k++) {
            const j = arr[k];
            if (stamp[j] === q) continue;
            stamp[j] = q;
            const req = Math.max(sg[j] + sp.r, sp.g + sr[j]);
            const d = segSegDist(ax, ay, bx, by, sx1[j], sy1[j], sx2[j], sy2[j]) - req;
            if (d < s) {
              s = d;
              if (s < 0) return s;
            }
          }
        }
      }
    }

    if (this.P.edge === 'inside') {
      s = Math.min(
        s,
        x + sp.minx - sp.r,
        y + sp.miny - sp.r,
        this.W - (x + sp.maxx) - sp.r,
        this.H - (y + sp.maxy) - sp.r,
      );
    }
    return s;
  }

  // Clearance of a bare point: distance to the nearest ghost (capped at `limit`).
  pointClearance(px, py, limit) {
    let s = limit;
    const cell = this.cell;
    const { sx1, sy1, sx2, sy2, sg, stamp } = this;
    const q = ++this.qid;
    const cx0 = Math.floor((px - limit) / cell), cx1 = Math.floor((px + limit) / cell);
    const cy0 = Math.floor((py - limit) / cell), cy1 = Math.floor((py + limit) / cell);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const arr = this.grid.get(cellKey(cx, cy));
        if (!arr) continue;
        for (const j of arr) {
          if (stamp[j] === q) continue;
          stamp[j] = q;
          const d = Math.sqrt(pointSegDist2(px, py, sx1[j], sy1[j], sx2[j], sy2[j])) - sg[j];
          if (d < s) s = d;
        }
      }
    }
    return s;
  }

  accept(sp, x, y) {
    if (this.P.edge !== 'clip') return true; // 'inside' is enforced by slack, 'tile' wraps
    return x + sp.minx - sp.r < this.W && x + sp.maxx + sp.r > 0 && y + sp.miny - sp.r < this.H && y + sp.maxy + sp.r > 0;
  }

  wrap(x, y) {
    if (this.P.edge !== 'tile') return [x, y];
    return [((x % this.W) + this.W) % this.W, ((y % this.H) + this.H) % this.H];
  }

  place(sp, x, y) {
    const { W, H, cell, margin } = this;
    const { local: L, ...spec } = sp;
    const p = { ...spec, id: this.placed.length, x, y };
    this.placed.push(p);
    if (x >= 0 && x < W && y >= 0 && y < H) {
      const c = Math.floor(y / this.covSize) * this.covCols + Math.floor(x / this.covSize);
      if (!this.covered[c]) { this.covered[c] = 1; this.coveredCount++; }
    }
    const offsets = this.P.edge === 'tile' ? TILE_OFFSETS : [[0, 0]];

    for (const [ox, oy] of offsets) {
      const dx = x + ox * W, dy = y + oy * H;
      if (dx + sp.maxx + sp.g < -margin || dx + sp.minx - sp.g > W + margin) continue;
      if (dy + sp.maxy + sp.g < -margin || dy + sp.miny - sp.g > H + margin) continue;
      for (let i = 0; i < L.length; i += 4) {
        const ax = L[i] + dx, ay = L[i + 1] + dy, bx = L[i + 2] + dx, by = L[i + 3] + dy;
        const j = this.sx1.length;
        this.sx1.push(ax); this.sy1.push(ay); this.sx2.push(bx); this.sy2.push(by);
        this.sr.push(sp.r); this.sg.push(sp.g); this.stamp.push(0);
        const cx0 = Math.floor((Math.min(ax, bx) - sp.g) / cell), cx1 = Math.floor((Math.max(ax, bx) + sp.g) / cell);
        const cy0 = Math.floor((Math.min(ay, by) - sp.g) / cell), cy1 = Math.floor((Math.max(ay, by) + sp.g) / cell);
        for (let cx = cx0; cx <= cx1; cx++) {
          for (let cy = cy0; cy <= cy1; cy++) {
            const key = cellKey(cx, cy);
            const arr = this.grid.get(key);
            if (arr) arr.push(j);
            else this.grid.set(key, [j]);
          }
        }
      }
    }
    return p.id;
  }

  // Slide the candidate along (dx, dy) until it touches something. Returns the final
  // position, or null if the start position is already blocked.
  trace(sp, x, y, dx, dy, maxTravel) {
    let travel = 0;
    for (let it = 0; it < 60; it++) {
      const s = this.slack(sp, x, y, Math.min(this.cap, maxTravel - travel) + EPS);
      if (s < 0) return null;
      if (s <= EPS || travel >= maxTravel) break;
      const step = Math.min(s - EPS / 4, maxTravel - travel);
      x += dx * step; y += dy * step;
      travel += step;
      [x, y] = this.wrap(x, y);
    }
    return [x, y];
  }

  *run() {
    const { rng, W, H } = this;
    if (!this.shapes.length || !this.P.colors.length) return;

    // Seed shape.
    for (let t = 0; t < 500 && !this.placed.length; t++) {
      const sp = this.randomSpec();
      const x = rng() * W, y = rng() * H;
      if (this.slack(sp, x, y, 0) >= 0 && this.accept(sp, x, y)) this.place(sp, x, y);
    }
    if (!this.placed.length) return;

    // Phase 1: grow outward from active shapes, each new shape slid against a neighbour.
    const TRIES = 24;
    const active = [0];
    while (active.length) {
      const ai = Math.floor(rng() * active.length);
      const anchor = this.placed[active[ai]];
      let added = -1;
      for (let k = 0; k < TRIES && added < 0; k++) {
        const sp = this.randomSpec();
        const th = rng() * Math.PI * 2;
        const dx = Math.cos(th), dy = Math.sin(th);
        const R = anchor.rad + sp.rad + anchor.g + sp.g + 1;
        const [x, y] = this.wrap(anchor.x + dx * R, anchor.y + dy * R);
        const res = this.trace(sp, x, y, -dx, -dy, R);
        if (res && this.accept(sp, res[0], res[1])) added = this.place(sp, res[0], res[1]);
      }
      if (added >= 0) active.push(added);
      else { active[ai] = active[active.length - 1]; active.pop(); }
      this.progress = PHASE1_SHARE * Math.min(1, this.coveredCount / this.covered.length);
      yield 1;
    }

    // Phase 2: sweep a fine grid in random order and fill any remaining holes.
    const h = Math.max(1, this.minR * 1.5);
    const nx = Math.ceil(W / h), ny = Math.ceil(H / h);
    const order = new Uint32Array(nx * ny);
    for (let i = 0; i < order.length; i++) order[i] = i;
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = order[i]; order[i] = order[j]; order[j] = t;
    }
    const FILL_TRIES = 16;
    for (let n = 0; n < order.length; n++) {
      const k = order[n];
      const px = Math.min(W, ((k % nx) + rng()) * h), py = Math.min(H, (Math.floor(k / nx) + rng()) * h);
      if (this.pointClearance(px, py, this.minR + 1) >= this.minR) {
        for (let t = 0; t < FILL_TRIES; t++) {
          const sp = this.randomSpec();
          let x = px, y = py;
          if (rng() < 0.5) {
            // Anchor a random point of the shape on the hole instead of its center.
            const v = 2 * Math.floor(rng() * (sp.local.length / 2));
            x -= sp.local[v]; y -= sp.local[v + 1];
          }
          [x, y] = this.wrap(x, y);
          if (this.slack(sp, x, y, 0) >= 0 && this.accept(sp, x, y)) {
            this.place(sp, x, y);
            break;
          }
        }
      }
      if ((n & 255) === 0) {
        this.progress = PHASE1_SHARE + (1 - PHASE1_SHARE) * (n / order.length);
        yield 2;
      }
    }
    this.progress = 1;
  }

  // Output <path> attributes for one placement (several copies in tile mode).
  pathsFor(p) {
    const shape = this.shapes[p.si];
    const a = (p.angle * Math.PI) / 180;
    const cos = Math.cos(a) * p.scale, sin = Math.sin(a) * p.scale;
    const offsets = this.P.edge === 'tile' ? TILE_OFFSETS : [[0, 0]];
    // Rough circles come from their own RNG, so drawing never shifts the layout, and are
    // made once per placement so tile copies match.
    if (this.rough && !p.circles) {
      p.circles = roughCircles(shape.lines, [cos, sin, -sin, cos, 0, 0], p.sw / 2, this.rough, makeRng(`${this.seed}/${p.id}`));
    }
    const out = [];
    for (const [ox, oy] of offsets) {
      const x = p.x + ox * this.W, y = p.y + oy * this.H;
      if (x + p.maxx + p.r < 0 || x + p.minx - p.r > this.W || y + p.maxy + p.r < 0 || y + p.miny - p.r > this.H) continue;
      if (this.rough) out.push({ d: circlesToD(p.circles, x, y), fill: p.color });
      else {
        out.push({
          d: cmdsToD(transformCmds(shape.cmds, [cos, sin, -sin, cos, x, y])),
          stroke: p.color,
          'stroke-width': fmt(p.sw),
        });
      }
    }
    return out;
  }

  toSvg({ background } = {}) {
    const { W, H } = this;
    const lines = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
      `<defs><clipPath id="canvas"><rect width="${W}" height="${H}"/></clipPath></defs>`,
    ];
    if (background) lines.push(`<rect width="${W}" height="${H}" fill="${background}"/>`);
    lines.push(`<g clip-path="url(#canvas)" fill="none" stroke-linecap="round" stroke-linejoin="round">`);
    for (const p of this.placed) {
      for (const attrs of this.pathsFor(p)) {
        lines.push(`<path ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ')}/>`);
      }
    }
    lines.push('</g>', '</svg>');
    return lines.join('\n');
  }
}
