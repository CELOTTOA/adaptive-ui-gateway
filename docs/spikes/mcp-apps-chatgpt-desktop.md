# Spike: AUG in ChatGPT Desktop

Date: 2026-11-03. Status: native view renders; origin enrollment succeeds; HTTP is blocked
by host CSP. **Local HTTPS is implemented and tested; certificate approach is under review.
The current generated certificate must not be trusted because of its key's broad ACLs.**

## First route: local Codex host

The current [OpenAI MCP documentation](https://learn.chatgpt.com/docs/extend/mcp#configure-in-the-chatgpt-desktop-app)
supports STDIO servers in ChatGPT Desktop's local Codex host. Start here to test the same local
process already used by Claude. This is distinct from installing a plugin in ordinary ChatGPT
conversations; configuration alone does not prove that a given chat surface renders MCP Apps.

Build with `npm run build`. In ChatGPT Desktop, open **Settings > MCP servers > Add server**:

| Setting | Value |
|---|---|
| Name | `aug` |
| Transport | `STDIO` |
| Command | `C:\Program Files\nodejs\node.exe` |
| Arguments | `C:\adaptive-ui-gateway\apps\mcp-apps-server\dist\main.js` |
| Working directory, if offered | `C:\adaptive-ui-gateway` |

The proposed HTTPS profile sets `AUG_GATEWAY_TLS_CERT` and `AUG_GATEWAY_TLS_KEY` to local PEM
files under `.local/tls/`. Those files are now under a security hold: do not activate this
profile with the current keypair. Decide on certificate storage and trust before proceeding.
HTTP remains the default when both settings are absent, preserving the working Claude setup.
Setting only one TLS path fails at startup instead of downgrading to HTTP.

After a certificate solution has been reviewed, safely provisioned and explicitly approved,
save and select **Restart**, then start a new local Codex conversation. Use `/mcp` to check
availability. The ready-to-merge TOML equivalent is [chatgpt-desktop.config.toml](chatgpt-desktop.config.toml).
Existing MCP servers and settings must be preserved. No user-level configuration was edited
automatically as part of this preparation.

Ask to open the AUG customer search view, enter `demo-analyst-token` inside the view, create the
interface and search `CANARY`. Expected: one authorized row from tenant-a. Validate:

1. MCP initialization, app support advertised by the host, and resource loading.
2. `aug_register_view_origin` called from the view with only the exact origin.
3. HTTP preflight 204, plan creation 201, query 200 with one row.
4. A new view/conversation can enroll its own exact origin.
5. Values remain outside MCP results; check the model context separately from HTTP success.

Record the actual sandbox origin and connection details on failure. If the local host does not
render the view, distinguish that from a failed direct HTTP request before changing transport.
Do not infer that a native desktop app guarantees loopback access from its sandboxed UI.

## Compatibility prepared

ChatGPT [supports the MCP Apps standard](https://developers.openai.com/plugins/build/chatgpt-ui).
The shared renderer and `App.connect()` remain unchanged. The origin recognizer now also
accepts the documented default `https://web-sandbox.oaiusercontent.com` and one DNS label
under it for dedicated widgets. Sources: [OpenAI reference](https://developers.openai.com/plugins/reference)
and [OpenAI's app implementation lessons](https://developers.openai.com/blog/15-lessons-building-chatgpt-apps).

The Windows native Codex host has now been observed using a different scheme:
`codex-sandbox://mcp-app-759ffd0cc15e6b093ffcc9e0beb80edc046100e46aa928f0.web-sandbox.oaiusercontent.com`.
Its view reported all local-network policies delegated, but the HTTPS-only origin recognizer
skipped registration. A direct preflight reproduction against the active gateway on port 62522
returned 403 for that origin. This is a reproduction with an explicit Origin header, not a
capture of the browser's network request.

The shared origin rule now also accepts the observed native format: `codex-sandbox://mcp-app-`
followed by exactly 48 lowercase hexadecimal digits and `.web-sandbox.oaiusercontent.com`.
Registration preserves the original scheme; it does not translate it to HTTPS or permit a
wildcard. Other schemes, app prefixes, hash lengths, paths, ports and deceptive hosts fail closed.
This native format comes from the real view diagnostic, not a documented guarantee across
all future Codex versions. Reload the AUG MCP server and open a fresh view to test it.

The same origin pattern is inlined into the view and enforced by the server. Matching a host
does not authorize data: the bridge enrolls one exact origin in one process, capped at 128
dynamic entries, and HTTP requests still need the access token and gateway policy checks.
Unregistered sibling origins, lookalike sites, other oaiusercontent hosts, paths and ports are
rejected. The default ChatGPT sandbox is shared; this local demo does not replace production
authentication or the dedicated widget origin required for submission.

The two metadata/search tools declare read-only annotations. The app-only origin registrar
declares its in-memory mutation; it returns no records, credentials, plan or session id.

Validation: `npm test` passed, **75 passed / 2 live skipped / 0 failed** (77 total), build included.
New origin and browser-glue tests failed before the change. The real two-process STDIO test
enrolls both HTTPS and native Codex origins on only one instance, checks exact CORS responses,
then creates a plan and queries one row over HTTP. The two native-origin tests failed before
the fix. This is server-side/local evidence, not a result from the real ChatGPT iframe.

## Ordinary ChatGPT conversations

For ordinary Chat/Work usage, package and install a plugin instead of assuming local Codex
configuration applies to those surfaces. OpenAI documents
[local plugin packaging and marketplaces](https://developers.openai.com/plugins/build/plugins)
and [desktop-only STDIO plugins](https://developers.openai.com/plugins/deploy/desktop-only).
Local marketplace availability varies by surface; public local-MCP submission is a separate
process limited to approved partners.

For a hosted plugin, [Connect and test your plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt)
requires public HTTPS/Streamable HTTP or Secure MCP Tunnel. A tunnel can expose MCP metadata
and tools without public ingress, but it does not by itself solve the view's direct data channel.
The current AUG entrypoint is STDIO. A remote route needs its own adapter/authentication and a
reachable, authorized data endpoint, while keeping protected records out of MCP results.

No server was published, no tunnel was started and no OpenAI API key is needed for this local
spike: Grok remains the optional AUG planner, while ChatGPT is the host.

## Confirmed second failure: HTTP removed from host CSP

On 2026-11-03 at 17:37 CET the new instance used port 50215. The exact native origin was
already registered: an external preflight returned 204 with the correct allow-origin.
The real desktop console log explicitly reports that connecting to
`http://127.0.0.1:50215/v1/plans` violates `connect-src`. The declared gateway origin is absent
from the policy applied by the host. Local-network permissions being delegated does not bypass CSP.

Read-only inspection of the installed ChatGPT Desktop `26.1027.6604.0` resource normalizer
confirms that it reads both standard `ui.csp` and the legacy OpenAI alias, then drops HTTP
connection origins in this build. Running the extracted pure normalizer in an isolated VM
returns `null` for the local HTTP origin and preserves the equivalent HTTPS origin. Adding
another metadata alias therefore would not fix this case. No installed application files were edited.

The gateway now supports optional HTTPS, advertises the effective HTTPS origin to the view
and its resource CSP, and derives same-origin checks from the actual TLS socket. TLS validation
remains enabled. Tests verify default rejection of an untrusted self-signed certificate,
per-connection explicit trust, exact native-origin CORS, authenticated plan/query, HTTPS
same-origin behavior, a real TLS-enabled stdio process and incomplete configuration failures.
No host/browser test of the HTTPS flow has succeeded yet.

### Current certificate rejected for use; decision deferred

**Security hold, 2026-11-03:** inspection found that the generated private key inherits broad
workspace ACLs, including read access for `BUILTIN\Users` and modification for
`NT AUTHORITY\Authenticated Users`. Exclusion from Git is not access control. The current
keypair must not be trusted: first provision private storage with access limited to the user,
SYSTEM and administrators, then generate a new short-lived keypair. Do not reuse the old
fingerprint as approval for a new certificate. The trust script now fails closed on broad
key/directory ACLs or unexpected ownership. No real-user trust-store import has occurred.

The ignored `.local/tls/` contains the old proposed keypair, retained only as an inspected
artifact. These details identify that keypair; they are not an installation candidate:

- Names: `localhost` and `127.0.0.1`; TLS server authentication; `CA:FALSE`.
- Valid until 2027-11-03 16:45:50 UTC.
- SHA-256: `EC788E76C2376938F1BC3817A85AC0264C8EEF5EAC219EE1DB407BD6585F8194`.
- SHA-1 thumbprint: `46505325B2134F19CCDE36F5CC6607AE03149C1E`.

No certificate has been added to the real user's trust store. No existing trusted localhost
certificate was found in the user's personal store. There is no pending instruction to
install the old certificate. The user requested a development-status update first and a
separate discussion of the certificate afterwards. No trust-store, ACL or configuration
change is authorized by that documentation request.

The trust script has been parsed and exercised with a mocked import: it rejects the current
broad key/directory ACLs before reaching import. The real import has not been executed.
The proposed TLS profile has been parsed and its file paths verified, but the real user's
MCP config has not been switched to HTTPS. Tests use a separate public fixture keypair which
is never installed in an OS trust store. A future proposal must first select safe storage,
generate a new short-lived keypair and review its new fingerprint and removal procedure.
