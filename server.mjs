// Tiny zero-dependency dev server: serves ./app and reads shape folders from disk.
//   node server.mjs            -> http://localhost:8787
//   PORT=9000 node server.mjs

import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(ROOT, 'app');
const PORT = Number(process.env.PORT) || 8787;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const isSvg = (name) => name.toLowerCase().endsWith('.svg');

function resolveFolder(name) {
  if (name.startsWith('~')) return path.join(os.homedir(), name.slice(1));
  return path.resolve(ROOT, name);
}

async function listFolders() {
  const entries = await fs.readdir(ROOT, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'app' || e.name === 'node_modules') continue;
    const files = await fs.readdir(path.join(ROOT, e.name));
    if (files.some(isSvg)) out.push(e.name);
  }
  return out.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

async function readShapes(folder) {
  const dir = resolveFolder(folder);
  const files = (await fs.readdir(dir)).filter(isSvg).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return Promise.all(files.map(async (name) => ({ name, svg: await fs.readFile(path.join(dir, name), 'utf8') })));
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/folders') return send(res, 200, await listFolders());
    if (url.pathname === '/api/shapes') {
      const folder = url.searchParams.get('folder') || '';
      if (!folder) return send(res, 400, { error: 'Missing folder' });
      return send(res, 200, await readShapes(folder));
    }
    const file = path.resolve(APP, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(APP + path.sep)) return send(res, 403, 'Forbidden', 'text/plain');
    send(res, 200, await fs.readFile(file), TYPES[path.extname(file)] || 'application/octet-stream');
  } catch (err) {
    send(res, err.code === 'ENOENT' ? 404 : 500, { error: err.code === 'ENOENT' ? 'Not found' : err.message });
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`Pattern generator: http://localhost:${PORT}`));
