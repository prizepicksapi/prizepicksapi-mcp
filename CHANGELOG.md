# Changelog

All notable changes to this package. Dates are UTC.


## Unreleased

- tools/list now returns all fifteen tools with or without a key, so clients and registries see the whole surface; a
  keyed tool called without a key still returns the sign-up link and spends nothing.
- Every tool description says when to use it instead of its siblings and what the rows contain; every argument has a
  description and enums where the API has them (`status`, `result`, `tier`).
- Tool annotations add `destructiveHint: false` and `idempotentHint: true`.
## 0.1.0 - 2026-11-15

- First release: stdio MCP server for the PrizePicks API at https://prizepicksapi.com. Keyless tools work with no key; set
  `PRIZEPICKS_API_KEY` for the rest. Published to npm as `prizepicksapi-mcp`.
