# Host compatibility record

Evidence snapshot: **4 November 2026**. Observations are specific to the tested versions and
transport. This is not a claim about every ChatGPT/Claude surface or future release.

| Surface | Evidence | Status / next check |
|---|---|---|
| Standalone loopback browser UI | Shared renderer tests; HTTP plan/query integration; synthetic demo smoke | Primary reproducible entry point; no desktop host needed |
| Claude Desktop 4.4212.0 on Windows | Real log session on 3 November: enrolled origin, plan 201 using Grok, query 200 with one authorized row | Direct channel observed working; explicit visual values and current model-context challenge remain open |
| ChatGPT Desktop local Codex host, build 26.1027.6604.0 | View and native origin observed; actual console reports CSP rejection of loopback HTTP | HTTP blocked in this build; HTTPS inside the real host is not yet verified |
| Gateway HTTPS, local clients | Explicit certificate validation, CORS, plan/query and real stdio TLS tests | Implemented; fixture trust is per test connection, not an OS installation |
| Ordinary ChatGPT chat/plugin deployment | No completed AUG deployment | Separate deployment/authentication work; do not infer support from local Codex configuration |
| Other hosts / OS combinations | Automated CI is configured for Windows/Linux, Node 22/24 | Community reproduction requested; configured jobs are not evidence until they run |

The local MCP launcher is `apps/mcp-apps-server/dist/main.js`, after `npm run build`.
It starts the synthetic backend and a per-process loopback gateway. A new host view enrolls
its exact origin using a metadata-only tool before attempting HTTP. The view still needs
`demo-analyst-token`. Do not widen CORS to `*` to bypass an unexplained failure.

For optional TLS, set both `AUG_GATEWAY_TLS_CERT` and `AUG_GATEWAY_TLS_KEY` to a properly
provisioned certificate/key. Setting only one fails startup. No quickstart step installs
a certificate. The prior locally generated key was rejected because of broad inherited
permissions; resolving safe provisioning remains an open design issue.

When reporting compatibility, record host/OS/version, transport, actual view origin, HTTP
status/CSP evidence and whether records rendered. Check model-context exposure separately.
Use synthetic canaries; remove tokens and private information from reports.

[Claude spike](spikes/mcp-apps-claude-desktop.md) and
[ChatGPT spike](spikes/mcp-apps-chatgpt-desktop.md) retain detailed and historical evidence.
