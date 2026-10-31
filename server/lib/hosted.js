'use strict';
// hosted.js — optional hosted defaults from the shared ~/Development/.env.
// HOSTED_MCPGW_URL is the hosted Privilege gateway origin; HOSTED_HOSTILE_MCP_URL is the hosted
// hostile MCP fixture. Both must be https. Unset or invalid means no hosted default (the callers
// fall back to their own). Explicit PRIVILEGE_GATEWAY_HOST / DIRECT_HOSTILE_MCP_URL still win.

function httpsOrigin(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'https:' ? url.origin : '';
  } catch {
    return '';
  }
}

const gatewayHost = (env = process.env) => httpsOrigin(env.HOSTED_MCPGW_URL);

function hostileMcpUrl(env = process.env) {
  const origin = httpsOrigin(env.HOSTED_HOSTILE_MCP_URL);
  return origin ? `${origin}/mcp` : '';
}

module.exports = { gatewayHost, hostileMcpUrl };
