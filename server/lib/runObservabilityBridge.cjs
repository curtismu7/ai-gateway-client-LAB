'use strict';
// CJS bridge over the vendored ESM core (server/src/runObservability.mjs, byte-identical with the pin). The bridge is
// loaded lazily and cached; a lab that needs it synchronously awaits bridgeReady first.
let core = null;
const bridgeReady = import('./runObservability.js').then((m) => { core = m; });
const proxy = new Proxy({}, {
  get(_, key) {
    if (!core) throw new Error('runObservability.cjs: the ESM core is not loaded yet; await bridgeReady first');
    return core[key];
  },
  has(_, key) { return core ? key in core : false; },
});
module.exports = proxy;
module.exports.bridgeReady = bridgeReady;
module.exports.__setCore = (m) => { core = m; };
