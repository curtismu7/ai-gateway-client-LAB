'use strict';
// Mock samples: counts, paging, policy filtering per door, resources/read, templates, prompts,
// and the sample API. Everything runs in mock mode (in-process, zero outbound).
process.env.MODE = 'mock';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DOOR_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-gateway-client-samples-'));
process.env.GATEWAY_ENV_PATH = path.join(process.env.DOOR_STORE_DIR, 'gateway.env');

const express = require('express');
const relay = require('./lib/relay');
const mock = require('./lib/mockGateway');
const samples = require('./lib/mockSamples');

const PRIVILEGE = 'https://mock-gateway.invalid/opensearch/mcp';
const DIRECT = 'https://mock-gateway.invalid/direct/opensearch/mcp';

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

let nextId = 1;
async function rpc(token, door, method, params = {}) {
  const res = await mock.handle(new URL(door), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  });
  const body = await res.json();
  return { status: res.status, ...body };
}

/** All pages of a list. Returns { items, pages, meta } where meta is the first page's _meta. */
async function listAll(token, door, method, key) {
  const items = [];
  let cursor;
  let pages = 0;
  let meta;
  do {
    const out = await rpc(token, door, method, cursor ? { cursor } : {});
    assert.ok(out.result, `${method} failed: ${JSON.stringify(out)}`);
    if (pages === 0) meta = out.result._meta;
    items.push(...out.result[key]);
    cursor = out.result.nextCursor;
    pages += 1;
    assert.ok(pages < 20, 'paging must end');
  } while (cursor);
  return { items, pages, meta };
}

async function withSample(id, fn) {
  mock.reset();
  assert.equal(mock.setSample(id), true);
  const token = await mockToken();
  await fn(token);
}

// Expected shape of every sample: tools, resources, templates, prompts per door, and what policy hides.
const EXPECTED = {
  minimal: { privilege: [2, 1, 0, 0], direct: [2, 1, 0, 0], hiddenTools: 0, prompts: false },
  standard: { privilege: [4, 4, 1, 2], direct: [6, 4, 1, 2], hiddenTools: 2, prompts: true },
  large: { privilege: [40, 12, 1, 1], direct: [40, 12, 1, 1], hiddenTools: 0, prompts: true },
  empty: { privilege: [0, 0, 0, 0], direct: [0, 0, 0, 0], hiddenTools: 0, prompts: true },
  'policy-heavy': { privilege: [5, 3, 1, 1], direct: [14, 8, 1, 3], hiddenTools: 9, prompts: true },
  docs: { privilege: [3, 20, 1, 0], direct: [3, 20, 1, 0], hiddenTools: 0, prompts: false },
};

test('the six samples exist and the default is standard', () => {
  assert.deepEqual(samples.ids().sort(), Object.keys(EXPECTED).sort());
  assert.equal(samples.DEFAULT_SAMPLE, 'standard');
  mock.reset();
  assert.equal(mock.sampleId(), 'standard');
});

for (const [id, want] of Object.entries(EXPECTED)) {
  test(`${id}: counts per door, hidden by policy, and capabilities`, async () => {
    await withSample(id, async (token) => {
      for (const [doorName, url] of [['privilege', PRIVILEGE], ['direct', DIRECT]]) {
        const [tools, resources, templates, prompts] = want[doorName];
        const t = await listAll(token, url, 'tools/list', 'tools');
        assert.equal(t.items.length, tools, `${id} ${doorName} tools`);
        const init = await rpc(token, url, 'initialize', {});
        if (resources > 0 || id === 'empty' || id === 'minimal' || id === 'docs') {
          assert.ok(init.result.capabilities.resources, `${id} declares resources`);
        }
        const r = await listAll(token, url, 'resources/list', 'resources');
        assert.equal(r.items.length, resources, `${id} ${doorName} resources`);
        const tpl = await listAll(token, url, 'resources/templates/list', 'resourceTemplates');
        assert.equal(tpl.items.length, templates, `${id} ${doorName} templates`);
        if (want.prompts) {
          const p = await listAll(token, url, 'prompts/list', 'prompts');
          assert.equal(p.items.length, prompts, `${id} ${doorName} prompts`);
        } else {
          const p = await rpc(token, url, 'prompts/list');
          assert.equal(p.error.code, -32601, `${id} has no prompts capability`);
          assert.equal(init.result.capabilities.prompts, undefined);
        }
        if (doorName === 'privilege') {
          const hiddenNames = (t.meta?.deniedTools || []).map((x) => x.name);
          assert.equal(hiddenNames.length, want.hiddenTools);
        } else {
          assert.equal(t.meta, undefined, 'the direct door reports nothing hidden');
        }
      }
    });
  });
}

test('the counts the sample picker shows match what the doors serve', () => {
  for (const [id, want] of Object.entries(EXPECTED)) {
    const counts = samples.describe(samples.get(id)).counts;
    assert.deepEqual([counts.privilege.tools, counts.privilege.resources, counts.privilege.templates, counts.privilege.prompts], want.privilege, `${id} privilege`);
    assert.deepEqual([counts.direct.tools, counts.direct.resources, counts.direct.templates, counts.direct.prompts], want.direct, `${id} direct`);
    assert.equal(counts.privilege.hiddenTools, want.hiddenTools, `${id} hidden tools`);
  }
});

test('large: tools come in pages of 10 with nextCursor, the last page has none', async () => {
  await withSample('large', async (token) => {
    const first = await rpc(token, PRIVILEGE, 'tools/list');
    assert.equal(first.result.tools.length, 10);
    assert.ok(first.result.nextCursor);
    let cursor = first.result.nextCursor;
    const sizes = [10];
    const cursors = [cursor];
    for (;;) {
      const next = await rpc(token, PRIVILEGE, 'tools/list', { cursor });
      sizes.push(next.result.tools.length);
      if (!next.result.nextCursor) break;
      cursor = next.result.nextCursor;
      cursors.push(cursor);
    }
    assert.deepEqual(sizes, [10, 10, 10, 10]);
    assert.equal(cursors.length, 3);
    assert.equal(new Set(cursors).size, 3, 'cursors are distinct');
    const all = await listAll(token, PRIVILEGE, 'tools/list', 'tools');
    assert.equal(all.pages, 4);
    assert.equal(new Set(all.items.map((t) => t.name)).size, 40, 'no tool repeats across pages');
    const resources = await listAll(token, PRIVILEGE, 'resources/list', 'resources');
    assert.equal(resources.pages, 2);
  });
});

test('paging refuses a bad cursor, and a cursor from another list', async () => {
  await withSample('large', async (token) => {
    const bad = await rpc(token, PRIVILEGE, 'tools/list', { cursor: 'not-a-cursor' });
    assert.equal(bad.error.code, -32602);
    const tools = await rpc(token, PRIVILEGE, 'tools/list');
    const wrongKind = await rpc(token, PRIVILEGE, 'resources/list', { cursor: tools.result.nextCursor });
    assert.equal(wrongKind.error.code, -32602);
  });
});

test('small samples are not paged', async () => {
  await withSample('docs', async (token) => {
    const out = await rpc(token, PRIVILEGE, 'resources/list');
    assert.equal(out.result.resources.length, 20);
    assert.equal(out.result.nextCursor, undefined);
  });
});

test('tool, resource and prompt entries carry the fields the UI shows', async () => {
  for (const id of samples.ids()) {
    await withSample(id, async (token) => {
      const tools = (await listAll(token, DIRECT, 'tools/list', 'tools')).items;
      for (const tool of tools) {
        assert.ok(tool.name && tool.title && tool.description, `${id}/${tool.name} has name, title, description`);
        assert.ok(tool.description.length <= 300, `${id}/${tool.name} description is short`);
        assert.equal(tool.inputSchema.type, 'object');
        for (const [key, schema] of Object.entries(tool.inputSchema.properties)) {
          assert.ok(schema.type && schema.description, `${id}/${tool.name}.${key} is typed and described`);
        }
        for (const required of tool.inputSchema.required || []) assert.ok(tool.inputSchema.properties[required]);
        assert.equal(tool.requires, undefined, 'internal policy fields never leave the server');
      }
      if (tools.length > 2) {
        assert.ok(tools.some((t) => t.annotations?.readOnlyHint === true), `${id} has read-only tools`);
      }
      const resources = (await listAll(token, DIRECT, 'resources/list', 'resources')).items;
      for (const r of resources) {
        assert.ok(r.uri && r.name && r.title && r.description && r.mimeType, `${id}/${r.uri} is complete`);
        assert.equal(typeof r.size, 'number');
        assert.equal(r.text, undefined, 'a listing never includes content');
      }
    });
  }
  await withSample('standard', async (token) => {
    const tools = (await listAll(token, DIRECT, 'tools/list', 'tools')).items;
    assert.ok(tools.find((t) => t.name === 'delete_index').annotations.destructiveHint);
    assert.ok(tools.find((t) => t.name === 'get_document').annotations.idempotentHint);
  });
});

test('policy-heavy: the Privilege door hides 9 tools, the Direct door lists all 14', async () => {
  await withSample('policy-heavy', async (token) => {
    const privilege = await listAll(token, PRIVILEGE, 'tools/list', 'tools');
    const direct = await listAll(token, DIRECT, 'tools/list', 'tools');
    assert.equal(privilege.items.length, 5);
    assert.equal(direct.items.length, 14);
    const hidden = privilege.meta.deniedTools;
    assert.equal(hidden.length, 9);
    for (const entry of hidden) {
      assert.ok(entry.name && entry.description && entry.deniedReason.startsWith('Policy:'));
      assert.ok(direct.items.some((t) => t.name === entry.name), 'every hidden tool exists on the Direct door');
      assert.ok(!privilege.items.some((t) => t.name === entry.name), 'and is absent from the Privilege door');
    }
    assert.deepEqual(
      new Set([...privilege.items.map((t) => t.name), ...hidden.map((t) => t.name)]),
      new Set(direct.items.map((t) => t.name)),
    );
    // Resources and prompts are filtered the same way.
    const resources = await listAll(token, PRIVILEGE, 'resources/list', 'resources');
    assert.equal(resources.items.length, 3);
    assert.equal(resources.meta.deniedResources.length, 5);
    const prompts = await listAll(token, PRIVILEGE, 'prompts/list', 'prompts');
    assert.equal(prompts.items.length, 1);
    assert.equal(prompts.meta.deniedPrompts.length, 2);
  });
});

test('policy: a hidden tool, resource or prompt is refused with 403 on the Privilege door and works on Direct', async () => {
  await withSample('policy-heavy', async (token) => {
    const deniedTool = await rpc(token, PRIVILEGE, 'tools/call', { name: 'create_transfer', arguments: { from: 'ACC-100', to: 'ACC-200', amount: 5 } });
    assert.equal(deniedTool.status, 403);
    const okTool = await rpc(token, DIRECT, 'tools/call', { name: 'create_transfer', arguments: { from: 'ACC-100', to: 'ACC-200', amount: 5 } });
    assert.equal(okTool.result.isError, false);
    assert.match(okTool.result.content[0].text, /simulated/);

    const deniedRes = await rpc(token, PRIVILEGE, 'resources/read', { uri: 'ledger://audit/recent' });
    assert.equal(deniedRes.status, 403);
    const okRes = await rpc(token, DIRECT, 'resources/read', { uri: 'ledger://audit/recent' });
    assert.match(okRes.result.contents[0].text, /svc-reports/);

    const deniedPrompt = await rpc(token, PRIVILEGE, 'prompts/get', { name: 'month_end_review', arguments: { account: 'ACC-100' } });
    assert.equal(deniedPrompt.status, 403);
    const okPrompt = await rpc(token, DIRECT, 'prompts/get', { name: 'month_end_review', arguments: { account: 'ACC-100' } });
    assert.match(okPrompt.result.messages[0].content.text, /ACC-100/);
  });
});

test('policy follows the signed-in user grants carried in the token', async () => {
  await withSample('policy-heavy', async () => {
    const claimsOf = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    const token = await mockToken();
    assert.deepEqual(claimsOf(token).grants, samples.MOCK_USER_GRANTS);
    // A user who also holds ledger.write sees those tools on the Privilege door; admin-only ones stay hidden.
    const door = { policy: true };
    const grants = [...samples.MOCK_USER_GRANTS, 'ledger.write'];
    const sample = samples.get('policy-heavy');
    assert.equal(samples.visible(sample.tools, door, grants).length, 8);
    const out = mock.mcpHandle(new URL(PRIVILEGE), '/opensearch/mcp', { policy: true }, { id: 1, method: 'tools/list', params: {} }, { grants });
    assert.equal(out.result.tools.length, 8);
    assert.equal(out.result._meta.deniedTools.length, 6);
  });
});

test('every resource in every sample can be read, with content that matches its mimeType', async () => {
  for (const id of samples.ids()) {
    await withSample(id, async (token) => {
      const resources = (await listAll(token, DIRECT, 'resources/list', 'resources')).items;
      for (const r of resources) {
        const out = await rpc(token, DIRECT, 'resources/read', { uri: r.uri });
        assert.ok(out.result, `${id} ${r.uri}: ${JSON.stringify(out)}`);
        const content = out.result.contents[0];
        assert.equal(content.uri, r.uri);
        assert.equal(content.mimeType, r.mimeType);
        assert.ok(content.text.length > 0);
        assert.equal(r.size, Buffer.byteLength(content.text, 'utf8'), 'size is the byte length of the content');
        if (r.mimeType === 'application/json') JSON.parse(content.text);
      }
      // Reads are deterministic.
      if (resources[0]) {
        const a = await rpc(token, DIRECT, 'resources/read', { uri: resources[0].uri });
        const b = await rpc(token, DIRECT, 'resources/read', { uri: resources[0].uri });
        assert.deepEqual(a.result, b.result);
      }
    });
  }
});

test('docs: 20 resources of three mime types and a template', async () => {
  await withSample('docs', async (token) => {
    const resources = (await listAll(token, PRIVILEGE, 'resources/list', 'resources')).items;
    assert.equal(resources.length, 20);
    assert.deepEqual([...new Set(resources.map((r) => r.mimeType))].sort(), ['application/json', 'text/markdown', 'text/plain']);
    const templates = (await listAll(token, PRIVILEGE, 'resources/templates/list', 'resourceTemplates')).items;
    assert.equal(templates[0].uriTemplate, 'docs://pages/{slug}');
  });
});

test('resources/read: unknown uri is an error, bad input is refused', async () => {
  await withSample('standard', async (token) => {
    const missing = await rpc(token, DIRECT, 'resources/read', { uri: 'opensearch://indices/nope' });
    assert.equal(missing.error.code, -32002);
    assert.equal(missing.error.data.uri, 'opensearch://indices/nope');
    const noUri = await rpc(token, DIRECT, 'resources/read', {});
    assert.equal(noUri.error.code, -32602);
    // A template matches by shape, but an id that does not exist is still not found.
    const noDoc = await rpc(token, DIRECT, 'resources/read', { uri: 'opensearch://indices/support-articles/documents/KB-999' });
    assert.equal(noDoc.error.code, -32002);
    // Object property names and broken percent escapes are just not found, never a raw error.
    for (const uri of ['opensearch://indices/__proto__/documents/x', 'opensearch://indices/constructor/documents/x', 'opensearch://indices/%E0%A4%A/documents/x']) {
      const out = await rpc(token, DIRECT, 'resources/read', { uri });
      assert.equal(out.error.code, -32002, uri);
      assert.equal(/TypeError|URI malformed|is not a function/.test(JSON.stringify(out)), false, uri);
    }
  });
});

test('templates: listed with uriTemplate and description, and readable through a matching uri', async () => {
  await withSample('standard', async (token) => {
    const list = await rpc(token, PRIVILEGE, 'resources/templates/list');
    const [template] = list.result.resourceTemplates;
    assert.equal(template.uriTemplate, 'opensearch://indices/{index}/documents/{id}');
    assert.ok(template.description && template.name && template.mimeType);
    const read = await rpc(token, PRIVILEGE, 'resources/read', { uri: 'opensearch://indices/support-articles/documents/KB-101' });
    assert.match(read.result.contents[0].text, /Reset a password/);
    assert.equal(read.result.contents[0].mimeType, 'application/json');
  });
  await withSample('docs', async (token) => {
    const read = await rpc(token, PRIVILEGE, 'resources/read', { uri: 'docs://pages/faq' });
    assert.match(read.result.contents[0].text, /^# FAQ/);
  });
  assert.deepEqual(samples.matchTemplate('a://{x}/b/{y}', 'a://one/b/two'), { x: 'one', y: 'two' });
  assert.equal(samples.matchTemplate('a://{x}', 'a://one/two'), null);
});

test('prompts: list with arguments, get with substitution, errors for a missing argument and an unknown prompt', async () => {
  await withSample('standard', async (token) => {
    const list = await rpc(token, PRIVILEGE, 'prompts/list');
    assert.equal(list.result.prompts.length, 2);
    const summarize = list.result.prompts.find((p) => p.name === 'summarize_article');
    assert.ok(summarize.description);
    assert.deepEqual(summarize.arguments.map((a) => [a.name, a.required]), [['id', true], ['audience', false]]);
    const got = await rpc(token, PRIVILEGE, 'prompts/get', { name: 'summarize_article', arguments: { id: 'KB-101', audience: 'new starters' } });
    assert.equal(got.result.messages[0].role, 'user');
    assert.equal(got.result.messages[0].content.type, 'text');
    assert.match(got.result.messages[0].content.text, /KB-101.*new starters/);
    const missing = await rpc(token, PRIVILEGE, 'prompts/get', { name: 'summarize_article', arguments: {} });
    assert.equal(missing.error.code, -32602);
    assert.match(missing.error.message, /id/);
    const unknown = await rpc(token, PRIVILEGE, 'prompts/get', { name: 'nope' });
    assert.equal(unknown.error.code, -32602);
  });
});

test('a server without a capability answers method not found', async () => {
  await withSample('minimal', async (token) => {
    for (const method of ['prompts/list', 'prompts/get']) {
      const out = await rpc(token, PRIVILEGE, method, { name: 'x' });
      assert.equal(out.error.code, -32601);
    }
  });
});

test('tools/call: required arguments are enforced for every tool in every sample, and unknown tools are refused', async () => {
  for (const id of samples.ids()) {
    await withSample(id, async (token) => {
      const tools = (await listAll(token, DIRECT, 'tools/list', 'tools')).items;
      for (const tool of tools.filter((t) => (t.inputSchema.required || []).length)) {
        const out = await rpc(token, DIRECT, 'tools/call', { name: tool.name, arguments: {} });
        assert.equal(out.error.code, -32602, `${id}/${tool.name}`);
      }
      const unknown = await rpc(token, DIRECT, 'tools/call', { name: 'no_such_tool', arguments: {} });
      assert.equal(unknown.error.code, -32602);
    });
  }
});

test('tools/call returns a result for every tool when given its required arguments', async () => {
  await withSample('large', async (token) => {
    const tools = (await listAll(token, DIRECT, 'tools/list', 'tools')).items;
    for (const tool of tools) {
      const args = Object.fromEntries((tool.inputSchema.required || []).map((k) => {
        const type = tool.inputSchema.properties[k].type;
        return [k, type === 'integer' || type === 'number' ? 3 : type === 'object' ? {} : type === 'array' ? [] : tool.inputSchema.properties[k].enum?.[0] || 'x'];
      }));
      const out = await rpc(token, DIRECT, 'tools/call', { name: tool.name, arguments: args });
      assert.ok(out.result?.content?.[0]?.text, `${tool.name} answered`);
    }
  });
});

test('the original standard behaviour is unchanged: 4 tools, 2 hidden, delete_index is 403', async () => {
  await withSample('standard', async (token) => {
    const tools = await listAll(token, PRIVILEGE, 'tools/list', 'tools');
    assert.deepEqual(tools.items.map((t) => t.name), ['search_documents', 'get_document', 'list_indices', 'cluster_health']);
    assert.deepEqual(tools.meta.deniedTools.map((t) => t.name), ['delete_index', 'update_mapping']);
    const denied = await rpc(token, PRIVILEGE, 'tools/call', { name: 'delete_index', arguments: { index: 'orders-2026' } });
    assert.equal(denied.status, 403);
    const search = await rpc(token, PRIVILEGE, 'tools/call', { name: 'search_documents', arguments: { index: 'support-articles', query: 'password' } });
    assert.match(search.result.content[0].text, /KB-101/);
  });
});

test('standard carries one hostile-looking entry that is served as plain text and flagged by its invisible characters', async () => {
  await withSample('standard', async (token) => {
    const resources = (await listAll(token, PRIVILEGE, 'resources/list', 'resources')).items;
    const hostile = resources.find((r) => r.name === 'vendor-changelog');
    assert.match(hostile.description, /<img src="x" onerror=/);
    assert.match(hostile.description, /<script>/);
    assert.match(hostile.description, /\u200B/);
    assert.match(hostile.description, /\u202E/);
    assert.equal(hostile.mimeType, 'text/plain');
    const read = await rpc(token, PRIVILEGE, 'resources/read', { uri: hostile.uri });
    assert.match(read.result.contents[0].text, /<script>alert/);
  });
  // The source file itself holds no invisible character: they are written as escapes.
  const source = fs.readFileSync(path.join(__dirname, 'lib', 'mockSamples.js'), 'utf8');
  assert.equal(/[\u200B-\u200F\u202A-\u202E\uFEFF]/.test(source), false);
});

test('samples invent everything: any URL uses an .example or .invalid host', () => {
  const text = JSON.stringify(samples.ids().map((id) => samples.get(id)), (_k, v) => (typeof v === 'function' ? undefined : v));
  const hosts = [...text.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1]);
  assert.ok(hosts.length > 0);
  for (const host of hosts) assert.match(host, /\.(example|invalid)$/, host);
  for (const mail of text.matchAll(/[a-z0-9._-]+@([a-z0-9-]+(?:\.[a-z0-9-]+)*)/gi)) assert.match(mail[1], /\.example$/, mail[0]);
});

// ---------------------------------------------------------------------------
// The sample API
// ---------------------------------------------------------------------------
async function withApp(fn) {
  const app = express();
  app.use('/api/gateway', relay);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const putSample = (base, sample) => fetch(`${base}/api/gateway/mock/sample`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sample }),
});

async function signInThroughApp(base) {
  const start = await (await fetch(`${base}/api/gateway/auth/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ returnTo: '/' }),
  })).json();
  const authorize = await fetch(start.authUrl, { redirect: 'manual' });
  const callback = await fetch(authorize.headers.get('location'), { redirect: 'manual' });
  assert.equal(callback.headers.get('location'), '/?auth=success');
}

test('API: GET lists the samples with counts, PUT switches, an unknown id is 400', async () => {
  relay.__test.reset();
  mock.reset();
  await withApp(async (base) => {
    const list = await (await fetch(`${base}/api/gateway/mock/sample`)).json();
    assert.equal(list.active, 'standard');
    assert.deepEqual(list.samples.map((s) => s.id), samples.ids());
    const heavy = list.samples.find((s) => s.id === 'policy-heavy');
    assert.equal(heavy.counts.privilege.tools, 5);
    assert.equal(heavy.counts.direct.tools, 14);
    assert.equal(heavy.counts.privilege.hiddenTools, 9);
    assert.ok(heavy.label && heavy.purpose);

    const put = await putSample(base, 'large');
    assert.equal(put.status, 200);
    assert.equal((await put.json()).active, 'large');
    assert.equal((await (await fetch(`${base}/api/gateway/mock/sample`)).json()).active, 'large');
    assert.equal((await (await fetch(`${base}/api/gateway/state`)).json()).mockSample, 'large');

    const bad = await putSample(base, 'nope');
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, 'unknown_sample');
    assert.equal(mock.sampleId(), 'large', 'a refused change leaves the sample as it was');
    // Names that exist on every object are not samples.
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      const proto = await putSample(base, name);
      assert.equal(proto.status, 400, name);
      assert.equal(mock.sampleId(), 'large', `${name} leaves the sample as it was`);
    }
  });
});

test('API: reset returns the sample to the default', async () => {
  relay.__test.reset();
  mock.reset();
  await withApp(async (base) => {
    await putSample(base, 'empty');
    assert.equal(mock.sampleId(), 'empty');
    relay.resetAll();
    assert.equal(mock.sampleId(), 'standard');
  });
});

test('API: /catalog reports lists, pages, supported flags and what policy hid, per sample', async () => {
  relay.__test.reset();
  mock.reset();
  await withApp(async (base) => {
    await signInThroughApp(base);
    const catalog = async () => (await fetch(`${base}/api/gateway/catalog`)).json();

    await putSample(base, 'large');
    let c = await catalog();
    assert.equal(c.tools.length, 40);
    assert.equal(c.lists.tools.pages, 4);
    assert.equal(c.lists.resources.pages, 2);
    assert.equal(c.resources.length, 12);
    assert.deepEqual(c.errors, []);

    await putSample(base, 'minimal');
    c = await catalog();
    assert.equal(c.tools.length, 2);
    assert.equal(c.lists.prompts.supported, false);
    assert.equal(c.lists.resources.supported, true);
    assert.equal(c.resources.length, 1);

    await putSample(base, 'empty');
    c = await catalog();
    assert.deepEqual([c.tools.length, c.resources.length, c.resourceTemplates.length, c.prompts.length], [0, 0, 0, 0]);
    assert.equal(c.lists.prompts.supported, true, 'declared but empty is not the same as not supported');
    assert.equal(c.lists.tools.count, 0);

    await putSample(base, 'policy-heavy');
    c = await catalog();
    assert.equal(c.tools.length, 5);
    assert.equal(c.lists.tools.hidden.length, 9);
    assert.equal(c.lists.resources.hidden.length, 5);
    assert.equal(c.lists.prompts.hidden.length, 2);
    assert.ok(c.lists.tools.hidden.every((h) => h.name && h.description && h.deniedReason));

    // Reading through the relay: a resource, a template, a prompt, and a missing resource.
    const request = (method, params) => fetch(`${base}/api/gateway/request`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }),
    });
    const read = await (await request('resources/read', { uri: 'ledger://accounts/summary' })).json();
    assert.match(read.result.contents[0].text, /current/);
    const tpl = await (await request('resources/read', { uri: 'ledger://accounts/ACC-100/statement' })).json();
    assert.match(tpl.result.contents[0].text, /Opening balance/);
    const prompt = await (await request('prompts/get', { name: 'explain_transaction', arguments: { id: 'TX-9001' } })).json();
    assert.match(prompt.result.messages[0].content.text, /TX-9001/);
    const missing = await request('resources/read', { uri: 'ledger://nope' });
    assert.equal(missing.status, 500);
    const body = await missing.json();
    assert.equal(body.rpcError.code, -32002);
  });
});

test('switching sample keeps the sign-in and clears the old lists', async () => {
  relay.__test.reset();
  mock.reset();
  await withApp(async (base) => {
    await signInThroughApp(base);
    await fetch(`${base}/api/gateway/tools/list`, { method: 'POST' });
    await putSample(base, 'docs');
    const state = await (await fetch(`${base}/api/gateway/state`)).json();
    assert.equal(state.oauth.authenticated, true);
    assert.deepEqual(state.tools, []);
    const tools = await (await fetch(`${base}/api/gateway/tools/list`, { method: 'POST' })).json();
    assert.equal(tools.tools.length, 3);
  });
});
