// The header shows this lab's own Verified / In progress mark. The mark is read from the same GET /api/shelf call the Shelf link makes: through
// the lab-proxy that call reaches the shelf, whose payload lists every demo with its mark; on the lab's own port it answers only { shelfUrl }.
// This lab's web tests are plain `node --test` (no DOM library, no new dependencies), so the shared VerifyMark is loaded through Vite's SSR
// loader with its two hooks driven by hand (helpers/hooks-shim.js), and App.jsx's wiring is checked in the source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { renderToStaticMarkup } from 'react-dom/server';

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, '..');
const read = (...p) => readFileSync(join(web, ...p), 'utf8');
const MY_ID = JSON.parse(readFileSync(join(web, '..', 'docs', 'shelf-entry.json'), 'utf8')).id;

const mark = (status, label, extra = {}) => ({ status, label, note: '', updatedAt: '2026-11-15', source: 'shipped', ...extra });

let vite;
let VerifyMark;
let harness; // the shim instance the component sees: loaded through the same Vite loader, not imported natively
test.before(async () => {
  vite = await createServer({
    root: web, configFile: false, logLevel: 'silent', appType: 'custom', server: { middlewareMode: true, hmr: false, watch: null },
    plugins: [react()],
    optimizeDeps: { noDiscovery: true, include: [] }, // load two modules, not the app: no dependency pre-bundling (it would scan index.html and the aliased react)
    resolve: { alias: [{ find: /^react$/, replacement: join(here, 'helpers', 'hooks-shim.js') }] },
  });
  harness = (await vite.ssrLoadModule('/test/helpers/hooks-shim.js')).harness;
  VerifyMark = (await vite.ssrLoadModule('/src/components/VerifyMark.jsx')).default;
});
test.after(async () => { await vite?.close(); });

// Render <VerifyMark id=... /> against a stubbed GET /api/shelf; returns the markup it settles on and the request it made.
async function headerBadge(payload, { id = MY_ID, ok = true } = {}) {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => { seen.push({ url, init }); return { ok, json: async () => payload }; };
  try {
    harness.reset();
    const props = { id };
    harness.begin();
    VerifyMark(props); // first render: loading, so nothing
    for (const effect of harness.takeEffects()) effect();
    await new Promise((r) => setTimeout(r, 0));
    harness.begin();
    return { html: renderToStaticMarkup(VerifyMark(props)), seen };
  } finally { globalThis.fetch = real; }
}

test('shows this lab\'s own mark and no other lab\'s, with the note as its tooltip', async () => {
  const { html, seen } = await headerBadge({
    shelfUrl: 'http://shelf.example',
    demos: [
      { id: 'some-other-lab', verification: mark('in-progress', 'In progress', { note: 'not this lab' }) },
      { id: MY_ID, verification: mark('verified', 'Verified', { note: 'Every step run on the mock' }) },
    ],
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, '/api/shelf');
  assert.equal(seen[0].init.credentials, 'omit');
  assert.equal((html.match(/class="verify"/g) || []).length, 1, html);
  assert.match(html, /data-status="verified"/);
  assert.match(html, />Verified</);
  assert.match(html, /title="[^"]*Every step run on the mock/);
  assert.doesNotMatch(html, /In progress|not this lab/);
});

test('shows the In progress label for an in-progress mark', async () => {
  const { html } = await headerBadge({ demos: [{ id: MY_ID, verification: mark('in-progress', 'In progress') }] });
  assert.match(html, /data-status="in-progress"/);
  assert.match(html, />In progress</);
});

test('shows nothing without a mark, with a "none" mark, for another lab only, on the lab\'s own port ({ shelfUrl } only), or when the shelf is down', async () => {
  const none = [
    ['no mark', { shelfUrl: 'http://shelf.example', demos: [{ id: MY_ID, verification: null }] }],
    ['mark none', { shelfUrl: 'http://shelf.example', demos: [{ id: MY_ID, verification: mark('none', 'None') }] }],
    ['only another lab marked', { shelfUrl: 'http://shelf.example', demos: [{ id: 'some-other-lab', verification: mark('verified', 'Verified') }] }],
    ['own port: only shelfUrl', { shelfUrl: 'http://shelf.example' }],
  ];
  for (const [name, payload] of none) assert.equal((await headerBadge(payload)).html, '', name);
  assert.equal((await headerBadge({ demos: [{ id: MY_ID, verification: mark('verified', 'Verified') }] }, { ok: false })).html, '', 'shelf down');
});

test('App.jsx renders exactly one <VerifyMark> for this lab\'s own shelf id, inside the TopMenu, and main.jsx loads its CSS', () => {
  const app = read('src', 'App.jsx');
  assert.match(app, /import VerifyMark from '\.\/components\/VerifyMark\.jsx';/);
  const uses = app.match(/<VerifyMark\b[^>]*>/g) || [];
  assert.deepEqual(uses, [`<VerifyMark id="${MY_ID}" />`]);
  const menu = app.match(/<TopMenu\b[\s\S]*?<\/TopMenu>/);
  assert.ok(menu, 'TopMenu has children');
  assert.ok(menu[0].includes(uses[0]), 'the badge sits inside TopMenu (its own pill, readable on the dark shell bar)');
  assert.match(read('src', 'main.jsx'), /import '\.\/components\/VerifyMark\.css';/);
});
