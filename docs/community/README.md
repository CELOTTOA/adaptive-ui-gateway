# Initial contribution briefs

These briefs can become GitHub issues after publication. They define concrete questions
and acceptance criteria without prescribing a large redesign.

These briefs originated with the read-only search prototype. The current baseline also
includes `aug/0.2` operations, a shared runtime and optional encrypted invocation storage;
see [the roadmap](../roadmap.md) for protocol conformance and independent implementation
questions. Keep a brief's original search-specific scope explicit when reproducing it.

| Brief | Suggested kind |
|---|---|
| [Reproduce the quickstart](01-reproduce-quickstart.md) | Documentation / first contribution |
| [Bound backend response streaming](02-response-streaming.md) | Data-plane hardening |
| [Evaluate planner usefulness](03-planner-evaluation.md) | Research / UX evaluation |
| [Contribute an independent backend adapter](04-independent-adapter.md) | Integration |
| [Review local HTTPS and host boundaries](05-host-https.md) | Architecture / host interoperability |
| [Bound OpenAPI reference resolution](06-openapi-references.md) | Discovery hardening |

Use synthetic data. Security findings follow [SECURITY.md](../../SECURITY.md), rather than
posting exploitable details publicly. Do not label policy changes as beginner tasks solely
because the patch is short.
