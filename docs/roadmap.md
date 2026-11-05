# Roadmap and open decisions

AUG is an experimental protocol and reference implementation. The goal is for backends to
declare capabilities through a common contract and for compatible runtimes to provide
interfaces, including inside AI chats. Progress should establish interoperability and
useful interactions rather than require every feature in the original RFC.

## Implemented baseline

- An API-key-free synthetic demo and contract/integration tests; Windows/Linux CI on Node
  22 and 24. Historical publication evidence is recorded in [publication](publication.md).
- Application wire version `aug/0.2`: backend-native operations, JSON Schema inputs,
  audience-aware output negotiation and an invocation lifecycle with explicit confirmations.
- One shared runtime in a browser and an MCP App: operation selection, typed/JSON input,
  inline collections/JSON/text, saved-input review and lost-reply/status recovery.
- Optional encrypted SQLite invocation state, durable request receipts and conservative
  crash recovery. Unknown execution outcomes require backend reconciliation.
- An annotated read-only OpenAPI adapter, the original search-plan flow and optional
  model-assisted layout planning. The local MCP launcher supports external read backends
  through configuration; Archteathos is a separate-checkout example.
- A standalone Python inventory producer and independent Node terminal consumer, with
  shared wire vectors and cross-checks against the original broker/browser runtime.
  See [the interoperability exercise](interoperability.md). This is a second implementation
  within the project; adoption by external implementers remains unproven.

These are reference capabilities, not evidence of production deployment, exactly-once
effects or successful operation in every chat host.

## Next investigations

| Question | Useful result |
|---|---|
| Can external developers implement AUG independently? | Reproduce the standalone pair and wire vectors, then contribute an implementation from the specification and report ambiguities |
| How should profiles evolve? | Explicit compatibility/version rules and tests for independently extended runtimes; keep JSON/text fallbacks intentional |
| Which additional outputs matter? | A bounded reference/document profile implementation, including authorization, expiry and safe fetching; streaming needs its own contract |
| Can an effect be reconciled after uncertainty? | A synthetic backend with durable business idempotency and an explicit reconciliation flow, tested across crashes without blind replay |
| How portable is the embedded runtime? | Real host/version evidence for rendering, direct requests, confirmation and recovery, with a separate model-context check |
| How should local HTTPS be provisioned? | Reviewed storage, permissions, trust, rotation and removal without weakening certificate verification |
| What does integration actually cost? | An independent backend integration with recorded declarations, transformations and unsupported semantics |
| Can response handling stay bounded? | Streaming size enforcement with oversized/misleading Content-Length tests |
| Can imported metadata fail safely? | Bounded local reference resolution and cyclic/invalid OpenAPI tests |
| Does optional model planning improve a task? | Reproducible comparison with deterministic/hand-built layouts, including cost, latency and failures |

## Requires separate design

Production identity/OAuth, remote multi-user deployment, durable audit export, distributed
state ownership and cross-application workflow graphs require further design. So do broad
custom visual extensions, OpenAPI write discovery, alternative UI serialization and
automatic MCP capability discovery. Native confirmed effects and optional invocation
persistence are already implemented; they do not solve those broader deployment questions.

The [initial community briefs](community/README.md) retain useful bounded investigations
from the first search prototype. They are repository drafts, not public GitHub issues.
