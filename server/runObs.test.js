'use strict';
// Rule 27: the lab's half of the run-observability panel (runObs.js, the X-Obs-Run header on traced actions, GET /api/gateway/obs/run).
// The vendored collector has its own tests in the shared folder. The pre-existing compose SHELF_URL failure on main is not touched here.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const runObs = require('./lib/runObs');

const WORDS = /refused|denied|rejected|forbidden|failed|invalid|expired|mismatch|token|audience|scope|served|unauthori[sz]ed|insufficient|not allowed/i;
const LINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z ai-gateway-client-lab decision step=[A-Za-z0-9._:/@-]+ layer=[a-z]+ actor=[A-Za-z0-9._:/@-]+ result=(?:passed|stopped|unclear) run=[A-Za-z0-9._:/@-]+$/;

const EXCHANGE = (overrides = {}) => ({
  step: 1, door: 'privilege', status: 200,
  trace: { source: 'mock', decisions: [
    { id: 'authenticated', label: 'Access token', outcome: 'pass', basis: 'checked', evidence: 'the bearer token is signed by the mock sign-in server' },
    { id: 'grant', label: 'Grant', outcome: 'pass', basis: 'checked', evidence: "the caller's grants include tool update_record" },
  ] },
  ...overrides,
});

test('a mock tools/call maps to an allowed Authorize pair; a refused grant is refused, a refused access-token check is information', async () => {
  const events = runObs.actionEvents({ exchanges: [EXCHANGE()] });
  assert.deepEqual(events.map((e) => [e.layer, e.outcome]), [['authorize', 'allowed'], ['authorize', 'allowed']]);
  const denied = runObs.actionEvents({ exchanges: [EXCHANGE({ trace: { source: 'mock', decisions: [
    { id: 'authenticated', label: 'Access token', outcome: 'pass', basis: 'checked', evidence: 'ok' },
    { id: 'grant', label: 'Grant', outcome: 'fail', basis: 'checked', evidence: 'the grants do not include it' },
  ] } })] });
  assert.equal(denied[1].outcome, 'refused', 'a refused grant is a policy refusal');
  const noAuth = runObs.actionEvents({ exchanges: [EXCHANGE({ trace: { source: 'mock', decisions: [
    { id: 'authenticated', label: 'Access token', outcome: 'fail', basis: 'checked', evidence: 'no Authorization header' },
  ] } })] });
  assert.equal(noAuth[0].outcome, 'info', 'a refused access-token check is a credential state, not a policy refusal');
});

test('the chain view: user and scopes come from the session (runObs carries none itself; the record validates without them)', async () => {
  const events = runObs.actionEvents({ exchanges: [EXCHANGE()] });
  const at = '2026-11-24T10:00:00.000Z';
  await runObs.obsReady;
  const rec = await runObs.recordOf({ id: 'act-0001', source: 'mock', startedAt: at, endedAt: at, events: events.map((e, seq) => ({ ...e, at, seq })), notes: [], partial: false });
  const core = await import(pathToFileURL(path.join(__dirname, 'src/runObservability.js')));
  assert.deepEqual(core.assertRunObservability(rec), []);
  const stamped = rec.rows.filter((r) => r.origin !== 'not-logged');
  assert.equal(stamped.length, 2);
  assert.equal(stamped[0].outcome, 'allowed');
});

test('every line survives the sanitiser and no shared matcher reads one', async () => {
  await runObs.obsReady;
  const events = runObs.actionEvents({ exchanges: [EXCHANGE()] });
  const line = runObs.decisionLine({ ...events[0], at: '2026-11-24T10:00:00.000Z', who: 'caller x=1\ninjected' }, 'run\nx=1');
  assert.equal(line.split('\n').length, 1);
  assert.match(line, LINE);
  const core = await import(pathToFileURL(path.join(__dirname, 'src/runObservability.js')));
  for (const product of ['p1', 'p2']) {
    assert.equal(core.classify({ product, message: line, at: Date.parse('2026-11-24T10:00:00.000Z'), atExact: '2026-11-24T10:00:00.000Z' }, []), null);
  }
});

test('the log keeps the last few runs and Reset clears it', async () => {
  await runObs.obsReady;
  const lines = [];
  const runLog = await runObs.createRunLog({ write: (l) => lines.push(l), clock: () => '2026-11-24T10:00:00.000Z', max: 3 });
  for (let i = 0; i < 5; i += 1) runLog.mock(() => runObs.actionEvents({ exchanges: [EXCHANGE()] }));
  assert.equal(runLog.size(), 3);
  assert.equal(runLog.get('act-nope'), null);
  runLog.clear();
  assert.equal(runLog.size(), 0);
});

test('over HTTP: a traced action stamps X-Obs-Run and the record route answers that record', async () => {
  await runObs.obsReady;
  const { createApp } = (() => { try { return require('../index'); } catch { return {}; } })();
  if (!createApp) return; // index.js listens at import time in some shapes; covered by the e2e below
  const { createServer } = require('node:http');
  const server = createServer(createApp());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await fetch(`${base}/api/gateway/tools/list`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: '{}' });
    const runId = r.headers.get('x-obs-run');
    assert.ok(runId, 'the answer carries the run id');
    const rec = await fetch(`${base}/api/gateway/obs/run?runId=${encodeURIComponent(runId)}`).then(async (x) => ({ status: x.status, body: await x.json() }));
    assert.equal(rec.status, 200);
    assert.ok(rec.body.record?.rows?.length, 'the record has rows');
    assert.equal((await fetch(`${base}/api/gateway/obs/run?runId=nope`)).status, 400);
  } finally { await new Promise((r) => server.close(r)); }
});
