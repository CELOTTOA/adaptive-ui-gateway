# Changelog

## Unreleased

- Advance the application wire protocol to `aug/0.2` for explicit indeterminate outcomes.
- Add optional encrypted SQLite invocation state and durable request receipts behind a store
  interface; never automatically replay interrupted effects, and verify crash/HTTP recovery.
- Add the shared operation runtime with typed/JSON inputs, inline profile rendering,
  explicit confirmation and request/status recovery, available standalone and through MCP.
- Expose metadata-only `aug_open_runtime`; keep private inputs and results on the direct view channel.
- Add backend-owned AUG operation contracts, input validation and invocation lifecycle schemas.
- Introduce a process-local operation broker with owned immutable confirmations, bounded
  deduplication and safe state delivery; expose native handlers and protected reads over HTTP.
- Introduce the transport-independent `aug/0.1` output protocol draft, JSON Schemas,
  built-in representation profiles and explicit runtime/audience negotiation.
- Add opt-in `/v1/aug/query` delivery through the existing protected query checks;
  retain the legacy search view and MCP metadata-only channel.
- Configure the same MCP entrypoint for an external OpenAPI backend with explicit principal,
  tenant, scopes and separate service/view tokens; retain the synthetic demo as the default.
- Select an isolated local env profile with `AUG_ENV_FILE`; reject incomplete external setup.
- Include input schemas in the authorized MCP capability catalog without returning records.
- Run the Archteathos read facade separately and generate a temporary ignored MCP profile.
- Add real stdio external-backend, credential-boundary, startup-failure and Archteathos tests.

## 0.1.0 — experimental publication candidate

- Annotated OpenAPI read discovery, scoped capability catalog and `aug.ui/0.1` plans.
- Deterministic and optional model-assisted planning with validation and fallback.
- Direct authenticated data channel, session checks, field projection and value-free audit hooks.
- Shared fixed renderer, synthetic multi-tenant demo and local MCP Apps adapter.
- Exact sandbox-origin enrollment and optional gateway TLS, with host limitations documented.
- Optional Archteathos read adapter and existing-backend test.
- Public quickstart, architecture/security guides, MIT license and contribution briefs.

This is a candidate, not evidence that a GitHub release or package publication has occurred.
