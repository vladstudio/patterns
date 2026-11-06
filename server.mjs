// Tiny zero-dependency dev server: serves ./app, plus shapes.json built live from ./shapes.
//   node server.mjs            -> http://localhost:8787
//   PORT=9000 node server.mjs

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLibrary } from './tools/library.mjs';

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), 'app');
const PORT = Number(process.env.PORT) || 8787;

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.txt': 'text/plain',
  '.xml': 'application/xml',
};

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/shapes.json') return send(res, 200, await readLibrary());
    const file = path.resolve(APP, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(APP + path.sep)) return send(res, 403, 'Forbidden', 'text/plain');
    send(res, 200, await fs.readFile(file), TYPES[path.extname(file)] || 'application/octet-stream');
  } catch (err) {
    const status = err.status || (err.code === 'ENOENT' ? 404 : 500);
    send(res, status, { error: err.code === 'ENOENT' ? 'Not found' : err.message });
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`Pattern generator: http://localhost:${PORT}`));
