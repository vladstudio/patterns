// Builds the static site into ./dist: the app as-is plus shapes.json.
//   node tools/build.mjs

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLibrary } from './library.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

await fs.rm(DIST, { recursive: true, force: true });
await fs.cp(path.join(ROOT, 'app'), DIST, { recursive: true });
const library = await readLibrary();
await fs.writeFile(path.join(DIST, 'shapes.json'), JSON.stringify(library));
console.log(`Built dist/ with ${Object.keys(library).length} shape sets`);
