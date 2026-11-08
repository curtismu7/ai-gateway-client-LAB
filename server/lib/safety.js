'use strict';
// Host check (DNS-rebinding guard) and same-origin writes.
//  - Host: loopback, or a name in LAB_ALLOWED_HOSTS (the lab-proxy's name for this app), else 421 bad_host.
//  - Writes with an Origin: Origin host must equal Host, or the request came through the lab-proxy (see below). Cross-site is refused.

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

// Extra Host names this app answers to (family standard): LAB_ALLOWED_HOSTS, comma separated host names that point at this Mac,
// such as the lab-proxy's ai-gateway-client.local.ping-devops.com. Loopback always works; unset = loopback only.
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
function allowedHostsFrom(env = process.env) {
  const names = String(env.LAB_ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  for (const h of names) if (!HOSTNAME.test(h)) throw new Error(`LAB_ALLOWED_HOSTS: not a host name: ${h}`);
  return new Set(names);
}

const hostName = (hostHeader) => String(hostHeader || '').trim().toLowerCase().replace(/:\d+$/, '');

function makeGuard(allowedHosts = new Set()) {
  return function hostAndOriginGuard(req, res, next) {
    const hostname = hostName(req.headers.host);
    if (!LOOPBACK_HOSTNAMES.has(hostname) && !allowedHosts.has(hostname)) return res.status(421).json({ error: 'bad_host' });
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return res.status(403).json({ error: 'cross_origin_write' });
      if (req.headers.origin) {
        let origin = null;
        try { origin = new URL(req.headers.origin).host; } catch { /* keep null */ }
        // Behind the lab-proxy the browser's origin is the proxy's public one (local.ping-devops.com:8443) while Host is this app's
        // own name. The proxy sets X-Forwarded-Host/-Proto; they are believed only when Host is one of the allowed names (loopback
        // does not count), so a request that did not come through the proxy cannot use them.
        const xfh = String(req.headers['x-forwarded-host'] || '').toLowerCase();
        const xfp = String(req.headers['x-forwarded-proto'] || 'https').toLowerCase();
        const proxied = allowedHosts.has(hostname) && xfh !== '' && (xfp === 'https' || xfp === 'http') && req.headers.origin === `${xfp}://${xfh}`;
        if (origin !== req.headers.host && !proxied) return res.status(403).json({ error: 'cross_origin_write' });
      }
    }
    next();
  };
}

module.exports = { allowedHostsFrom, makeGuard, LOOPBACK_HOSTNAMES };
