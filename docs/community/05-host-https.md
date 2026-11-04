# Review local HTTPS and the embedded host boundary

The observed ChatGPT Desktop/Codex build filters loopback HTTP from the resource CSP.
HTTPS gateway tests succeed locally; the actual host HTTPS path and certificate lifecycle
remain unverified. The prior generated key had unsafe inherited permissions and was rejected.

Acceptance: an architecture proposal covering private-key storage, OS trust scope, identity
of the endpoint, rotation/removal and host/version evidence. Use synthetic records and
separate CORS tests from actual sandbox fetches and model-context checks. Never disable
verification or install the public TLS fixture in an OS store as a workaround.
