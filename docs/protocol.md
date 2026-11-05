# AUG protocol — draft 0.2

This is the first executable slice of the proposed application protocol. A backend
**produces outputs that conform to AUG**; a runtime declares which representations it
understands. The contract is independent of a backend framework, model provider, chat
host and UI component library.

The implemented slices cover output descriptions, profiles, inline/reference delivery,
representation negotiation, and [operation contracts and invocation lifecycle](operations.md).
Operations add input schemas, execution states, explicit confirmations and bounded retries.
Arbitrary business workflows, streaming and cancellation remain outside this draft. The
existing search UI keeps its session/action contract; operation invocation is independent
of UI plans.

Version `aug/0.2` adds the indeterminate execution state and optional
[persistent recovery](persistence.md). Generic runtime/backend versions must match;
the representation profile versions remain independent.

## Three separate contracts

| Contract | Responsibility |
|---|---|
| AUG protocol (`aug/0.2`) | Operations, invocation lifecycle, results, representations and permitted destinations |
| A representation profile | Structure and semantics that a consumer promises to understand |
| UI format / host transport | How a runtime presents content and integrates into an environment |

`aug/0.2` does not replace `aug.ui/0.1`, the current search UI plan format. A collection
profile is not tied to a table widget: a runtime may present the same collection as a
table, a list or another suitable accessible interface.

## Backend declaration

An output has a protocol version, a stable result identifier and one or more
representations. Each representation declares a versioned profile, an exact lowercase
media type, explicit permitted audiences, and either inline JSON content or a reference.
The producer orders alternatives by preference.

```json
{
  "protocolVersion": "aug/0.2",
  "id": "invoices-42",
  "representations": [
    {
      "id": "collection",
      "profile": "aug.collection/0.1",
      "mediaType": "application/json",
      "audiences": ["view"],
      "delivery": {
        "kind": "inline",
        "value": {
          "columns": [{ "key": "number" }, { "key": "amount" }],
          "rows": [{ "number": "INV-42", "amount": 125.5 }]
        }
      }
    }
  ]
}
```

This is a backend declaration, not a model-generated interpretation of arbitrary data.
The same contract applies to invoices, sensor measurements or other domain objects.
The backend is responsible for permission checks and field projection before constructing
an output. Profile validation checks structure; it cannot establish authorization.

## Profiles implemented in the reference package

| Versioned identifier | Media type | Content / delivery |
|---|---|---|
| `aug.json/0.1` | `application/json` | Any JSON value, inline or referenced |
| `aug.collection/0.1` | `application/json` | `columns` and `rows`, inline or referenced |
| `aug.text/0.1` | `text/plain` | A string, inline or referenced |
| `aug.document/0.1` | `application/pdf` | A reference to a PDF; no PDF viewer or binary validation is supplied |

Collection columns contain a unique nonempty `key` and optional `label`. Every row must
contain exactly the declared keys, including on empty-result responses where columns
remain present. Values may be nested JSON. The profile does not yet carry field-level
schemas, edit rules or relationships.

Custom profiles use independently namespaced, versioned identifiers, for example
`com.example.geometry/1`. An unfamiliar profile is structurally valid but can only be
selected when a runtime advertises support. Its implementation must validate its content;
the core validator does not claim to understand custom profile semantics. A profile name
never instructs the runtime to download or execute a plugin.

The producer may offer a generic JSON or text alternative. Alternatives must preserve
the intended task semantics; the core cannot verify equivalence across profiles. It never
converts an unsupported result itself. Unknown fields in the core envelope are rejected;
extensions belong in independently specified profiles rather than undocumented keys.

## Runtime declaration and selection

```json
{
  "protocolVersions": ["aug/0.2"],
  "profiles": ["aug.collection/0.1", "aug.json/0.1"],
  "mediaTypes": ["application/json"],
  "deliveryKinds": ["inline"]
}
```

The reference implementation selects the first producer-declared representation that
matches **all** of the runtime's version, profile, media type and delivery requirements
and permits the requested audience. All version matching is exact. It returns only the
selected representation plus the protocol version, output ID and target audience.

An invalid envelope or malformed built-in inline profile is rejected before selection,
even when another representation would have been compatible. Unsupported combinations
fail explicitly; there is no automatic text fallback or implicit version downgrade.

```ts
import { collectionOutput, negotiateOutput } from "@aug/protocol";

// Backend: these records have already passed domain authorization and field projection.
const output = collectionOutput("invoices-42", {
  columns: [{ key: "number" }, { key: "amount" }],
  rows: [{ number: "INV-42", amount: 125.5 }],
}, ["view"]);

// Runtime: this example can consume generic JSON only.
const selected = negotiateOutput(output, {
  protocolVersions: ["aug/0.2"],
  profiles: ["aug.json/0.1"],
  mediaTypes: ["application/json"],
  deliveryKinds: ["inline"],
}, "view");
// selected.representation.profile === "aug.json/0.1"
```

`collectionOutput` deliberately creates both collection and JSON representations with
identical data and audience permissions. The kernel supplies selection and validation.
The [operation runtime](runtime.md) supplies an initial shared interpreter for operations,
inputs and supported inline profiles. Existing search views still use their current
read-only renderer and legacy query response.

The operation binding preflights representation offers before invoking a backend handler.
It supports inputs and execution independently of the current UI format; see
[operations](operations.md).

## Delivery and privacy boundaries

- `view` permits delivery to the application view; `model` permits delivery to model
  context. There is no default audience and no inference based on media type.
- A view-only collection remains view-only through every declared alternative. A model
  response requires a separate representation explicitly permitted for that destination.
- Output IDs, profile names, column metadata and reference URLs can also be sensitive.
  Keep the full envelope on the permitted data plane; do not publish it wholesale as a
  model-visible capability catalog or tool result.
- These labels are delivery constraints enforced by cooperating code, not encryption,
  authentication or protection from an untrusted host. The integration decides which
  audience a channel actually represents; a client's declaration cannot establish trust.
- The kernel never fetches references. Root-relative paths and HTTPS URLs without embedded
  credentials, fragments, whitespace or backslashes are accepted. Consumers must resolve
  paths against the producer origin, authorize requests, enforce origin/network/size limits
  and validate content before use. A valid URL is not an allowed destination by itself.
- For referenced JSON, collection and text content, consumers call `validateProfileContent`
  after parsing the retrieved body. A custom profile additionally needs its own validator.
  A PDF profile consumer must verify the actual file using its trusted document handler.
- Structural array bounds are not a streaming byte/depth limiter. A transport must apply
  its own size limits before parsing untrusted JSON.

## Integration with the current gateway

`POST /v1/aug/query` is an opt-in HTTP binding for the current read-only search application.
It accepts the existing `planId`, `actionId` and `state`, plus a `runtime` declaration.
Use the same Bearer authentication and exact-origin rules as `/v1/data/query`.

```json
{
  "planId": "the-plan-id-returned-by-v1-plans",
  "actionId": "query-data",
  "state": { "filters": { "q": "Torino" } },
  "runtime": {
    "protocolVersions": ["aug/0.2"],
    "profiles": ["aug.collection/0.1"],
    "mediaTypes": ["application/json"],
    "deliveryKinds": ["inline"]
  }
}
```

The binding fixes the destination to `view`; it exposes no model-query tool. It checks
runtime compatibility before fetching records, then executes the same principal/tenant,
session, scope, action and field checks as the existing query path. Column declarations
come from the authorized plan, so an empty result still identifies its fields. The result
contains only the selected representation. Query audit events use the existing metadata-only
hook; compatibility failures occur before a data query and do not emit query audit events.

Malformed runtime declarations return HTTP 400. Unsupported versions or representations
return 406. Other query errors retain their existing status. Preflight uses the same
exact-origin policy. The existing `/v1/data/query` response and MCP tools are unchanged.

This endpoint is a reference binding, not a claim that the generic protocol standardizes
OpenAPI discovery, search plan sessions or arbitrary backend calls.

## Source and verification

- [TypeScript package and types](../packages/protocol/src/index.ts)
- [Language-neutral output schema](../packages/protocol/src/schemas/output.json)
- [Language-neutral runtime schema](../packages/protocol/src/schemas/runtime.json)
- [Collection profile schema](../packages/protocol/src/schemas/collection.json) (also requires unique keys and exact row/column correspondence)
- [Protocol contract tests](../tests/contract/protocol.test.mjs)
- [HTTP integration and access-boundary tests](../tests/integration/protected-flow.test.mjs)

Run `npm test` to build the workspace and execute the contract and integration suite.
These tests cover this output/negotiation slice. They do not certify a complete AUG runtime
or host-wide confidentiality.
