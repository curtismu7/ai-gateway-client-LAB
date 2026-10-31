'use strict';
// diagrams.js — loads a flow diagram by name from ../diagrams/<name>.json.
// The files are diagram-studio/1 data (boxes, arrows, steps). The web app builds
// the ReactFlow graph from this data; nothing is hand-built in the UI.

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '..', 'diagrams');
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Returns the diagram as data, or null when the name is unknown or the file is not a valid diagram-studio/1 diagram. */
function load(name) {
  if (typeof name !== 'string' || !NAME.test(name)) return null;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(path.join(DIR, `${name}.json`), 'utf8'));
  } catch {
    return null;
  }
  return validate(data) ? data : null;
}

function validate(d) {
  if (!d || d.schema !== 'diagram-studio/1' || typeof d.id !== 'string') return false;
  if (!Array.isArray(d.nodes) || !Array.isArray(d.edges)) return false;
  const ids = new Set(d.nodes.map((n) => n.id));
  if (ids.size !== d.nodes.length) return false;
  if (!d.edges.every((e) => ids.has(e.source) && ids.has(e.target))) return false;
  if (!Array.isArray(d.steps)) return false;
  return d.steps.every((s) => Array.isArray(s.edges) && s.edges.every((i) => Number.isInteger(i) && i >= 0 && i < d.edges.length));
}

module.exports = { load, validate, DIR };
