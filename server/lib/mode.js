'use strict';
// mode.js — the server decides whether this run is MOCK (in-process, offline,
// the default) or LIVE (contacts the gateway the user typed; owner-run).
// The browser only asks; a switch to live at runtime needs an explicit confirm.

const MODES = ['mock', 'live'];

let current = MODES.includes(process.env.MODE) ? process.env.MODE : 'mock';
// MODE=live in the environment is the owner's own explicit choice, so it counts as confirmed.
let liveConfirmed = current === 'live';

function currentMode() {
  return current;
}

function isMock() {
  return current === 'mock';
}

function isLiveConfirmed() {
  return liveConfirmed;
}

/** Returns null on success, or an error code string. Switching to live needs confirm === true. */
function setMode(next, { confirm = false } = {}) {
  if (!MODES.includes(next)) return 'bad_mode';
  if (next === 'live') {
    if (confirm !== true) return 'confirm_required';
    liveConfirmed = true;
  } else {
    liveConfirmed = false;
  }
  current = next;
  return null;
}

module.exports = { MODES, currentMode, isMock, isLiveConfirmed, setMode };
