'use strict';
// In live mode the sample API is refused: samples belong to the mock gateway only.
process.env.MODE = 'live';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DOOR_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-gateway-client-samples-live-'));
process.env.GATEWAY_ENV_PATH = path.join(process.env.DOOR_STORE_DIR, 'gateway.env');

const express = require('express');
const relay = require('./lib/relay');
const mock = require('./lib/mockGateway');

test('live mode refuses GET and PUT of the mock sample and leaves it alone', async () => {
  const app = express();
  app.use('/api/gateway', relay);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const get = await fetch(`${base}/api/gateway/mock/sample`);
    assert.equal(get.status, 409);
    assert.equal((await get.json()).error, 'mock_only');
    const put = await fetch(`${base}/api/gateway/mock/sample`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sample: 'large' }),
    });
    assert.equal(put.status, 409);
    assert.equal(mock.sampleId(), 'standard');
    const state = await (await fetch(`${base}/api/gateway/state`)).json();
    assert.equal(state.mockSample, null);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
