# Agent Privilege Client LAB

A local, no-login test client for an OAuth-protected MCP gateway. Shows one tool call through the gateway and directly, so the policy difference is visible.

## Run and test

```sh
npm install --prefix server
npm test --prefix server
```

## Rules that bite

- No real tenant ids, client ids, customer names or internal hostnames. Use `.example` or `.invalid` hosts only.
- Never commit `.env` files or keys. Copy `.env.example` and fill it in locally.
- Mock mode works fully offline. Live mode is optional.
