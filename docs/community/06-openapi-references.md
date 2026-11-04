# Bound OpenAPI reference resolution

Discovery recursively resolves local schema references. Cyclic or deeply nested documents
need a bounded failure mode; the importer is not a complete OpenAPI validator.

Acceptance: self and mutual cycles terminate with a safe, documented error; reasonable
acyclic local references still import; missing/unsupported references fail clearly; errors
do not echo sensitive document contents. Document input trust assumptions and size/depth limits.
