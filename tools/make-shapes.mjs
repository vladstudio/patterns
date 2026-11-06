// Generates the procedural shape sets in ../shapes. Each set is one kind of shape drawn
// several times with slightly different parameters, like shapes/almost-straight (one
// vertical cubic Bézier per file, varied in length, bend and tilt).
//
//   node tools/make-shapes.mjs            -> (re)writes every set below
//   node tools/make-shapes.mjs spirals    -> just one set
//
// Units match almost-straight: a few units per shape, scaled up by the app's Scale.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SHAPES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'shapes');
const COUNT = 10;

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- shapes: each returns a list of segments [[x0,y0], [c1], [c2], [x1,y1]] ----------

// A line from (0,0) downwards with an asymmetric bend. `bend` is how far the control
// points sit off the chord, as a share of its length; `skew` (-1..1) moves the bulge
// towards one end. Arc length is kept at `length` however much the line bends.
function bentLine(length, bend, skew, tiltDeg) {
  const sag = 0.75 * bend * length; // a cubic with both controls offset by c bulges 0.75c
  const chord = length - (8 * sag * sag) / (3 * length);
  const c1 = bend * chord * (1 + skew), c2 = bend * chord * (1 - skew);
  const t = (tiltDeg * Math.PI) / 180, cos = Math.cos(t), sin = Math.sin(t);
  const r = ([x, y]) => [x * cos + y * sin, -x * sin + y * cos];
  return [[r([0, 0]), r([c1, chord / 3]), r([c2, (2 * chord) / 3]), r([0, chord])]];
}

// Archimedean spiral from radius r0 out to r1 over `turns`, as cubic pieces of ≤45°
// built from the exact tangents. `squash` flattens it slightly into an oval.
function spiral(r0, r1, turns, squash, clockwise) {
  const total = turns * 2 * Math.PI;
  const dr = (r1 - r0) / total;
  const pieces = Math.ceil(total / (Math.PI / 4));
  const h = total / pieces;
  const s = clockwise ? -1 : 1;
  const at = (th) => {
    const r = r0 + dr * th, c = Math.cos(th), n = Math.sin(th);
    return { p: [r * c, s * r * n * squash], d: [dr * c - r * n, s * (dr * n + r * c) * squash] };
  };
  const segs = [];
  for (let i = 0; i < pieces; i++) {
    const a = at(i * h), b = at((i + 1) * h);
    segs.push([a.p, [a.p[0] + (a.d[0] * h) / 3, a.p[1] + (a.d[1] * h) / 3], [b.p[0] - (b.d[0] * h) / 3, b.p[1] - (b.d[1] * h) / 3], b.p]);
  }
  return segs;
}

// A closed, slightly hand-drawn circle: four quarter arcs whose radii wobble a little.
function circle(radius, wobble, squash, rand) {
  const K = 0.5523;
  const radii = [0, 1, 2, 3].map(() => radius * (1 + (rand() * 2 - 1) * wobble));
  const pt = (i) => {
    const a = (i * Math.PI) / 2, r = radii[i % 4];
    return { p: [r * Math.cos(a), r * Math.sin(a) * squash], d: [-r * Math.sin(a), r * Math.cos(a) * squash] };
  };
  const segs = [];
  for (let i = 0; i < 4; i++) {
    const a = pt(i), b = pt(i + 1);
    segs.push([a.p, [a.p[0] + a.d[0] * K, a.p[1] + a.d[1] * K], [b.p[0] - b.d[0] * K, b.p[1] - b.d[1] * K], b.p]);
  }
  segs.closed = true;
  return segs;
}

// ---------- sets ----------

const between = (rand, min, max) => min + rand() * (max - min);
const sign = (rand) => (rand() < 0.5 ? -1 : 1);

const SETS = {
  // Short and clearly bent; lengths within ±4%.
  'curved-short': (rand) => bentLine(between(rand, 5.75, 6.25), sign(rand) * between(rand, 0.14, 0.24), between(rand, -0.5, 0.5), between(rand, -6, 6)),
  // Short and nearly straight, bent about as much as almost-straight; lengths within ±4%.
  'straight-short': (rand) => bentLine(between(rand, 5.75, 6.25), sign(rand) * between(rand, 0, 0.05), between(rand, -0.6, 0.6), between(rand, -6, 6)),
  // 1.5–2.5 turns, about 8 units across. Loops are ~2 units apart, so keep
  // stroke width + safe zone below ~2 × Scale or the loops merge.
  'spirals': (rand) => spiral(between(rand, 0.2, 0.6), between(rand, 3.6, 4.2), between(rand, 1.5, 2.25), between(rand, 0.88, 1), rand() < 0.5),
  // About 4 units across. The hole stays open while the stroke is under ~4 × Scale.
  'hollow-circles': (rand) => circle(between(rand, 1.9, 2.1), 0.04, between(rand, 0.9, 1), rand),
};

// ---------- output, in the same style as the hand-made sets ----------

const fmt = (n) => String(Math.round(n * 1e4) / 1e4);

function toSvg(segs) {
  const pts = segs.flat();
  const pad = 0.5; // room for the 1px stroke the files carry, as in almost-straight
  const minx = Math.min(...pts.map((p) => p[0])) - pad, miny = Math.min(...pts.map((p) => p[1])) - pad;
  const w = Math.ceil(Math.max(...pts.map((p) => p[0])) - minx + pad);
  const h = Math.ceil(Math.max(...pts.map((p) => p[1])) - miny + pad);
  const P = ([x, y]) => `${fmt(x - minx)} ${fmt(y - miny)}`;
  let d = `M${P(segs[0][0])}`;
  for (const [, c1, c2, p] of segs) d += `C${P(c1)} ${P(c2)} ${P(p)}`;
  if (segs.closed) d += 'Z';
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill="none" xmlns="http://www.w3.org/2000/svg">\n<path d="${d}" stroke="black"/>\n</svg>\n`;
}

const only = process.argv.slice(2);
for (const [name, make] of Object.entries(SETS)) {
  if (only.length && !only.includes(name)) continue;
  const dir = path.join(SHAPES, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const rand = rng([...name].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619), 2166136261));
  for (let i = 1; i <= COUNT; i++) fs.writeFileSync(path.join(dir, `${i}.svg`), toSvg(make(rand)));
  console.log(`${name}: ${COUNT} shapes`);
}
