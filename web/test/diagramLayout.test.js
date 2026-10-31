import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BOX_MIN_FONT_PX, boundsOf, fitViewport, legibleZoom, revealViewport } from '../src/lib/viewFit.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, rel), 'utf8');
const diagram = JSON.parse(read('../../diagrams/auth-code-pkce.json'));
const css = read('../src/components/FlowDiagram.css');

const cssPx = (selector, prop) => {
  const m = css.match(new RegExp(`${selector.replace('.', '\\.')}\\s*\\{[^}]*?${prop}:\\s*(\\d+(?:\\.\\d+)?)px`));
  assert.ok(m, `${selector} sets ${prop} in px`);
  return Number(m[1]);
};

// Boxes as the CSS draws them. A box can grow when its text wraps, so allow 40 more than the minimum height.
const W = cssPx('.flow-node', 'width');
const H = cssPx('.flow-node', 'min-height') + 40;
const rects = diagram.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y, w: W, h: H }));
const bounds = boundsOf(rects);

// Canvas sizes the panel really gets (measured in the browser): 1280 wide three column, 1024 wide three column,
// and the 375 phone, which is the narrowest. Height is the CSS canvas height less its border.
const PHONE = { w: 309, h: 378 };
const CANVASES = { '1440': { w: 776, h: 438 }, '1280': { w: 614, h: 438 }, '1024': { w: 354, h: 438 }, '375': PHONE };

test('the diagram boxes do not overlap each other', () => {
  for (let a = 0; a < rects.length; a++) {
    for (let b = a + 1; b < rects.length; b++) {
      const A = rects[a], B = rects[b];
      const hit = A.x < B.x + B.w && B.x < A.x + A.w && A.y < B.y + B.h && B.y < A.y + A.h;
      assert.equal(hit, false, `${A.id} and ${B.id}`);
    }
  }
});

test('every box fits every canvas at once, with box text at 10px or more on screen', () => {
  for (const [name, size] of Object.entries(CANVASES)) {
    const v = fitViewport({ bounds, size });
    assert.equal(v.clipped, false, `${name}: the whole diagram is on the canvas, nothing to pan`);
    assert.ok(BOX_MIN_FONT_PX * v.zoom >= 10, `${name}: smallest box text ${BOX_MIN_FONT_PX * v.zoom}px`);
    for (const r of rects) {
      assert.ok(r.x * v.zoom + v.x >= 0 && (r.x + r.w) * v.zoom + v.x <= size.w, `${name}: ${r.id} inside across`);
      assert.ok(r.y * v.zoom + v.y >= 0 && (r.y + r.h) * v.zoom + v.y <= size.h, `${name}: ${r.id} inside down`);
    }
  }
});

test('the diagram is no wider than the phone canvas allows at the zoom floor', () => {
  assert.ok(bounds.w * legibleZoom() + 16 <= PHONE.w, `${bounds.w} wide at ${legibleZoom()}`);
});

test('every Simulate step shows the boxes it names, even when the canvas is smaller than the diagram', () => {
  // A canvas two thirds of the phone: too small for the whole diagram, so Simulate has to pan.
  const size = { w: 200, h: 200 };
  const fit = fitViewport({ bounds, size });
  assert.equal(fit.clipped, true);
  for (const [i, step] of diagram.steps.entries()) {
    const named = new Set(step.edges.flatMap((e) => [diagram.edges[e].source, diagram.edges[e].target]));
    const target = boundsOf(rects.filter((r) => named.has(r.id)));
    const v = revealViewport({ view: fit, target, size }) || fit;
    const inside = (extent, start, len, zoom, offset) => start * zoom + offset >= 0 && (start + len) * zoom + offset <= extent;
    // Boxes of one step that fit the canvas must be in view; a larger set is anchored at its top left.
    if (target.w * v.zoom + 16 <= size.w) assert.ok(inside(size.w, target.x, target.w, v.zoom, v.x), `step ${i + 1} across`);
    if (target.h * v.zoom + 16 <= size.h) assert.ok(inside(size.h, target.y, target.h, v.zoom, v.y), `step ${i + 1} down`);
    assert.equal(v.zoom, fit.zoom, `step ${i + 1} keeps the zoom`);
  }
});

test('the panel is never wider than its column', () => {
  const panel = css.match(/\.flow-panel\s*\{[^}]*\}/)[0];
  assert.doesNotMatch(panel, /min-width:\s*[1-9]/);
});

test('the shell stacks its columns at the 900px breakpoint, in the script and in the stylesheet', () => {
  const jsx = read('../src/components/shared/InspectorShell.jsx');
  const shellCss = read('../src/components/shared/InspectorShell.css');
  const app = read('../src/App.jsx');
  assert.match(jsx, /NARROW_QUERY = '\(max-width: 900px\)'/);
  assert.match(shellCss, /@media \(max-width: 900px\)\s*\{\s*\.inspector-shell-grid--narrow/);
  assert.match(app, /matchMedia\('\(max-width: 900px\)'\)/);
  assert.doesNotMatch(jsx + shellCss + app, /768px/);
});
