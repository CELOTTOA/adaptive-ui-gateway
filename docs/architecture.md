# Current architecture

This document describes implemented behavior. The [architecture RFC](../adaptive-ui-gateway-architecture-spec-v0.3.md)
is broader and includes future work. The current format is `aug.ui/0.1`; no A2UI serializer exists.

## From declared capability to query

1. `discovery-openapi` imports explicitly read-only GET operations and field policy metadata.
2. `capability-catalog` registers capabilities per tenant and filters them by principal scopes.
3. `GatewayService.createPlan()` constructs an authorized planning description and calls a planner.
4. The deterministic planner chooses a standard search/table layout. The model-assisted planner
   accepts a constrained layout proposal, then server code composes actions and binding policies.
5. `ui-schema` validates structure and references against the actual capability and principal.
6. The gateway stores the validated plan in a time-limited session tied to principal and tenant.
7. The fixed renderer emits DOM elements and text nodes. It never executes model-generated code.
8. A query action resolves only server-approved input bindings. `ProtectedDataGateway` rechecks
   scopes/fields, performs GET against the configured backend, and selects the permitted scalar fields.

```mermaid
sequenceDiagram
  participant U as User / view
  participant G as Gateway
  participant P as Planner
  participant B as Backend
  U->>G: Intent + capability ID + access token
  G->>P: Authorized metadata and intent
  P-->>G: Layout proposal
  Note over G: Compose and validate plan; create session
  G-->>U: UI Plan + session ID
  U->>G: Session + action + bound search state
  Note over G: Check identity, tenant, action and fields
  G->>B: Allowlisted GET + service credential + principal context
  B-->>G: Records
  G-->>U: Permitted fields
```

## Code map

| Location | Responsibility |
|---|---|
| `packages/core` | Shared contracts and errors |
| `packages/discovery-openapi` | OpenAPI subset import |
| `packages/capability-catalog` | Tenant and scope-aware capability lookup |
| `packages/ui-planner` | Planning abstraction, layout validation, deterministic composition and fallback |
| `packages/model-provider-xai` | Optional provider transport |
| `packages/ui-schema` | UI schema and semantic policy checks |
| `packages/security` | Authorized backend query and field projection |
| `packages/ui-renderer` | Shared trusted browser renderer |
| `apps/gateway-server` | HTTP/HTTPS API, plan sessions, audit hooks and standalone demo |
| `apps/mcp-apps-server` | Local stdio metadata tools, origin enrollment and fixed embedded view |
| `examples/customer-api` | Synthetic multi-tenant backend with public demo credentials |
| `examples/archteathos` | Optional read facade for a separate existing backend |

## Transport and state

The standalone page uses the gateway's same origin. MCP views use a direct gateway URL
advertised by their local process. The MCP tools expose capability/request metadata; no
data-query tool exists. Exact view origin enrollment uses only origin metadata over the bridge.
An enrolled origin still needs the HTTP token and every policy check.

Sessions live in memory, expire after 15 minutes by default and are limited to 10,000 by
default in `GatewayService`. Restarting a process invalidates them. The HTTP server and MCP
transport construct separate service instances in the demo; HTTP sessions belong to the
HTTP service. The standalone loader currently expects exactly one authorized capability.

Audit hooks emit operation identifiers, principal/tenant IDs, field names, counts and error
codes. They do not persist events by default. This is not an external durable audit service.

## Extension points

- Implement `ModelProvider` to propose layouts through another vendor, keeping validation and composition.
- Construct `GatewayService` or `startGatewayServer` with a different OpenAPI source and backend origin.
- Adapt nested/legacy data into a narrow, authorized read API without altering core packages.
- Extend the component contract and trusted renderer together, with relevant policy tests.

Authentication in the sample launchers is a token-to-principal fixture. A remote deployment,
write broker and persistent session store are not implemented.

The local MCP entrypoint now accepts either the default synthetic demo or a fully specified
external backend profile. It uses the same configuration for its MCP catalog and HTTP data
gateway, registers the configured principal's tenant, and only owns the synthetic backend's
lifecycle. Partial external settings fail startup. The model-facing catalog includes input
schemas, so the host can inspect parameter requirements; generation of arbitrary parameter
forms remains separate future work. See [configuration](backend-integration.md).
