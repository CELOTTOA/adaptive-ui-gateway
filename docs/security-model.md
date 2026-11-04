# Security model and evidence

**Experimental, local reference implementation.** This is an account of the checks in the
code and tests, not an independent security audit or a claim of host-wide confidentiality.

## Trust boundaries

| Actor or channel | Receives / controls | Boundary |
|---|---|---|
| Planner / optional external model | User intent, authorized operation metadata, field names and component contract | No backend records or credentials are provided by AUG; sensitive user input/metadata remains possible |
| Model proposal | Layout choices within the supported schema | Cannot supply endpoints, binding policies, extra fields or executable code |
| Gateway | User token, session, policy, service credential and backend response | Revalidates access and projects allowed fields |
| View and its host | Validated plan, token entered in the view and returned record values | Trusted to display the data; not protected from a compromised host or screen capture |
| Backend | Service credential and principal/tenant context | Must enforce business rules and its own authorization; demo headers alone are not production identity |
| MCP channel | Capability/request metadata and exact origin registration | No record query tool, record response or HTTP session/token transport |
| Audit hook | Principal/tenant IDs, capability/field names, row counts and denial codes | No row values, search arguments, prompts or raw provider output |

## Implemented controls

- Only explicitly declared read operations enter discovery. Unknown field classifications
  default to restricted; UI-visible fields require an allowed classification and scopes.
- UI plans are validated structurally and against authorized catalog entries. Model errors,
  malformed proposals and policy violations use a deterministic fallback by default.
- Plan sessions bind principal and tenant; unknown/expired sessions and unknown actions fail.
- Backend operations use the configured origin, server credential and approved scalar arguments.
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

`npm test` covers metadata-only planning, malicious model proposals, fallback, field/tenant
authorization, session replay, renderer text handling, exact origins, TLS and real stdio processes.
Most model tests use a recording simulated provider; separate live tests are opt-in.
These tests exercise selected threats and regressions; they do not exhaustively prove security.

An observed Claude Desktop session completed direct plan creation and record retrieval.
The current transport still needs explicit real-host visual/model-context verification.
The ChatGPT Desktop/Codex observation failed at host CSP for HTTP. A direct external request
does not demonstrate that a sandbox can make the same connection.

## Open work before production use

- Actual authenticated identities and credential lifecycle, including remote/OAuth deployment.
- Streaming enforcement of the backend body-size limit: the core currently buffers text before
  its final size check. A misleading/missing Content-Length can consume more memory first.
- Complete JSON Schema enforcement for query constraints; current checks primarily enforce
  scalar types, allowlisted names and string length, rather than every declared minimum/pattern.
- Bounded parser behavior for hostile/cyclic OpenAPI references and a documented metadata trust policy.
- Operational rate limits, durable audit/session handling, monitoring and load evaluation.
- Certificate storage, trust, rotation and removal for local HTTPS hosts.
- Host-specific observation and retention beyond AUG's own controlled channels.

The sample access/service tokens and TLS fixture private key are public test data. Keep actual
secrets in ignored local files or appropriate secret storage. Never use the fixture key for
anything beyond tests. Report vulnerabilities using [SECURITY.md](../SECURITY.md).
