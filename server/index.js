#!/usr/bin/env node
'use strict';
/**
 * ai-gateway-client server — a local, no-login test client for an
 * OAuth-protected MCP gateway. Drives OAuth PKCE + Dynamic Client
 * Registration against the gateway's own authorization server, then relays
 * MCP JSON-RPC (tools/list, tools/call, and the other protocol methods)
 * through it. Defaults to PingOne's Agent Privilege; point it at any
 * other self-advertising (RFC 9728/8414) MCP gateway via env vars.
 */
require('dotenv').config({
  path: process.env.STANDALONE_ENV || require('path').join(require('os').homedir(), 'Development', '.env'),
});

const path = require('path');
const express = require('express');
const { allowedHostsFrom, makeGuard } = require('./lib/safety');
// Read before anything else loads or listens: a bad name must leave nothing running.
const allowedHosts = allowedHostsFrom(process.env);
const relay = require('./lib/relay');
const mode = require('./lib/mode');

const PORT = parseInt(process.env.PORT || '6880', 10);
// Loopback by default. The Docker image sets HOST=0.0.0.0 inside the container, and compose publishes 127.0.0.1 only.
const HOST = process.env.HOST || '127.0.0.1';
const app = express();

app.use(makeGuard(allowedHosts));

app.use('/api/gateway', relay);

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Health contract (demo-shelf docs/health-contract.md) and reset for doctor and the shelf.
const DEMO = { id: 'ai-gateway-client', name: 'Agent Privilege Client LAB', version: require('../package.json').version || '0.1.0' };
app.get('/api/health', (_req, res) => {
  const state = mode.isMock() || process.env.PINGONE_ENVIRONMENT_ID ? 'ready' : 'needs-setup';
  res.set('Cache-Control', 'no-store').json({ schema: 'demo-health/1', at: new Date().toISOString(), state, runtime: mode.currentMode(), demo: DEMO });
});
// Rule 19 (owner, 2026-11-02): GET /api/info {source, realAvailable}; POST /api/mode {source} switches at runtime.
// "real" maps onto this app's live mode (contacts the configured gateway); the older PUT /api/gateway/mode stays.
const realAvailable = () => Boolean(process.env.PRIVILEGE_GATEWAY_HOST || require('./lib/hosted').gatewayHost());
app.get('/api/info', (_req, res) => {
  res.set('Cache-Control', 'no-store').json({
    source: mode.currentMode() === 'live' ? 'real' : 'mock',
    realAvailable: realAvailable(),
  });
});
app.post('/api/mode', express.json({ limit: '2kb' }), (req, res) => {
  const b = req.body;
  if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).length !== 1 || !['mock', 'real'].includes(b.source)) {
    return res.status(400).json({ error: 'bad_body', message: 'body must be exactly {"source": "mock" or "real"}' });
  }
  if (b.source === 'real' && !realAvailable()) {
    return res.status(409).json({ error: 'conflict', message: 'Real mode is not available: no gateway host is configured. Set PRIVILEGE_GATEWAY_HOST in the shared settings file.' });
  }
  const err = mode.setMode(b.source === 'real' ? 'live' : 'mock', { confirm: true });
  if (err) return res.status(err === 'confirm_required' ? 409 : 400).json({ error: err, message: 'The switch was refused.' });
  return res.json({ source: b.source });
});

app.post('/api/reset', (_req, res) => {
  relay.resetAll();
  res.json({ ok: true });
});

// ── Static web build (production) ───────────────────────────────────────
const webDist = path.join(__dirname, '..', 'web', 'dist');
app.use(express.static(webDist));
app.get(/^(?!\/api\/).*/, (_req, res, next) => {
  res.sendFile(path.join(webDist, 'index.html'), (err) => {
    if (err) next();
  });
});

app.listen(PORT, HOST, () => {
  console.log(`[ai-gateway-client] mode ${mode.currentMode()}, listening on http://127.0.0.1:${PORT}`);
});
