# Getting started

Use Node.js 22.14+ on the 22.x line or Node.js 24.x. Install from the lockfile:

```sh
npm ci
npm test
npm run smoke:demo
npm run demo
```

Open http://127.0.0.1:4000. Use `demo-analyst-token`, create the search interface, then
search `CANARY`. Only the tenant-a synthetic match is returned, with `id`, `name`, `city`
and `amountDue`. `internalNotes` and `tenantId` are not UI columns.
The backend at port 4100 still enforces its own tenant filter and service credential.
Stop both servers with Ctrl+C. If a port is occupied, choose `AUG_PORT` and
`AUG_BACKEND_PORT` in your shell before starting.

## Reproduce the HTTP path

In another terminal, create a plan:

```sh
curl -s http://127.0.0.1:4000/v1/plans \
  -H 'Authorization: Bearer demo-analyst-token' \
  -H 'Content-Type: application/json' \
  -d '{"intent":"Search customers","capabilityId":"demo.customers.list"}'
```

Copy the returned `planId` into the following request. The response above contains a UI
plan and its session identifier, not customer rows:

```sh
curl -s http://127.0.0.1:4000/v1/data/query \
  -H 'Authorization: Bearer demo-analyst-token' \
  -H 'Content-Type: application/json' \
  -d '{"planId":"PASTE_PLAN_ID","actionId":"query-data","state":{"filters":{"q":"CANARY"}}}'
```

The query response contains the authorized rows. These requests reproduce the gateway API;
they do not prove access from an embedded desktop sandbox.
On Windows PowerShell, use `curl.exe` for these curl examples, or use `Invoke-RestMethod`
with equivalent JSON bodies and headers. See [the walkthrough](demo-walkthrough.md).

## Optional model-assisted planning

The default demo works without a model. To opt in, copy [.env.example](../.env.example)
to `.envlocal` and set your own `GROK_API_KEY`. `npm run demo` loads the optional file;
the MCP entrypoint also loads it. Existing environment values take precedence.
`XAI_MODEL` selects a provider model and `PLANNER_TIMEOUT_MS` sets a 1,000–60,000 ms timeout.
Model availability depends on the provider/account; a failure uses the deterministic fallback.
This guide does not claim the hardcoded default model is permanently available.

`npm run test:live` runs opt-in provider tests when a key is configured, and can incur
provider charges. Live tests are not necessary for `npm test` or the default demo.
Do not put record values into intent or metadata just because retrieval uses a separate channel.

## MCP Apps and the second backend

For local stdio hosts, build first and run
`node /absolute/path/to/adaptive-ui-gateway/apps/mcp-apps-server/dist/main.js`.
The entrypoint currently starts the synthetic customer backend. Its stdout is MCP-only;
diagnostics are written to stderr. The demo access token is `demo-analyst-token`.
Use host-specific configuration only after reading [compatibility](compatibility.md).

Archteathos is optional and requires a separate checkout. Follow
[its adapter guide](../examples/archteathos/README.md); the main quickstart is independent of it.

## Troubleshooting

| Symptom | Check |
|---|---|
| `EADDRINUSE` | Stop the other local demo, or choose unused gateway/backend ports |
| No capability or plan is denied | Verify token, tenant, scopes and OpenAPI read/field annotations |
| “This demo requires exactly one…” | The standalone loader supports one authorized capability; multiple workflows need a selection UI |
| Model timeout/provider error | Inspect value-free planner events; deterministic fallback is expected |
| TLS test fails on an unusual system clock | Check the public fixture validity; do not disable certificate verification |
| Embedded view says “Failed to fetch” | Check actual host CSP, origin and CORS; an external curl success is insufficient |

Never work around a host failure by sending records through MCP or by disabling TLS validation.
