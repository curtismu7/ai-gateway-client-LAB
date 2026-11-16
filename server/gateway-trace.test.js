'use strict';
// "What Privilege did" (rule 25), Mock: the traces of every gateway call against the shared contract (assertTrace) and the honesty rule.
// The lab's own mock gateway computed the token and policy checks, so those decisions are `checked`. Nothing secret is in a trace.
process.env.MODE = 'mock';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DOOR_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-gateway-client-trace-'));
process.env.GATEWAY_ENV_PATH = path.join(process.env.DOOR_STORE_DIR, 'gateway.env');

const express = require('express');
const relay = require('./lib/relay');
const mock = require('./lib/mockGateway');
const samples = require('./lib/mockSamples');
const gatewayTrace = require('./lib/gatewayTraceLog');
const { assertTrace } = require('./src/gatewayTrace.js');

// A real sign-in against the mock issuer, so the token carries the mock user's grants.
async function mockToken() {
  const redirect = 'http://127.0.0.1:1/cb';
  const reg = await (await mock.handle(new URL('https://mock-idp.invalid/register'), {
    method: 'POST', body: JSON.stringify({ redirect_uris: [redirect], token_endpoint_auth_method: 'none' }),
  })).json();
  const verifier = 'v'.repeat(50);
  const auth = mock.authorize({
    client_id: reg.client_id, redirect_uri: redirect, response_type: 'code', state: 's', scope: 'openid',
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
  });
  const code = new URL(auth.location).searchParams.get('code');
  const token = await (await mock.handle(new URL('https://mock-idp.invalid/token'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: reg.client_id, redirect_uri: redirect, code_verifier: verifier }),
  })).json();
  return token.access_token;
}

async function withServer(fn) {
  const app = express();
  app.use('/api/gateway', relay);
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/gateway`;
  try { await fn(base); } finally { relay.__test.reset(); await new Promise((resolve) => server.close(resolve)); }
}

const post = (base, route, token, body) => fetch(`${base}${route}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body || {}),
});
const trace = async (base) => (await fetch(`${base}/trace`)).json();
const hiddenTool = () => samples.hidden(samples.get('standard').tools, { policy: true }).map((t) => t.name)[0];

test('mock: a tools/list through the Privilege door is traced step by step, every trace passes assertTrace, and the decisions are the mock gateway\'s own', async () => {
  await withServer(async (base) => {
    const token = await mockToken();
    assert.equal((await post(base, '/tools/list', token)).status, 200);
    const { action, exchanges } = await trace(base);
    assert.equal(action.label, 'tools/list');
    assert.deepEqual(exchanges.map((e) => e.step), exchanges.map((_, i) => i + 1), 'steps are 1..n in order');
    assert.deepEqual(exchanges.map((e) => e.trace.request.body?.method), ['server/discover', 'initialize', 'notifications/initialized', 'tools/list']);
    for (const ex of exchanges) {
      assert.deepEqual(assertTrace(ex.trace), [], `step ${ex.step}`);
      assert.equal(ex.trace.source, 'mock');
      assert.equal(ex.door, 'privilege');
      assert.match(ex.trace.request.url, /^https:\/\/mock-gateway\.invalid\//, 'a simulated gateway never has a real host');
      assert.ok(ex.trace.decisions.some((d) => d.id === 'authenticated' && d.outcome === 'pass' && d.basis === 'checked'), `step ${ex.step}: the token check ran`);
    }
    const list = exchanges.at(-1).trace;
    const filter = list.decisions.find((d) => d.id === 'filter');
    assert.equal(filter.basis, 'checked');
    assert.equal(filter.outcome, 'info');
    assert.ok(filter.evidence.includes(hiddenTool()), 'the filter decision names what the policy hid');
    // The decision is read back from the reply the mock returned: the same names are in _meta.deniedTools.
    assert.ok(list.response.body.result._meta.deniedTools.some((t) => t.name === hiddenTool()));
  });
});

test('mock: a tool the caller\'s grants hide is refused with 403 on the Privilege door, and the grant decision is the one that failed', async () => {
  await withServer(async (base) => {
    const token = await mockToken();
    const res = await post(base, '/tools/call', token, { name: hiddenTool(), arguments: {} });
    assert.equal(res.status, 403);
    const call = (await trace(base)).exchanges.at(-1);
    assert.equal(call.status, 403);
    assert.deepEqual(assertTrace(call.trace), []);
    const grant = call.trace.decisions.find((d) => d.id === 'grant');
    assert.deepEqual([grant.outcome, grant.basis], ['fail', 'checked']);
    assert.match(grant.evidence, new RegExp(hiddenTool()));
    assert.match(call.trace.response.body.error, /denied by gateway policy/);
  });
});

test('mock: the same call through the Direct door is shown as having no gateway in the path: no grant decision, one `info` policy line', async () => {
  await withServer(async (base) => {
    const token = await mockToken();
    const cfg = await post(base, '/config', token, { gatewayMode: 'direct', mcpUrl: `${mock.MOCK_GATEWAY_ORIGIN}/direct/opensearch/mcp` });
    assert.equal(cfg.status, 200);
    const res = await post(base, '/tools/call', token, { name: hiddenTool(), arguments: { query: 'x' } });
    assert.notEqual(res.status, 403, 'the Direct door has no policy to refuse it');
    const { exchanges } = await trace(base);
    for (const ex of exchanges) {
      assert.deepEqual(assertTrace(ex.trace), []);
      assert.equal(ex.door, 'direct');
      assert.match(ex.title, /^Direct door \(no gateway\)/);
      assert.ok(!ex.trace.decisions.some((d) => d.id === 'grant' || d.id === 'filter'));
      const policy = ex.trace.decisions.find((d) => d.id === 'policy');
      assert.deepEqual([policy.outcome, policy.basis], ['info', 'checked']);
    }
  });
});

test('mock: a bad bearer token is refused 401 and the token decision is the one that failed', async () => {
  await withServer(async (base) => {
    const bogus = `mock-${crypto.randomBytes(12).toString('hex')}`;
    const res = await post(base, '/rpc', bogus, { jsonrpc: '2.0', id: 9, method: 'initialize', params: {} });
    assert.equal(res.status, 401);
    const { exchanges } = await trace(base);
    const last = exchanges.at(-1);
    assert.equal(last.status, 401);
    assert.deepEqual(assertTrace(last.trace), []);
    assert.deepEqual(last.trace.decisions.map((d) => [d.id, d.outcome, d.basis]), [['authenticated', 'fail', 'checked']]);
    assert.ok(!JSON.stringify(last.trace).includes(bogus), 'the bearer value is never in the trace');
    assert.match(last.trace.response.headers['www-authenticate'], /invalid_token/);
  });
});

test('mock: the catalog\'s parallel list calls land in one action, in step order, with no step repeated', async () => {
  await withServer(async (base) => {
    const token = await mockToken();
    const res = await fetch(`${base}/catalog`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    const { action, exchanges } = await trace(base);
    assert.equal(action.label, 'catalog');
    const methods = exchanges.map((e) => e.trace.request.body?.method);
    for (const m of ['tools/list', 'resources/list', 'resources/templates/list', 'prompts/list']) assert.ok(methods.includes(m), m);
    assert.deepEqual(exchanges.map((e) => e.step), exchanges.map((_, i) => i + 1));
    for (const ex of exchanges) assert.deepEqual(assertTrace(ex.trace), []);
  });
});

test('mock: no token, session id or Authorization value is in any trace, and the page-facing reply is unchanged', async () => {
  await withServer(async (base) => {
    const token = await mockToken();
    const res = await post(base, '/tools/call', token, { name: samples.get('standard').tools.find((t) => !samples.hidden([t], { policy: true }).length).name, arguments: { query: 'x' } });
    const reply = await res.json();
    assert.ok(reply.result || reply.error, 'the route still returns the raw JSON-RPC reply, not a wrapper');
    assert.equal(reply.trace, undefined);
    const text = JSON.stringify(await trace(base));
    assert.ok(!text.includes(token), 'the access token is not in the trace');
    assert.ok(!/Bearer [A-Za-z0-9_-]{20,}/.test(text), 'no bearer value of any length');
    assert.match(text, /Bearer <token, \d+ characters, kept on the server>/);
    const fullSession = `mock-${crypto.createHash('sha1').update(token).digest('hex').slice(0, 16)}`;
    assert.ok(!text.includes(fullSession), 'the full MCP session id is not in the trace');
    assert.match(text, /mock-[0-9a-f]{3}… \(shortened\)/);
  });
});

test('Reset clears the trace', async () => {
  await withServer(async (base) => {
    const token = await mockToken();
    await post(base, '/tools/list', token);
    assert.ok((await trace(base)).exchanges.length > 0);
    relay.resetAll();
    assert.deepEqual(await trace(base), { action: null, exchanges: [] });
  });
});

test('an action opens only when a gateway call is made, and the newest action is the one shown', async () => {
  gatewayTrace.clear();
  assert.deepEqual(gatewayTrace.latest(), { action: null, exchanges: [] });
  const handler = (label) => gatewayTrace.traced(label, () => gatewayTrace.begin());
  for (let i = 1; i <= 7; i += 1) handler(`a${i}`)({}, {}, () => {});
  assert.equal(gatewayTrace.latest().action.label, 'a7');
  assert.equal(gatewayTrace.begin(), null, 'outside an action scope there is nothing to record into');
  gatewayTrace.clear();
});
