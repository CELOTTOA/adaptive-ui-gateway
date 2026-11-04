# v0.1 publication record

This file records preparation evidence, not a certification of production readiness.

## Public scope

The release presents AUG as an experimental reference implementation of metadata-driven,
read-only UI planning with a separate authorized data channel. The API-key-free synthetic
demo is the supported first experience. Archteathos is an optional external-checkout adapter.
The license is MIT, attributed to DevSoftIQ and contributors as identified by the project RFC.

The GitHub repository is [CELOTTOA/adaptive-ui-gateway](https://github.com/CELOTTOA/adaptive-ui-gateway),
matching the authenticated maintainer account. It was first created privately for validation.
The initial source snapshot is commit `228206afca72f27e8e8043e180785c8393ad7f01`,
authored with the maintainer's GitHub noreply address. The original repository/history
remains separate and unchanged; it was not pushed to GitHub.

## Source snapshot

`npm run export:publication -- .local/publication/candidate` creates a deliberate source
snapshot with a sibling SHA-256 manifest. It excludes `.git`, `.envlocal`, local TLS material,
generated builds, installed dependencies, logs and loose unreviewed artwork. Existing local
history is not rewritten. The source-history review is a separate read-only check.

`npm run check:publication -- --history` checks relative documentation links, selected common
credential formats, exact configured local-secret values and private-key exceptions against
working sources and reachable Git blobs. Values are never printed. The public TLS test key
is an explicitly documented exception. This is targeted checking, not an exhaustive scanner.

Before publishing, inspect the selected source paths and verify a clean `npm ci`, `npm test`
and an actual demo launch without a key or local backend. Run `npm audit --omit=dev` against
the registry. Check the GitHub matrix rather than representing a configured workflow as passed.

## Evidence on 4 November 2026

- Working tree: `npm test` passed 76 tests, skipped 3 opt-in live tests, failed 0 (79 total).
- Separate Archteathos backend run: 10 passed, with 13 source sheets retrieved over HTTP.
- Production dependency audit: 0 known vulnerabilities reported by the npm registry.
- Targeted publication scan before the final documentation update: 107 source files and
  95 historical text blobs passed. No configured local-secret matches were found.
- Clean snapshot: fresh dependency installation, the same 76 passed / 3 skipped tests,
  publication checks and the actual deterministic demo-launcher smoke all succeeded.
- [GitHub CI run 41847411105](https://github.com/CELOTTOA/adaptive-ui-gateway/actions/runs/41847411105)
  passed all four Windows/Linux × Node 22/24 jobs. Each installed from the lockfile, built,
  tested, launched the demo on free ports and checked publication files. The production
  dependency audit passed in the Linux Node 24 job. External provider tests were skipped.

No browser interaction or real desktop HTTPS sandbox test is implied by this CI result.
The initial publication source has no `.envlocal`, working TLS key, installed dependencies,
generated build, unreviewed artwork or original Git history. The public TLS test fixture
is intentional and is not a credential for any operational endpoint.

## Intentional open items

The live ChatGPT HTTPS path, certificate lifecycle, independent real-host context checks,
AI-layout usefulness evaluation and production identity are not release claims. Their
contribution briefs are linked from [the roadmap](roadmap.md). No certificate trust-store
or real-user desktop configuration change belongs to this publication task.

Before public release, enable and verify GitHub private vulnerability reporting. Do not post
the draft community briefs as public messages automatically; they remain reviewable issue
seeds in the repository. Hosting documentation/source is distinct from deploying a data gateway.
