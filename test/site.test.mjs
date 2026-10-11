import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { get } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSiteServer, resolveSitePath } from '../scripts/serve-site.mjs';

const root = resolve(fileURLToPath(new URL('../site', import.meta.url)));

test('resolveSitePath maps / to index.html and keeps traversal inside the root', () => {
  assert.equal(resolveSitePath(root, '/'), resolve(root, 'index.html'));
  assert.equal(resolveSitePath(root, '/styles.css?x=1'), resolve(root, 'styles.css'));
  assert.equal(resolveSitePath(root, '/../bridge.mjs'), resolve(root, 'bridge.mjs'));
  assert.equal(resolveSitePath(root, '/%2e%2e/bridge.mjs'), resolve(root, 'bridge.mjs'));
  assert.equal(resolveSitePath(root, '/%E0%A4%A'), undefined);
});

test('index.html links only assets that exist and has each section anchor', () => {
  const html = readFileSync(resolve(root, 'index.html'), 'utf8');
  for (const asset of ['styles.css', 'script.js']) {
    assert.ok(html.includes(asset));
    assert.ok(readFileSync(resolve(root, asset), 'utf8').length > 0);
  }
  for (const id of ['features', 'install', 'faq', 'demo']) assert.ok(html.includes(`id="${id}"`));
});

test('server serves index, 404s unknown paths and never leaks files outside the root', async () => {
  const server = createSiteServer(root).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const ok = await fetch(`${base}/`);
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-type'), /text\/html/);
    assert.equal((await fetch(`${base}/nope.html`)).status, 404);
    assert.equal((await fetch(`${base}/%E0%A4%A`)).status, 400);
    const status = await new Promise((r) => get({ host: '127.0.0.1', port: server.address().port, path: '/%2e%2e/bridge.mjs' }, (res) => { res.resume(); r(res.statusCode); }));
    assert.equal(status, 404);
  } finally {
    server.close();
  }
});
