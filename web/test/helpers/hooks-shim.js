// A stand-in for 'react' used only by verify-mark-header.test.js. The lab's web tests run on plain `node --test` with no DOM library
// (and no new dependencies are allowed), so VerifyMark's own useState / useEffect are driven here by hand: one component, one slot per hook.
let slots = [];
let cursor = 0;
let effects = [];
export const harness = {
  reset() { slots = []; cursor = 0; effects = []; },
  begin() { cursor = 0; effects = []; },
  takeEffects() { const e = effects; effects = []; return e; },
};
export function useState(initial) {
  const i = cursor++;
  if (!(i in slots)) slots[i] = initial;
  return [slots[i], (v) => { slots[i] = v; }];
}
export function useEffect(fn) { cursor++; effects.push(fn); }
export default { useState, useEffect };
