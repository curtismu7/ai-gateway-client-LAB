// The "What Privilege did" files (rule 25) are vendored byte for byte from the family's shared/gateway-trace (curtismu7/AI-DEMO-Standalone)
// and pinned by sha256: a hand-edited or stale copy fails here. Re-vendor (copy, never edit), then re-pin:
//   cd web/src/gateway-trace && shasum -a 256 GatewayTrace.jsx gateway-trace.css gateway-trace.test.jsx
// The server copy server/src/gatewayTrace.js is pinned by the same file, listed there as plain gatewayTrace.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = 'web/src/gateway-trace';
const WHERE = { 'GatewayTrace.jsx': WEB, 'gateway-trace.css': WEB, 'gateway-trace.test.jsx': WEB, 'gatewayTrace.js': 'server/src' };
// The canonical hashes (AI-DEMO-Standalone shared/gateway-trace, PR #282). A re-vendor updates these and gateway-trace.sha256 together.
const CANONICAL = {
  'GatewayTrace.jsx': '3f6f76d6c621afcb264da335cbea7ca9b70fb51f060d3d99bbd6810022db5b52',
  'gateway-trace.css': '945c779062e2e4bcbfd9a1f225b9f506fa2eb7ac28af61b6f5e110c44f5aa4d8',
  'gateway-trace.test.jsx': '8821f7a2d508ab01a9aa2ab2012b5d33534e33a35e7035dd8aedfa5e32ef1519',
  'gatewayTrace.js': 'c3178e7c5158adc248dc3e5e741b2df7cc38faab7f7141a4cce9514f85ffc42d',
};
const sha = (rel) => createHash('sha256').update(readFileSync(join(root, rel))).digest('hex');
const pins = readFileSync(join(root, WEB, 'gateway-trace.sha256'), 'utf8').split('\n').filter((l) => /^[0-9a-f]{64}\s/.test(l)).map((l) => l.split(/\s+/));

test('every vendored gateway-trace file matches its pinned sha256 and the canonical hash, and all four are pinned', () => {
  assert.deepEqual(pins.map(([, f]) => f).sort(), Object.keys(WHERE).sort());
  for (const [hash, file] of pins) {
    const actual = sha(`${WHERE[file]}/${file}`);
    assert.equal(actual, hash, `${file} differs from gateway-trace.sha256 (hand-edited, or re-vendored without re-pinning)`);
    assert.equal(actual, CANONICAL[file], `${file} differs from the canonical shared/gateway-trace`);
  }
});

test('the shared trace builder is vendored as server/src/gatewayTrace.js (trace.js is the W3C traceparent helper, a different file)', () => {
  assert.ok(existsSync(join(root, 'server/src/gatewayTrace.js')));
});

test("the panel imports the lab's own Rule 24 JsonPane, which exports setJsonView (the vendored test needs it)", () => {
  assert.match(readFileSync(join(root, WEB, 'GatewayTrace.jsx'), 'utf8'), /from "\.\.\/components\/JsonPane"/);
  assert.match(readFileSync(join(root, 'web/src/components/JsonPane.jsx'), 'utf8'), /export const setJsonView/);
});
