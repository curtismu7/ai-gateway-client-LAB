// labelPlacement.js - pure edge-label placement. No DOM, no React. Everything is in screen pixels.
//
// Each label gets its own spot along its own edge. A label is tried as text first. When no spot is free
// of other labels and of the boxes, it becomes a small numbered badge, and the text moves to a legend.
// When even a badge has no free spot (a zoomed-in view that shows none of the edge), it is only listed.

const T_STEPS = [0.5, 0.36, 0.64, 0.24, 0.76, 0.14, 0.86];
// How far from its own edge a label may sit, in label heights. Text stays next to its line; a badge may go one step further.
const SIDE_STEPS = { text: [0, 1, -1], badge: [0, 1, -1, 2, -2] };

const grow = (r, p) => ({ x: r.x - p, y: r.y - p, w: r.w + 2 * p, h: r.h + 2 * p });
export const intersects = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (r, b) => r.x >= b.x && r.y >= b.y && r.x + r.w <= b.x + b.w && r.y + r.h <= b.y + b.h;

/** Point at a fraction of the length of a polyline, with the unit normal of the segment it falls on. */
export function pointAt(points, frac) {
  if (points.length === 0) return null;
  if (points.length === 1) return { x: points[0].x, y: points[0].y, nx: 0, ny: -1 };
  const lens = [];
  let total = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const l = Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
    lens.push(l);
    total += l;
  }
  let want = total * frac;
  for (let i = 0; i < lens.length; i++) {
    if (want <= lens[i] || i === lens.length - 1) {
      const a = points[i], b = points[i + 1];
      const f = lens[i] === 0 ? 0 : Math.min(1, want / lens[i]);
      const dx = lens[i] === 0 ? 1 : (b.x - a.x) / lens[i], dy = lens[i] === 0 ? 0 : (b.y - a.y) / lens[i];
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, nx: -dy, ny: dx };
    }
    want -= lens[i];
  }
  return null;
}

function candidateBoxes(points, size, sides) {
  const out = [];
  const step = size.h + 2;
  for (const k of sides) {
    for (const t of T_STEPS) {
      const p = pointAt(points, t);
      if (!p) continue;
      const cx = p.x + p.nx * step * k, cy = p.y + p.ny * step * k;
      out.push({ box: { x: cx - size.w / 2, y: cy - size.h / 2, w: size.w, h: size.h }, anchor: { x: p.x, y: p.y }, leader: k !== 0 });
    }
  }
  return out;
}

/**
 * items: [{ id, points, text: {w,h}, badge: {w,h}, badgeOnly? }]   points = the edge as a screen-space polyline
 * badgeOnly: never draw this one as text (edges in a lane group, where text floating off a lane would be ambiguous)
 * obstacles: [{x,y,w,h}] boxes a label must stay off.   bounds: {x,y,w,h} the canvas.   pad: gap kept between labels.
 * Returns, in item order: { id, mode: 'text' | 'badge' | 'listed', box, anchor, leader }.
 */
export function placeLabels({ items, obstacles = [], bounds, pad = 4 }) {
  const result = new Map();
  const taken = [];
  const free = (box) => inside(box, bounds)
    && !obstacles.some((o) => intersects(grow(box, pad), o))
    && !taken.some((t) => intersects(grow(box, pad), t));
  const staticFree = (box) => inside(box, bounds) && !obstacles.some((o) => intersects(grow(box, pad), o));

  // Badge-only items go first: they have the least room, and text must not take it from them.
  const passes = [['badge', (it) => it.badgeOnly], ['text', (it) => !it.badgeOnly], ['badge', () => true]];
  for (const [kind, want] of passes) {
    const pending = items
      .filter((it) => !result.has(it.id) && want(it))
      .map((it) => {
        const cands = candidateBoxes(it.points, it[kind], SIDE_STEPS[kind]);
        return { it, cands, room: cands.filter((c) => staticFree(c.box)).length };
      })
      .sort((a, b) => a.room - b.room);
    for (const { it, cands } of pending) {
      const hit = cands.find((c) => free(c.box));
      if (!hit) continue;
      taken.push(hit.box);
      result.set(it.id, { id: it.id, mode: kind, box: hit.box, anchor: hit.anchor, leader: hit.leader });
    }
  }
  return items.map((it) => result.get(it.id) || { id: it.id, mode: 'listed', box: null, anchor: null, leader: false });
}
