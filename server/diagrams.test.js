'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const diagrams = require('./lib/diagrams');

test('loads a diagram-studio/1 diagram by name', () => {
  const d = diagrams.load('auth-code-pkce');
  assert.equal(d.schema, 'diagram-studio/1');
  assert.ok(d.nodes.length >= 2 && d.edges.length >= 1 && d.steps.length >= 1);
});

test('refuses names that are not plain diagram ids', () => {
  assert.equal(diagrams.load('../package'), null);
  assert.equal(diagrams.load('nope-missing'), null);
  assert.equal(diagrams.load(''), null);
});

test('validate rejects an arrow to an unknown box and a step pointing at a missing arrow', () => {
  const base = { schema: 'diagram-studio/1', id: 'x', nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ source: 'a', target: 'b' }], steps: [{ edges: [0] }] };
  assert.equal(diagrams.validate(base), true);
  assert.equal(diagrams.validate({ ...base, edges: [{ source: 'a', target: 'zz' }] }), false);
  assert.equal(diagrams.validate({ ...base, steps: [{ edges: [5] }] }), false);
});
