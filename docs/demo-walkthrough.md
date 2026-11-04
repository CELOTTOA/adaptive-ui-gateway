# Demo walkthrough

The primary demonstration is the synthetic customer API. All names, notes, tokens and
amounts below are intentional public fixtures.

1. Run `npm run demo` after installation. Open http://127.0.0.1:4000.
2. Enter `demo-analyst-token`. Select **Create search interface**.
3. The page fetches the authorized catalog and asks the gateway to create a plan.
   The plan describes a search input, button, table and status. It contains no customer rows.
4. Type `CANARY` in the generated Search input and select **Search**.
5. The view sends the plan session, approved action and search state directly to the gateway.
   The data response contains this single tenant-a record:

| id | name | city | amountDue |
|---|---|---|---|
| cus-a-001 | Aurora CANARY-A-7F3A | Milano | 1250.5 |

`internalNotes` and `tenantId` are absent from the UI projection. An empty search returns
two tenant-a rows. `Torino` returns the other tenant-a fixture; an unmatched term returns zero.

For a second session, use `demo-other-tenant-token`: it has its own tenant-b capability
context and returns its own synthetic record. `demo-no-scope-token` cannot discover/create
the customer search plan. A plan from another principal/tenant cannot be replayed.

These assertions are covered in `tests/integration/protected-flow.test.mjs`. Renderer tests
exercise text handling and permitted columns; model tests record the simulated provider
channel to check that canaries and credentials are absent.

## Inspect the boundary

In browser developer tools, observe `/v1/catalog`, `/v1/plans` and `/v1/data/query`.
Only the last response contains customer rows. Planner audit events contain identifiers,
field names and counts, not query/record values. The browser is intentionally allowed to
see the returned records: it is the display recipient, not a data-blind party.

An embedded MCP view has the same renderer but a host-specific network boundary. Its
success must be checked inside that host. This standalone walkthrough does not validate
Claude/ChatGPT sandbox policy or the model context maintained by those applications.
