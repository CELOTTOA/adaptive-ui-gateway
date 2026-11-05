# Security model and evidence

**Experimental, local reference implementation.** This is an account of the checks in the
code and tests, not an independent security audit or a claim of host-wide confidentiality.

## Trust boundaries

| Actor or channel | Receives / controls | Boundary |
|---|---|---|
| Planner / optional external model | User intent, authorized operation metadata, field names and component contract | No backend records or credentials are provided by AUG; sensitive user input/metadata remains possible |
| Model proposal | Layout choices within the supported schema | Cannot supply endpoints, binding policies, extra fields or executable code |
| Gateway / operation broker | User token, invocation inputs/state, policies and backend responses; service credential for the read adapter | Revalidates access, input/output contracts and saved-input confirmation; the read adapter projects allowed fields |
| View and its host | Authorized descriptors or validated plan, entered token, inputs, confirmations and results | Trusted to display the data; not protected from a compromised host or screen capture |
| Backend | Service credential and principal/tenant context | Must enforce business rules and its own authorization; demo headers alone are not production identity |
| MCP channel | Capability/request metadata and exact origin registration | No record query tool, record response or HTTP session/token transport |
| Audit hook | Principal/tenant IDs, capability/field names, row counts and denial codes | No row values, search arguments, prompts or raw provider output |

## Implemented controls

- Backend-native operation discovery filters registrations by tenant/scopes; inputs are
  validated against the registered JSON Schema. Non-read effects require explicit
  confirmation of immutable saved inputs, with authorization rechecked before dispatch.
- The OpenAPI adapter imports only explicitly declared reads. Unknown field classifications
  default to restricted; UI-visible fields require an allowed classification and scopes.
- UI plans are validated structurally and against authorized catalog entries. Model errors,
  malformed proposals and policy violations use a deterministic fallback by default.
- Plan sessions bind principal and tenant; unknown/expired sessions and unknown actions fail.
- OpenAPI read requests use the configured origin, server credential and approved scalar arguments.
  Redirects are rejected. Requests have a five-second timeout; returned rows are capped at 100.
- The gateway checks response content type, array shape and scalar projected values. It checks
  a response-size limit, with the buffering limitation below.
- The renderer uses text nodes. The standalone page restricts script/style/connect sources
  through CSP. Cross-origin direct requests require an exact configured/enrolled origin.
- Origin enrollment is process-local and bounded. It neither supplies authentication nor
  validates the trustworthiness of a whole host; it solves an origin-registration problem.
- Optional HTTPS retains certificate verification. Tests explicitly trust only a public test
  fixture on individual client connections; they never modify OS trust stores.

## Evidence and limits

`npm test` covers metadata-only planning, malicious proposals, fallback, field/tenant
authorization, session replay, renderer text handling, exact origins, TLS and real stdio
processes. Operation tests cover schema validation, negotiation, confirmations, deduplication,
retained-access checks, lost replies, encrypted persistence and killed-process recovery.
Most model tests use a recording simulated provider; separate live tests are opt-in.
These tests exercise selected threats and regressions; they do not exhaustively prove security.

An observed Claude Desktop session completed direct plan creation and record retrieval.
The current transport still needs explicit real-host visual/model-context verification.
The ChatGPT Desktop/Codex observation failed at host CSP for HTTP. A direct external request
does not demonstrate that a sandbox can make the same connection.

## Open work before production use

### Optional operation archive

The [persistent invocation adapter](persistence.md) is opt-in and separate from audit hooks
and legacy plan sessions. It retains encrypted inputs, confirmation state and results until
payload retirement, and encrypted minimal request receipts afterwards. The archive key stays
outside SQLite; opaque IDs, execution state/revision and retention timing remain visible.
Current authorization is rechecked for replay/status/confirmation, including retained caller
scopes and optional resource-specific guards. Recovery never automatically replays running
work; unknown outcomes require backend reconciliation. One local database has one broker
owner. This does not encrypt against a compromised host or provide exactly-once remote effects.

### Remaining production work

- Actual authenticated identities and credential lifecycle, including remote/OAuth deployment.
- Streaming enforcement of the backend body-size limit: the core currently buffers text before
  its final size check. A misleading/missing Content-Length can consume more memory first.
- Complete JSON Schema enforcement for the legacy OpenAPI query path; its adapter primarily
  checks scalar types, allowlisted names and string length. Native operation inputs use the
  registered draft-07 validator, including supported nested/range/pattern constraints.
- Bounded parser behavior for hostile/cyclic OpenAPI references and a documented metadata trust policy.
- Operational rate limits, durable audit/session handling, monitoring and load evaluation.
- Certificate storage, trust, rotation and removal for local HTTPS hosts.
- Host-specific observation and retention beyond AUG's own controlled channels.

The sample access/service tokens and TLS fixture private key are public test data. Keep actual
secrets in ignored local files or appropriate secret storage. Never use the fixture key for
anything beyond tests. Report vulnerabilities using [SECURITY.md](../SECURITY.md).
