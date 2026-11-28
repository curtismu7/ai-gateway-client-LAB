// What the Help dialog says. Plain, and as hedged as the rest of the lab (rule 2): what was measured, what is simulated, what is UNVERIFIED.
export const HELP_SECTIONS = [
  {
    heading: "What this lab is",
    body: "A local, no-login test client for an OAuth-protected MCP gateway — the kind that authenticates callers itself (OAuth Authorization Code + PKCE, with Dynamic Client Registration). It shows the same tool call through two paths: straight at the gateway (Privilege mode, policy enforced) and with no gateway in the path at all (Direct mode), so you can see exactly what the gateway adds. Both doors default to the public Ping AI Demo instance and work with zero setup; point either at your own MCP server/gateway when you are ready."
  },
  {
    heading: "Measured vs UNVERIFIED",
    body: "Mock mode is entirely simulated inside this app process: the sign-in, the gateway, its tool list and every tool result are mock-issued and labelled as mock. Live mode talks to the gateway URL you enter and the sign-in server that gateway advertises — sign-in and tool calls are real, and what the gateway does with them is whatever your gateway does; nothing here is verified against product documentation. No statement on this page is about real product defaults, detection quality or licensing."
  },
  {
    heading: "How to use the page",
    body: [
      "The source bar at the top holds the MCP server preset select, the \"MCP server URL\" field, \"Use this URL\", \"Sign in\" / \"Sign out\", \"Refresh\", \"Probe other doors\" and (live mode) \"Connect Privilege console\".",
      "The left column lists the door's catalog under the tabs \"Tools\", \"Resources\", \"Templates\", \"Prompts\" — including items hidden on the Privilege door, marked as such. Pick one to see its detail and, for a tool, fill its arguments and press \"Execute\".",
      "The right column output tabs: \"Response\", \"Request\", \"Relay log\", \"Trace\", \"Layers\", \"Flow\", \"Talk track\". For anything that is not tools/call, the middle column's \"Raw MCP request\" form (method + params JSON, \"Send\") speaks to the door directly."
    ]
  },
  {
    heading: "Mode honesty",
    body: "Mock: nothing leaves this machine (the page only fetches its fonts from Google Fonts); tokens and client ids shown are mock. Live: requests go to the gateway URL you entered and to the sign-in server it advertises, with real sign-in — switching to Live asks for confirmation (\"Switch to live\" / \"Stay in mock\"). Reset clears the relay: sessions, tokens and the relay log start over."
  }
];
