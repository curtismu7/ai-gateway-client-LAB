'use strict';
// netguard.js — the only door every outbound request in this app goes through.
//
// Mock mode (default): a request is served in-process by mockGateway when it
// targets one of the two mock origins, and refused otherwise. The real network
// is never touched, so zero outbound attempts happen.
//
// Live mode (owner-run, runtime switch needs a confirm): only https origins
// (loopback http for local gateways), only origins the user typed or the
// gateway's own metadata advertised, no link-local or metadata literals,
// redirects only within the same origin, a time cap, and a size cap.

const mode = require('./mode');
const mockGateway = require('./mockGateway');

const LIVE_TIMEOUT_MS = 20000;
const LIVE_MAX_BYTES = 2 * 1024 * 1024;
const LIVE_MAX_REDIRECTS = 3;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const UNSAFE_HOSTS = new Set(['0.0.0.0', '[::]', 'metadata.google.internal', '100.100.100.200']);
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

const stats = { attempts: 0, blocked: 0, mockServed: 0, outbound: 0 };
const liveOrigins = new Set();

class NetguardError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NetguardError';
    this.code = code;
  }
}

function parse(input) {
  try { return new URL(String(input)); } catch { return null; }
}

function isUnsafeLiteral(hostname) {
  return UNSAFE_HOSTS.has(hostname) || /^169\.254\./.test(hostname) || /^\[fe80:/i.test(hostname);
}

/**
 * Pure policy decision. Returns { allow, route, code, reason }.
 * Options exist so the self-test can ask about other modes without changing them.
 */
function decide(input, opts = {}) {
  const m = opts.mode || mode.currentMode();
  const confirmed = opts.confirmed ?? mode.isLiveConfirmed();
  const origins = opts.origins || liveOrigins;
  const url = parse(input);
  if (!url) return { allow: false, code: 'bad_url', reason: 'Not a valid URL.' };

  if (m === 'mock') {
    if (mockGateway.handles(url)) return { allow: true, route: 'mock' };
    return {
      allow: false,
      code: 'blocked_mock',
      reason: `Mock mode: ${url.origin} is not a mock endpoint. Switch to Live to contact a real gateway.`,
    };
  }
  if (!confirmed) {
    return { allow: false, code: 'confirm_required', reason: 'Live mode has not been confirmed.' };
  }
  const loopbackHttp = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !loopbackHttp) {
    return { allow: false, code: 'blocked_scheme', reason: 'Live mode allows https, or http to loopback only.' };
  }
  if (isUnsafeLiteral(url.hostname)) {
    return { allow: false, code: 'blocked_ssrf', reason: 'Link-local, metadata and unspecified addresses are refused.' };
  }
  if (!origins.has(url.origin)) {
    return { allow: false, code: 'blocked_origin', reason: `${url.origin} is not the gateway you entered or one it advertised.` };
  }
  return { allow: true, route: 'live' };
}

/** Records an origin the user typed (or a gateway advertised) as allowed in live mode. */
function allowOrigin(input) {
  const url = parse(input);
  if (!url) return false;
  if (url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))) {
    liveOrigins.add(url.origin);
    return true;
  }
  return false;
}

function forgetLiveOrigins() {
  liveOrigins.clear();
}

async function liveFetch(url, init, hop) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIVE_TIMEOUT_MS);
  if (init.signal) {
    if (init.signal.aborted) controller.abort();
    else init.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  stats.outbound += 1;
  let response;
  try {
    response = await globalThis.fetch(url, { ...init, redirect: 'manual', signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
  if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
    clearTimeout(timer);
    const next = new URL(response.headers.get('location'), url);
    if (next.origin !== url.origin || hop >= LIVE_MAX_REDIRECTS) {
      throw new NetguardError('redirect_blocked', `Redirect to ${next.origin} refused (cross-origin or too many hops).`);
    }
    return liveFetch(next, init, hop + 1);
  }
  const type = response.headers.get('content-type') || '';
  if (type.includes('text/event-stream')) {
    clearTimeout(timer);
    return response;
  }
  let buffer;
  try {
    buffer = Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
  if (buffer.length > LIVE_MAX_BYTES) {
    throw new NetguardError('too_large', `Response larger than ${LIVE_MAX_BYTES} bytes refused.`);
  }
  return new Response(NULL_BODY_STATUS.has(response.status) ? null : buffer, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** Drop-in for fetch(). Every outbound call in this app must use it. */
async function guardedFetch(input, init = {}) {
  stats.attempts += 1;
  const verdict = decide(input);
  if (!verdict.allow) {
    stats.blocked += 1;
    throw new NetguardError(verdict.code, verdict.reason);
  }
  if (verdict.route === 'mock') {
    stats.mockServed += 1;
    return mockGateway.handle(new URL(String(input)), init);
  }
  return liveFetch(new URL(String(input)), init, 0);
}

/** Self-test: exercises the policy with synthetic inputs. Makes no network call. */
function selfTest() {
  const cases = [
    { name: 'mock refuses a real-looking https origin', input: 'https://gateway.example.invalid/x', opts: { mode: 'mock' }, expect: 'blocked_mock' },
    { name: 'mock serves the mock gateway', input: 'https://mock-gateway.invalid/opensearch/mcp', opts: { mode: 'mock' }, expect: 'allow' },
    { name: 'mock serves the mock issuer', input: 'https://mock-idp.invalid/token', opts: { mode: 'mock' }, expect: 'allow' },
    { name: 'live refuses until confirmed', input: 'https://gw.example.invalid/x', opts: { mode: 'live', confirmed: false, origins: new Set(['https://gw.example.invalid']) }, expect: 'confirm_required' },
    { name: 'live refuses plain http to a remote host', input: 'http://gw.example.invalid/x', opts: { mode: 'live', confirmed: true, origins: new Set(['http://gw.example.invalid']) }, expect: 'blocked_scheme' },
    { name: 'live refuses the metadata address', input: 'https://169.254.169.254/latest', opts: { mode: 'live', confirmed: true, origins: new Set(['https://169.254.169.254']) }, expect: 'blocked_ssrf' },
    { name: 'live refuses an origin the user did not type', input: 'https://other.example.invalid/x', opts: { mode: 'live', confirmed: true, origins: new Set(['https://gw.example.invalid']) }, expect: 'blocked_origin' },
    { name: 'live allows the typed origin', input: 'https://gw.example.invalid/mcp', opts: { mode: 'live', confirmed: true, origins: new Set(['https://gw.example.invalid']) }, expect: 'allow' },
    { name: 'live allows loopback http for a typed local gateway', input: 'http://127.0.0.1:9/mcp', opts: { mode: 'live', confirmed: true, origins: new Set(['http://127.0.0.1:9']) }, expect: 'allow' },
  ];
  const checks = cases.map((c) => {
    const v = decide(c.input, c.opts);
    const got = v.allow ? 'allow' : v.code;
    return { name: c.name, ok: got === c.expect, got };
  });
  return { ok: checks.every((c) => c.ok), checks, stats: { ...stats } };
}

function statsSnapshot() {
  return { ...stats };
}

module.exports = { guardedFetch, decide, allowOrigin, forgetLiveOrigins, selfTest, statsSnapshot, NetguardError, stats, liveOrigins };
