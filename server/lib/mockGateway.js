'use strict';
// mockGateway.js — an in-process stand-in for an OAuth-protected MCP gateway
// and its authorization server. Nothing here opens a socket. netguard.js
// hands requests for the two mock origins to handle(), which returns a Response.
//
// Everything it returns is simulated and labelled as such. Tokens are signed
// with a key generated at start-up and are not valid anywhere else.

const crypto = require('crypto');
const samples = require('./mockSamples');

const MOCK_GATEWAY_ORIGIN = 'https://mock-gateway.invalid';
const MOCK_IDP_ORIGIN = 'https://mock-idp.invalid';
const SIMULATED = 'Simulated by the in-process mock. Not a real gateway or sign-in.';

// Two doors: the Privilege-style door enforces a policy filter, the direct door does not.
const DOORS = {
  '/opensearch/mcp': { policy: true, resource: `${MOCK_GATEWAY_ORIGIN}/opensearch/mcp` },
  '/direct/opensearch/mcp': { policy: false, resource: `${MOCK_GATEWAY_ORIGIN}/direct/opensearch/mcp` },
};
const PRM_PATH = '/.well-known/oauth-protected-resource';

// The sample the mock serves: tools, resources, templates and prompts. Server-side state,
// like the mode. Reset (and a mode change) puts it back to the default.
let currentSample = samples.DEFAULT_SAMPLE;

function sampleId() {
  return currentSample;
}

/** Returns false for an unknown sample id. */
function setSample(id) {
  if (!samples.get(id)) return false;
  currentSample = id;
  return true;
}

const activeSample = () => samples.get(currentSample);


// Mock signing key, generated per process. Not a real credential.
const SIGNING_KEY = crypto.randomBytes(32);
let idp = freshIdp();

function freshIdp() {
  return { clients: new Map(), codes: new Map(), refresh: new Map() };
}

function reset() {
  idp = freshIdp();
  currentSample = samples.DEFAULT_SAMPLE;
}

const b64u = (input) => Buffer.from(input).toString('base64url');
const sha256b64u = (input) => crypto.createHash('sha256').update(input).digest('base64url');

function sign(payload) {
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', SIGNING_KEY).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

function verify(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const expected = crypto.createHmac('sha256', SIGNING_KEY).update(`${parts[0]}.${parts[1]}`).digest('base64url');
  const a = Buffer.from(expected);
  const b = Buffer.from(parts[2]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  if (payload.exp && payload.exp * 1000 < Date.now()) return null;
  return payload;
}

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json', ...headers },
});

function handles(url) {
  return url.origin === MOCK_GATEWAY_ORIGIN || url.origin === MOCK_IDP_ORIGIN;
}

// ---------------------------------------------------------------------------
// Authorization server (mock issuer)
// ---------------------------------------------------------------------------
const ACCESS_TTL_S = 900;

function issueTokens(clientId, scope) {
  const now = Math.floor(Date.now() / 1000);
  const access = sign({
    iss: MOCK_IDP_ORIGIN, sub: 'mock-user', client_id: clientId, scope, aud: 'mock-gateway', iat: now, exp: now + ACCESS_TTL_S, mock: true, grants: samples.MOCK_USER_GRANTS,
  });
  const refresh = crypto.randomBytes(24).toString('base64url');
  idp.refresh.set(refresh, { clientId, scope });
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_S,
    refresh_token: refresh,
    scope,
    'x-simulated': SIMULATED,
  };
}

async function idpHandle(url, req) {
  const p = url.pathname;
  if (req.method === 'GET' && p === '/.well-known/oauth-authorization-server') {
    return json({
      issuer: MOCK_IDP_ORIGIN,
      authorization_endpoint: `${MOCK_IDP_ORIGIN}/authorize`,
      token_endpoint: `${MOCK_IDP_ORIGIN}/token`,
      registration_endpoint: `${MOCK_IDP_ORIGIN}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
      scopes_supported: ['openid', 'profile', 'email', 'mcp:tools'],
      'x-simulated': SIMULATED,
    });
  }
  if (req.method === 'POST' && p === '/register') {
    let meta;
    try { meta = JSON.parse(await req.text()); } catch { return json({ error: 'invalid_client_metadata' }, 400); }
    const uris = Array.isArray(meta.redirect_uris) ? meta.redirect_uris.filter((u) => typeof u === 'string') : [];
    if (uris.length === 0) return json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris is required.' }, 400);
    const clientId = `mock-client-${crypto.randomBytes(6).toString('hex')}`;
    const method = meta.token_endpoint_auth_method === 'none' ? 'none' : 'client_secret_post';
    const secret = method === 'none' ? null : crypto.randomBytes(24).toString('base64url');
    idp.clients.set(clientId, { secret, redirectUris: uris });
    return json({
      client_id: clientId,
      client_secret: secret,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: uris,
      token_endpoint_auth_method: method,
      client_name: meta.client_name || 'client',
      'x-simulated': 'Mock client registration. Not a real client.',
    }, 201);
  }
  if (req.method === 'POST' && p === '/token') {
    const form = new URLSearchParams(await req.text());
    const clientId = form.get('client_id') || '';
    const client = idp.clients.get(clientId);
    if (!client) return json({ error: 'invalid_client', error_description: 'Unknown client (mock).' }, 401);
    if (client.secret && form.get('client_secret') !== client.secret) {
      return json({ error: 'invalid_client', error_description: 'Client authentication failed (mock).' }, 401);
    }
    const grant = form.get('grant_type');
    if (grant === 'authorization_code') {
      const code = idp.codes.get(form.get('code') || '');
      idp.codes.delete(form.get('code') || '');
      if (!code || code.clientId !== clientId) return json({ error: 'invalid_grant', error_description: 'Unknown or used code (mock).' }, 400);
      if (code.expiresAt < Date.now()) return json({ error: 'invalid_grant', error_description: 'Code expired (mock).' }, 400);
      if (form.get('redirect_uri') !== code.redirectUri) return json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch (mock).' }, 400);
      if (sha256b64u(form.get('code_verifier') || '') !== code.challenge) {
        return json({ error: 'invalid_grant', error_description: 'PKCE verifier does not match (mock).' }, 400);
      }
      return json(issueTokens(clientId, code.scope));
    }
    if (grant === 'refresh_token') {
      const stored = idp.refresh.get(form.get('refresh_token') || '');
      if (!stored || stored.clientId !== clientId) return json({ error: 'invalid_grant', error_description: 'Unknown refresh token (mock).' }, 400);
      idp.refresh.delete(form.get('refresh_token'));
      return json(issueTokens(clientId, stored.scope));
    }
    return json({ error: 'unsupported_grant_type' }, 400);
  }
  return json({ error: 'not_found', 'x-simulated': SIMULATED }, 404);
}

/**
 * Browser-facing authorize step, served by this app at /api/gateway/mock-idp/authorize.
 * Checks the request like a real AS would, then approves as the mock user without a password.
 */
function authorize(params) {
  const clientId = params.client_id || '';
  const client = idp.clients.get(clientId);
  if (!client) return { status: 400, error: 'invalid_client', description: 'Unknown client (mock). Register first.' };
  const redirectUri = params.redirect_uri || '';
  if (!client.redirectUris.includes(redirectUri)) return { status: 400, error: 'invalid_request', description: 'redirect_uri is not registered (mock).' };
  if (params.response_type !== 'code') return { status: 400, error: 'unsupported_response_type', description: 'Only code is supported (mock).' };
  if (params.code_challenge_method !== 'S256' || !params.code_challenge) {
    return { status: 400, error: 'invalid_request', description: 'PKCE with S256 is required (mock).' };
  }
  const code = crypto.randomBytes(18).toString('base64url');
  idp.codes.set(code, {
    clientId, redirectUri, challenge: params.code_challenge, scope: params.scope || 'openid', expiresAt: Date.now() + 60000,
  });
  const target = new URL(redirectUri);
  target.searchParams.set('code', code);
  if (params.state) target.searchParams.set('state', params.state);
  target.searchParams.set('iss', MOCK_IDP_ORIGIN);
  return { status: 302, location: target.toString() };
}

// ---------------------------------------------------------------------------
// MCP gateway (mock resource server)
// ---------------------------------------------------------------------------
function challenge(doorPath) {
  const resourceMeta = `${MOCK_GATEWAY_ORIGIN}${PRM_PATH}${doorPath}`;
  return { 'WWW-Authenticate': `Bearer resource_metadata="${resourceMeta}"` };
}

const searchResult = (args) => {
  const docs = samples.INDICES[args.index];
  if (!docs) return { error: `Index not found: ${args.index}` };
  const q = String(args.query || '').toLowerCase();
  const size = Math.min(Math.max(parseInt(args.size, 10) || 3, 1), 20);
  const hits = docs
    .filter((d) => !q || `${d.title} ${d.body}`.toLowerCase().includes(q))
    .slice(0, size)
    .map((d, i) => ({ _id: d.id, _score: Number((1 - i * 0.1).toFixed(2)), _source: { title: d.title, body: d.body } }));
  return { index: args.index, total: hits.length, hits, simulated: true };
};

const UNIT_FACTORS = { 'km>mi': 0.621371, 'mi>km': 1.609344, 'kg>lb': 2.204623, 'lb>kg': 0.453592, 'c>f': null, 'f>c': null };

// Tools with a hand-made result. Every other tool answers with a plain simulated echo.
const TOOL_RESULTS = {
  search_documents: searchResult,
  get_document: (args) => {
    const doc = (samples.INDICES[args.index] || []).find((d) => d.id === args.id);
    return doc ? { index: args.index, _id: doc.id, _source: { title: doc.title, body: doc.body }, simulated: true } : { error: `Document not found: ${args.id}` };
  },
  list_indices: () => ({ indices: Object.entries(samples.INDICES).map(([index, docs]) => ({ index, docs: docs.length })), simulated: true }),
  cluster_health: () => ({ status: 'green', number_of_nodes: 1, simulated: true }),
  get_time: (args) => ({ timezone: args.timezone || 'UTC', iso: '2026-10-31T12:00:00Z', simulated: true }),
  convert_units: (args) => {
    const key = `${String(args.from).toLowerCase()}>${String(args.to).toLowerCase()}`;
    if (key === 'c>f') return { value: Number((Number(args.value) * 9 / 5 + 32).toFixed(2)), unit: args.to, simulated: true };
    if (key === 'f>c') return { value: Number(((Number(args.value) - 32) * 5 / 9).toFixed(2)), unit: args.to, simulated: true };
    return UNIT_FACTORS[key] ? { value: Number((Number(args.value) * UNIT_FACTORS[key]).toFixed(3)), unit: args.to, simulated: true } : { error: `Cannot convert ${args.from} to ${args.to}` };
  },
  get_balance: (args) => ({ account: args.account, currency: 'EUR', balance: 1234.56, simulated: true }),
  list_accounts: () => ({ accounts: [{ id: 'ACC-100', type: 'current', currency: 'EUR' }, { id: 'ACC-200', type: 'savings', currency: 'EUR' }], simulated: true }),
  search_docs: (args) => ({ query: args.query, pages: ['getting-started', 'authentication'], simulated: true }),
  get_page: (args) => (args.slug === 'getting-started' ? { slug: args.slug, markdown: '# Getting started\n\nInstall, sign in, make a first request.', simulated: true } : { error: `Page not found: ${args.slug}` }),
  list_spaces: () => ({ spaces: ['public', 'internal-example'], simulated: true }),
};

function toolResult(tool, args) {
  const handler = TOOL_RESULTS[tool.name];
  if (handler) return handler(args);
  return {
    tool: tool.name,
    status: 'ok',
    arguments: args,
    effect: tool.annotations?.readOnlyHint ? 'none (read-only)' : 'simulated change, nothing was stored',
    simulated: true,
  };
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

const deniedEntry = (item, fields) => Object.fromEntries([...fields.map((f) => [f, item[f]]), ['deniedReason', item.deniedReason || 'Filtered by gateway policy.']]);

function denyResponse(what) {
  return { status: 403, body: { error: `denied by gateway policy (mock): ${what}` } };
}

/** A paged list result for one kind (tools, resources, ...). The policy door adds what it hid to _meta on the first page. */
function listResult(id, sample, door, grants, spec, params) {
  const all = samples.visible(spec.items, door, grants);
  const paged = samples.page(all, spec.kind, params.cursor, sample.pageSize);
  if (paged.error) return rpcError(id, -32602, paged.error);
  const result = { [spec.key]: paged.items.map(spec.shape) };
  if (paged.nextCursor) result.nextCursor = paged.nextCursor;
  const hiddenItems = samples.hidden(spec.items, door, grants);
  if (spec.meta && hiddenItems.length && !params.cursor) {
    result._meta = { [spec.meta]: hiddenItems.map((item) => deniedEntry(item, spec.deniedFields)) };
  }
  return rpcResult(id, result);
}

function mcpHandle(url, doorPath, door, rpc, claims = {}) {
  const { id, method, params = {} } = rpc;
  const sample = activeSample();
  const grants = Array.isArray(claims.grants) ? claims.grants : samples.MOCK_USER_GRANTS;
  if (method === 'server/discover') return rpcError(id, -32601, 'Method not found (mock server speaks the 2024-11-05 handshake only).');
  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: '2024-11-05',
      capabilities: sample.capabilities,
      serverInfo: { name: `mock-${sample.id}-gateway${door.policy ? '' : '-direct'}`, version: '1.0.0' },
      instructions: SIMULATED,
    });
  }
  if (method === 'tools/list') {
    return listResult(id, sample, door, grants, {
      kind: 'tools', key: 'tools', items: sample.tools, shape: samples.publicTool, meta: 'deniedTools', deniedFields: ['name', 'title', 'description'],
    }, params);
  }
  if (method === 'tools/call') {
    const name = params.name;
    const tool = sample.tools.find((t) => t.name === name);
    if (!tool) return rpcError(id, -32602, `Unknown tool: ${name}`);
    if (door.policy && samples.hidden([tool], door, grants).length) return denyResponse(name);
    const required = tool.inputSchema.required || [];
    const missing = required.filter((k) => params.arguments?.[k] === undefined || params.arguments?.[k] === '');
    if (missing.length) return rpcError(id, -32602, `Missing required argument(s): ${missing.join(', ')}`);
    const output = toolResult(tool, params.arguments || {});
    return rpcResult(id, {
      content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
      isError: Boolean(output && output.error),
    });
  }
  if (method.startsWith('resources/')) {
    if (!sample.capabilities.resources) return rpcError(id, -32601, `Method not found: ${method} (this server does not support resources).`);
    if (method === 'resources/list') {
      return listResult(id, sample, door, grants, {
        kind: 'resources', key: 'resources', items: sample.resources, shape: samples.publicResource, meta: 'deniedResources', deniedFields: ['uri', 'name', 'title', 'description'],
      }, params);
    }
    if (method === 'resources/templates/list') {
      return listResult(id, sample, door, grants, {
        kind: 'templates', key: 'resourceTemplates', items: sample.templates, shape: samples.publicTemplate,
      }, params);
    }
    if (method === 'resources/read') {
      const uri = params.uri;
      if (typeof uri !== 'string' || !uri) return rpcError(id, -32602, 'uri is required');
      const known = sample.resources.find((r) => r.uri === uri);
      if (known) {
        if (door.policy && samples.hidden([known], door, grants).length) return denyResponse(uri);
        return rpcResult(id, { contents: [{ uri, mimeType: known.mimeType, text: known.text }] });
      }
      for (const template of sample.templates) {
        const vars = samples.matchTemplate(template.uriTemplate, uri);
        const text = vars && template.render(vars);
        if (text) return rpcResult(id, { contents: [{ uri, mimeType: template.mimeType, text }] });
      }
      return rpcError(id, -32002, 'Resource not found', { uri });
    }
    return rpcError(id, -32601, `Method not found: ${method} (${doorPath}).`);
  }
  if (method.startsWith('prompts/')) {
    if (!sample.capabilities.prompts) return rpcError(id, -32601, `Method not found: ${method} (this server does not support prompts).`);
    if (method === 'prompts/list') {
      return listResult(id, sample, door, grants, {
        kind: 'prompts', key: 'prompts', items: sample.prompts, shape: samples.publicPrompt, meta: 'deniedPrompts', deniedFields: ['name', 'title', 'description'],
      }, params);
    }
    if (method === 'prompts/get') {
      const prompt = (sample.prompts || []).find((p) => p.name === params.name);
      if (!prompt) return rpcError(id, -32602, `Unknown prompt: ${params.name}`);
      if (door.policy && samples.hidden([prompt], door, grants).length) return denyResponse(prompt.name);
      const args = params.arguments || {};
      const missing = prompt.arguments.filter((a) => a.required && (args[a.name] === undefined || args[a.name] === '')).map((a) => a.name);
      if (missing.length) return rpcError(id, -32602, `Missing required argument(s): ${missing.join(', ')}`);
      return rpcResult(id, { description: prompt.description, messages: [{ role: 'user', content: { type: 'text', text: prompt.render(args) } }] });
    }
    return rpcError(id, -32601, `Method not found: ${method} (${doorPath}).`);
  }
  return rpcError(id, -32601, `Method not found: ${method} (${doorPath}).`);
}



async function mcpRoute(url, req, doorPath, door) {
  const auth = req.headers.get('authorization') || '';
  const token = auth.match(/^Bearer\s+(\S+)/i)?.[1];
  if (!token) return new Response(null, { status: 401, headers: challenge(doorPath) });
  const claims = verify(token);
  if (!claims || claims.iss !== MOCK_IDP_ORIGIN) {
    return new Response(JSON.stringify({ error: 'invalid_token', 'x-simulated': SIMULATED }), {
      status: 401,
      headers: { 'content-type': 'application/json', 'WWW-Authenticate': `Bearer error="invalid_token", resource_metadata="${MOCK_GATEWAY_ORIGIN}${PRM_PATH}${doorPath}"` },
    });
  }
  if (req.method === 'GET') {
    // No server-initiated stream in the mock: a 405 is what a gateway without one answers.
    return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  }
  if (req.method !== 'POST') return new Response(null, { status: 405 });
  let rpc;
  try { rpc = JSON.parse(await req.text()); } catch { return json(rpcError(null, -32700, 'Parse error'), 400); }
  if (rpc.id === undefined) return new Response(null, { status: 202 });
  const sessionHeader = { 'mcp-session-id': `mock-${crypto.createHash('sha1').update(token).digest('hex').slice(0, 16)}` };
  const out = mcpHandle(url, doorPath, door, rpc, claims);
  if (out.status === 403) return json(out.body, 403, sessionHeader);
  return json(out, 200, sessionHeader);
}

async function gatewayHandle(url, req) {
  if (url.pathname.startsWith(PRM_PATH)) {
    const doorPath = url.pathname.slice(PRM_PATH.length);
    const door = DOORS[doorPath];
    if (!door) return json({ error: 'not_found' }, 404);
    return json({
      resource: door.resource,
      authorization_servers: [MOCK_IDP_ORIGIN],
      scopes_supported: ['mcp:tools'],
      bearer_methods_supported: ['header'],
      'x-simulated': SIMULATED,
    });
  }
  const door = DOORS[url.pathname];
  if (!door) return json({ error: 'not_found', 'x-simulated': SIMULATED }, 404);
  return mcpRoute(url, req, url.pathname, door);
}

/** Serves one request for a mock origin. Returns a fetch-style Response. */
async function handle(url, init = {}) {
  const req = new Request(url, init);
  if (url.origin === MOCK_IDP_ORIGIN) return idpHandle(url, req);
  return gatewayHandle(url, req);
}

module.exports = {
  MOCK_GATEWAY_ORIGIN,
  MOCK_IDP_ORIGIN,
  DOORS,
  handles,
  handle,
  authorize,
  reset,
  verify,
  sampleId,
  setSample,
  mcpHandle,
};
