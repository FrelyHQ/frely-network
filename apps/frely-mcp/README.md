# Frely MCP

This renamed app currently provides the safe local configuration boundary and the
Frely Network capability-resolution client. It is **not a usable MCP service**
yet: `bun run --cwd apps/frely-mcp start` exits with `FRELY_MCP_NOT_READY` until
the later MCP tool-wiring task lands.

The current code reads a bounded local configuration file, accepts only `env:`
secret references, and resolves capabilities through the Network service. It does
not perform Graph discovery, ENS/ERC-8004 verification, provider execution, or
payment. A successful unit test is not evidence of Network admission, provider
business output, or settlement.

## Verify

From the repository root, use Bun 1.4.0:

```sh
npm exec --yes --package=bun@1.4.0 -- bun install --frozen-lockfile
npm exec --yes --package=bun@1.4.0 -- bun test apps/frely-mcp/config.test.ts apps/frely-mcp/network-client.test.ts
npm exec --yes --package=bun@1.4.0 -- bun test packages/protocol/capability-resolution/index.test.ts
npm exec --yes --package=bun@1.4.0 -- bun run typecheck
```

For development, `FRELY_API_KEY` is an environment reference resolved only when
the Network client makes a request; do not put its value in the config file.
