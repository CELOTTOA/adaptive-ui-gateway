# Persistent invocation state — reference adapter

The broker now accepts an `InvocationStore` port. Its default remains in-memory state.
The optional `SqliteInvocationStore` persists invocations and request reservations across
gateway/process restarts, with encrypted private payloads and conservative crash recovery.

## Enable explicitly

Configure both variables in an ignored local profile or inject them through your secret
manager:

```dotenv
AUG_STATE_DB=.local/state/operations.aug-state.sqlite
AUG_STATE_KEY=
```

`AUG_STATE_KEY` must contain the canonical base64 encoding of 32 cryptographically random
bytes. Supply the key independently of the database and keep it secret. An empty/missing
pair disables persistence; a partial or invalid pair fails startup. A wrong key, invalid
archive or database already owned by another gateway also fails startup. There is no
automatic reset, key generation or fallback to an empty store.

The demo launcher and local MCP launcher read these variables. For MCP, only the HTTP data
gateway owns the persistent broker; the metadata service uses no persistent connection.
Hosts that launch multiple MCP processes need a separate database per gateway process.

Programmatic integrations can supply `operationStore: () => new SqliteInvocationStore(...)`
to `GatewayService`/`startGatewayServer`, or `store` to `OperationBroker`. The factory is
called for one broker owner, and startup validates persistent configuration immediately.
`GatewayService.close()`/HTTP server shutdown closes the broker and database. Registering
an invalid operation or failing to bind the server also releases ownership.

Keep the database directory private and outside publication artifacts. The default example
uses ignored `.local/`; the conventional `*.aug-state.sqlite` name and sidecars are ignored
and excluded from source exports. Other filenames also require an ignored/private location.

## Commit boundaries and ownership

The adapter uses SQLite transactions and `synchronous=FULL`. A request reservation and its
initial invocation record commit atomically. The broker commits `running` before calling a
handler, and commits a terminal result before exposing it. State replacements compare the
expected revision. Persistence failures prevent dispatch; failure to persist a completion
faults the broker rather than claiming the operation safely failed.

The reference adapter has one exclusive connection owner. Its OS lock remains held between
commits and is released on close/process death. A second owner is refused, including from a
different process. This intentionally supports one gateway process per local database,
not a distributed or network-filesystem broker. See the primary documentation for
[SQLite exclusive locking](https://www.sqlite.org/pragma.html#pragma_locking_mode) and
[atomic commits](https://www.sqlite.org/atomiccommit.html).

SQLite is loaded only when the adapter is constructed, using Node's built-in module; no
new npm dependency is required. The implementation uses the API available on the project's
Node 22.14+ baseline; see [Node 22 SQLite documentation](https://nodejs.org/download/release/v22.13.1/docs/api/sqlite.html).

## Recovery semantics

| Persisted state | After restart |
|---|---|
| `awaiting_confirmation` | Same saved input and token; original deadline and authorization still apply |
| `succeeded` / `failed` / `expired` | Same retained result/state, without executing again |
| `running` | `indeterminate` with `EXECUTION_OUTCOME_UNKNOWN`; no automatic handler replay |
| Retired private payload | Request ID remains reserved; replay returns HTTP 410 |

A handler may apply an effect before a crash or before returning an invalid result. AUG
cannot infer whether the domain operation committed. Errors after dispatch of a non-read
handler therefore also become `indeterminate`. Authorization failures before dispatch
remain ordinary failures. A closed broker ignores late handler completion; it cannot
overwrite recovery performed by a replacement broker.

The runtime locks new invocations in an indeterminate view and offers only status checks.
Reconciliation must use the backend's authoritative domain data; this step adds no generic
"retry anyway" or administrative resolution endpoint. Backends must still implement durable
domain idempotency and reconciliation using authenticated identity and request ID. Broker
persistence does not provide a transaction spanning a remote backend, and does not claim
exactly-once business effects.

Pending confirmations and retained results are bound to both the operation version and a
hash of its complete descriptor. Changing a descriptor without a version bump invalidates
old confirmations/replays with HTTP 409. Handler implementation changes must also receive
a new operation version; source code itself is not serialized or hashed as a contract.

Retained output also requires all originally granted caller scopes to remain present.
Registrations can supply `authorizeInvocation(input, principal)` for current resource-level
access. That guard is checked for fresh requests, replay, status, confirmation and dispatch,
using saved immutable input. It must check authorization separately from business-state
preconditions, which may naturally change after an effect. Returning anything other than
exactly `true` denies access.

## Retention and request receipts

The existing limits still apply: by default 1,000 retained/active payloads, a five-minute
confirmation deadline and fifteen-minute terminal payload retention. Retired payloads lose
their inputs, results and confirmation tokens from the active store. The persistent adapter
keeps an encrypted minimal receipt with invocation ID, request fingerprint and contract
hash, indexed by a keyed digest of tenant/user/request ID.

Receipts reserve the original request ID after payload expiry and across restarts.
Replaying the same request returns `INVOCATION_RETIRED` (410); reusing its ID for different
inputs returns `IDEMPOTENCY_CONFLICT` (409). Neither executes the handler. Receipts are not
automatically pruned and will grow with unique requests. Explicit archival/deletion policy
and key rotation remain operational work. The memory adapter retains its original finite
deduplication window.

There is no durable browser credential/input cache. A view kept open can recover using its
invocation/request ID after a server restart; closing/reloading it loses its client receipt.
Other clients must retain their own opaque request/invocation identifiers to recover later.

## Encryption and archive boundaries

Private records and receipts use AES-256-GCM with fresh random nonces and authenticated
metadata. Encryption and index keys are independently derived from the supplied master
key. Principal/tenant/request identifiers are not plaintext indexes. SQLite stores opaque
invocation IDs, state, revision and retention timestamps outside the encrypted payload.
It is not whole-database encryption; access patterns and operational metadata remain visible.

The database does not contain the master key. Loss of the key prevents recovery. A wrong
key or altered authenticated record fails closed. Existing foreign files/databases are
rejected without initializing or replacing them. Store errors and handler errors never
echo private values, keys or database paths through the protocol.

The operating system/filesystem and archive administrator remain trusted for availability
and rollback prevention. Deleting/restoring an older archive can lose request reservations;
backups must be coordinated with backend reconciliation. Encryption does not prevent file
deletion or prove that a database is the newest copy, and does not protect against an
untrusted chat host after content is delivered to its view.

## Wire compatibility

The application protocol advances to **`aug/0.2`** because the invocation state machine adds
`indeterminate`. Core schemas and runtime messages use that version explicitly. Generic
`aug/0.1` messages are refused; upgrade the backend and generic runtime together and restart
the MCP server to reload the resource. Representation profiles such as `aug.collection/0.1`
and the legacy `aug.ui/0.1` search plan remain separately versioned. Existing legacy search
endpoints keep their prior contract.

The SQLite archive has an independent internal format version. Unknown formats or invalid
retained records are rejected; no automatic migration is performed.

## Evidence

[Contract tests](../tests/contract/invocation-persistence.test.mjs) cover reopen/replay,
confirmation recovery, a forcibly killed worker, ownership, encryption, wrong keys,
altered records, foreign files, retirement receipts, authorization and failed persistence
before dispatch/after completion. [HTTP tests](../tests/integration/persistent-operations.test.mjs)
cover shutdown/restart, saved confirmation, result recovery and interrupted execution.
The [runtime contract test](../tests/contract/operation-runtime.test.mjs) covers the locked
unknown-outcome state and status-only recovery. All fixtures use synthetic data and temporary
archives; tests do not enable persistence for a real application or perform production writes.
