'use strict';
// Rule 19 endpoints on the app itself: GET /api/info {source, realAvailable}; POST /api/mode {source}.
// Runs the real server as a child on an ephemeral port so the app wiring (dotenv, express, guards) is covered.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

function withServer(env, fn) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'index.js')], {
      env: { ...process.env, ...env, PORT: '6879' },
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

const post = (url, body) => fetch(`${url}/api/mode`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url }, body: JSON.stringify(body) });
const info = async (url) => (await (await fetch(`${url}/api/info`)).json());

test('GET /api/info: mock by default; realAvailable reflects a configured gateway host', async () => {
  await withServer({ HOSTED_MCPGW_URL: '', HOSTED_HOSTILE_MCP_URL: '' }, async (url) => {
    const j = await info(url);
    assert.equal(j.source, 'mock'); assert.equal(j.realAvailable, false);
  });
  await withServer({ PRIVILEGE_GATEWAY_HOST: 'https://gw.example.invalid' }, async (url) => {
    assert.equal((await info(url)).realAvailable, true);
  });
});

test('POST /api/mode: exact body, Real refused 409 without a host, switch both ways with one', async () => {
  await withServer({ HOSTED_MCPGW_URL: '', HOSTED_HOSTILE_MCP_URL: '' }, async (url) => {
    const bad = await post(url, { source: 'sideways' }); assert.equal(bad.status, 400);
    const extra = await post(url, { source: 'mock', extra: 1 }); assert.equal(extra.status, 400);
    const refused = await post(url, { source: 'real' }); assert.equal(refused.status, 409);
    assert.equal((await info(url)).source, 'mock', 'a refused switch changes nothing');
    const ok = await post(url, { source: 'mock' }); assert.equal(ok.status, 200);
  });
  await withServer({ PRIVILEGE_GATEWAY_HOST: 'https://gw.example.invalid' }, async (url) => {
    const up = await post(url, { source: 'real' }); assert.equal(up.status, 200); assert.equal((await up.json()).source, 'real');
    assert.equal((await info(url)).source, 'real');
    const down = await post(url, { source: 'mock' }); assert.equal(down.status, 200); assert.equal((await info(url)).source, 'mock');
  });
});
