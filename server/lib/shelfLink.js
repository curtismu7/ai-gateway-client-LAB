'use strict';
// shelf-link service, server side (CommonJS port of the canonical shared/shelf-link/shelf.js: this server is CommonJS).
// GET /api/shelf returns { shelfUrl } read from env SHELF_URL (set by compose, or by dotenv from the shared settings file).
// No hardcoded host here: unconfigured means shelfUrl null and the web component renders nothing.
const fs = require('node:fs');

const clean = (v) => String(v).trim().replace(/^["']|["']$/g, '').replace(/\/+$/, '');

function readShelfUrl(env = process.env) {
  if (env.SHELF_URL) return clean(env.SHELF_URL);
  const candidates = [];
  if (env.STANDALONE_ENV) candidates.push(env.STANDALONE_ENV);
  candidates.push(`${env.HOME || ''}/Development/.env`);
  for (const f of candidates) {
    try {
      const m = fs.readFileSync(f, 'utf8').split('\n').map((l) => l.match(/^SHELF_URL=(.*)$/)).find(Boolean);
      if (m) return clean(m[1]);
    } catch { /* next candidate */ }
  }
  return null;
}

function shelfInfo(env = process.env) {
  return { shelfUrl: readShelfUrl(env) };
}

function mountShelfRoute(router, { env = process.env } = {}) {
  router.get('/api/shelf', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(shelfInfo(env));
  });
}

module.exports = { shelfInfo, mountShelfRoute };
