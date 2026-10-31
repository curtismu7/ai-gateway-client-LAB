# Agent Privilege Client LAB

A local, no-login test client for an OAuth-protected MCP gateway. Shows one tool call through the gateway and directly, so the policy difference is visible.

## Run and test

```sh
npm install --prefix server
npm test --prefix server
npm test --prefix web
```

## Rules that bite

- No real tenant ids, client ids, customer names or internal hostnames. Use `.example` or `.invalid` hosts only.
- Never commit `.env` files or keys. Copy `.env.example` and fill it in locally.
- Mock mode works fully offline. Live mode is optional and owner-run. Mock mode must make zero outbound requests: every outbound call goes through `server/lib/netguard.js`.
- Tests run on Node 26. Relay tests set `MODE=live` because they drive a loopback MCP server.
- Flow diagram labels: `web/src/lib/labelPlacement.js` and `edgeRouting.js` are pure and unit-tested (`npm test --prefix web`). Do not draw edge labels with ReactFlow's own `label`: edges between the same two boxes share a path and the labels pile up. Check a diagram change with the overlap detector in the AI-DEMO-Standalone repo (`scripts/diagram-overlap.js`).
