'use strict';
// GET /api/shelf feeds the header Shelf button. Runs the real server as a child with no web build, so the route
// must not depend on web/dist. Same child-process style as infoMode.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const path = require('node:path');

function withServer(env, fn) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'index.js')], {
      env: { ...process.env, ...env, PORT: '6878' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let url = '';
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      const m = /listening on (http:\S+)/.exec(out);
      if (m && !url) { url = m[1]; fn(url).then(resolve, reject).finally(() => child.kill()); }
    });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => { if (!url) reject(new Error(`server exited ${code}: ${out.slice(-300)}`)); });
    setTimeout(() => { if (!url) { child.kill(); reject(new Error(`no listen line: ${out.slice(-300)}`)); } }, 8000);
  });
}

test('GET /api/shelf is reachable without a web build and reads SHELF_URL; POST is refused', async () => {
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'web', 'dist', 'index.html')), 'this test must run without a web build');
  await withServer({ SHELF_URL: 'https://shelf.example:8443/' }, async (url) => {
    const r = await fetch(`${url}/api/shelf`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { shelfUrl: 'https://shelf.example:8443' });
    assert.notEqual((await fetch(`${url}/api/shelf`, { method: 'POST', headers: { Origin: url } })).status, 200);
  });
});

test('compose passes a usable SHELF_URL so the header Shelf button shows in Docker', () => {
  const compose = fs.readFileSync(path.join(__dirname, '..', 'docker-compose.yml'), 'utf8');
  assert.match(compose, /SHELF_URL:\s*\$\{SHELF_URL:-http:\/\/127\.0\.0\.1:4400\}/);
});
