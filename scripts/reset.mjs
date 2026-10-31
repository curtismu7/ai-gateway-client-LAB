#!/usr/bin/env node
// Clears the app's session, event stream and cached client registrations. Usage: npm run reset
const port = process.env.PORT || '6880';
try {
  const res = await fetch(`http://127.0.0.1:${port}/api/reset`, { method: 'POST', signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  console.log('reset: session, event stream and client registrations cleared');
} catch (err) {
  console.error(`reset failed on port ${port}: ${err.message}. Is the app running?`);
  process.exit(1);
}
