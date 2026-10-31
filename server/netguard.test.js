'use strict';
// Netguard and mock-mode proof: zero outbound attempts in mock mode, the self-test passes,
// and the policy refuses what it should. Runs in its own process, so MODE is set before load.
process.env.MODE = 'mock';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DOOR_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-gateway-client-netguard-'));
process.env.GATEWAY_ENV_PATH = path.join(process.env.DOOR_STORE_DIR, 'gateway.env');

const express = require('express');
const relay = require('./lib/relay');
const netguard = require('./lib/netguard');
const mode = require('./lib/mode');

test('mode defaults to mock and live needs a confirm at runtime', () => {
  assert.equal(mode.currentMode(), 'mock');
  assert.equal(mode.setMode('live', {}), 'confirm_required');
  assert.equal(mode.currentMode(), 'mock');
  assert.equal(mode.setMode('bogus', { confirm: true }), 'bad_mode');
});

test('netguard self-test passes every policy case', () => {
  const report = netguard.selfTest();
  assert.equal(report.ok, true, JSON.stringify(report.checks.filter((c) => !c.ok)));
  assert.ok(report.checks.length >= 8);
});

test('guardedFetch refuses a real origin in mock mode without calling fetch', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error('real fetch must not run in mock mode'); };
  const before = netguard.stats.outbound;
  try {
    await assert.rejects(netguard.guardedFetch('https://gateway.example.invalid/x'), (err) => err.code === 'blocked_mock');
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(calls, 0);
  assert.equal(netguard.stats.outbound, before);
});

test('a full mock sign-in, discovery and tool call makes zero outbound attempts', async () => {
  const realFetch = globalThis.fetch;
  const violations = [];
  // The test's own requests go to 127.0.0.1; anything else reaching globalThis.fetch is an outbound attempt.
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input && input.url ? input.url : input));
    if (url.hostname !== '127.0.0.1') violations.push(url.origin);
    return realFetch(input, init);
  };
  const app = express();
  app.use('/api/gateway', relay);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const outboundBefore = netguard.stats.outbound;
  try {
    const state = await (await realFetch(`${base}/api/gateway/state`)).json();
    assert.equal(state.mode.current, 'mock');
    assert.match(state.config.mcpUrl, /^https:\/\/mock-gateway\.invalid\//);

    const start = await (await realFetch(`${base}/api/gateway/auth/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ returnTo: '/' }),
    })).json();
    assert.match(start.authUrl, /\/api\/gateway\/mock-idp\/authorize\?/);

    const authorize = await realFetch(start.authUrl, { redirect: 'manual' });
    assert.equal(authorize.status, 302);
    const callback = await realFetch(authorize.headers.get('location'), { redirect: 'manual' });
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get('location'), '/?auth=success');

    const tools = await (await realFetch(`${base}/api/gateway/tools/list`, { method: 'POST' })).json();
    assert.equal(tools.tools.length, 4);
    assert.equal(tools.policy.filtered, 2);

    const call = await (await realFetch(`${base}/api/gateway/tools/call`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'search_documents', arguments: { index: 'support-articles', query: 'password' } }),
    })).json();
    assert.match(call.result.content[0].text, /KB-101/);

    const denied = await realFetch(`${base}/api/gateway/tools/call`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'delete_index', arguments: { index: 'orders-2026' } }),
    });
    assert.equal(denied.status, 403);
  } finally {
    globalThis.fetch = realFetch;
    await new Promise((resolve) => server.close(resolve));
  }
  assert.deepEqual(violations, [], 'no request may leave for a non-loopback origin');
  assert.equal(netguard.stats.outbound, outboundBefore, 'the real network was never used');
  assert.ok(netguard.stats.mockServed > 0, 'the flow was served by the in-process mock');
});

test('a live gateway typed in mock mode is refused with a clear reason', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/gateway', relay);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fetch(`${base}/api/gateway/config`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gatewayMode: 'direct', mcpUrl: 'https://gateway.example.invalid/mcp' }),
    });
    const res = await fetch(`${base}/api/gateway/auth/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ returnTo: '/' }),
    });
    const body = await res.json();
    assert.equal(res.status, 500);
    assert.match(body.error, /Mock mode: https:\/\/gateway\.example\.invalid is not a mock endpoint/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the mock issuer refuses a wrong PKCE verifier', async () => {
  const mock = require('./lib/mockGateway');
  mock.reset();
  const reg = await mock.handle(new URL('https://mock-idp.invalid/register'), {
    method: 'POST', body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:1/cb'] }),
  });
  const client = await reg.json();
  const verifier = 'a'.repeat(50);
  const challenge = require('crypto').createHash('sha256').update(verifier).digest('base64url');
  const auth = mock.authorize({
    client_id: client.client_id, redirect_uri: 'http://127.0.0.1:1/cb', response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 'x',
  });
  const code = new URL(auth.location).searchParams.get('code');
  const token = await mock.handle(new URL('https://mock-idp.invalid/token'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, client_id: client.client_id, client_secret: client.client_secret,
      redirect_uri: 'http://127.0.0.1:1/cb', code_verifier: 'wrong-verifier',
    }),
  });
  assert.equal(token.status, 400);
  assert.equal((await token.json()).error, 'invalid_grant');
});
