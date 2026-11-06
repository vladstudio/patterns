import { IDENTITY, multiply, parseTransform, parsePathData, transformCmds, elementToPathData, prepareShape, cmdsToD } from './geometry.js';
import { Packer } from './generator.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const STORAGE_KEY = 'pattern-generator-settings';

const DEFAULTS = {
  folder: '01',
  colors: '#000 #333 #666 #999 #CCC #FFF',
  width: 800,
  height: 800,
  background: '#808080',
  transparent: false,
  edge: 'clip',
  strokeWidth: 6,
  strokeWidthRand: 0,
  safe: 6,
  safeRand: 0,
  angle: 0,
  angleRand: 180,
  scale: 4,
  scaleRand: 0,
  seed: '1',
  auto: true,
};

const SLIDERS = [
  ['Stroke width', null, [
    { key: 'strokeWidth', label: 'Width', min: 0.1, max: 40, step: 0.1 },
    { key: 'strokeWidthRand', label: '± random', min: 0, max: 20, step: 0.1 },
  ]],
  ['Safe zone', 'Ghost stroke = stroke width + safe distance; new shapes never touch it', [
    { key: 'safe', label: 'Distance', min: 0, max: 40, step: 0.1 },
    { key: 'safeRand', label: '± random', min: 0, max: 20, step: 0.1 },
  ]],
  ['Angle', '0° = as drawn in the file', [
    { key: 'angle', label: 'Degrees', min: -180, max: 180, step: 1 },
    { key: 'angleRand', label: '± random', min: 0, max: 180, step: 1 },
  ]],
  ['Shape size', 'Multiplier on the size the shape has in its file', [
    { key: 'scale', label: 'Scale ×', min: 0.1, max: 20, step: 0.1 },
    { key: 'scaleRand', label: '± random', min: 0, max: 10, step: 0.1 },
  ]],
];

const $ = (id) => document.getElementById(id);
const settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') };
let shapes = [];
let packer = null;
let job = 0;

// ---------- controls ----------

function buildSliders() {
  const root = $('sliders');
  for (const [title, hint, rows] of SLIDERS) {
    const section = document.createElement('section');
    section.innerHTML = `<h2>${title}</h2>`;
    rows.forEach((row, i) => {
      const el = document.createElement('div');
      el.className = 'slider' + (i ? ' sub' : '');
      el.innerHTML =
        `<label for="${row.key}">${row.label}</label>` +
        `<input type="range" min="${row.min}" max="${row.max}" step="${row.step}">` +
        `<input type="number" id="${row.key}" step="${row.step}" ${row.min >= 0 ? 'min="0"' : ''}>`;
      const [range, number] = el.querySelectorAll('input');
      range.value = number.value = settings[row.key];
      range.addEventListener('input', () => { number.value = range.value; update(row.key, +range.value); });
      number.addEventListener('input', () => {
        if (number.value === '' || Number.isNaN(+number.value)) return;
        range.value = number.value;
        update(row.key, +number.value);
      });
      section.append(el);
    });
    if (hint) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = hint;
      section.append(p);
    }
    root.append(section);
  }
}

function bindInputs() {
  for (const key of ['folder', 'colors', 'width', 'height', 'background', 'transparent', 'edge', 'seed', 'auto']) {
    const el = $(key);
    if (el.type === 'checkbox') el.checked = settings[key];
    else el.value = settings[key];
    el.addEventListener(el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input', () => {
      const value = el.type === 'checkbox' ? el.checked : el.type === 'number' ? +el.value : el.value;
      if (el.type === 'number' && !(value > 0)) return;
      if (key !== 'folder') update(key, value);
      else settings.folder = value;
      save();
    });
  }
  $('folder').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadFolder(); });
  $('loadFolder').addEventListener('click', loadFolder);
  $('pickFolder').addEventListener('change', pickFolder);
  $('reseed').addEventListener('click', () => {
    const seed = Math.random().toString(36).slice(2, 8);
    $('seed').value = seed;
    update('seed', seed, true);
  });
  $('generate').addEventListener('click', generate);
  $('download').addEventListener('click', download);
  $('reset').addEventListener('click', () => {
    localStorage.removeItem(STORAGE_KEY);
    location.reload();
  });
  $('frame').addEventListener('click', () => { $('frame').classList.toggle('actual'); fit(); });
  new ResizeObserver(fit).observe($('stage'));
}

let debounce = 0;
function update(key, value, force = false) {
  settings[key] = value;
  save();
  if (key === 'colors') renderSwatches();
  if (key === 'background' || key === 'transparent') return applyBackground();
  if (settings.auto || force) {
    clearTimeout(debounce);
    debounce = setTimeout(generate, 120);
  }
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

function parseColors(text) {
  return text.split(/[\s,;]+/).filter((c) => c && CSS.supports('color', c));
}

function renderSwatches() {
  $('swatches').replaceChildren(...parseColors(settings.colors).map((c) => {
    const s = document.createElement('span');
    s.style.background = c;
    s.title = c;
    return s;
  }));
}

// ---------- shapes ----------

const SKIP = new Set(['defs', 'clipPath', 'mask', 'symbol', 'pattern', 'marker', 'metadata', 'title', 'desc', 'style', 'script', 'linearGradient', 'radialGradient', 'filter']);
const GEOMETRY = new Set(['path', 'line', 'polyline', 'polygon', 'rect', 'circle', 'ellipse']);

// Only the vector geometry is used: the file's size, viewBox, strokes and fills are ignored.
function svgToShape(name, text) {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  if (doc.querySelector('parsererror')) throw new Error(`${name}: not valid SVG`);
  const cmds = [];
  (function walk(el, m) {
    for (const child of el.children) {
      if (SKIP.has(child.localName)) continue;
      const t = child.getAttribute('transform');
      const cm = t ? multiply(m, parseTransform(t)) : m;
      if (GEOMETRY.has(child.localName)) {
        const d = elementToPathData(child.localName, (n) => child.getAttribute(n));
        if (d) cmds.push(...transformCmds(parsePathData(d), cm));
      } else {
        walk(child, cm);
      }
    }
  })(doc.documentElement, IDENTITY);
  return prepareShape(name, cmds);
}

function setShapes(files, label) {
  const errors = [];
  shapes = [];
  for (const { name, svg } of files) {
    try {
      const s = svgToShape(name, svg);
      if (s) shapes.push(s);
      else errors.push(`${name}: no geometry`);
    } catch (err) {
      errors.push(err.message);
    }
  }
  renderShapeList(label, errors);
  generate();
}

function renderShapeList(label, errors = []) {
  const list = $('shapeList');
  list.replaceChildren();
  for (const s of shapes) {
    const pad = Math.max(s.width, s.height) * 0.25 + 0.5;
    const size = Math.max(s.width, s.height) + pad * 2;
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `${-size / 2} ${-size / 2} ${size} ${size}`);
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', cmdsToD(s.cmds.map((c) => c.p ? { c: c.c, p: c.p.map((v) => v * 100) } : c)));
    path.setAttribute('transform', 'scale(0.01)');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', '#1d1d1f');
    path.setAttribute('stroke-width', size * 6);
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.append(path);
    const title = document.createElementNS(SVG_NS, 'title');
    title.textContent = s.name;
    svg.append(title);
    list.append(svg);
  }
  const msg = document.createElement('div');
  msg.className = 'msg' + (shapes.length ? '' : ' err');
  msg.style.width = '100%';
  msg.textContent = shapes.length ? `${shapes.length} shapes from ${label}` : `No usable shapes in ${label}`;
  list.append(msg);
  for (const e of errors) {
    const el = document.createElement('div');
    el.className = 'msg err';
    el.textContent = e;
    list.append(el);
  }
}

async function loadFolder() {
  const folder = $('folder').value.trim();
  if (!folder) return;
  settings.folder = folder;
  save();
  try {
    const res = await fetch(`/api/shapes?folder=${encodeURIComponent(folder)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    setShapes(data, `“${folder}”`);
  } catch (err) {
    shapes = [];
    $('shapeList').innerHTML = '';
    const el = document.createElement('div');
    el.className = 'msg err';
    el.textContent = `Couldn't load “${folder}”: ${err.message}`;
    $('shapeList').append(el);
  }
}

async function pickFolder(e) {
  const files = [...e.target.files].filter((f) => f.name.toLowerCase().endsWith('.svg'));
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const folder = e.target.files[0]?.webkitRelativePath.split('/')[0] || 'picked folder';
  $('folder').value = '';
  setShapes(await Promise.all(files.map(async (f) => ({ name: f.name, svg: await f.text() }))), `“${folder}” (from disk)`);
  e.target.value = '';
}

async function loadFolderList() {
  try {
    const folders = await (await fetch('/api/folders')).json();
    $('folders').replaceChildren(...folders.map((f) => Object.assign(document.createElement('option'), { value: f })));
  } catch {}
}

// ---------- generation ----------

function readParams() {
  const n = (k) => Number(settings[k]) || 0;
  return {
    width: Math.max(10, n('width')),
    height: Math.max(10, n('height')),
    edge: settings.edge,
    colors: parseColors(settings.colors),
    strokeWidth: n('strokeWidth'),
    strokeWidthRand: Math.abs(n('strokeWidthRand')),
    safe: n('safe'),
    safeRand: Math.abs(n('safeRand')),
    angle: n('angle'),
    angleRand: Math.abs(n('angleRand')),
    scale: n('scale'),
    scaleRand: Math.abs(n('scaleRand')),
  };
}

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

function generate() {
  const my = ++job;
  const P = readParams();
  if (!shapes.length) return status('Load a shape folder to start');
  if (!P.colors.length) return status('Add at least one valid color');

  packer = new Packer(shapes, P, settings.seed);
  const it = packer.run();

  const svg = svgEl('svg', { width: P.width, height: P.height, viewBox: `0 0 ${P.width} ${P.height}` });
  const bg = svgEl('rect', { id: 'bg', width: P.width, height: P.height });
  const g = svgEl('g', { fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  svg.append(bg, g);
  $('frame').replaceChildren(svg);
  applyBackground();
  fit();

  let drawn = 0, phase = 1;
  const t0 = performance.now();
  const tick = () => {
    if (my !== job) return;
    const until = performance.now() + 25;
    let done = false;
    while (performance.now() < until) {
      const r = it.next();
      if (r.done) { done = true; break; }
      phase = r.value;
    }
    const frag = document.createDocumentFragment();
    for (; drawn < packer.placed.length; drawn++) {
      for (const p of packer.pathsFor(packer.placed[drawn])) {
        frag.append(svgEl('path', { d: p.d, stroke: p.stroke, 'stroke-width': p.width }));
      }
    }
    g.append(frag);
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    if (done) status(`${packer.placed.length} shapes · ${secs}s`);
    else { status(`${phase === 1 ? 'Placing' : 'Filling gaps'}… ${packer.placed.length} shapes`); requestAnimationFrame(tick); }
  };
  tick();
}

function applyBackground() {
  const bg = document.querySelector('#frame #bg');
  if (bg) bg.setAttribute('fill', settings.transparent ? 'none' : settings.background);
}

function fit() {
  const svg = document.querySelector('#frame svg');
  if (!svg || !packer) return;
  const { W, H } = packer;
  if ($('frame').classList.contains('actual')) {
    svg.style.width = W + 'px';
    svg.style.height = H + 'px';
    return;
  }
  const stage = $('stage');
  const k = Math.min(1, (stage.clientWidth - 64) / W, (stage.clientHeight - 64) / H);
  svg.style.width = Math.max(1, W * k) + 'px';
  svg.style.height = Math.max(1, H * k) + 'px';
}

function status(text) {
  $('status').textContent = text;
}

function download() {
  if (!packer) return;
  const text = packer.toSvg({ background: settings.transparent ? null : settings.background });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
  a.download = `pattern-${settings.folder || 'shapes'}-${settings.seed}.svg`.replace(/[^\w.-]+/g, '_');
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- init ----------

buildSliders();
bindInputs();
renderSwatches();
loadFolderList();
if (settings.folder) loadFolder();
else status('Load a shape folder to start');
