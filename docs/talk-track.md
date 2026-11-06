# Talk track: Agent Privilege Client LAB

Each `##` heading is one presenter step. This is a Tester-tier tool: the story is one tool call through two doors, with the gateway's policy difference made visible. Mock mode is the default and fully offline.

## This is simulated

Point at the Mock/Live toggle in the header. The server decides the mode, and Mock is the default: the issuer, the gateway and the tool results are all in-process, labelled simulated or mock, and zero requests leave the machine. Stay in Mock for the demo; Live is owner-run.

## Two doors, one call

The whole premise is on the source bar: the same tool call made through the **Privilege** door (policy enforced at the gateway) and the **Direct** door (no gateway in the path at all). Say it plainly: what changes is not the call, it is which door you walk through.

## Sign in with no setup

Click **Sign in** on the Privilege door. The tool discovers the gateway's authorization server, registers itself on the fly with Dynamic Client Registration (RFC 7591), and runs OAuth Authorization Code + PKCE. No client id to paste in — the app registers itself.

## Watch the flow

Open the **Flow** tab. It draws the sign-in sequence as a diagram with Simulate, Reset and a speed control. Press Simulate and narrate the loop: authorize, code, token, call.

## List the tools on both doors

Open the **Tools** tab. The counts line shows both doors side by side — in the default sample, the Privilege door shows 4 tools and the Direct door shows 6, because the gateway hides the 2 admin tools by policy. The same server, seen through two doors.

## Make the denied call

Call the admin tool (in the Standard sample, `delete_index`). Through the Privilege door it is refused with 403 by policy; through the Direct door the same call succeeds. This contrast is the takeaway of the whole demo.

## See what else the gateway filters

Open the **Resources**, **Templates** and **Prompts** tabs. Each has its own badge and counts, and the policy summary says what the gateway hid vs. permitted. A server that does not offer one of them shows "Not supported by this server" — switch the Mock sample to Minimal to show that.

## Turn up the policy

Switch the **Mock sample** list to **Policy-heavy**. The Direct door lists all 14 ledger tools; the Privilege door lists 5 and reports 9 hidden by policy, plus hidden resources and prompts. This is the sample for a "what does policy actually buy me" question.

## Try a poisoned server (red team)

Switch the source bar to the hostile MCP presets: **Privilege — libre** through the gateway, where the poisoned tools arrive but a `create_transfer` call is denied; then **Direct — Hostile MCP** against the raw server, where nothing stops it. Say: the gateway is the control point.

## Ask "denied here — does it work anywhere else?"

Press the **Doors probe**. It tries the current token against every other configured door in one click. A 401 suggests a different OAuth audience; a 403 suggests a policy denial. Useful when someone asks how a stolen token spreads.

## Show the wire

Open the **Relay log**. Every request and response this tool sent and received, live over SSE. Nothing to take on faith — the evidence is on the screen.

## Reset

`npm run reset` (or Reset in the UI) puts the mode, sample and sign-in state back to defaults: Mock, Standard sample. Do it between sessions so the next run starts clean.
