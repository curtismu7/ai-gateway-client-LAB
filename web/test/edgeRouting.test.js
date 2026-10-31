import test from 'node:test';
import assert from 'node:assert/strict';
import { routeEdges, polylinePath, simplify } from '../src/lib/edgeRouting.js';

// The same four boxes as diagrams/auth-code-pkce.json.
const rects = [
  { id: 'user', x: 0, y: 0, w: 200, h: 96 },
  { id: 'client', x: 400, y: 0, w: 200, h: 96 },
  { id: 'as', x: 800, y: 0, w: 200, h: 96 },
  { id: 'api', x: 800, y: 320, w: 200, h: 96 },
];
const edges = [
  { source: 'client', target: 'as' },
  { source: 'user', target: 'as' },
  { source: 'as', target: 'client' },
  { source: 'client', target: 'as' },
  { source: 'as', target: 'client' },
  { source: 'client', target: 'api' },
];

test('edges that join the same two boxes get different lanes, so they no longer share a path', () => {
  const routes = routeEdges(rects, edges);
  const pair = [0, 2, 3, 4].map((i) => routes[i]);
  assert.ok(pair.every((r) => r.lanes === 4));
  assert.equal(new Set(pair.map((r) => r.points[0].y)).size, 4, 'four different heights');
  assert.equal(new Set(pair.map((r) => r.lane)).size, 4);
});

test('lanes stay inside the side of the box', () => {
  const routes = routeEdges(rects, edges);
  for (const i of [0, 2, 3, 4]) {
    for (const p of routes[i].points) assert.ok(p.y > 0 && p.y < 96);
  }
});

test('an edge that would cross a third box goes over it', () => {
  const r = routeEdges(rects, edges)[1];
  assert.ok(r.points.every((p) => p.y <= 0), 'stays above the row of boxes');
  assert.ok(r.points.some((p) => p.y < 0));
});

test('a box below and to the side is reached from the bottom, not through the lanes', () => {
  const r = routeEdges(rects, edges)[5];
  assert.equal(r.points[0].y, 96);
  assert.equal(r.points[r.points.length - 1].y, 320);
});

test('routes follow the boxes when one moves', () => {
  const moved = rects.map((r) => (r.id === 'as' ? { ...r, y: 200 } : r));
  const a = routeEdges(rects, edges)[0];
  const b = routeEdges(moved, edges)[0];
  assert.notDeepEqual(a.points, b.points);
});

test('every segment is horizontal or vertical', () => {
  for (const r of routeEdges(rects, edges)) {
    for (let i = 0; i + 1 < r.points.length; i++) {
      assert.ok(r.points[i].x === r.points[i + 1].x || r.points[i].y === r.points[i + 1].y);
    }
  }
});

test('simplify drops repeats and straight-through points; polylinePath starts and ends on the ends', () => {
  const pts = simplify([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);
  assert.equal(pts.length, 3);
  const d = polylinePath(pts);
  assert.ok(d.startsWith('M 0 0') && d.endsWith('L 10 10'));
});

test('an edge to an unknown box gives an empty route instead of throwing', () => {
  assert.deepEqual(routeEdges(rects, [{ source: 'user', target: 'nope' }])[0].points, []);
});
