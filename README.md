# Agent Privilege Client LAB

Tier: Tester


A local, no-login test client for an OAuth-protected [MCP](https://modelcontextprotocol.io) gateway — the kind that authenticates callers itself (OAuth Authorization Code + PKCE, with Dynamic Client Registration for callers it's never seen before) rather than trusting a static API key. Defaults to [PingOne's Agent Privilege](https://www.pingidentity.com), which works out of the box against the public Ping AI Demo instance with zero setup.

It shows the same tool call through two paths — **straight at the gateway** (Privilege mode, policy enforced) and **no gateway in the path at all** (Direct mode) — so you can see exactly what the gateway adds: the same call succeeding, being refused, or being logged, depending only on which door you went through. Both doors default to the public Ping AI Demo instance and work with zero setup; point either at your own MCP server/gateway when you're ready.

Repo: https://github.com/ping-sandbox/ai-gateway-client-LAB

## Installation

**Prerequisites:** Node.js 22+ and npm. Docker is optional (a `Dockerfile` is included).

### Run from a clone

```bash
git clone https://github.com/ping-sandbox/ai-gateway-client-LAB.git
cd ai-gateway-client-LAB
npm install --prefix server
npm install --prefix web
npm run build --prefix web
npm start                      # mock mode on http://127.0.0.1:6880
```

```bash
git clone https://github.com/ping-sandbox/ai-gateway-client-LAB.git
cd ai-gateway-client
npm run install:all   # installs both server/ and web/
npm start              # builds the UI, then starts the server on :6880 (mock mode)
```

Verify it's up:

```bash
curl http://127.0.0.1:6880/api/health
```

Then open http://127.0.0.1:6880. It defaults to the **Privilege** door on the public Ping AI Demo gateway — click **Sign in** and complete the OAuth flow in your browser (no client registration needed; the tool registers itself with the gateway on the fly via RFC 7591 Dynamic Client Registration). Switch to the **Direct** door to make the same call with no gateway in front — it defaults to the same demo's façade, which is a separate self-advertising, open-registration broker, so it also needs no setup.

## What it does

- **OAuth PKCE + DCR** — discovers the gateway's own authorization server (RFC 9728 protected-resource metadata, or a `WWW-Authenticate` challenge), registers itself as a client if the gateway doesn't already trust one (RFC 7591), and runs the PKCE Authorization Code flow. Falls back to plain PingOne OIDC discovery if you point it at an environment id instead.
- **Tools** — `tools/list` / `tools/call`, with a policy summary (how many tools were filtered by the gateway vs. permitted).
- **Raw MCP requests** — anything that isn't `tools/call`: resources, prompts, completion, tasks.
- **Doors probe** — "denied here — does this identity work anywhere else?" Tries the current token against every other configured door in one click. A `401` can mark a different OAuth audience; a `403` can indicate a policy denial.
- **Relay log** — every request/response this tool sends and receives, live over SSE, so you can see exactly what went over the wire.
- **Privilege console door discovery** (optional) — paste your Privilege console session's `auth_token` cookie to pull in every Agentic App and policy registered on your environment as selectable doors, no code change or redeploy needed.

## Mock and live mode

The header has a **Mock / Live** toggle on every page. The server decides the mode (`MODE=mock` is the default; `MODE=live` in the environment is treated as your own confirmed choice). Switching to Live at runtime asks for a confirm.

- **Mock (default, offline).** Sign-in is a PKCE + Dynamic Client Registration flow against an in-process mock issuer (the browser's authorize step is this app's own `/api/gateway/mock-idp/authorize`). The mock MCP gateway serves four OpenSearch-style tools, and its Privilege-style door filters two more by policy, so a `delete_index` call is refused with 403. Tool results are generated in-process and labelled simulated. Tokens are mock-issued and labelled mock. Nothing leaves the machine.
- **Live (owner-run).** Contacts the gateway URL you enter, and the sign-in server that gateway advertises, with real sign-in and real tool calls. Privilege console features are live only.
- **Flow tab.** The sign-in sequence is drawn from the shared diagram-studio data in `diagrams/auth-code-pkce.json`, with Simulate, Reset and a speed control, plus zoom and fit buttons. Arrows between the same two boxes each get their own lane. Arrow labels are placed so none overlap or sit on a box; one that does not fit becomes a numbered badge, and its text is listed under the diagram. Labels follow their arrow when you drag a box.
- **Netguard** (`server/lib/netguard.js`). Every outbound request goes through it. In mock mode no outbound request is made, and `GET /api/gateway/netguard` runs a self-test of the policy. In live mode it allows https (loopback http only), only the origin you typed or the gateway advertised, refuses link-local and metadata addresses, follows only same-origin redirects, and caps time (20 s) and size (2 MB).

## Config

Copy `server/.env.example` to `server/.env`. Nothing is required to try either door against the public demo — set `PRIVILEGE_GATEWAY_HOST` (and friends) to point Privilege mode at your own Agent Privilege, or `DIRECT_MCP_URL` to point Direct mode at any other MCP server you run.

Optional hosted defaults, in the shared settings file: `HOSTED_MCPGW_URL` (an https gateway origin; used for the Privilege doors when `PRIVILEGE_GATEWAY_HOST` is not set) and `HOSTED_HOSTILE_MCP_URL` (an https origin; its `/mcp` becomes the Direct hostile preset when `DIRECT_HOSTILE_MCP_URL` is not set). Ask the owner for the values. Mock mode ignores both. Unset means the defaults below.

### Live integration tests

Run with `MODE=live` (the live suite contacts real gateways). The opt-in live suite checks configured Gateway allow/deny behavior with door-scoped OAuth tokens. The interactive runner signs in to both app audiences with the same test identity and keeps each bearer in memory. For setup and safe fixture requirements, see [`server/INTEGRATION_TESTS.md`](server/INTEGRATION_TESTS.md).

### Red-team demo: the hostile MCP server

Two doors ship for the hostile MCP server (`standalone/hostile-mcp-server`, behind Privilege as the `libre` app):

- **Privilege — libre** — through the gateway. Its `tools/list` shows the poisoned tools arriving, and a `create_transfer` call is denied by the app's policy.
- **Direct — Hostile MCP (no Privilege)** — the raw server, no gateway. Run it first: `cd standalone/hostile-mcp-server && npm start` (defaults to `http://127.0.0.1:8899/`; override with `DIRECT_HOSTILE_MCP_URL`, or set `HOSTED_HOSTILE_MCP_URL`).

Switch between the two on the same call to see exactly what Privilege adds. See `docs/superpowers/specs/2026-09-13-hostile-mcp-behind-privilege-design.md`.

## Tests

```bash
npm test --prefix server   # node:test, run on Node 22; mock-mode tests prove zero outbound attempts
```

## Development

```bash
npm run install:all
npm run dev   # server on :6880 (API), Vite dev server on :5174 (UI)
```

The OAuth callback URL is derived from whichever host the browser used to reach the API, so DCR-based sign-in (the default, self-registering path) works the same in dev or prod. If you configure a **static** client id instead (no DCR), register both `http://127.0.0.1:6880/api/gateway/auth/callback` and `http://127.0.0.1:5174/api/gateway/auth/callback` as redirect URIs, or just test against the production build (`npm start`).

## Docker

```bash
docker build -t ai-gateway-client .
docker run -p 127.0.0.1:6880:6880 -v ai-gateway-client-data:/root/.ai-gateway-client ai-gateway-client
```

## Not included

Adapted from a larger internal tool that also compared LLM-call policy enforcement (chat completions through a separate "Privilege LLM Gateway" lane vs. direct-to-provider) and a third "Façade" door mode that proxied through this same tool's own durable OAuth broker so a standalone MCP client's registration survived a gateway restart. Both depend on hosting infrastructure this standalone tool doesn't have, so they were left out — this build is scoped to the MCP tool-calling gateway itself.

## Ports, and what to do if the port is taken

This app listens on **6880** (set with `PORT`). Port range for this app: 6880-6889.

If the port is taken:
1. Find what is using it: `lsof -iTCP:<port> -sTCP:LISTEN -n -P`
2. If it is an old copy of this app, stop that process: `kill <PID>`
3. If it is something else, stop it, or start this app on another port: `PORT=6881 npm start`
4. Do not use 8080, 5173, 3000, 4000, 4400, 4510, 4600-4601, 18080, 19080 or 19090. Other demos and tools use them.
