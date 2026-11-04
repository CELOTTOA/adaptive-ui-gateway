# Contributing to AUG

This is an early reference implementation. Small, reproducible findings are especially
valuable: a failing test, an adapter, a host compatibility observation or a usability result.
You do not need a model API key to contribute.

## Local setup

Use Node.js 22.14+ on the 22.x line or Node.js 24.x and npm:

```sh
npm ci
npm test
npm run demo
```

`npm test` builds the packages and runs the contract and integration tests. Provider tests
and the existing-checkout Archteathos test are skipped when their explicit configuration is
absent. `npm run test:live` can contact the configured provider and incur usage charges;
run it only when you intend to use your own key. Do not commit `.envlocal` or local TLS keys.

The [getting-started guide](docs/getting-started.md) explains the demo. Read
[the architecture](docs/architecture.md) and [security model](docs/security-model.md)
before changing policy, data access or host transport.

## Proposing work

Use a bug report for a reproducible failure, a design proposal for an architectural change,
or one of the [initial contribution briefs](docs/community/README.md). For a bug, include
Node/OS versions, the command, expected behavior and a redacted error. For host reports,
include the exact host version and distinguish real sandbox evidence from an external HTTP test.

Keep pull requests focused. Explain the problem and resulting behavior, include the relevant
validation, and update docs when the public contract changes. Add a meaningful regression
test for a policy fix or behavioral change. Documentation-only corrections do not need new tests.
Follow the surrounding TypeScript/ES module style; avoid unrelated formatting changes.

## Boundaries to preserve

- Treat model output as untrusted. The server composes bindings and retains authorization.
- Keep record values and credentials out of model requests, MCP results, audit events and errors.
- Preserve tenant and principal checks when adding a route, adapter or session feature.
- Render values as text through trusted components. Do not execute model-supplied markup/code.
- Do not turn a host network failure into a fallback that sends records through MCP.
- Keep the API-key-free demo and tests operational. Document any optional external service.
- Declare estimates and adapter limitations. Do not present a fixture or simulated provider as a live result.

Please discuss write operations, remote authentication, certificate distribution, new component
execution capabilities or changes to the data/model boundary before implementing a broad solution.

## Review and community

Be specific, respectful and open to contrary evidence. Critique ideas and code rather than
people. Contributors retain attribution and submit contributions under the repository's
[MIT License](LICENSE); no separate contributor agreement is required by this project.
Never post real credentials or customer records. Security reports follow [SECURITY.md](SECURITY.md).
