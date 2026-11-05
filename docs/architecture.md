# Current architecture

This document describes implemented behavior. The [architecture RFC](../adaptive-ui-gateway-architecture-spec-v0.3.md)
records a broader proposal. The application protocol is `aug/0.2`; representation profiles
and the legacy `aug.ui/0.1` search-plan format have independent versions. No A2UI serializer exists.

## From backend declaration to interaction

1. A backend registers an operation descriptor and handler with `OperationBroker`. The
   descriptor declares identity, input schema, required scopes, effects and output offers.
   A protected OpenAPI read adapter can also expose an existing search capability this way.
2. Discovery returns only operations authorized for the principal and tenant. Descriptors
   contain no handler code, service credentials or backend URLs selected by the client.
3. The shared runtime generates typed controls or a JSON editor from the input schema.
   It submits inputs, a request ID and its supported representation profiles.
4. The broker validates authorization and inputs, selects a compatible output offer and
   reserves the request. Duplicate requests reuse the recorded invocation or are refused
   if their inputs differ. Effects wait for explicit confirmation of the saved input.
5. Before dispatch, the broker rechecks authorization and records the transition. The
   backend handler owns domain validation, business effects and backend authorization.
6. The broker validates the result against the selected representation and returns the
   invocation state. The runtime renders supported inline collections, JSON or text through
   trusted components. It recovers lost replies using the same request ID or status lookup.

```mermaid
sequenceDiagram
  participant H as Chat host / MCP
  participant U as Protected AUG view
  participant G as Operation broker
  participant B as Backend handler
  H->>U: Open runtime (metadata only)
  U->>G: Authenticated discovery
  G-->>U: Authorized operation descriptors
  U->>G: Inputs + request ID + supported profiles
  Note over G: Validate, negotiate and reserve
  opt Operation has effects
    G-->>U: Saved input + confirmation request
    U->>G: Explicit confirmation
  end
  Note over G: Recheck access; persist transition if configured
  G->>B: Authorized invocation
  B-->>G: Declared result
  G-->>U: Validated result + invocation state
```

This path requires no model or generated UI plan. The same browser module runs at `/runtime`
and in the `aug_open_runtime` embedded resource. Complex values use JSON input; custom
visual profiles, reference/PDF rendering and business workflow graphs remain open work.
See [operations](operations.md) and [runtime](runtime.md).

## Original search-plan path

The earlier search UI remains available and shares the protected read gateway:

1. `discovery-openapi` imports explicitly read-only GET operations and field policies.
2. `capability-catalog` filters capabilities by tenant and principal scopes.
3. `GatewayService.createPlan()` sends authorized metadata and intent to a planner.
   The deterministic planner chooses a standard search/table layout; an optional model
   proposes a constrained layout. Server code composes the bindings and actions.
4. `ui-schema` validates the plan against the capability and principal; the gateway stores
   it in a time-limited session. The fixed renderer creates DOM elements and text nodes.
5. Query actions resolve approved inputs. `ProtectedDataGateway` rechecks scopes/fields,
   performs an allowlisted GET with server credentials and projects permitted scalar fields.

`GatewayService.queryOutput()` and the opt-in `POST /v1/aug/query` binding can wrap those
results in a negotiated output envelope. Existing search views use `/v1/data/query`.
The operation runtime instead uses `/v1/aug/operations` and the invocation routes, without
requiring a search plan. No route's local tests imply live host compatibility.

## Code map

| Location | Responsibility |
|---|---|
| `packages/core` | Shared application contracts and errors |
| `packages/protocol` | Operation/output contracts, representation profiles and negotiation |
| `packages/discovery-openapi` | Annotated read-only OpenAPI subset import |
| `packages/capability-catalog` | Tenant/scope-aware capability lookup |
| `packages/ui-planner` | Legacy planning abstraction, validation, composition and fallback |
| `packages/model-provider-xai` | Optional planner provider transport |
| `packages/ui-schema` | Legacy UI schema and semantic policy checks |
| `packages/security` | Authorized backend query and field projection |
| `packages/ui-renderer` | Shared operation runtime and original search renderer |
| `apps/gateway-server` | Operation broker, optional encrypted SQLite store, HTTP/HTTPS bindings, plan sessions and standalone views |
| `apps/mcp-apps-server` | Local stdio metadata tools, origin enrollment and embedded views |
| `examples/customer-api` | Synthetic multi-tenant backend and public demo credentials |
| `examples/archteathos` | Optional read facade for a separate existing backend |

## Transport, privacy and state

Standalone views use the gateway's same origin. Embedded views use the direct gateway URL
advertised by their local process. MCP exposes authorized discovery/opening metadata and
exact origin enrollment; inputs, confirmation tokens, states and result values use the
view's authenticated HTTP/HTTPS transport. An enrolled origin still needs credentials and
every authorization check. The host controls the embedding environment, so this is channel
separation, not encryption against an untrusted host.

Operation state is process-local by default. Optional [SQLite persistence](persistence.md)
encrypts invocation payloads and request receipts with an external key, commits state before
dispatch and marks interrupted execution `indeterminate`. One process owns a database.
Retired requests remain reserved after result expiry; the broker never automatically
replays an uncertain effect. Backend idempotency and reconciliation remain necessary.
This provides neither a distributed broker nor exactly-once business effects.

Legacy plan sessions remain in memory: a restart invalidates them. `GatewayService` defaults
to a 15-minute TTL and 10,000-session limit. The original standalone search loader expects
one authorized capability; the operation runtime has an authorized operation picker.
Browser credentials and recovery state are in memory and do not survive a reload.

Audit hooks emit identifiers, principal/tenant context, field names, counts and error codes.
They do not persist events by default; invocation storage is not a durable audit service.
Retained invocation access rechecks tenant, identity, scopes and optional resource policy.

## Integration and extension points

- Register backend-native operations with explicit effects, policies and output offers;
  keep domain logic and durable business idempotency in the backend.
- Add representation profiles by defining their contract and implementing negotiation,
  validation and trusted rendering. Unsupported profiles are refused before execution.
- Compose `GatewayService` or `startGatewayServer` with a different OpenAPI source and
  backend origin, or adapt legacy data into a narrow authorized read API.
- Implement `ModelProvider` for another search-layout provider while retaining validation.
- Implement `InvocationStore` for another persistence adapter while preserving state and
  reservation semantics. The shipped SQLite adapter permits only one owner.

The local MCP launcher accepts the synthetic demo or a complete external OpenAPI profile.
Its catalog and gateway share configuration; partial external settings fail startup and
the launcher only owns the synthetic backend's lifecycle. See [backend integration](backend-integration.md).
Sample authentication remains a token-to-principal fixture. Production OAuth, remote
multi-user hosting and persistent legacy plan sessions are not implemented.
