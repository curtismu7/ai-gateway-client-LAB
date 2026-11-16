'use strict';
// "What Privilege did" (rule 25), Real: the relay talks to a loopback fake gateway (live mode, like relay.test.js). A real gateway reports no
// per-check detail, so a real trace may only say `inferred` or `observed`, never `checked`. Real mode against the live gateway is owner-run.
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DOOR_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-gateway-client-trace-real-'));
process.env.GATEWAY_ENV_PATH = path.join(process.env.DOOR_STORE_DIR, 'gateway.env');
process.env.MODE = 'live';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const relay = require('./lib/relay');
const gatewayTrace = require('./lib/gatewayTraceLog');
const { assertTrace } = require('./src/gatewayTrace.js');

async function startFake(handler) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    const rpc = raw ? JSON.parse(raw) : {};
    const out = await handler({ pathname: req.url, rpc });
    res.statusCode = out.status || 200;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('MCP-Session-Id', out.sessionId || 'fake-session-0123456789abcdef');
    res.end(JSON.stringify(out.body !== undefined ? out.body : { jsonrpc: '2.0', id: rpc.id, result: out.result || {} }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
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
const door = (base, gatewayMode, mcpUrl, token) => post(base, '/config', token, { gatewayMode, mcpUrl });
// A modern-handshake gateway: server/discover answers, every other method goes to `rest`.
const gateway = (rest) => ({ rpc, pathname }) => {
  if (rpc.method === 'server/discover') return { result: { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } } };
  return rest({ rpc, pathname });
};
// Fake bearer, built at run time so no token-shaped literal is in the repo.
const fakeToken = () => `fake-${crypto.randomBytes(24).toString('hex')}`;

function assertHonest(exchanges) {
  assert.ok(exchanges.length > 0);
  for (const ex of exchanges) {
    assert.deepEqual(assertTrace(ex.trace), [], `step ${ex.step}`);
    assert.equal(ex.trace.source, 'real');
    assert.ok(ex.trace.decisions.every((d) => d.basis !== 'checked'), `step ${ex.step}: a real trace never says checked`);
  }
}

test('real, Privilege door: a 200 is inferred (token, grant) and the gateway-reported filter is observed; none is `checked`', async () => {
  const fake = await startFake(gateway(() => ({
    result: { tools: [{ name: 'search' }], _meta: { deniedTools: [{ name: 'delete_all', deniedReason: 'scope_missing' }] } },
  })));
  try {
    await withServer(async (base) => {
      const token = fakeToken();
      await door(base, 'privilege', `${fake.base}/aggregate/mcp`, token);
      assert.equal((await post(base, '/tools/list', token)).status, 200);
      const { exchanges } = await trace(base);
      assertHonest(exchanges);
      assert.equal(exchanges.at(-1).trace.request.body.method, 'tools/list');
      assert.ok(exchanges.every((e) => e.door === 'privilege'));
      const d = Object.fromEntries(exchanges.at(-1).trace.decisions.map((x) => [x.id, x]));
      assert.deepEqual([d.authenticated.outcome, d.authenticated.basis], ['pass', 'inferred']);
      assert.deepEqual([d.grant.outcome, d.grant.basis], ['pass', 'inferred']);
      assert.deepEqual([d.filter.outcome, d.filter.basis], ['info', 'observed']);
      assert.match(d.filter.evidence, /delete_all/);
    });
  } finally { await fake.close(); }
});

test('real, Privilege door: 403 is a grant refusal read from the outcome (inferred), 401 is a token refusal with the grant not reached', async () => {
  const fake = await startFake(gateway(({ rpc }) => (rpc.method === 'tools/call' ? { status: 403, body: { error: 'denied' } } : { result: {} })));
  try {
    await withServer(async (base) => {
      const token = fakeToken();
      await door(base, 'privilege', `${fake.base}/aggregate/mcp`, token);
      assert.equal((await post(base, '/tools/call', token, { name: 'delete_all', arguments: {} })).status, 403);
      const { exchanges } = await trace(base);
      assertHonest(exchanges);
      const last = exchanges.at(-1);
      assert.equal(last.status, 403);
      const grant = last.trace.decisions.find((x) => x.id === 'grant');
      assert.deepEqual([grant.outcome, grant.basis], ['fail', 'inferred']);
    });
  } finally { await fake.close(); }
  const refusing = await startFake(() => ({ status: 401, body: { error: 'invalid_token' } }));
  try {
    await withServer(async (base) => {
      const token = fakeToken();
      await door(base, 'privilege', `${refusing.base}/aggregate/mcp`, token);
      await post(base, '/rpc', token, { jsonrpc: '2.0', id: 3, method: 'initialize', params: {} });
      const { exchanges } = await trace(base);
      assertHonest(exchanges);
      const d = Object.fromEntries(exchanges.at(-1).trace.decisions.map((x) => [x.id, x]));
      assert.deepEqual([d.authenticated.outcome, d.authenticated.basis], ['fail', 'inferred']);
      assert.deepEqual([d.grant.outcome, d.grant.basis], ['skipped', 'inferred']);
    });
  } finally { await refusing.close(); }
});

test('real, Direct door: there is no gateway in the path, so one observed `info` line and no Privilege decision or log pointer', async () => {
  const fake = await startFake(gateway(() => ({ result: { tools: [{ name: 'search' }] } })));
  try {
    await withServer(async (base) => {
      const token = fakeToken();
      await door(base, 'direct', `${fake.base}/open/mcp`, token);
      assert.equal((await post(base, '/tools/list', token)).status, 200);
      const { exchanges } = await trace(base);
      assertHonest(exchanges);
      for (const ex of exchanges) {
        assert.equal(ex.door, 'direct');
        assert.match(ex.title, /^Direct door \(no gateway\)/);
        assert.deepEqual(ex.trace.decisions.map((x) => [x.id, x.outcome, x.basis]), [['direct', 'info', 'observed']]);
        assert.equal(ex.trace.record, null);
      }
    });
  } finally { await fake.close(); }
});

test('real: the token, the session id and anything the gateway echoes back of them are never in a trace', async () => {
  const token = fakeToken();
  const sessionId = `sess-${crypto.randomBytes(16).toString('hex')}`;
  const fake = await startFake(gateway(({ rpc }) => (rpc.method === 'tools/call'
    ? { sessionId, result: { content: [{ type: 'text', text: `you sent ${token} in session ${sessionId}` }] } }
    : { sessionId, result: {} })));
  try {
    await withServer(async (base) => {
      await door(base, 'privilege', `${fake.base}/aggregate/mcp`, token);
      assert.equal((await post(base, '/tools/call', token, { name: 'echo', arguments: {} })).status, 200);
      const text = JSON.stringify(await trace(base));
      assert.ok(!text.includes(token), 'the access token is not in the trace, even where the gateway echoed it');
      assert.ok(!text.includes(sessionId), 'the full session id is not in the trace');
      assert.match(text, new RegExp(`Bearer <token, ${token.length} characters, kept on the server>`));
      assert.match(text, /<kept on the server>/);
      assert.ok(text.includes(`${sessionId.slice(0, 8)}… (shortened)`), 'the session id header is shortened');
    });
  } finally { await fake.close(); }
});

test('real: a gateway that cannot be reached is a request with no response and one observed `fail`, never an invented decision', async () => {
  const fake = await startFake(gateway(() => ({ result: {} })));
  const url = `${fake.base}/aggregate/mcp`;
  await fake.close();
  await withServer(async (base) => {
    const token = fakeToken();
    await door(base, 'privilege', url, token);
    assert.notEqual((await post(base, '/tools/list', token)).status, 200);
    const { exchanges } = await trace(base);
    assertHonest(exchanges);
    const last = exchanges.at(-1).trace;
    assert.equal(last.response, null);
    assert.deepEqual(last.decisions.map((x) => [x.id, x.outcome, x.basis]), [['reach', 'fail', 'observed']]);
  });
});

test('real: an event-stream reply is shown as the text the gateway sent, and the decisions still read the JSON in it', () => {
  const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":4,"result":{"tools":[{"name":"search"}]}}\n\n';
  const sess = { gatewayMode: 'privilege', oauth: { accessToken: fakeToken() }, config: {}, mcpSession: {} };
  const response = new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  let exchange;
  gatewayTrace.traced('rpc', () => {
    const ticket = gatewayTrace.begin();
    gatewayTrace.record({
      sess, ticket, targetUrl: new URL('http://127.0.0.1:1/aggregate/mcp'), headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sess.oauth.accessToken}` },
      rpc: { jsonrpc: '2.0', id: 4, method: 'tools/list' }, checks: null, response, text: sse, parsed: JSON.parse(sse.split('data: ')[1]),
    });
    exchange = gatewayTrace.latest().exchanges[0];
  })({}, {}, () => {});
  assert.equal(exchange.trace.response.body, sse);
  assert.deepEqual(assertTrace(exchange.trace), []);
  assert.match(exchange.trace.decisions.find((x) => x.id === 'grant').evidence, /search/);
  gatewayTrace.clear();
});
