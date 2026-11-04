# Security policy

AUG v0.1 is experimental. The supported review target is the current `main` branch;
there is no production support or response-time commitment.

## Reporting a vulnerability

Do not put real secrets, customer records or an exploitable disclosure in a public issue.
Use GitHub's **Report a vulnerability** under the repository's Security tab if private
vulnerability reporting is enabled. If it is unavailable, open a minimal issue asking for
a private reporting channel, without technical exploit details or sensitive data.
Repository maintainers must enable and verify private reporting before the public launch.

Include the affected revision, required attacker access, reproduction using synthetic
data, expected boundary and observed result. A fix or regression test is welcome.

## Scope and assumptions

The implementation separates UI planning from authorized retrieval. That separation is
not a promise of protection from a compromised desktop client, browser, OS, screen capture,
browser extensions, deliberate user disclosure or host-side observation of a rendered view.
An external model still receives user intent and authorized capability metadata.

The default demo binds to loopback and uses public fixture credentials. Do not deploy its
authentication as a remote service or substitute real records without designing actual
identity, credential storage, backend authorization and operational controls.

Local HTTPS support does not install trust. The private key under `tests/fixtures/tls/`
is deliberately public test material; never use it for a real server or add it to an OS trust
store. The certificate-trust PowerShell script is a guarded, Windows-only experiment,
not part of the quickstart or a supported certificate distribution solution.

For implemented checks, trust boundaries and unresolved issues, read
[the security model](docs/security-model.md) and [compatibility notes](docs/compatibility.md).
