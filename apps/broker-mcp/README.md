# Broker MCP

A local stdio MCP server exposing only `find_capability`. It delegates discovery
to `@frely-network/the-graph`; it does not verify identities, execute providers,
or make payments. Candidate results are not verified providers.

## Install and verify

From the repository root, use Bun 1.4.0. If the default Bun is older:

```sh
npm exec --yes --package=bun@1.4.0 -- bun install --frozen-lockfile
npm exec --yes --package=bun@1.4.0 -- bun run typecheck
npm exec --yes --package=bun@1.4.0 -- bun test
```

The protocol test launches a real MCP subprocess with a test-only fake discovery
implementation. It verifies initialization, tool listing, calls, invalid inputs,
discovery errors and startup configuration failures. It is not live Graph or M3
evidence. Fake data never replaces a failed production discovery request.

## Production entry

Supply these environment variables through the MCP host:

| Variable | Meaning |
| --- | --- |
| `GRAPH_ENDPOINT` | Required GraphQL HTTP(S) endpoint supplied by G |
| `PAYMENT_NETWORK` | Required manifest payment-network filter; does not initiate payment |

The Graph request timeout is 10 seconds. Metadata retrieval behavior remains that
of the existing discovery adapter. Custom query, metadata gateway and additional
header authentication are not configured by this minimal entry; confirm any such
requirements with G before live integration.

Configure the MCP host to launch this command from the repository root:

```sh
npm exec --yes --package=bun@1.4.0 -- bun run --cwd apps/broker-mcp start
```

With Bun 1.4.0 already on PATH, the equivalent is `bun run --cwd apps/broker-mcp start`.
The process waits for MCP input on stdin; running it alone is not a successful
protocol test. Stdout carries protocol messages only. Configuration failures exit
with status 1 and a generic message on stderr, without printing secrets.

## Tool

`tools/list` exposes `find_capability`. Example `tools/call` arguments:

```json
{"capabilities":["vision"]}
```

Capabilities must be a nonempty array of nonblank strings. Use the capability
from the manifest: `vision-basic` is a model name, not necessarily a capability.

The business value is `ProviderCandidate[]`. MCP wraps it in
`structuredContent.providers`, with the same JSON object in text content:

```json
{"providers":[{"id":"fake-provider","capabilities":["vision"],"supportsX402":true}]}
```

This example is synthetic. No endpoint, payment receipt or `verified: true` is
invented. Known discovery failures (`NO_PROVIDER`, `GRAPH_QUERY_FAILED`,
`GRAPH_SCHEMA_INVALID`, `CAPABILITY_NOT_SUPPORTED`) return `isError: true` with
the code. Unexpected failures return `DISCOVERY_FAILED`. Calls are not retried.

## Next milestone

T3 requires G's actual Graph configuration and indexed manifest data, followed
by a real MCP call returning candidates. A passing fake test does not satisfy
T3. `use_capability` and the Frely execution path remain T4; payment stays separate.
