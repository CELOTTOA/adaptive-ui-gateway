# AUG 0.2 interoperability exercise

This exercise implements the written operation/output contract with a Python backend and
a terminal runtime that share no AUG implementation code. The producer and consumer use
only their language's standard/built-in libraries. Their common operation declarations
are wire metadata, not shared execution or validation logic.

This is a second implementation within the project, by the same authoring process. It
tests portability of this bounded contract; external independent adoption remains unproven.

## Checked combinations

| Producer | Consumer | Check |
|---|---|---|
| Python inventory HTTP backend | Independent Node terminal runtime | Discovery, inline collection/JSON/text negotiation, read and explicit confirmed effect |
| TypeScript reference broker with native inventory handlers | Independent Node terminal runtime | Same wire fixtures, reads, confirmation, polling and retained-request behavior |
| Python inventory HTTP backend | Original shared browser runtime | Generated input controls, rendered collection and explicit confirmation over real HTTP using a test DOM |
| TypeScript reference broker with native inventory handlers | Original shared browser runtime | Same operation/view interaction through the HTTP binding using a test DOM |

The Python process and terminal executable are also run from an isolated temporary folder
containing only `backend.py`, `operations.json` and `runtime.mjs`. There is no package install,
build output or original AUG packages in that folder. The Python interpreter runs in isolated mode.
The files are available in [the standalone example](../examples/independent/README.md).

The browser-runtime checks use the original module with a minimal test DOM and real HTTP
requests. They do not exercise visual layout, a real browser, an embedded chat sandbox or
model-context disclosure. No new live-host compatibility claim follows from this exercise.

## Reusable evidence

- [Language-neutral vectors](../tests/fixtures/aug-interop.json) contain profile preferences
  and positive/negative HTTP cases. Both producers receive the same cases.
- [Operation declarations](../examples/independent/operations.json) describe a second
  domain: tenant-scoped stock availability and confirmed synthetic reservation.
- [Cross-implementation checks](../tests/interoperability/independent.interop.mjs) test the
  matrix, current authorization, retained ownership, immutable input, concurrent/repeated
  confirmations and canonical request replay. Python messages also pass the reference
  validator, as an additional verifier rather than a dependency of the implementation.
- [Terminal consumer checks](../tests/contract/independent-runtime.test.mjs) exercise lost
  replies, invalid/audience-mismatched output, wrong profiles, state regression, bounded
  response streaming, collection shape and terminal control characters.

Run `npm run test:interop` with Python 3.11+ and the supported Node version. It builds the
reference implementation for the cross-check and fails if Python is unavailable. `npm test`
keeps its existing Node-only entry point and includes the terminal consumer contract tests.
CI installs Python and runs the interoperability check on its Windows/Linux × Node 22/24
matrix. A configured CI step is not evidence of a completed remote run.

Local verification on 5 November 2026: the main suite passed 160 tests and skipped 4
opt-in tests (164 total); the dedicated interoperability suite passed all 53 tests without
skips. The demo smoke and targeted publication checks also passed. These results do not
replace a remote run of the updated CI workflow.

## Details made explicit by the exercise

The [HTTP binding](operations.md) now spells out details that the first implementation
had previously expressed mainly in code:

- Discovery returns an object with `protocolVersion` and `operations`, including an empty
  array for a valid principal without permitted operations. It does not return a bare array.
- A synchronous producer may return an already terminal state with HTTP 200. Consumers
  cannot assume every initial response is `running` or that every operation needs polling.
- Revisions count internal transitions. Consumers can observe jumps and skip intermediate
  states. The same revision must describe the same snapshot; terminal states cannot reopen.
- Confirmation deadlines are Unix epoch milliseconds. Tokens are opaque, server-owned
  values; the consumer must not depend on UUID syntax or length beyond the contract bounds.
- Object-key order is irrelevant to request fingerprints. Integer `1` and JSON number
  `1.0` represent the same value; booleans remain a different type. The Python producer
  normalizes its accepted numeric input before fingerprinting. This does not standardize
  a cross-language cryptographic canonicalization format.
- An unknown profile does not cause conversion or a text fallback. A producer must offer
  the alternative, and a consumer must advertise it. The producer's ordering wins.

No wire version bump is introduced: these clarify existing semantics. The consumer imposes
documented local resource limits; it does not claim to consume every theoretically valid
message. The Python backend implements its two fixed schemas and refuses unsupported
schema keywords at startup, rather than claiming a general JSON Schema engine.

## Still outside the evidence

The exercise covers inline built-in profiles and a small in-memory domain. It does not
certify every profile, arbitrary schemas, references/PDFs, streaming results, remote identity,
durable/distributed effects, workflow orchestration or host-wide confidentiality. Both
implementations use public fixture credentials. Production identity and backend durable
idempotency/reconciliation remain separate work.
