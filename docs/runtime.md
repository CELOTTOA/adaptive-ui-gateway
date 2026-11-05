# Generic operation runtime — reference implementation

One fixed browser module interprets backend-declared AUG operations in a standalone page
and an embedded MCP App. It does not generate or execute JavaScript from backend metadata
or a model. Supported forms and result profiles need no domain-specific frontend code.

## Entry points

- Standalone: run `npm run demo`, then open `/runtime` on the reported gateway origin.
  The public demo token `demo-analyst-token` exposes the synthetic read operation.
- Embedded: call `aug_open_runtime`, optionally with an authorized `operationId`. Its resource
  is `ui://aug/runtime-view.html`. Enter the view token in its Connection form.
- Library: import `createOperationRuntime` and `runtimeCapabilities` from
  `@aug/ui-renderer/operation-runtime.js`, and include `@aug/ui-renderer/runtime.css`.

The MCP tool returns opening metadata only. Its operation ID scopes the picker; the backend
still authorizes every request. Existing search tools and views remain available.

## Library interface

`createOperationRuntime(root, options)` creates the view and returns `{ ready, dispose }`.
`ready` resolves to whether discovery succeeded. `dispose()` clears the view, aborts client
requests and releases polling timers. It does not cancel accepted backend work.

| Option | Purpose |
|---|---|
| `request(path, input, { signal })` | Authenticated transport returning parsed payloads |
| `operationId` | Optional operation filter |
| `document` | DOM provider; defaults to the current document |
| `newRequestId` | Secure ID source; defaults to `crypto.randomUUID()` |
| `pollMs`, `maxPolls` | Automatic polling budget; defaults to 500 ms and 40 polls |

The adapter must reject unsuccessful responses. A known protocol/backend code may be
attached as `error.code`; raw messages are not shown. Keep explicit refusals distinguishable
from network/malformed-response errors and forward the abort signal. Operation descriptors
never supply AJAX URLs. The reference adapters post to known gateway paths; other
environments may map the injected transport to equivalent bindings.

## Supported interpretation

- Strings, numbers, integers, booleans and scalar enums use native labeled controls.
  Optional blank controls are omitted; false and numeric zero retain their types.
- Nested objects, arrays, unions and referenced property schemas accept JSON values.
- Complex/open root schemas use a JSON-object editor. Other forms also offer JSON input
  mode, preserving valid values when switching. This can express an empty optional string.
- Native controls hint required inputs and numeric bounds. The backend remains authoritative
  for full JSON Schema and business rules. This module uses no runtime `eval` and does not
  duplicate a full schema validator in the browser.
- Inline `aug.collection/0.1`, `aug.json/0.1` and `aug.text/0.1` are advertised. Collections
  use text-only cells, numeric alignment and local batches of fifty rows. JSON/text use
  wrapping text views. Empty collections keep columns. Currency and units are never guessed.
- References/PDFs, streaming, custom visual profiles and business workflow graphs are not
  advertised. Unsupported offers are refused by the broker before execution.

Every label, description and value is inserted as text. No plugins are imported, backend
HTML is never parsed, and reference URLs are never automatically fetched.

## Confirmation and recovery

Effects display the backend's saved input for review. A separate explicit click sends the
confirmation token. Inputs and operation selection are locked while pending/running.
Back to inputs leaves an unconfirmed invocation to expire; it does not cancel it. That
control locks too once confirmation starts.

Each new invocation gets a fresh request ID. If its start response is lost, Retry request
sends the saved request and ID. Once an invocation ID is known, recovery checks status
instead of resending the operation or automatically confirming again. After the polling
budget, Check status continues the same invocation. Unknown outcomes are reported explicitly
before the view permits another request.

Client recovery state and credentials exist only in memory. Reloading/reconnecting loses
them. The broker can now use [persistent encrypted state](persistence.md); real effects still
require durable backend idempotency/reconciliation. An indeterminate invocation locks the
view to status checks and explains that the backend outcome needs reconciliation.

This runtime speaks `aug/0.2`. Upgrade backend and runtime together; inline representation
profiles retain their independent `/0.1` versions.

## Privacy and host boundaries

Adapters retain tokens in a transport closure and clear password fields after connecting.
They use no browser persistence, URL parameters or cookies for credentials. Requests use
`credentials: "omit"`, `cache: "no-store"` and `referrerPolicy: "no-referrer"`.

The embedded view enrolls its exact origin over the host bridge. Inputs, confirmation
tokens, invocation states and results use its direct authenticated HTTP/HTTPS connection.
It never calls conversation/model-context update methods. The host still controls the
environment; this is not encryption against an untrusted host.

Actual host connectivity retains the [recorded limitations](compatibility.md). Local browser
verification and resource tests do not establish successful live deployment on every chat
host. No production identity system is introduced here.

## Verification

- [Runtime contracts](../tests/contract/operation-runtime.test.mjs): types, JSON fallback,
  repeated execution, lost replies, confirmation, paging and disposal.
- [Embedded adapter](../tests/contract/mcp-operation-view.test.mjs): origin-only enrollment,
  token clearing and private direct requests.
- [Resources/assets](../tests/integration/mcp-apps.test.mjs): metadata-only opening, shared
  fixed renderer, gateway connection policy and restrictive standalone CSP.

Run `npm test`, `npm run smoke:demo` and `npm run check:publication`.
