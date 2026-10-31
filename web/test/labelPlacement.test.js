import test from 'node:test';
import assert from 'node:assert/strict';
import { placeLabels, pointAt, intersects } from '../src/lib/labelPlacement.js';

const bounds = { x: 0, y: 0, w: 600, h: 400 };
const line = [{ x: 100, y: 200 }, { x: 300, y: 200 }];
const item = (id, points = line, w = 150) => ({ id, points, text: { w, h: 22 }, badge: { w: 20, h: 20 } });
const boxOf = (p) => p.box;

function assertClean(placed, obstacles, pad = 4) {
  const boxes = placed.filter((p) => p.mode !== 'listed').map(boxOf);
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      assert.ok(!intersects({ x: boxes[i].x - pad, y: boxes[i].y - pad, w: boxes[i].w + 2 * pad, h: boxes[i].h + 2 * pad }, boxes[j]), `labels ${i} and ${j} touch`);
    }
    for (const o of obstacles) assert.ok(!intersects(boxes[i], o), `label ${i} sits on a box`);
    assert.ok(boxes[i].x >= bounds.x && boxes[i].y >= bounds.y && boxes[i].x + boxes[i].w <= bounds.w && boxes[i].y + boxes[i].h <= bounds.h, `label ${i} is cut off`);
  }
}

test('pointAt walks a polyline by length and gives the normal of its segment', () => {
  const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];
  assert.deepEqual(pointAt(pts, 0.25), { x: 50, y: 0, nx: -0, ny: 1 });
  const p = pointAt(pts, 0.75);
  assert.equal(p.x, 100);
  assert.equal(p.y, 50);
});

test('one label alone is text, on its line', () => {
  const [a] = placeLabels({ items: [item(0)], bounds });
  assert.equal(a.mode, 'text');
  assert.equal(a.leader, false);
  assert.equal(a.box.y + a.box.h / 2, 200);
});

test('several edges on one shared path never end up with overlapping labels (the reported bug)', () => {
  const items = [0, 1, 2, 3].map((i) => item(i, line, 190));
  const placed = placeLabels({ items, bounds });
  assertClean(placed, []);
  assert.equal(placed.length, 4);
});

test('labels too wide for the room become numbered badges instead of overlapping', () => {
  // A 120px gap between two boxes, four labels 190px wide.
  const obstacles = [{ x: 0, y: 150, w: 100, h: 100 }, { x: 220, y: 150, w: 100, h: 100 }];
  const items = [0, 1, 2, 3].map((i) => ({ ...item(i, [{ x: 100, y: 180 + i * 12 }, { x: 220, y: 180 + i * 12 }], 190), badgeOnly: i > 0 }));
  const placed = placeLabels({ items, obstacles, bounds });
  assertClean(placed, obstacles);
  assert.ok(placed.every((p) => p.mode === 'badge'));
});

test('a label never sits on a box, even when that is the nearest spot', () => {
  const obstacles = [{ x: 150, y: 190, w: 100, h: 20 }];
  const placed = placeLabels({ items: [item(0, line, 100)], obstacles, bounds });
  assertClean(placed, obstacles);
});

test('badgeOnly items are never text', () => {
  const [a] = placeLabels({ items: [{ ...item(0), badgeOnly: true }], bounds });
  assert.equal(a.mode, 'badge');
});

test('an edge with no room at all is listed, not drawn', () => {
  const tiny = { x: 0, y: 0, w: 10, h: 10 };
  const [a] = placeLabels({ items: [item(0)], bounds: tiny });
  assert.equal(a.mode, 'listed');
  assert.equal(a.box, null);
});

test('placement is deterministic and follows the edge when it moves', () => {
  const run = (dy) => placeLabels({ items: [item(0, [{ x: 100, y: 200 + dy }, { x: 300, y: 200 + dy }])], bounds })[0].box;
  assert.deepEqual(run(0), run(0));
  assert.equal(run(40).y - run(0).y, 40);
});
