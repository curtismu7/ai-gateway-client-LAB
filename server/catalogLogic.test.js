'use strict';
// The web UI's pure helpers (web/src/lib/catalog.js): counts line, page note, untrusted-text
// inspection, safe JSON, content formatting and templates. The web package has no test runner of
// its own, so the logic is exercised here by importing the ES module.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'web', 'src', 'lib', 'catalog.js')).href);

test('counts line matches the owner example and names what policy hides', async () => {
  const c = await load();
  const base = { templates: 1, hiddenResources: 0, hiddenPrompts: 0, unsupported: [] };
  assert.equal(c.countsLine('Privilege', { ...base, tools: 5, resources: 3, prompts: 1, hiddenTools: 9 }), 'Privilege: 5 tools, 3 resources, 1 prompt (9 tools hidden by policy)');
  assert.equal(c.countsLine('Direct', { ...base, tools: 14, resources: 8, prompts: 3, hiddenTools: 0 }), 'Direct: 14 tools, 8 resources, 3 prompts');
  assert.equal(c.countsLine('Privilege', { ...base, tools: 1, resources: 1, prompts: 1, hiddenTools: 1, hiddenResources: 5, hiddenPrompts: 2 }), 'Privilege: 1 tool, 1 resource, 1 prompt (1 tool, 5 resources, 2 prompts hidden by policy)');
  assert.equal(c.countsLine('Privilege', { ...base, tools: 2, resources: 1, prompts: 0, hiddenTools: 0, unsupported: ['prompts'] }), 'Privilege: 2 tools, 1 resource, prompts not supported');
});

test('summarise reads the catalog response', async () => {
  const c = await load();
  const s = c.summarise({
    tools: [{}, {}], resources: [{}], resourceTemplates: [], prompts: [],
    lists: { tools: { supported: true, hidden: [{}, {}, {}] }, resources: { supported: true, hidden: [] }, prompts: { supported: false, hidden: [] } },
  });
  assert.deepEqual(s, { tools: 2, resources: 1, templates: 0, prompts: 0, hiddenTools: 3, hiddenResources: 0, hiddenPrompts: 0, unsupported: ['prompts'] });
  assert.deepEqual(c.summarise(null).unsupported, []);
});

test('page note', async () => {
  const c = await load();
  assert.equal(c.pageNote('tool', 'tools', 40, 4), 'Loaded 40 tools in 4 pages');
  assert.equal(c.pageNote('resource', 'resources', 1, 1), 'Loaded 1 resource in 1 page');
});

test('inspectText finds invisible characters and HTML-looking text, and leaves the text itself alone', async () => {
  const c = await load();
  const hostile = 'Hi <img src=x onerror=alert(1)> there​​ end‮';
  const info = c.inspectText(hostile);
  assert.equal(info.text, hostile);
  assert.equal(info.htmlLike, true);
  assert.equal(info.invisible.length, 3);
  assert.equal(info.invisibleSummary, 'U+200B x2, U+202E');
  assert.equal(info.marked, 'Hi <img src=x onerror=alert(1)> there[U+200B][U+200B] end[U+202E]');
  const clean = c.inspectText('Plain text, 2 < 3 and 5 > 4.');
  assert.equal(clean.htmlLike, false);
  assert.equal(clean.invisible.length, 0);
  assert.equal(c.inspectText(undefined).text, '');
  // The tag block (used to smuggle hidden instructions) is caught too.
  assert.equal(c.inspectText('a\u{E0041}b').invisible.length, 1);
});

test('safeJson writes invisible characters as escapes', async () => {
  const c = await load();
  const out = c.safeJson({ text: 'a​b‮', tag: '\u{E0041}' });
  assert.ok(!/[​‮]/.test(out) && !out.includes('\u{E0041}'));
  assert.match(out, /a\\u200Bb\\u202E/);
  assert.match(out, /\\u\{E0041\}/);
  assert.equal(c.safeJson(undefined), '');
});

test('formatContent pretty-prints JSON and keeps everything else as text', async () => {
  const c = await load();
  assert.equal(c.formatContent('{"a":1}', 'application/json').text, '{\n  "a": 1\n}');
  const bad = c.formatContent('{nope', 'application/json');
  assert.equal(bad.format, 'text');
  assert.ok(bad.note);
  assert.equal(c.formatContent('<b>x</b>', 'text/plain').text, '<b>x</b>');
  assert.equal(c.formatContent('# t', 'text/markdown').format, 'markdown');
});

test('templates: variables and filling', async () => {
  const c = await load();
  assert.deepEqual(c.templateVariables('opensearch://indices/{index}/documents/{id}'), ['index', 'id']);
  assert.equal(c.fillTemplate('docs://pages/{slug}', { slug: 'a b' }), 'docs://pages/a%20b');
  assert.equal(c.fillTemplate('docs://pages/{slug}', {}), 'docs://pages/');
});

test('tool badges use words and mark what the Privilege door hides', async () => {
  const c = await load();
  const tool = { annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false } };
  assert.deepEqual(c.toolBadges(tool).map((b) => b.text), ['destructive']);
  assert.deepEqual(c.toolBadges({ annotations: { readOnlyHint: true, idempotentHint: true } }).map((b) => b.text), ['read-only']);
  assert.deepEqual(c.toolBadges(tool, { hiddenOnPrivilege: true }).map((b) => b.text), ['destructive', 'hidden on Privilege door']);
  assert.deepEqual(c.toolBadges({}, { hiddenHere: true }).map((b) => b.text), ['hidden by policy']);
  assert.deepEqual(c.toolBadges({}), []);
});

test('the web source holds no invisible characters (they are written as escapes)', async () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'lib', 'catalog.js'), 'utf8');
  assert.equal(/[​-‏‪-‮﻿]/.test(src), false);
});
