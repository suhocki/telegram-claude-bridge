import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

export function resolveSitePath(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0]);
  } catch {
    return undefined;
  }
  if (decoded.includes('\0')) return undefined;
  const clean = normalize(decoded).replace(/^([/\\])+/, '');
  const full = resolve(root, clean === '' || clean.endsWith(sep) ? join(clean, 'index.html') : clean);
  return full === root || full.startsWith(root + sep) ? full : null;
}

export function createSiteServer(root) {
  return createServer(async (req, res) => {
    const file = resolveSitePath(root, req.url ?? '/');
    if (file === undefined) {
      res.writeHead(400).end('Bad request');
      return;
    }
    if (file === null) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(body);
    } catch (err) {
      const missing = err.code === 'ENOENT' || err.code === 'EISDIR' || err.code === 'ENOTDIR';
      res.writeHead(missing ? 404 : 500).end(missing ? 'Not found' : 'Server error');
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL('../site', import.meta.url)));
  const port = Number(process.env.PORT ?? 4173);
  createSiteServer(root).listen(port, '127.0.0.1', () => {
    console.log(`site: http://127.0.0.1:${port}`);
  });
}
