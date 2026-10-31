// viewFit.js - pure view-fit math for the flow diagram. No DOM, no React.
//
// The fit picks the largest zoom that shows every box, but never a zoom that renders the smallest box text
// below LEGIBLE_PX on screen. When the canvas is too small for that, the zoom stops at the floor, the
// diagram is anchored to the top left, and the user pans to the rest (a drag, or the scroll bar of the panel).

// Smallest box text, in CSS pixels, as FlowDiagram.css sets it (.flow-node__sub). A test keeps the two in step.
export const BOX_MIN_FONT_PX = 14;
// The least a box text may measure on screen. A hair over 10 so rounding never reads 9.9.
export const LEGIBLE_PX = 10.1;
// Space kept round the boxes, in screen pixels.
export const FIT_PAD = 8;
export const MAX_ZOOM = 1.5;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** The lowest zoom at which text of fontPx still measures targetPx on screen. */
export function legibleZoom(fontPx = BOX_MIN_FONT_PX, targetPx = LEGIBLE_PX) {
  return fontPx > 0 ? targetPx / fontPx : 0;
}

/** Bounding box of rectangles { x, y, w, h }, or null for none. */
export function boundsOf(rects) {
  if (!rects || rects.length === 0) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// One axis: centre the content when it fits, otherwise anchor its start at the padding.
function place(boundsStart, boundsLen, size, zoom, pad) {
  const content = boundsLen * zoom;
  const offset = content + 2 * pad <= size ? (size - content) / 2 : pad;
  return offset - boundsStart * zoom;
}

/**
 * bounds: {x,y,w,h} of the boxes in flow units. size: {w,h} of the canvas in screen pixels.
 * Returns { x, y, zoom, clipped }. clipped is true when the floor stopped the zoom and part of the diagram is off canvas.
 */
export function fitViewport({ bounds, size, pad = FIT_PAD, minZoom = legibleZoom(), maxZoom = MAX_ZOOM }) {
  if (!bounds || !size || size.w <= 0 || size.h <= 0 || bounds.w <= 0 || bounds.h <= 0) return null;
  const fit = Math.min((size.w - 2 * pad) / bounds.w, (size.h - 2 * pad) / bounds.h);
  const zoom = clamp(fit, minZoom, maxZoom);
  return {
    x: place(bounds.x, bounds.w, size.w, zoom, pad),
    y: place(bounds.y, bounds.h, size.h, zoom, pad),
    zoom,
    clipped: fit < minZoom,
  };
}

/** Should a change of canvas size refit the view? Not when the user moved or zoomed it, or the size did not change. */
export function shouldRefit({ moved, prev, next }) {
  if (moved) return false;
  if (!next || next.w <= 0 || next.h <= 0) return false;
  return !prev || prev.w !== next.w || prev.h !== next.h;
}

/** Remembers whether the user has moved or zoomed the view since the last fit. */
export function createFitTracker() {
  let moved = false;
  return {
    fitted() { moved = false; },
    userMoved() { moved = true; },
    get moved() { return moved; },
  };
}

/** Calls fn once, ms after the last call. cancel() drops a pending call. */
export function debounce(fn, ms) {
  let timer = null;
  const wrapped = (...args) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(...args); }, ms);
  };
  wrapped.cancel = () => { if (timer !== null) { clearTimeout(timer); timer = null; } };
  return wrapped;
}
