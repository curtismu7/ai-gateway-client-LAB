'use strict';
// runObs.js (CJS — this server is CommonJS) — "What each layer logged for this run" (rule 27) for this lab.
// The lab's own action trace (gatewayTraceLog.js) already groups every exchange of one user action; this file turns the
// NEWEST action into the run-observability record, mapping its decisions onto the six layers. The vendored collector
// (server/src/runObservability.js) is never edited here; this lab reads no logs, so it vendors the core only.
//
// What a run is here. ONE user action (a tools/list, a tools/call, a catalog load, a raw request, a door probe): the
// exchanges the action made (the session handshake, then the call), in step order. Mock: the mock gateway computed the
// checks, so every row is a step that answer holds (basis 'checked'). Real: only what the lab received (inferred /
// observed). The Direct door has no gateway: its rows say so.
//
// Which layer holds what. The mock gateway's access-token check and grant check are the Authorize layer's decisions
// (the policy door's policy is this lab's Privilege policy). The gateway's list filter (what it hid from this caller)
// is the Agent gateway layer. The MCP server's answer (a JSON-RPC error or a result) is the Resource server row:
// information, never a second decision. The caller is the mock persona (mock) or the workload token (real).
let obs = null; let LAYERS = null; let createMasker = null;
// The ESM core loads asynchronously; every export resolves through lazily-awaited access. Routes and the record route await
// obsReady before the core is touched; the masker is built inside a function so require() stays synchronous.
let obsReady = import('../src/runObservability.js').then((m) => {
  obs = m; LAYERS = m.LAYERS; createMasker = m.createMasker;
});

const SERVICE = 'ai-gateway-client-lab';

// The stdout line's sanitiser: only safe characters survive, so a typed name cannot add a second key=value pair.
const lineValue = (v, n = 64) => String(v ?? '').replace(/[^A-Za-z0-9._:/@-]+/g, '_').slice(0, n) || '-';
const MATCHER_WORDS = /refused|denied|rejected|forbidden|failed|invalid|expired|mismatch|token|audience|scope|served|unauthori[sz]ed|insufficient/gi;
let mask = null;
const field = (v) => lineValue(mask ? mask(String(v ?? '')) : String(v ?? '')).replace(MATCHER_WORDS, '_');
const RESULT = { allowed: 'passed', refused: 'stopped', blocked: 'stopped', info: 'unclear', pass: 'passed', fail: 'stopped' };

// The id -> (layer, step) map for the mock gateway's checks and the trace's inferred/observed decisions.
const CHECK_LAYER = {
  authenticated: ['authorize', 'access-token'],
  policy: ['authorize', 'gateway-policy'],
  grant: ['authorize', 'grant-check'],
  filter: ['gateway', 'list-filter'],
  result: ['resource', 'rpc-result'],
  direct: ['gateway', 'no-gateway'],
  session: ['gateway', 'session'],
  exchange: ['privilege', 'token-exchange'],
  discovery: ['privilege', 'discovery'],
  registration: ['privilege', 'registration'],
  pkce: ['privilege', 'pkce'],
  signin: ['person', 'sign-in'],
  signout: ['person', 'sign-out'],
};
const layerOf = (id) => (CHECK_LAYER[id] ?? ['gateway', lineValue(String(id ?? 'step'), 40)])[0];
const stepOf = (id) => (CHECK_LAYER[id] ?? [null, lineValue(String(id ?? 'step'), 40)])[1];

// One exchange's decisions -> observability events. `trace` is the record gatewayTrace.js built (its decisions carry
// outcome pass/fail/skipped/info and basis checked/inferred/observed); `door` says whether a gateway sat in the path.
// `chain` carries what the session knows (the token's subject and scope claim); its keys ride every decision row's detail,
// so the core's chain builder can group the run. No secret is included.
function exchangeEvents(ex, chain = {}) {
  const out = [];
  const trace = ex?.trace;
  if (!trace || !Array.isArray(trace.decisions)) return out;
  const source = trace.source === 'real' ? 'real' : 'mock';
  for (const d of trace.decisions) {
    const [layer, step] = [layerOf(d.id), stepOf(d.id)];
    // The Direct door's one info line is gateway information: there is no Privilege decision to read.
    const outcome = d.outcome === 'pass' ? 'allowed' : d.outcome === 'fail' ? (d.id === 'filter' ? 'info' : 'refused') : 'info';
    // A refused grant check is a policy refusal; a refused access-token check is information (a credential state).
    const final = (outcome === 'refused' && d.id === 'authenticated') ? 'info' : outcome;
    out.push({
      layer, product: source === 'mock' ? `lab mock ${layer}` : `the lab's reading of the gateway (${layer})`,
      step, outcome: final, who: 'the caller',
      message: `${d.label}: ${d.evidence}`,
      detail: { door: ex.door, basis: d.basis, status: ex.status ?? null, requestId: `${ex.step}`, ...(source === 'real' ? { real: true } : {}), ...chain },
    });
  }
  return out;
}

// The newest action -> the events of one run (or an empty list: nothing ran yet). `chain` is what the session knows.
function actionEvents(latestAction, chain = {}) {
  const exchanges = Array.isArray(latestAction?.exchanges) ? latestAction.exchanges : [];
  return exchanges.flatMap((ex) => exchangeEvents(ex, chain));
}

// ---- Stdout lines ------------------------------------------------------------------------------------------------------------------------------------
function decisionLine(ev, runId) {
  return `${ev.at} ${SERVICE} decision step=${lineValue(ev.step)} layer=${lineValue(ev.layer, 12)} actor=${field(ev.who)} result=${RESULT[ev.outcome] ?? 'unclear'} run=${lineValue(runId)}`;
}

// ---- The run log: bounded, one list. Every run here is source 'mock' or 'real' by the action's exchanges. -------------------------------
async function createRunLog(...args) {
  await obsReady;
  mask = createMasker().mask;
  return createRunLogSync(...args);
}
function createRunLogSync({ write = (line) => process.stdout.write(`${line}\n`), clock = () => new Date().toISOString(), max = 12 } = {}) {
  let made = 0;
  const kept = [];
  const line = (ev, id) => { try { write(decisionLine(ev, id)); } catch (err) { reportFailure('line', err); } };
  function reportFailure(where, err) {
    process.stderr.write(`[${SERVICE}] run observability: ${lineValue(where, 40)} ${lineValue(err?.code || err?.name || 'error', 40)} (the error's text is not logged)\n`);
  }
  return {
    // One action = one run. `build` may throw: then nothing is stored and the answer is the baseline's.
    mock(build, { source = 'mock' } = {}) {
      try {
        const events = build();
        if (!events.length) return null;
        const at = typeof clock() === 'string' ? clock() : new Date(clock()).toISOString();
        const run = { id: `act-${String(++made).padStart(4, '0')}`, source, startedAt: at, endedAt: at, events: events.map((e, seq) => ({ ...e, at, seq })), notes: [], partial: false };
        kept.push(run);
        while (kept.length > max) kept.shift();
        for (const ev of run.events) line(ev, run.id);
        return run.id;
      } catch (err) { reportFailure('mock-run', err); return null; }
    },
    get(id) { return kept.find((r) => r.id === id) || null; },
    clear() { kept.length = 0; },
    size() { return kept.length; },
  };
}
const runField = (id) => (id ? { run: { id } } : { run: null, runNote: 'The lab could not keep a record of this run (the server log says why).' });

// ---- The record ----------------------------------------------------------------------------------------------------------------------------------------
const WHY = {
  person: 'This lab has no sign-in of its own in the gateway path: the caller is the lab\'s client session, not a person.',
  agent: 'The caller is the lab\'s own MCP client; no agent token or OBO exchange exists in the gateway path.',
  authorize: 'This action made no authenticated gateway call (a discovery, a registration or a probe of the Direct door): no access-token or grant check ran.',
  privilege: 'This action minted no token: the mock exchange was not part of it.',
  gateway: 'This action made no gateway call.',
  resource: 'The MCP server answered no request in this action (the gateway stopped the call first, or nothing was asked).',
};

async function recordOf(run, { clock = Date.now } = {}) {
  await obsReady;
  return obs.createRunObservability({ clock }).collectRun({
    runId: run.id, startedAt: run.startedAt, endedAt: run.endedAt, source: run.source,
    layers: LAYERS.map((layer) => {
      const own = run.events.filter((e) => e.layer === layer).map((e) => ({ at: e.at, product: e.product, outcome: e.outcome, message: e.message, detail: { ...e.detail, eventSeq: e.seq } }));
      return { layer, products: [], reason: WHY[layer], simulated: own };
    }),
  });
}

module.exports = { SERVICE, lineValue, field, decisionLine, createRunLog, runField, recordOf, actionEvents, exchangeEvents, layerOf, stepOf, WHY, obsReady };
