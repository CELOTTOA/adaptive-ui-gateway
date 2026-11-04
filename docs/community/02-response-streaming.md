# Enforce the backend response limit while reading

The core currently checks Content-Length and then validates the size after buffering text.
A missing or false header can allow excess memory consumption before rejection.

Propose a bounded stream reader in `packages/security`, preserving timeout/redirect behavior
and safe errors. Acceptance: normal responses still work; chunked/oversized and misleading
length responses are stopped at the configured byte limit; streams are cancelled and no
partial record list is returned. Tests should exercise behavior rather than mirror the loop.
