# Agent Privilege Client LAB

A local, no-login test client for an OAuth-protected MCP gateway. Shows one tool call through the gateway and directly, so the policy difference is visible.

## Run and test

```sh
npm install --prefix server
npm test --prefix server
npm install --prefix web
npm test --prefix web
```

## Rules that bite

- No real tenant ids, client ids, customer names or internal hostnames. Use `.example` or `.invalid` hosts only.
- Never commit `.env` files or keys. Copy `.env.example` and fill it in locally.
- Mock mode works fully offline. Live mode is optional and owner-run. Mock mode must make zero outbound requests: every outbound call goes through `server/lib/netguard.js`.
- Tests run on Node 26. Relay tests set `MODE=live` because they drive a loopback MCP server.
- Flow diagram labels: `web/src/lib/labelPlacement.js` and `edgeRouting.js` are pure and unit-tested (`npm test --prefix web`). Do not draw edge labels with ReactFlow's own `label`: edges between the same two boxes share a path and the labels pile up. Check a diagram change with the overlap detector in the AI-DEMO-Standalone repo (`scripts/diagram-overlap.js`).
- Flow diagram view: `web/src/lib/viewFit.js` is pure and unit-tested. The fit never zooms out past the point where box text measures 10px on screen (`BOX_MIN_FONT_PX` must equal the smallest box font in `FlowDiagram.css`; a test checks it), so a narrow panel is panned, not shrunk. The diagram data is a compact 2 by 2 loop (boxes 160 wide) so the whole diagram fits a 375px phone at that floor (`web/test/diagramLayout.test.js`); a canvas that is still too small is panned, and Simulate pans to the boxes of each step. The shell stacks its columns at 900px, so the Flow panel is never squeezed into a sliver. A canvas resize refits only if the user has not moved or zoomed the view since the last fit; Fit and Reset always refit.
- What Privilege did (Rule 25, owner 2026-11-15): the **Trace** tab (`web/src/components/TracePanel.jsx`) draws the shared `GatewayTrace` for the newest action, read from `GET /api/gateway/trace`. `server/lib/gatewayTraceLog.js` records each exchange from `relay.js` `fetchMcp` (the one place every door call passes) and builds it with the shared builder `server/src/gatewayTrace.js`. The panel, its css, its test and the builder are vendored byte for byte from AI-DEMO-Standalone `shared/gateway-trace/`, pinned by `web/src/gateway-trace/gateway-trace.sha256` and `web/test/gateway-trace.pin.test.js`, and never edited here (`trace.js` is the W3C traceparent helper, a different file). The routes that make door calls (`tools/list`, `tools/call`, `catalog`, `request`, `rpc`, `doors/probe`) are wrapped in `gatewayTrace.traced(...)` (AsyncLocalStorage, placed after `express.json()`), which groups the handshake and the call into one action; the routes still return the raw reply, the trace is never added to it. HONESTY RULE: Mock decisions come from `mockGateway.js` (`handle(url, { checks })` fills the array as it decides: token, grant, list filter) and are `checked`; Real decisions come from the shared `realDecisions` and are only `inferred` (status) or `observed` (the reply, `_meta.denied*`), never `checked`; the Direct door has no gateway, so its calls get one `info` line. A trace never holds the access, refresh or client secret (the Authorization line shows only a length; every string is scrubbed of every secret the session holds), the full MCP or procyon session id (shortened), or response headers outside an allowlist. Ring: the newest 5 actions, cleared by Reset and a mode change. Tests: `server/gateway-trace.test.js` (Mock), `server/gateway-trace-real.test.js` (Real, loopback fake gateway), `web/src/test/trace-panel.test.jsx`, `web/src/gateway-trace/gateway-trace.test.jsx` (vendored). Real mode against the live Privilege gateway is UNVERIFIED (owner-run).
