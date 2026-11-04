These certificate and key files are public test fixtures only. They are never installed in
an OS trust store or used by the MCP demo. Tests trust the fixture certificate explicitly
on their own HTTPS connections. Real local TLS files belong in the ignored `.local/tls/`.
