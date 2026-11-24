'use strict';
// gatewayTraceLog.js — "What Privilege did" for this lab (rule 25). relay.js fetchMcp is the one choke point for every MCP
// JSON-RPC call to a door; it hands each request/response pair here, and this file turns it into the record the shared
// GatewayTrace panel draws, using the vendored builder server/src/gatewayTrace.js (never edited; trace.js is the W3C helper).
//
// One user action (a tool call, a catalog load, a raw request, a door probe) makes several exchanges: the session handshake and then
// the call. Each route that makes gateway calls runs inside traced(), an AsyncLocalStorage scope, so every exchange of that action
// lands in the same group and parallel actions never mix. The newest groups are kept in memory only, and cleared by Reset and by a
// mode change. The routes still return the raw reply the Response tab shows; the trace is read from GET /trace.
//
// HONESTY RULE. Mock: the lab's own mockGateway computed the token and policy checks and wrote them to `checks`, so those
// decisions are `checked`. Real: a real gateway reports no per-check detail, so decisions are `inferred` (read from the status) or
// `observed` (read from the reply, such as _meta.denied*), never `checked`. The Direct door has no gateway in the path: its
// exchanges are shown for the contrast, with one `info` line saying there is no Privilege decision to read.
//
// NEVER in a trace: the access token (only its length), the refresh token, a client secret, the full MCP or procyon session id
// (shortened), or the Authorization header. Every string in a record is scrubbed of every secret the session holds.
const { AsyncLocalStorage } = require('node:async_hooks');
const { bearerForDisplay, failureTrace, mockTrace, realTrace } = require('../src/gatewayTrace.js');
const mockGateway = require('./mockGateway');
const runObs = require('./runObs');

// Rule 27: the observability run log (runObs.js). One action = one run, recorded when the action's FIRST exchange is
// pushed (the action is then complete enough: its later exchanges add rows to the same run while it is open).
// The log itself is created asynchronously (the ESM core loads first); pushes before it exists record nothing.
let runLogPromise = null;
let runLogSync = null;
// The chain facts of the action in flight (set by relay.js fetchMcp from the session): the token's subject and scope claim.
let currentChain = {};
const runLogOf = async () => {
  runLogPromise = runLogPromise || runObs.createRunLog();
  runLogSync = await runLogPromise;
  return runLogSync;
};

const als = new AsyncLocalStorage();
const MAX_ACTIONS = 5;
let actions = [];
let nextActionId = 1;

const NO_AUTH = '(none: the request carries no Authorization header)';
const shortId = (v) => (String(v).length > 8 ? `${String(v).slice(0, 8)}… (shortened)` : String(v));
// Response headers worth showing; everything else (cookies, set-cookie, internal ones) is left out.
const RESPONSE_HEADERS = ['content-type', 'www-authenticate', 'mcp-session-id', 'allow', 'retry-after', 'x-request-id', 'request-id', 'x-correlation-id'];
const DENIED_KEYS = ['deniedTools', 'deniedResources', 'deniedPrompts'];

/** Route wrapper: opens one action scope per request. Put it INSIDE express.json(): a body-parser callback drops the async context.
 *  When the handler finishes, the action's exchanges become one observability run (rule 27) and ctx.runId carries its id. */
function traced(label, handler) {
  return (req, res, next) => als.run({ label, action: null, steps: 0, runId: null }, () => {
    // The run id rides the answer: X-Obs-Run on every traced action's response, set when res.json first runs
    // (the run is recorded when the first exchange is pushed, which is always before res.json).
    if (typeof res.json === 'function' && typeof res.set === 'function') {
      const json = res.json.bind(res);
      res.json = (body) => {
        const id = currentRunId();
        if (id) res.set('X-Obs-Run', id);
        return json(body);
      };
    }
    return handler(req, res, next);
  });
}

/** Reserves the next step of the current action, or null when no action is open (nothing to record then). */
function begin() {
  const ctx = als.getStore();
  if (!ctx) return null;
  if (!ctx.action) {
    ctx.action = { id: nextActionId++, label: ctx.label, at: new Date().toISOString(), exchanges: [], __ctx: ctx };
    actions.unshift(ctx.action);
    actions = actions.slice(0, MAX_ACTIONS);
    runLogOf().catch(() => {}); // have the log ready by the time the first exchange is pushed
  }
  ctx.steps += 1;
  return { action: ctx.action, step: ctx.steps };
}

function scrubDeep(value, secrets) {
  const list = secrets.filter((s) => typeof s === 'string' && s.length >= 8);
  const walk = (v) => {
    if (typeof v === 'string') return list.reduce((t, s) => t.split(s).join('<kept on the server>'), v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value);
}

// The request headers the lab really sent, minus Authorization (shown by length), with session ids shortened.
function sentHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if (name.toLowerCase() === 'authorization') continue;
    out[name] = /session-id$/i.test(name) ? shortId(value) : String(value);
  }
  return out;
}

function shownResponseHeaders(response) {
  const out = {};
  for (const name of RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null && value !== undefined) out[name] = name === 'mcp-session-id' ? shortId(value) : value;
  }
  return out;
}

// What the gateway reported it hid from this caller, read from the reply itself (observed).
function deniedDecision(body) {
  const result = body && typeof body === 'object' ? body.result : null;
  const names = DENIED_KEYS.flatMap((k) => (Array.isArray(result?._meta?.[k]) ? result._meta[k].map((e) => e?.name || e?.uri || e?.uriTemplate).filter(Boolean) : []));
  if (!names.length) return null;
  return { id: 'filter', label: 'List filter', outcome: 'info', basis: 'observed', evidence: `the gateway's reply reports it hid ${names.length} from this caller (_meta.denied*): ${names.join(', ')}` };
}

const urlForDisplay = (u) => { const c = new URL(u); c.username = ''; c.password = ''; c.search = ''; c.hash = ''; return c.toString(); };
// Which door this call went to: the mock's own door table says so for a mock URL; a probe session carries the door of the URL it probes.
const doorOf = (sess, targetUrl) => (targetUrl.origin === mockGateway.MOCK_GATEWAY_ORIGIN
  ? (targetUrl.pathname.startsWith('/direct/') ? 'direct' : 'privilege')
  : (sess.traceDoor || sess.gatewayMode));
const titleOf = (door, rpc) => `${door === 'direct' ? 'Direct door (no gateway)' : 'Gateway'}: ${rpc?.method || 'request'}`;

function secretsOf(sess, extra) {
  return [sess.oauth?.accessToken, sess.oauth?.refreshToken, sess.oauth?.dcrClientSecret, sess.config?._procyonSessionId, sess.mcpSession?.sessionId, ...extra];
}

function requestPart(sess, targetUrl, headers) {
  const sentAuth = headers.Authorization;
  return {
    url: urlForDisplay(targetUrl),
    authorization: sentAuth ? bearerForDisplay('<access token>', () => sentAuth.replace(/^Bearer\s+/i, '')) : NO_AUTH,
    requestHeaders: sentHeaders(headers),
  };
}

/**
 * Records one finished exchange. `ticket` is what begin() returned; `checks` is the array the mock gateway filled (null for a real call).
 * Never throws: a trace problem must not break the relay.
 */
function record({ sess, ticket, targetUrl, headers, rpc, checks, response, text, parsed }) {
  if (!ticket) return;
  try {
    const door = doorOf(sess, targetUrl);
    const { url, authorization, requestHeaders } = requestPart(sess, targetUrl, headers);
    const status = response.status;
    const sse = /text\/event-stream/i.test(response.headers.get('content-type') || '');
    const empty = !text || !text.trim();
    // The reply as the gateway sent it: an event stream stays text, an empty body stays empty, JSON is shown parsed.
    const shown = empty ? null : sse ? text : parsed;
    let trace;
    if (checks) {
      const decisions = checks.map((c) => ({ ...c }));
      if (parsed?.error && typeof parsed.error === 'object' && status < 400) {
        decisions.push({ id: 'result', label: 'Request', outcome: 'fail', basis: 'observed', evidence: `the reply is a JSON-RPC error: ${String(parsed.error.message || parsed.error.code).slice(0, 200)}` });
      }
      trace = mockTrace({
        url, authorization, rpc, status, body: shown, headers: shownResponseHeaders(response), requestHeaders, decisions,
      });
    } else {
      trace = realTrace({
        url, authorization, rpc, status, headers: shownResponseHeaders(response), body: parsed, credential: 'workload-token', requestHeaders, at: new Date().toISOString(),
      });
      trace.response.body = shown;
      if (door === 'direct') {
        trace.decisions = [{ id: 'direct', label: 'No gateway in this path', outcome: 'info', basis: 'observed', evidence: `the Direct door goes straight to the MCP server, so there is no Privilege decision to show; HTTP ${status} is the server's own answer` }];
        trace.record = null;
      } else {
        const filter = deniedDecision(parsed);
        if (filter) trace.decisions.push(filter);
      }
    }
    push(ticket, door, rpc, status, scrubDeep(trace, secretsOf(sess, [response.headers.get('mcp-session-id')])));
  } catch { /* the trace is a view: it never breaks a call */ }
}

/** A call that never got an answer (blocked, refused, timed out). Only a real call is shown: a mock call always answers. */
function recordFailure({ sess, ticket, targetUrl, headers, rpc, checks, error }) {
  if (!ticket || checks) return;
  try {
    const door = doorOf(sess, targetUrl);
    const { url, authorization, requestHeaders } = requestPart(sess, targetUrl, headers);
    const trace = failureTrace({ url, authorization, rpc, requestHeaders, error: `no answer: ${error}` });
    push(ticket, door, rpc, null, scrubDeep(trace, secretsOf(sess, [])));
  } catch { /* see record() */ }
}

function push(ticket, door, rpc, status, trace) {
  ticket.action.exchanges.push({ step: ticket.step, title: titleOf(door, rpc), status, door, trace });
  // Rule 27: record the observability run as soon as this action's exchanges are complete enough — synchronously, so the
  // run id is available to the route before the answer goes out (recordAction stores it on the action's scope).
  recordAction(ticket.action && ticket.action.__ctx, currentChain);
}
// recordAction above needs the ctx, not just the action: begin() stores it. Kept idempotent (ctx.runId set once).
function recordAction(ctx, chain = {}) {
  try {
    if (!ctx || !ctx.action || !ctx.action.exchanges.length || ctx.runId) return;
    const runLog = runLogSync;
    if (!runLog) return;
    const action = ctx.action;
    const source = action.exchanges.some((e) => e.trace && e.trace.source === 'real') ? 'real' : 'mock';
    const id = runLog.mock(() => runObs.actionEvents(action, chain), { source });
    if (id) ctx.runId = id;
  } catch { /* the record is a view: it never breaks a call */ }
}
/** relay.js sets the chain facts (the token's subject and scope claim) before the exchanges are recorded. */
function setChain(chain) { currentChain = chain && typeof chain === 'object' ? chain : {}; }

/** The newest action's exchanges in step order (parallel calls finish out of order), or an empty list. */
function latest() {
  const action = actions[0];
  if (!action) return { action: null, exchanges: [] };
  const runId = action.__ctx?.runId ?? null;
  return { ...(runId ? { obsRun: runId } : {}), action: { id: action.id, label: action.label, at: action.at, ...(runId ? { runId } : {}) }, exchanges: [...action.exchanges].sort((a, b) => a.step - b.step) };
}

function clear() {
  actions = [];
  if (runLogPromise) runLogOf().then((rl) => rl.clear()).catch(() => {});
}

/** The observability run id the CURRENT action was recorded under (null before the handler finished, or when nothing ran). */
function currentRunId() {
  const ctx = als.getStore();
  return (ctx && ctx.runId) || null;
}

module.exports = { traced, begin, record, recordFailure, latest, clear, currentRunId, runLogOf, setChain };
