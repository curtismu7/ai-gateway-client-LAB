'use strict';
// Host check and same-origin writes, including the lab-proxy case: LAB_ALLOWED_HOSTS names the Host the proxy sends, and a write whose
// Origin is the proxy's public origin is accepted only when X-Forwarded-Host/-Proto agree. The app wiring is covered by running index.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const express = require('express');
const { allowedHostsFrom, makeGuard } = require('./lib/safety');

const LAB = 'agc.lab.example';
const PROXY = 'proxy.example:8443';
const via = (over = {}) => ({ host: `${LAB}:6880`, origin: `https://${PROXY}`, 'x-forwarded-host': PROXY, 'x-forwarded-proto': 'https', ...over });

// Like fetch, but lets a test set Host. Header values that are undefined are dropped.
function raw(port, { method = 'GET', pathname = '/ping', headers = {} } = {}) {
  const h = Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== undefined));
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: h, agent: false }, (res) => {
      let text = ''; res.on('data', (c) => { text += c; }); res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject); req.end();
  });
}

async function withGuard(allowedHosts, fn) {
  const app = express();
  app.use(makeGuard(allowedHosts));
  app.all('/ping', (_req, res) => res.json({ ok: true }));
  const srv = app.listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  try { await fn(srv.address().port); } finally { srv.closeAllConnections?.(); await new Promise((r) => srv.close(r)); }
}

test('LAB_ALLOWED_HOSTS: names are trimmed and lower-cased, unset is empty, an invalid name throws', () => {
  assert.deepEqual([...allowedHostsFrom({ LAB_ALLOWED_HOSTS: ` ${LAB.toUpperCase()}, second.lab.example ` })].sort(), [LAB, 'second.lab.example']);
  assert.equal(allowedHostsFrom({}).size, 0);
  assert.equal(allowedHostsFrom({ LAB_ALLOWED_HOSTS: '' }).size, 0);
  for (const bad of ['good.example,bad name', 'http://x.example', 'x.example:8443', '-x.example', 'x..example', 'a_b.example', 'x.example/']) {
    assert.throws(() => allowedHostsFrom({ LAB_ALLOWED_HOSTS: bad }), /LAB_ALLOWED_HOSTS: not a host name/, bad);
  }
});

test('Host check: listed names pass with or without a port in any case, loopback passes, every other name is 421', async () => {
  await withGuard(allowedHostsFrom({ LAB_ALLOWED_HOSTS: `${LAB},second.lab.example` }), async (port) => {
    for (const host of [LAB, `${LAB}:6880`, 'AGC.Lab.Example:8443', 'second.lab.example', 'localhost:6880', '127.0.0.1', '[::1]:6880']) {
      assert.equal((await raw(port, { headers: { host } })).status, 200, host);
    }
    for (const host of [`${LAB}.evil.example`, `evil.${LAB}`, `x${LAB}`, 'lab.example', 'third.lab.example', `${LAB}@evil.example`, '0.0.0.0', '10.0.0.5']) {
      assert.equal((await raw(port, { headers: { host } })).status, 421, host);
    }
  });
});

test('Host check: with LAB_ALLOWED_HOSTS unset only loopback passes', async () => {
  await withGuard(allowedHostsFrom({}), async (port) => {
    assert.equal((await raw(port, { headers: { host: LAB } })).status, 421);
    assert.equal((await raw(port, { headers: { host: '127.0.0.1:6880' } })).status, 200);
  });
});

test('same-origin writes: loopback origin equal to Host passes, any other origin is refused', async () => {
  await withGuard(allowedHostsFrom({}), async (port) => {
    const h = { host: '127.0.0.1:6880' };
    assert.equal((await raw(port, { method: 'POST', headers: { ...h, origin: 'http://127.0.0.1:6880' } })).status, 200);
    assert.equal((await raw(port, { method: 'POST', headers: h })).status, 200, 'no Origin (curl)');
    assert.equal((await raw(port, { method: 'POST', headers: { ...h, origin: 'http://evil.example' } })).status, 403);
    assert.equal((await raw(port, { method: 'POST', headers: { ...h, origin: 'null' } })).status, 403);
    assert.equal((await raw(port, { method: 'POST', headers: { ...h, origin: 'http://127.0.0.1:6880', 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal((await raw(port, { method: 'POST', headers: { ...h, origin: 'http://127.0.0.1:6880', 'sec-fetch-site': 'same-origin' } })).status, 200);
  });
});

test('proxied write: accepted for a listed Host with a matching forwarded host and scheme', async () => {
  await withGuard(allowedHostsFrom({ LAB_ALLOWED_HOSTS: LAB }), async (port) => {
    assert.equal((await raw(port, { method: 'POST', headers: via() })).status, 200);
    assert.equal((await raw(port, { method: 'DELETE', headers: via({ host: LAB.toUpperCase() }) })).status, 200, 'Host case does not matter');
    assert.equal((await raw(port, { method: 'POST', headers: via({ 'x-forwarded-proto': undefined }) })).status, 200, 'the scheme defaults to https');
    assert.equal((await raw(port, { method: 'POST', headers: via({ origin: 'http://proxy.example', 'x-forwarded-host': 'proxy.example', 'x-forwarded-proto': 'http' }) })).status, 200);
  });
});

test('proxied write: refused for a foreign origin, a forwarded host mismatch, the wrong scheme, cross-site and a missing forwarded host', async () => {
  await withGuard(allowedHostsFrom({ LAB_ALLOWED_HOSTS: LAB }), async (port) => {
    const cases = {
      'foreign origin': via({ origin: 'https://evil.example' }),
      'forwarded host mismatch': via({ 'x-forwarded-host': 'other.example:8443' }),
      'https origin, http forwarded': via({ 'x-forwarded-proto': 'http' }),
      'http origin, https default': via({ origin: `http://${PROXY}`, 'x-forwarded-proto': undefined }),
      'unknown scheme': via({ origin: `ftp://${PROXY}`, 'x-forwarded-proto': 'ftp' }),
      'no forwarded host': via({ 'x-forwarded-host': undefined }),
      'cross-site': via({ 'sec-fetch-site': 'cross-site' }),
    };
    for (const [name, headers] of Object.entries(cases)) assert.equal((await raw(port, { method: 'POST', headers })).status, 403, name);
  });
});

test('forwarded headers are ignored on a loopback Host, on a Host that is not listed, and when LAB_ALLOWED_HOSTS is unset', async () => {
  await withGuard(allowedHostsFrom({ LAB_ALLOWED_HOSTS: LAB }), async (port) => {
    for (const host of ['127.0.0.1:6880', 'localhost:6880', '[::1]:6880']) assert.equal((await raw(port, { method: 'POST', headers: via({ host }) })).status, 403, host);
    assert.equal((await raw(port, { method: 'POST', headers: via({ host: 'other.lab.example' }) })).status, 421);
  });
  await withGuard(allowedHostsFrom({}), async (port) => {
    assert.equal((await raw(port, { method: 'POST', headers: via({ host: '127.0.0.1:6880' }) })).status, 403);
    assert.equal((await raw(port, { method: 'POST', headers: via() })).status, 421);
  });
});

// ── App wiring: index.js itself ─────────────────────────────────────────
const INDEX = path.join(__dirname, 'index.js');
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const childEnv = (extra) => ({ ...process.env, STANDALONE_ENV: path.join(__dirname, 'no-such-env-file'), HOST: '127.0.0.1', MODE: 'mock', LAB_ALLOWED_HOSTS: '', ...extra });

test('index.js: the lab host answers and a proxied write works end to end', async () => {
  const port = await freePort();
  const child = spawn(process.execPath, [INDEX], { env: childEnv({ PORT: String(port), LAB_ALLOWED_HOSTS: LAB }), stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((resolve, reject) => {
      let out = '';
      child.stdout.on('data', (d) => { out += d; if (/listening on/.test(out)) resolve(); });
      child.stderr.on('data', (d) => { out += d; });
      child.once('exit', (code) => reject(new Error(`exited ${code}: ${out.slice(-300)}`)));
      setTimeout(() => reject(new Error(`no listen line: ${out.slice(-300)}`)), 10000).unref();
    });
    assert.equal((await raw(port, { pathname: '/api/info', headers: { host: `${LAB}:${port}` } })).status, 200);
    assert.equal((await raw(port, { pathname: '/api/info', headers: { host: `${LAB}.evil.example` } })).status, 421);
    assert.equal((await raw(port, { method: 'POST', pathname: '/api/reset', headers: via({ host: `${LAB}:${port}` }) })).status, 200);
    assert.equal((await raw(port, { method: 'POST', pathname: '/api/reset', headers: via({ host: `127.0.0.1:${port}` }) })).status, 403);
  } finally { child.kill(); }
});

test('index.js: an invalid LAB_ALLOWED_HOSTS exits before anything listens', async () => {
  const port = await freePort();
  const child = spawn(process.execPath, [INDEX], { env: childEnv({ PORT: String(port), LAB_ALLOWED_HOSTS: 'good.example,bad name' }), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const code = await new Promise((resolve) => { child.once('exit', resolve); setTimeout(() => { child.kill(); resolve('timeout'); }, 10000).unref(); });
  assert.notEqual(code, 0);
  assert.notEqual(code, 'timeout');
  assert.match(out, /LAB_ALLOWED_HOSTS: not a host name: bad name/);
  assert.doesNotMatch(out, /listening on/);
  await assert.rejects(raw(port, { headers: { host: '127.0.0.1' } }), /ECONNREFUSED/);
});
