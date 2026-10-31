#!/usr/bin/env node
// Checks that this app is set up and running. Prints one line per check. Exit 1 if any check fails.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const port = process.env.PORT || '6880';
const sharedEnv = process.env.STANDALONE_ENV || path.join(os.homedir(), 'Development', '.env');
let failed = false;
const line = (ok, label, detail = '') => {
  if (!ok) failed = true;
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${label}${detail ? ` (${detail})` : ''}`);
};

line(Number(process.versions.node.split('.')[0]) >= 26, 'Node 26 or newer', process.version);

const hasFile = fs.existsSync(sharedEnv);
line(hasFile, 'shared settings file', sharedEnv);
const keys = hasFile ? fs.readFileSync(sharedEnv, 'utf8').split('\n').map((l) => l.split('=')[0]) : [];
line(keys.includes('PINGONE_ENVIRONMENT_ID'), 'PINGONE_ENVIRONMENT_ID is set in the shared file');

try {
  const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000) });
  const body = await res.json();
  line(body.schema === 'demo-health/1', 'app answers /api/health', `port ${port}, state ${body.state}`);
} catch {
  line(false, 'app answers /api/health', `nothing on port ${port}; run npm start`);
}
process.exit(failed ? 1 : 0);
