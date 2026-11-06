import { IDENTITY, multiply, parseTransform, parsePathData, transformCmds, elementToPathData, prepareShape, cmdsToD } from './geometry.js';
import { Packer } from './generator.js';
import { parseHex, oklchGradient } from './color.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const STORAGE_KEY = 'pattern-generator-settings';

const DEFAULTS = {
  folder: 'almost-straight',
  colorFrom: '#000000',
  colorTo: '#FFFFFF',
  colorCount: 6,
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
const settings = { ...DEFAULTS };
const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
for (const key in DEFAULTS) if (typeof stored[key] === typeof DEFAULTS[key]) settings[key] = stored[key];
let shapes = [];
let packer = null;
let job = 0;
let folders = []; // shape sets available in ./shapes
let loadedFolder = null; // shape set the current shapes came from

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
  for (const key of FIELDS) {
    const el = $(key);
    el.addEventListener(el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input', () => {
      const value = el.type === 'checkbox' ? el.checked : el.type === 'number' ? +el.value : el.value;
      if (el.type === 'number' && !(value > 0)) return;
      if (key !== 'folder') return update(key, value);
      settings.folder = value;
      save();
      $('folderNote').textContent = '';
      loadFolder();
    });
  }
  // Each hex field has a color picker next to it; keep the two in sync.
  for (const picker of document.querySelectorAll('input[type="color"][data-for]')) {
    const text = $(picker.dataset.for);
    text.addEventListener('input', () => { if (parseHex(text.value)) picker.value = normalizeHex(text.value); });
    picker.addEventListener('input', () => {
      text.value = picker.value.toUpperCase();
      update(picker.dataset.for, text.value);
    });
  }
  // Pick up folders added to ./shapes while the page is open.
  $('folder').addEventListener('focus', loadFolderList);
  $('lucky').addEventListener('click', feelingLucky);
  $('reseed').addEventListener('click', () => {
    const seed = Math.random().toString(36).slice(2, 8);
    $('seed').value = seed;
    update('seed', seed, true);
  });
  $('generate').addEventListener('click', generate);
  $('download').addEventListener('click', download);
  $('exportSettings').addEventListener('click', exportSettings);
  $('importSettings').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', importSettings);
  $('frame').addEventListener('click', () => { $('frame').classList.toggle('actual'); fit(); });
  new ResizeObserver(fit).observe($('viewport'));
}

const FIELDS = ['folder', 'colorFrom', 'colorTo', 'colorCount', 'width', 'height', 'background', 'transparent', 'edge', 'seed', 'auto'];

// Push `settings` into every control.
function syncInputs() {
  for (const key of FIELDS) {
    const el = $(key);
    if (el.type === 'checkbox') el.checked = settings[key];
    else el.value = settings[key];
  }
  for (const [, , rows] of SLIDERS) {
    for (const { key } of rows) $(key).value = $(key).previousElementSibling.value = settings[key];
  }
  for (const picker of document.querySelectorAll('input[type="color"][data-for]')) {
    const value = settings[picker.dataset.for];
    if (parseHex(value)) picker.value = normalizeHex(value);
  }
  renderSwatches();
}

function exportSettings() {
  const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `pattern-settings-${settings.seed}.json`.replace(/[^\w.-]+/g, '_');
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// Only known keys are taken, and only when their type matches the default's.
async function importSettings(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let data;
  try {
    data = JSON.parse(await file.text());
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not a settings object');
  } catch (err) {
    return status(`Couldn't import ${file.name}: ${err.message}`);
  }
  const previousFolder = settings.folder;
  for (const key in DEFAULTS) {
    if (typeof data[key] === typeof DEFAULTS[key]) settings[key] = data[key];
  }
  await loadFolderList();
  if (!folders.includes(settings.folder)) {
    $('folderNote').textContent = `${file.name} uses shape set “${settings.folder}”, which isn't in shapes/. Kept “${previousFolder}”.`;
    settings.folder = previousFolder;
  } else {
    $('folderNote').textContent = '';
  }
  applySettings();
}

// After `settings` changed wholesale: persist, refresh controls, redraw.
function applySettings() {
  save();
  syncInputs();
  if (settings.folder !== loadedFolder) loadFolder();
  else {
    renderShapeList();
    generate();
  }
}

// Ranges are narrower than the sliders' on purpose, and a draw is rejected when it would
// produce more than ~LUCKY_MAX_SHAPES (e.g. dots with a 2px stroke on a large canvas
// is 180k shapes and several seconds of work). Canvas size is left as it is.
const LUCKY_MAX_SHAPES = 15000;

async function feelingLucky() {
  const rand = (min, max, step = 1) => Math.round((min + Math.random() * (max - min)) / step) * step;
  const round1 = (v) => Math.round(v * 10) / 10;
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const hex = () => '#' + Math.floor(Math.random() * 0x1000000).toString(16).padStart(6, '0').toUpperCase();

  await loadFolderList();
  const folder = pick(folders) ?? settings.folder;
  let set;
  try {
    set = await fetchShapes(folder);
  } catch (err) {
    return status(`Couldn't load “${folder}”: ${err.message}`);
  }
  const length = set.shapes.reduce((sum, s) => sum + Math.max(s.width, s.height), 0) / Math.max(1, set.shapes.length);

  let next;
  for (let attempt = 0; attempt < 200; attempt++) {
    const strokeWidth = rand(2, 16, 0.5);
    const safe = rand(1, 16, 0.5);
    const scale = round1(rand(1, 8, 0.1));
    next = {
      folder,
      colorFrom: hex(),
      colorTo: hex(),
      colorCount: rand(2, 8),
      background: hex(),
      transparent: Math.random() < 0.2,
      edge: pick(['clip', 'inside', 'tile']),
      strokeWidth,
      strokeWidthRand: round1(Math.random() * strokeWidth * 0.4),
      safe,
      safeRand: round1(Math.random() * safe * 0.5),
      angle: rand(-180, 180),
      angleRand: rand(0, 180),
      scale,
      scaleRand: round1(Math.random() * scale * 0.3),
      seed: Math.random().toString(36).slice(2, 8),
    };
    // Rough shape count: canvas area over each shape's footprint (calibrated on real runs).
    const thick = strokeWidth + safe;
    if ((1.25 * settings.width * settings.height) / ((length * scale + thick) * thick) <= LUCKY_MAX_SHAPES) break;
  }
  Object.assign(settings, next);
  ({ shapes, errors: shapeErrors } = set);
  loadedFolder = folder;
  $('folderNote').textContent = '';
  applySettings();
}

let debounce = 0;
function update(key, value, force = false) {
  settings[key] = value;
  save();
  if (key.startsWith('color')) renderSwatches();
  if (key === 'scale' || key === 'strokeWidth') renderShapeList();
  if (key === 'background' || key === 'transparent') return applyBackground();
  if (settings.auto || force) {
    clearTimeout(debounce);
    debounce = setTimeout(generate, 120);
  }
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

function normalizeHex(hex) {
  return '#' + parseHex(hex).map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('');
}

function colorSet() {
  return oklchGradient(settings.colorFrom, settings.colorTo, Math.min(256, Math.max(1, Math.round(settings.colorCount))));
}

function renderSwatches() {
  $('swatches').replaceChildren(...colorSet().map((c) => {
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

let shapeErrors = [];

async function fetchShapes(folder) {
  const res = await fetch(`/api/shapes?folder=${encodeURIComponent(folder)}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  const shapes = [], errors = [];
  for (const { name, svg } of data) {
    try {
      const s = svgToShape(name, svg);
      if (s) shapes.push(s);
      else errors.push(`${name}: no geometry`);
    } catch (err) {
      errors.push(err.message);
    }
  }
  return { shapes, errors };
}

// Thumbnails show each shape as it will be drawn (current scale and stroke width),
// all at the same zoom so their relative sizes are visible.
function renderShapeList() {
  const list = $('shapeList');
  list.replaceChildren();
  const scale = Math.max(0.01, Number(settings.scale) || 1);
  const sw = Math.max(0.1, Number(settings.strokeWidth) || 1);
  const size = Math.max(...shapes.map((s) => Math.max(s.width, s.height) * scale), 0) * 1.15 + sw * 1.5;
  for (const s of shapes) {
    const svg = svgEl('svg', { viewBox: `${-size / 2} ${-size / 2} ${size} ${size}` });
    svg.append(svgEl('path', {
      d: cmdsToD(transformCmds(s.cmds, [scale, 0, 0, scale, 0, 0])),
      fill: 'none',
      stroke: '#1d1d1f',
      'stroke-width': sw,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    }));
    const title = svgEl('title', {});
    title.textContent = s.name;
    svg.append(title);
    list.append(svg);
  }
  if (!shapes.length && loadedFolder) {
    const msg = document.createElement('div');
    msg.className = 'msg err';
    msg.textContent = `No usable shapes in “${loadedFolder}”`;
    list.append(msg);
  }
  for (const e of shapeErrors) {
    const el = document.createElement('div');
    el.className = 'msg err';
    el.textContent = e;
    list.append(el);
  }
}

async function loadFolder() {
  const folder = settings.folder;
  if (!folder) return status('Add a folder of SVGs to shapes/ to start');
  try {
    ({ shapes, errors: shapeErrors } = await fetchShapes(folder));
    loadedFolder = folder;
    renderShapeList();
    generate();
  } catch (err) {
    shapes = [];
    shapeErrors = [];
    loadedFolder = null;
    $('shapeList').innerHTML = '';
    const el = document.createElement('div');
    el.className = 'msg err';
    el.textContent = `Couldn't load “${folder}”: ${err.message}`;
    $('shapeList').append(el);
  }
}

async function loadFolderList() {
  try {
    folders = await (await fetch('/api/folders')).json();
  } catch {
    folders = [];
  }
  const select = $('folder');
  const current = [...select.options].map((o) => o.value);
  if (current.join('\n') !== folders.join('\n')) select.replaceChildren(...folders.map((f) => Object.assign(document.createElement('option'), { value: f, textContent: f })));
  select.value = settings.folder;
}

// ---------- generation ----------

function readParams() {
  const n = (k) => Number(settings[k]) || 0;
  return {
    width: Math.max(10, n('width')),
    height: Math.max(10, n('height')),
    edge: settings.edge,
    colors: colorSet(),
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
  setPending(false); // a run in progress is abandoned below (job changed)
  if (!shapes.length) return status('No shapes loaded');
  if (!P.colors.length) return status('Enter valid hex colors, e.g. #1A2B3C');

  packer = new Packer(shapes, P, settings.seed);
  const it = packer.run();
  status('');
  setPending(true);

  const svg = svgEl('svg', { width: P.width, height: P.height, viewBox: `0 0 ${P.width} ${P.height}` });
  const bg = svgEl('rect', { id: 'bg', width: P.width, height: P.height });
  const g = svgEl('g', { fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  svg.append(bg, g);
  $('frame').replaceChildren(svg);
  applyBackground();
  fit();

  let drawn = 0;
  const tick = () => {
    if (my !== job) return;
    const until = performance.now() + 25;
    let done = false;
    while (performance.now() < until) {
      if (it.next().done) { done = true; break; }
    }
    const frag = document.createDocumentFragment();
    for (; drawn < packer.placed.length; drawn++) {
      for (const p of packer.pathsFor(packer.placed[drawn])) {
        frag.append(svgEl('path', { d: p.d, stroke: p.stroke, 'stroke-width': p.width }));
      }
    }
    g.append(frag);
    if (done) return setPending(false);
    const pct = Math.floor(packer.progress * 100);
    $('progress').style.width = pct + '%';
    $('progressLabel').textContent = `Generating… ${pct}%`;
    requestAnimationFrame(tick);
  };
  tick();
}

// The progress UI appears only if generating takes longer than a moment, so quick
// redraws while dragging a slider don't flicker. Download waits for a finished pattern.
let pendingTimer = 0;
function setPending(on) {
  clearTimeout(pendingTimer);
  $('download').disabled = on;
  if (on) {
    $('progress').style.width = '0%';
    $('progressLabel').textContent = 'Generating…';
    pendingTimer = setTimeout(() => document.body.classList.add('pending'), 200);
  } else {
    document.body.classList.remove('pending');
  }
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
  // Like object-fit: contain — as large as the preview area allows.
  const view = $('viewport');
  const k = Math.min(view.clientWidth / W, view.clientHeight / H);
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

// The canvas starts out the size of the preview area, so the pattern fills it 1:1.
const view = $('viewport');
if (view.clientWidth > 0 && view.clientHeight > 0) {
  settings.width = view.clientWidth;
  settings.height = view.clientHeight;
  save();
}

buildSliders();
bindInputs();
syncInputs();
await loadFolderList();
// A saved folder that no longer exists falls back to the first available set.
if (!folders.includes(settings.folder)) {
  settings.folder = folders[0] || '';
  $('folder').value = settings.folder;
  save();
}
loadFolder();
