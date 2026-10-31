'use strict';
// mockGateway.js — an in-process stand-in for an OAuth-protected MCP gateway
// and its authorization server. Nothing here opens a socket. netguard.js
// hands requests for the two mock origins to handle(), which returns a Response.
//
// Everything it returns is simulated and labelled as such. Tokens are signed
// with a key generated at start-up and are not valid anywhere else.

const crypto = require('crypto');

const MOCK_GATEWAY_ORIGIN = 'https://mock-gateway.invalid';
const MOCK_IDP_ORIGIN = 'https://mock-idp.invalid';
const SIMULATED = 'Simulated by the in-process mock. Not a real gateway or sign-in.';

// Two doors: the Privilege-style door enforces a policy filter, the direct door does not.
const DOORS = {
  '/opensearch/mcp': { policy: true, resource: `${MOCK_GATEWAY_ORIGIN}/opensearch/mcp` },
  '/direct/opensearch/mcp': { policy: false, resource: `${MOCK_GATEWAY_ORIGIN}/direct/opensearch/mcp` },
};
const PRM_PATH = '/.well-known/oauth-protected-resource';

const TOOLS = [
  {
    name: 'search_documents',
    description: 'Full-text search over one index. Returns the top hits.',
    inputSchema: {
      type: 'object',
      properties: {
        index: { type: 'string', description: 'Index name, e.g. support-articles' },
        query: { type: 'string', description: 'Search text' },
        size: { type: 'integer', description: 'Maximum hits, 1 to 20' },
      },
      required: ['index', 'query'],
    },
  },
  {
    name: 'get_document',
    description: 'Fetch one document by id.',
    inputSchema: {
      type: 'object',
      properties: {
        index: { type: 'string', description: 'Index name' },
        id: { type: 'string', description: 'Document id, e.g. KB-101' },
      },
      required: ['index', 'id'],
    },
  },
  { name: 'list_indices', description: 'List indices and their document counts.', inputSchema: { type: 'object', properties: {} } },
  { name: 'cluster_health', description: 'Cluster status: green, yellow or red.', inputSchema: { type: 'object', properties: {} } },
];

const DENIED_TOOLS = [
  { name: 'delete_index', description: 'Delete an index and all its documents.', deniedReason: 'Policy: index deletion needs the opensearch.admin grant.' },
  { name: 'update_mapping', description: 'Change the field mapping of an index.', deniedReason: 'Policy: schema changes need the opensearch.admin grant.' },
];

const INDICES = {
  'support-articles': [
    { id: 'KB-101', title: 'Reset a password', body: 'Use the self-service reset link. The link expires after 15 minutes.' },
    { id: 'KB-204', title: 'Enable two-step sign-in', body: 'Add an authenticator app from the security page.' },
    { id: 'KB-310', title: 'Export your data', body: 'Exports are queued and delivered by email within an hour.' },
  ],
  'orders-2026': [
    { id: 'ORD-1001', title: 'Order 1001', body: 'Shipped. Carrier tracking is available on the order page.' },
    { id: 'ORD-1002', title: 'Order 1002', body: 'Awaiting payment confirmation.' },
  ],
};

// Mock signing key, generated per process. Not a real credential.
const SIGNING_KEY = crypto.randomBytes(32);
let idp = freshIdp();

function freshIdp() {
  return { clients: new Map(), codes: new Map(), refresh: new Map() };
}

function reset() {
  idp = freshIdp();
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
    iss: MOCK_IDP_ORIGIN, sub: 'mock-user', client_id: clientId, scope, aud: 'mock-gateway', iat: now, exp: now + ACCESS_TTL_S, mock: true,
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

function toolResult(name, args) {
  const q = String(args.query || '').toLowerCase();
  if (name === 'search_documents') {
    const docs = INDICES[args.index];
    if (!docs) return { error: `Index not found: ${args.index}` };
    const size = Math.min(Math.max(parseInt(args.size, 10) || 3, 1), 20);
    const hits = docs
      .filter((d) => !q || `${d.title} ${d.body}`.toLowerCase().includes(q))
      .slice(0, size)
      .map((d, i) => ({ _id: d.id, _score: Number((1 - i * 0.1).toFixed(2)), _source: { title: d.title, body: d.body } }));
    return { index: args.index, total: hits.length, hits, simulated: true };
  }
  if (name === 'get_document') {
    const doc = (INDICES[args.index] || []).find((d) => d.id === args.id);
    return doc ? { index: args.index, _id: doc.id, _source: { title: doc.title, body: doc.body }, simulated: true } : { error: `Document not found: ${args.id}` };
  }
  if (name === 'list_indices') {
    return { indices: Object.entries(INDICES).map(([index, docs]) => ({ index, docs: docs.length })), simulated: true };
  }
  if (name === 'cluster_health') {
    return { status: 'green', number_of_nodes: 1, simulated: true };
  }
  return null;
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function mcpHandle(url, doorPath, door, rpc) {
  const { id, method, params = {} } = rpc;
  if (method === 'server/discover') return rpcError(id, -32601, 'Method not found (mock server speaks the 2024-11-05 handshake only).');
  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: `mock-opensearch-gateway${door.policy ? '' : '-direct'}`, version: '1.0.0' },
      instructions: SIMULATED,
    });
  }
  if (method === 'tools/list') {
    const result = { tools: TOOLS };
    if (door.policy) result._meta = { deniedTools: DENIED_TOOLS };
    return rpcResult(id, result);
  }
  if (method === 'tools/call') {
    const name = params.name;
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
      if (door.policy && DENIED_TOOLS.some((t) => t.name === name)) return { status: 403, body: { error: `denied by gateway policy (mock): ${name}` } };
      return rpcError(id, -32602, `Unknown tool: ${name}`);
    }
    const missing = (tool.inputSchema.required || []).filter((k) => params.arguments?.[k] === undefined || params.arguments?.[k] === '');
    if (missing.length) return rpcError(id, -32602, `Missing required argument(s): ${missing.join(', ')}`);
    const output = toolResult(name, params.arguments || {});
    return rpcResult(id, {
      content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
      isError: Boolean(output && output.error),
    });
  }
  if (method === 'prompts/list') return rpcResult(id, { prompts: [] });
  if (method === 'resources/list') return rpcResult(id, { resources: [] });
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
  const out = mcpHandle(url, doorPath, door, rpc);
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
  TOOLS,
  DENIED_TOOLS,
};
