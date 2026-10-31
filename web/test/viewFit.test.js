import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  BOX_MIN_FONT_PX, LEGIBLE_PX, FIT_PAD, MAX_ZOOM,
  legibleZoom, boundsOf, fitViewport, revealViewport, shouldRefit, createFitTracker, debounce,
} from '../src/lib/viewFit.js';

// A wide row of four boxes, 1000 flow units across: too wide for most canvases, so it exercises the zoom floor.
// (The real diagram is compact; test/diagramLayout.test.js covers it.)
const rects = [
  { x: 0, y: 0, w: 200, h: 96 }, { x: 400, y: 0, w: 200, h: 96 },
  { x: 800, y: 0, w: 200, h: 96 }, { x: 800, y: 320, w: 200, h: 96 },
];
const bounds = boundsOf(rects);
const onScreen = (fontPx, view) => fontPx * view.zoom;

test('boundsOf wraps every rectangle, and is null for none', () => {
  assert.deepEqual(bounds, { x: 0, y: 0, w: 1000, h: 416 });
  assert.deepEqual(boundsOf([{ x: -10, y: 5, w: 20, h: 20 }]), { x: -10, y: 5, w: 20, h: 20 });
  assert.equal(boundsOf([]), null);
  assert.equal(boundsOf(undefined), null);
});

test('legibleZoom is the zoom at which the smallest box text measures the target', () => {
  assert.ok(Math.abs(onScreen(BOX_MIN_FONT_PX, { zoom: legibleZoom() }) - LEGIBLE_PX) < 1e-9);
  assert.ok(LEGIBLE_PX >= 10);
  assert.equal(legibleZoom(0), 0);
});

test('a canvas wide enough gets the whole diagram, centred, with text at or above the floor', () => {
  const size = { w: 1400, h: 700 };
  const v = fitViewport({ bounds, size });
  assert.equal(v.clipped, false);
  assert.ok(onScreen(BOX_MIN_FONT_PX, v) >= 10);
  const left = bounds.x * v.zoom + v.x, right = (bounds.x + bounds.w) * v.zoom + v.x;
  const top = bounds.y * v.zoom + v.y, bottom = (bounds.y + bounds.h) * v.zoom + v.y;
  assert.ok(left >= FIT_PAD - 1e-9 && right <= size.w - FIT_PAD + 1e-9);
  assert.ok(top >= FIT_PAD - 1e-9 && bottom <= size.h - FIT_PAD + 1e-9);
  assert.ok(Math.abs(left - (size.w - right)) < 1e-9, 'centred across');
  assert.ok(Math.abs(top - (size.h - bottom)) < 1e-9, 'centred down');
});

test('the zoom never goes above maxZoom, and the diagram is centred', () => {
  const v = fitViewport({ bounds: { x: 0, y: 0, w: 100, h: 50 }, size: { w: 2000, h: 1000 } });
  assert.equal(v.zoom, MAX_ZOOM);
  assert.equal(v.x, (2000 - 150) / 2);
  assert.equal(v.y, (1000 - 75) / 2);
});

test('a canvas too small stops at the legibility floor, anchors top left, and says it clipped', () => {
  for (const w of [584, 328, 204, 104, 311]) {
    const v = fitViewport({ bounds, size: { w, h: 380 } });
    assert.equal(v.zoom, legibleZoom(), `width ${w}`);
    assert.equal(v.clipped, true, `width ${w}`);
    assert.ok(onScreen(BOX_MIN_FONT_PX, v) >= 10, `width ${w}`);
    assert.equal(bounds.x * v.zoom + v.x, FIT_PAD, `left anchored at ${w}`);
  }
});

test('a canvas too short anchors the top, and one tall enough centres', () => {
  const short = fitViewport({ bounds, size: { w: 1400, h: 200 } });
  assert.equal(short.zoom, legibleZoom());
  assert.equal(short.y, FIT_PAD);
  const tall = fitViewport({ bounds, size: { w: 1400, h: 900 } });
  assert.ok(tall.y > FIT_PAD);
});

test('boxes that do not start at the origin are placed by their own bounds', () => {
  const b = { x: -300, y: 120, w: 1000, h: 416 };
  const v = fitViewport({ bounds: b, size: { w: 1400, h: 700 } });
  assert.ok(b.x * v.zoom + v.x >= FIT_PAD - 1e-9);
  assert.ok((b.y + b.h) * v.zoom + v.y <= 700 - FIT_PAD + 1e-9);
});

test('no fit for nothing to fit or a canvas with no size', () => {
  assert.equal(fitViewport({ bounds: null, size: { w: 500, h: 500 } }), null);
  assert.equal(fitViewport({ bounds, size: { w: 0, h: 500 } }), null);
  assert.equal(fitViewport({ bounds, size: { w: 500, h: -1 } }), null);
  assert.equal(fitViewport({ bounds: { x: 0, y: 0, w: 0, h: 10 }, size: { w: 500, h: 500 } }), null);
});

test('shouldRefit: on a real size change, not when the user moved, not for the same or an empty size', () => {
  const prev = { w: 700, h: 440 };
  assert.equal(shouldRefit({ moved: false, prev, next: { w: 500, h: 440 } }), true);
  assert.equal(shouldRefit({ moved: false, prev, next: { w: 700, h: 300 } }), true);
  assert.equal(shouldRefit({ moved: false, prev: null, next: { w: 500, h: 440 } }), true);
  assert.equal(shouldRefit({ moved: true, prev, next: { w: 500, h: 440 } }), false);
  assert.equal(shouldRefit({ moved: false, prev, next: { w: 700, h: 440 } }), false);
  assert.equal(shouldRefit({ moved: false, prev, next: { w: 0, h: 440 } }), false);
  assert.equal(shouldRefit({ moved: false, prev, next: null }), false);
});

test('the fit tracker: a user move blocks auto refit until the next fit', () => {
  const t = createFitTracker();
  assert.equal(t.moved, false);
  t.userMoved();
  assert.equal(t.moved, true);
  t.userMoved();
  assert.equal(t.moved, true);
  t.fitted();
  assert.equal(t.moved, false);
});

test('debounce runs once, after the last call, and cancel drops it', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const calls = [];
    const d = debounce((v) => calls.push(v), 150);
    d(1); mock.timers.tick(100); d(2); mock.timers.tick(100); d(3);
    assert.deepEqual(calls, []);
    mock.timers.tick(149);
    assert.deepEqual(calls, []);
    mock.timers.tick(1);
    assert.deepEqual(calls, [3]);
    d(4); d.cancel(); mock.timers.tick(500);
    assert.deepEqual(calls, [3]);
  } finally {
    mock.timers.reset();
  }
});

test('the CSS box text sizes match the constants the zoom floor is worked out from', () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/components/FlowDiagram.css'), 'utf8');
  const size = (selector) => {
    const m = css.match(new RegExp(`${selector.replace('.', '\\.')}\\s*\\{[^}]*?font-size:\\s*(\\d+(?:\\.\\d+)?)px`));
    assert.ok(m, `${selector} has a font-size in px`);
    return Number(m[1]);
  };
  const smallest = Math.min(size('.flow-node__title'), size('.flow-node__sub'));
  assert.equal(smallest, BOX_MIN_FONT_PX);
});

// revealViewport: Simulate pans to the boxes a step names.
const view = { x: 8, y: 8, zoom: 0.72 };
const canvas = { w: 300, h: 380 };

test('revealViewport leaves a target that is already on the canvas alone', () => {
  assert.equal(revealViewport({ view, target: { x: 0, y: 0, w: 200, h: 96 }, size: canvas }), null);
});

test('revealViewport pans just far enough to bring a box in from the right and from below', () => {
  const right = revealViewport({ view, target: { x: 400, y: 0, w: 160, h: 96 }, size: canvas });
  assert.equal(right.zoom, view.zoom);
  assert.equal(right.y, view.y, 'did not move vertically');
  assert.ok(Math.abs((400 + 160) * view.zoom + right.x - (canvas.w - FIT_PAD)) < 1e-9, 'right edge sits at the pad');
  const below = revealViewport({ view, target: { x: 0, y: 700, w: 160, h: 96 }, size: canvas });
  assert.equal(below.x, view.x, 'did not move sideways');
  assert.ok(Math.abs((700 + 96) * view.zoom + below.y - (canvas.h - FIT_PAD)) < 1e-9);
});

test('revealViewport brings a box in from the left and from above', () => {
  const panned = { x: -500, y: -400, zoom: 0.72 };
  const v = revealViewport({ view: panned, target: { x: 100, y: 100, w: 160, h: 96 }, size: canvas });
  assert.ok(Math.abs(100 * 0.72 + v.x - FIT_PAD) < 1e-9);
  assert.ok(Math.abs(100 * 0.72 + v.y - FIT_PAD) < 1e-9);
});

test('revealViewport anchors a target larger than the canvas at its top left, and never changes the zoom', () => {
  const v = revealViewport({ view, target: { x: 50, y: 20, w: 2000, h: 2000 }, size: canvas });
  assert.equal(50 * view.zoom + v.x, FIT_PAD);
  assert.equal(20 * view.zoom + v.y, FIT_PAD);
  assert.equal(v.zoom, view.zoom);
});

test('revealViewport has nothing to do without a view, a target or a canvas', () => {
  assert.equal(revealViewport({ view: null, target: { x: 0, y: 0, w: 1, h: 1 }, size: canvas }), null);
  assert.equal(revealViewport({ view, target: null, size: canvas }), null);
  assert.equal(revealViewport({ view, target: { x: 0, y: 0, w: 1, h: 1 }, size: { w: 0, h: 380 } }), null);
});
