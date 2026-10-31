// edgeRouting.js - pure geometry for the flow diagram. No DOM, no React.
// Edges that join the same two boxes get their own lane, so they stop sharing one path
// (the cause of labels piling up). An edge that would run through a third box goes over or under it.

const LANE_GAP = 18;      // preferred distance between two lanes, in flow units
const EDGE_MARGIN = 8;    // keep a lane this far from the corner of a box
const DETOUR = 40;        // how far above or below the boxes a detour runs
const BLOCK_PAD = 6;      // an edge may not come this close to a box it does not touch

const centre = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function segmentHitsRect(a, b, r, pad) {
  const x0 = r.x - pad, y0 = r.y - pad, x1 = r.x + r.w + pad, y1 = r.y + r.h + pad;
  // Edges here are horizontal or vertical, so a bounding-box test is exact.
  const sx0 = Math.min(a.x, b.x), sx1 = Math.max(a.x, b.x);
  const sy0 = Math.min(a.y, b.y), sy1 = Math.max(a.y, b.y);
  return sx1 > x0 && sx0 < x1 && sy1 > y0 && sy0 < y1;
}

function blocked(points, rects) {
  for (let i = 0; i + 1 < points.length; i++) {
    for (const r of rects) if (segmentHitsRect(points[i], points[i + 1], r, BLOCK_PAD)) return true;
  }
  return false;
}

/** Drops repeated points and the middle point of three in a straight line. */
export function simplify(points) {
  const out = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && last.x === p.x && last.y === p.y) continue;
    out.push(p);
  }
  return out.filter((p, i) => {
    if (i === 0 || i === out.length - 1) return true;
    const a = out[i - 1], b = out[i + 1];
    return !((a.x === p.x && p.x === b.x) || (a.y === p.y && p.y === b.y));
  });
}

function direct(axis, S, T, o) {
  const s = centre(S), t = centre(T);
  if (axis === 'h') {
    const right = t.x >= s.x;
    const a = { x: right ? S.x + S.w : S.x, y: s.y + clamp(o, -(S.h / 2 - EDGE_MARGIN), S.h / 2 - EDGE_MARGIN) };
    const b = { x: right ? T.x : T.x + T.w, y: t.y + clamp(o, -(T.h / 2 - EDGE_MARGIN), T.h / 2 - EDGE_MARGIN) };
    const mx = (a.x + b.x) / 2;
    return [a, { x: mx, y: a.y }, { x: mx, y: b.y }, b];
  }
  const down = t.y >= s.y;
  const a = { x: s.x + clamp(o, -(S.w / 2 - EDGE_MARGIN), S.w / 2 - EDGE_MARGIN), y: down ? S.y + S.h : S.y };
  const b = { x: t.x + clamp(o, -(T.w / 2 - EDGE_MARGIN), T.w / 2 - EDGE_MARGIN), y: down ? T.y : T.y + T.h };
  const my = (a.y + b.y) / 2;
  return [a, { x: a.x, y: my }, { x: b.x, y: my }, b];
}

function detour(side, S, T, o) {
  const s = centre(S), t = centre(T);
  const ax = s.x + clamp(o, -(S.w / 2 - EDGE_MARGIN), S.w / 2 - EDGE_MARGIN);
  const bx = t.x + clamp(o, -(T.w / 2 - EDGE_MARGIN), T.w / 2 - EDGE_MARGIN);
  if (side === 'top') {
    const y = Math.min(S.y, T.y) - DETOUR - Math.abs(o);
    return [{ x: ax, y: S.y }, { x: ax, y }, { x: bx, y }, { x: bx, y: T.y }];
  }
  const y = Math.max(S.y + S.h, T.y + T.h) + DETOUR + Math.abs(o);
  return [{ x: ax, y: S.y + S.h }, { x: ax, y }, { x: bx, y }, { x: bx, y: T.y + T.h }];
}

/**
 * Routes every edge.
 * rects: [{ id, x, y, w, h }] in flow units. edges: [{ source, target }].
 * Returns one { points, lane, lanes } per edge, in edge order. points is an orthogonal polyline.
 */
export function routeEdges(rects, edges) {
  const byId = new Map(rects.map((r) => [r.id, r]));

  // Lanes: edges that join the same two boxes, forward ones first, each in its own lane.
  const groups = new Map();
  edges.forEach((e, i) => {
    const key = [e.source, e.target].sort().join('\u0000');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  });
  const lane = new Array(edges.length).fill(0);
  const lanes = new Array(edges.length).fill(1);
  for (const idxs of groups.values()) {
    const sorted = idxs.slice().sort((a, b) => {
      const da = edges[a].source > edges[a].target ? 1 : 0;
      const db = edges[b].source > edges[b].target ? 1 : 0;
      return da - db || a - b;
    });
    sorted.forEach((i, k) => { lane[i] = k; lanes[i] = sorted.length; });
  }

  return edges.map((e, i) => {
    const S = byId.get(e.source), T = byId.get(e.target);
    if (!S || !T) return { points: [], lane: 0, lanes: 1 };
    const gapX = Math.max(T.x - (S.x + S.w), S.x - (T.x + T.w), 0);
    const gapY = Math.max(T.y - (S.y + S.h), S.y - (T.y + T.h), 0);
    const axis = gapY > gapX ? 'v' : 'h';
    // Lanes are spread along the side of the box the edge meets, and kept inside the shorter of the two boxes.
    const n = lanes[i];
    const span = (axis === 'h' ? Math.min(S.h, T.h) : Math.min(S.w, T.w)) - 2 * EDGE_MARGIN;
    const gap = n > 1 ? Math.min(LANE_GAP, span / (n - 1)) : 0;
    const o = (lane[i] - (n - 1) / 2) * gap;
    const others = rects.filter((r) => r.id !== e.source && r.id !== e.target);
    const candidates = [direct(axis, S, T, o), detour('top', S, T, o), detour('bottom', S, T, o)];
    const pick = candidates.find((c) => !blocked(c, others)) || candidates[0];
    return { points: simplify(pick), lane: lane[i], lanes: n };
  });
}

/** SVG path text for a polyline, with rounded corners. */
export function polylinePath(points, radius = 8) {
  if (points.length === 0) return '';
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i], a = points[i - 1], b = points[i + 1];
    const la = Math.hypot(p.x - a.x, p.y - a.y), lb = Math.hypot(b.x - p.x, b.y - p.y);
    const r = Math.min(radius, la / 2, lb / 2);
    const p1 = { x: p.x + ((a.x - p.x) / la) * r, y: p.y + ((a.y - p.y) / la) * r };
    const p2 = { x: p.x + ((b.x - p.x) / lb) * r, y: p.y + ((b.y - p.y) / lb) * r };
    d += ` L ${p1.x} ${p1.y} Q ${p.x} ${p.y} ${p2.x} ${p2.y}`;
  }
  const last = points[points.length - 1];
  return `${d} L ${last.x} ${last.y}`;
}
