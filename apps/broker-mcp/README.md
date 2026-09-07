# Broker MCP

A local stdio MCP server exposing `find_capability` and `use_capability`. Discovery
uses `@frely-network/the-graph`. Execution resolves identity before calling Frely.
An operator-approved configuration enables budgeted Hedera Testnet payments. Candidate results alone are not verified providers.

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
T3. T4 implementation is described below; real identity and Frely validation remain pending. Payment stays separate.

## Offline mock while Graph is unavailable

Run this explicit development entry from the repository root:

```sh
npm exec --yes --package=bun@1.4.0 -- bun run --cwd apps/broker-mcp start:mock
```

The MCP host launches the same command and calls `find_capability`. This entry
uses fixed synthetic candidates, never a model or network request. It prints a
mock notice to stderr; candidate IDs are prefixed with `mock-`. There are no
endpoint or verified fields and `supportsX402` is false. These records cannot
serve as identity, Provider execution, payment or live Graph evidence.

| Capabilities | Result |
| --- | --- |
| `["vision"]` | mock-vision-basic, mock-vision-ocr (fixed order) |
| `["vision", "ocr"]` | mock-vision-ocr |
| `["audio"]` | NO_PROVIDER |

All requested capabilities must match. The mock OCR candidate is synthetic and
does not claim that W has delivered an OCR service.

Set `MOCK_DISCOVERY_SCENARIO` only for this entry: `success` (default) filters the
fixed records, `empty` always returns NO_PROVIDER, and `query-error` returns
GRAPH_QUERY_FAILED. Unknown scenarios exit with MOCK_SCENARIO_INVALID.

Production `start` remains unchanged and never falls back to mock. T3 remains
blocked pending a verified live Graph call. Run `bun test apps/broker-mcp` under
Bun 1.4.0 to verify both the minimal protocol and the offline mock scenarios.

## T4: use_capability (integration only)

The production entry registers both tools. The standalone discovery mock still
registers only find_capability; it does not pretend its candidates have identities.

Additional environment variables for use_capability:

| Variable | Meaning |
| --- | --- |
| ENS_SEPOLIA_RPC_URL | G-provided Sepolia RPC |
| IDENTITY_CHAIN_ID | Must be 11155111 |
| ERC8004_IDENTITY_REGISTRY | G-provided nonzero registry address |
| BROKER_EXECUTION_MODE | Must explicitly be integration |
| FRELY_ALLOWED_ORIGIN | Trusted HTTPS origin allowed to receive the caller key, without trailing slash |
| FRELY_CALLER_API_KEY | Frely caller credential; never Swarm or model credentials |

Example tool arguments:

```json
{"capabilities":["vision"],"task":"Describe the image","input":{"image_url":"https://images.example/demo.png"}}
```

The Broker filters discovered candidates by all requested capabilities, sorts by
lowercase ENS name then ID using ordinal comparison, resolves the first one and
requires verified=true with matching identity. Failure stops; there is no next-
provider fallback. Only responses over HTTPS is supported. The origin setting
restricts credential delivery and never replaces ResolvedProvider.endpoint.

The current executor supports only vision, maps the request to vision-basic,
and requests non-streaming, non-stored Responses output. Redirects are disabled;
requests time out after 30 seconds and are not retried. Without payment enabled,
HTTP 402 returns PAYMENT_REQUIRED. The paid route requires an explicit request ID
and atomic budget; legacy maxAmount is unsupported. It preserves paymentOutcome
independently of business output. PAYMENT_CONFIG_PATH selects an operator-approved
policy via FRELY_PAYMENT_REGISTRY; absence leaves payment initialization disabled.
See the [x402 architecture](../../docs/architecture.md#x402-architecture-1--client-and-gateway-responsibilities)
and [payment workflow](../../workflows/hedera-auto-payment.md) for the input,
authorization and recovery contracts.

Integration mode is not a free-service guarantee: W must explicitly provide the
allowed test billing or payment exemption arrangement. The Broker never bypasses
Frely authentication and never calls Swarm directly.

T4 tests use synthetic identity and HTTP responses. They prove orchestration,
identity rejection, request mapping and credential-origin checks, not a real
Provider call. The existing G resolver still needs its ENSIP-25 association and
metadata/endpoint consistency issues reviewed before real acceptance. No identity
checks were disabled to make these tests pass.
