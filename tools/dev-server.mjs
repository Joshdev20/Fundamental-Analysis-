// Local dev server that mirrors the Vercel deployment: serves public/ as
// static files and routes /api/proxy to the same serverless handler.
//   node tools/dev-server.mjs [port]

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import proxy from '../api/proxy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(__dirname, '..', 'public');
const port = Number(process.argv[2] || process.env.PORT || 3000);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://localhost:${port}`);
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const s = await stat(file);
    if (s.isDirectory()) throw new Error('dir');
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
  }
}

// Adapt Node's req/res to the Vercel-style handler signature.
function vercelAdapter(req, res) {
  const url = new URL(req.url, `http://localhost:${port}`);
  const query = Object.fromEntries(url.searchParams);
  const shim = {
    method: req.method,
    query,
    setHeader: (k, v) => res.setHeader(k, v),
    status(code) { res.statusCode = code; return this; },
    json(obj) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); return this; },
    send(body) { res.end(body); return this; },
    end() { res.end(); return this; },
  };
  return proxy(shim, shim);
}

createServer((req, res) => {
  if (req.url.startsWith('/api/proxy')) return vercelAdapter(req, res);
  return serveStatic(req, res);
}).listen(port, () => {
  console.log(`dev server → http://localhost:${port}`);
  console.log('  /api/proxy mirrors the Vercel serverless function');
});
