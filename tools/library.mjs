// Reads the shape sets in ./shapes/<name>/*.svg into the shapes.json the app loads:
//   { "<set>": [{ "name": "1.svg", "svg": "<svg…>" }, …], … }
// Used by server.mjs.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SHAPES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'shapes');
const isSvg = (name) => name.toLowerCase().endsWith('.svg');
const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true });

export async function readLibrary() {
  const entries = await fs.readdir(SHAPES, { withFileTypes: true }).catch(() => []);
  const sets = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort(byName);
  const library = {};
  for (const set of sets) {
    const files = (await fs.readdir(path.join(SHAPES, set))).filter(isSvg).sort(byName);
    if (!files.length) continue;
    library[set] = await Promise.all(files.map(async (name) => ({ name, svg: await fs.readFile(path.join(SHAPES, set, name), 'utf8') })));
  }
  return library;
}
