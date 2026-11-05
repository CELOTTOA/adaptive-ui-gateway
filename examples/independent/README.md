# Independent AUG implementations

This example tests whether the written `aug/0.2` contract can connect a backend and runtime
that do not import the original implementation. It uses three standalone files:

- [backend.py](backend.py): Python standard library HTTP backend with synthetic inventory.
- [operations.json](operations.json): its two public operation declarations.
- [runtime.mjs](runtime.mjs): Node built-ins only, with an independent terminal renderer
  and protocol consumer. It imports no AUG packages, shared validator or browser renderer.

Copy those three files to a separate directory to run them without this monorepo or npm.
Use Python 3.11+ and Node 22.14+ / 24.x. This is an implementation exercise by the same
project, not an external organization's independent adoption or a production connector.

## Run the standalone pair

In the first terminal:

```sh
python -B backend.py --port 4200
```

The only startup output is the bound loopback origin. All records, credentials and changes
are public synthetic fixtures. The service listens only on `127.0.0.1`; Ctrl+C stops it.

In a second terminal, set the view credential. PowerShell:

```powershell
$env:AUG_VIEW_TOKEN = 'independent-demo-token'
```

POSIX shell:

```sh
export AUG_VIEW_TOKEN=independent-demo-token
```

Then discover and invoke:

```sh
node runtime.mjs http://127.0.0.1:4200 list
node runtime.mjs http://127.0.0.1:4200 run inventory.stock.list --input '{"q":"BOLT"}'
node runtime.mjs http://127.0.0.1:4200 run inventory.stock.reserve --input '{"sku":"BOLT-A","quantity":2}' --request-id reserve-example-1
```

The write displays saved inputs and requires typing `CONFIRM` in an interactive terminal.
Piped/noninteractive input cannot approve it. Repeating the same request ID and inputs
returns the existing invocation while retained, without subtracting stock again. Reusing
that ID for different inputs or runtime capabilities returns a conflict. Both processes
keep state only in memory; a backend restart loses reservations and resets stock.

Token `independent-other-token` sees tenant-b stock. Token `independent-denied-token` maps
to the first identity with no scopes and cannot discover or access retained invocations.
These credentials are fixtures, not a production identity scheme.

The HTTP binding fixes the audience to `view`. Terminal output is the authorized user's
data view, not an MCP/model tool result. The program never sends results to a model or
automatically fetches references, imports plugins or executes backend markup.

## Runtime library

```js
import { TerminalRuntime, renderInvocation } from "./runtime.mjs";

const runtime = new TerminalRuntime({ origin: "http://127.0.0.1:4200", token: process.env.AUG_VIEW_TOKEN });
const operations = await runtime.discover();
let state = await runtime.start("inventory.stock.list", { q: "BOLT" }, { requestId: "search-example-1" });
state = await runtime.wait(state);
console.log(renderInvocation(state));
```

`start` never confirms. A UI adapter must review `awaiting_confirmation.confirmation.input`
and obtain explicit approval before `confirm(state.id)`. `status(state.id)` reads the same
invocation. `wait` polls only `running`, at most forty times by default; it never retries
an invocation or confirmation. An indeterminate state is reported without another attempt.

`REQUEST_OUTCOME_UNKNOWN` means a submitted start/confirmation may have been accepted.
After a lost start reply, explicitly retry the same saved inputs, runtime and request ID.
After a lost confirmation reply, use status. No automatic replay occurs. CLI starts print
their request ID before dispatch; use `--request-id` with that ID and the same inputs to
recover in a later process. Other library recovery context lives only in memory.

Operation descriptors provide no network destinations. Operator configuration supplies
one HTTPS origin or loopback HTTP origin; redirects are refused. Credentials stay in a
private transport field. Responses have a 1 MiB streaming cap and five-second request
timeout. The consumer checks versions, identities, saved input, revision progression,
selected offers, view audiences and inline profile content before rendering. Collection
limits are 256 columns and 10,000 rows; JSON depth is capped at 32. Terminal control
characters are escaped. This is a bounded consumer, not a full JSON Schema implementation.

## Backend scope

The Python backend implements exactly the two declared operations, all their input
constraints, view-only collection/JSON/text negotiation, scoped discovery, owned invocation
state, confirmation and deduplication. It supports the fixed HTTP routes in the
[operation binding](../../docs/operations.md). It has no OpenAPI adapter, planner or shared
broker. It does not accept arbitrary operation registration or arbitrary JSON Schemas.

It bounds requests to 32 KiB and JSON depth to 32, rejects duplicate object keys/non-finite
numbers, and accepts only explicitly configured CORS origins. For a separate browser view,
add `--allow-origin https://the-exact-view-origin.example`; origin enrollment and MCP are
not implemented by this backend.

The backend has one serial owner, at most 512 retained invocations, five-minute pending
confirmations and fifteen-minute terminal retention. Expired records are swept on invoke/
control; request IDs become reusable after retirement. It provides no durable storage,
business idempotency, production audit, TLS server or exactly-once guarantee. Errors after
dispatch of a synthetic effect become `indeterminate`, requiring reconciliation.

## Reproduce the interoperability check

From the monorepo root:

```sh
npm ci
npm run test:interop
```

Set `AUG_PYTHON` to an executable path if the interpreter is not named `python`. A missing
interpreter fails the dedicated check; it is never silently skipped. `npm test` remains
Node-only and includes the terminal runtime's defensive contract tests.

See [the interoperability record](../../docs/interoperability.md) for the matrix, reusable
wire fixtures and limits of the evidence.
