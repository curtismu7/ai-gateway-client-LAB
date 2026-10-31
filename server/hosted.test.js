'use strict';
// Hosted defaults: only https origins are accepted, and nothing is hosted unless the shared settings say so.
const test = require('node:test');
const assert = require('node:assert/strict');
const { gatewayHost, hostileMcpUrl } = require('./lib/hosted');

test('nothing is hosted when the settings are unset', () => {
  assert.equal(gatewayHost({}), '');
  assert.equal(hostileMcpUrl({}), '');
});

test('the gateway host is the https origin, without path or trailing slash', () => {
  assert.equal(gatewayHost({ HOSTED_MCPGW_URL: 'https://gw.example.invalid/' }), 'https://gw.example.invalid');
  assert.equal(gatewayHost({ HOSTED_MCPGW_URL: 'https://gw.example.invalid/opensearch/mcp' }), 'https://gw.example.invalid');
});

test('the hostile fixture URL is the origin plus /mcp', () => {
  assert.equal(hostileMcpUrl({ HOSTED_HOSTILE_MCP_URL: 'https://hostile.example.invalid/' }), 'https://hostile.example.invalid/mcp');
});

test('plain http and malformed values are refused', () => {
  assert.equal(gatewayHost({ HOSTED_MCPGW_URL: 'http://gw.example.invalid' }), '');
  assert.equal(gatewayHost({ HOSTED_MCPGW_URL: 'not a url' }), '');
  assert.equal(hostileMcpUrl({ HOSTED_HOSTILE_MCP_URL: 'http://127.0.0.1:8899/' }), '');
});

function presetsFor(mode) {
  const { execFileSync } = require('node:child_process');
  const script = `
    const express = require('express');
    const relay = require('./lib/relay');
    const app = express();
    app.use('/api/gateway', relay);
    const server = app.listen(0, '127.0.0.1', async () => {
      const res = await fetch('http://127.0.0.1:' + server.address().port + '/api/gateway/state');
      const body = await res.json();
      console.log(JSON.stringify(body.presets));
      server.close();
    });`;
  const out = execFileSync(process.execPath, ['-e', script], {
    cwd: __dirname,
    env: {
      ...process.env,
      MODE: mode,
      DOOR_STORE_DIR: require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'hosted-test-')),
      HOSTED_MCPGW_URL: 'https://gw.example.invalid',
      HOSTED_HOSTILE_MCP_URL: 'https://hostile.example.invalid',
      PRIVILEGE_GATEWAY_HOST: '',
      DIRECT_HOSTILE_MCP_URL: '',
    },
  }).toString().trim().split('\n').pop();
  return JSON.parse(out);
}

test('live presets use the hosted gateway and hostile fixture', () => {
  const urls = presetsFor('live').map((p) => p.url);
  assert.ok(urls.includes('https://gw.example.invalid/opensearch/mcp'), urls.join(' '));
  assert.ok(urls.includes('https://gw.example.invalid/libre/mcp'), urls.join(' '));
  assert.ok(urls.includes('https://hostile.example.invalid/mcp'), urls.join(' '));
});

test('mock presets ignore the hosted settings', () => {
  const urls = presetsFor('mock').map((p) => p.url).join(' ');
  assert.ok(!urls.includes('example.invalid'), urls);
});
