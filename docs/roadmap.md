# Roadmap and open decisions

The project is a reference implementation under review, not a commitment to implement
every feature in the original RFC. Prefer evidence and small changes over expanding scope.

## v0.1: make the current slice reproducible

- API-key-free synthetic demo and test suite from a clean checkout.
- Explicit current architecture, threat model, host evidence and backend adapter contract.
- Windows/Linux CI on Node 22 and 24, plus opt-in provider tests.
- A reviewed publication snapshot, MIT license and contribution entry points.

## Next investigations

The local MCP entrypoint now connects external backends through configuration, with explicit
identity/credentials and input schemas in its metadata catalog. The same process is tested
against both the default demo and the separate Archteathos read adapter.

| Question | Useful result |
|---|---|
| Does model planning improve a task? | A small, reproducible comparison with deterministic and hand-built layouts, with latency/cost and failures |
| What does integration actually cost? | A second independent adapter with a log of annotations, transformations and unsupported semantics |
| Can response handling stay bounded? | Streaming size enforcement with oversized/misleading Content-Length tests |
| Can metadata fail safely? | Bounded local reference resolution and tests for cyclic/invalid OpenAPI documents |
| How portable is the embedded channel? | Real host/version evidence, including rendered values and a separate model-context check |
| How should local HTTPS be provisioned? | A reviewed lifecycle covering storage, permissions, trust, rotation and removal without weakening verification |
| How do we move beyond one search capability? | A capability selection interaction with preserved policy checks and no model-selected endpoints |

## Deliberately deferred

Write operations, remote OAuth/multi-user hosting, durable state, A2UI serialization,
automatic MCP capability discovery and a broad component library require separate design
review. They should not be prerequisites for examining the present read-only implementation.

Suggested initial work is recorded in [community briefs](community/README.md). These are
local issue drafts, not claims that public GitHub issues already exist.
