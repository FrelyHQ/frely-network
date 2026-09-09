# Frely Network

Open-source Agent Capability Network for ETHOnline 2026.

The project lets a host agent discover, verify, purchase, and invoke an
external capability. The current P0 target uses A2A, The Graph and ENS/ERC-8004
for discovery and identity, and Network's Hedera x402 layer for pay-per-use
settlement. Frely exposes the A2A service and handles ordinary account billing;
Swarm executes the task. G's packages implement discovery and identity, not
the A2A task client, payment orchestration, or Frely billing.

## Stack

- TypeScript
- Bun workspaces
- No required Agent Runtime dependency

## Repository layout

- `packages/protocol`: manifest schema and shared contracts
- `packages/discovery`: live provider discovery adapters
- `packages/identity`: ENS and ERC-8004 integrations
- `packages/payment`: Hedera x402 client integration
- `packages/broker`: discover, select, pay, and execute orchestration
- `packages/gateway`: Network x402 gateway
- `apps/broker-mcp`: historical scaffold; not the current P0 ingress
- `apps/explorer`: P1 explorer application
- `examples`: minimal Vision capability providers
- `scripts/register-provider`: P0 provider registration script
- `docs`: architecture and sponsor integration notes

## Development

```bash
bun install
bun run typecheck
bun test
```

## Discovery and identity entry point

B can add `"@frely-network/provider-directory": "workspace:*"` to the consuming
package's dependencies, then run `bun install` and use this server-side entry:

```ts
import { createProviderDirectory } from "@frely-network/provider-directory";

const { findProviders, resolveProvider } = createProviderDirectory(process.env);
const candidates = await findProviders(["vision"]);
// B owns deterministic selection; selected must come from candidates.
const selected = selectProvider(candidates);
const provider = await resolveProvider(selected);
// B must also enforce Network payment, Frely authorization/reservation,
// and support provider.a2aProtocolVersion before invoking provider.endpoint.
```

`selectProvider` above denotes B's selection function, not an SDK export.
The two returned functions use the existing shared types and can be passed as
callbacks without binding. Construction validates configuration but makes no
network requests. Calls use the real adapters; there is no fixture or endpoint
fallback, and errors propagate to B without starting execution or payment.

Required environment variables are listed in `.env.example`: `GRAPH_ENDPOINT`,
`ENS_SEPOLIA_RPC_URL`, `IDENTITY_CHAIN_ID`, `ERC8004_IDENTITY_REGISTRY`, and
`PAYMENT_NETWORK`. P0 fixes the identity chain to `11155111` and the payment
network to `hedera:testnet`; neither value supplies missing Provider claims.
Optional `METADATA_GATEWAY` is an HTTPS IPFS gateway prefix, such as
`https://gateway.example/ipfs/`, or a `{cid}` template. The same gateway is passed
to both Graph discovery and ERC-8004 reads. Metadata URIs must be HTTPS or IPFS
with an explicit gateway. ERC-8004 `data:application/json;base64,...` registration
files are decoded locally with strict base64/UTF-8 validation and a 1 MiB limit;
they do not require a gateway or an HTTP request. HTTP metadata is not supported.
Run Bun from the repository root to load a local `.env`, or inject these variables
in the server environment. Do not bundle this entry or Graph credentials into
the browser, or log URLs containing API keys.

Discovery reads the actual registration file referenced by `agentURI`; a missing,
invalid, or unavailable file cannot fall back to indexed fields. Official Agent0
row IDs use `chainId:agentId`, while `ProviderCandidate.id` remains the canonical
decimal token ID expected by the frozen shared types. Row network and token ID
claims must agree, and the ENS name must agree with the fetched metadata.

Resolution independently reads the configured ERC-8004 Registry's `tokenURI`,
normalizes the registration file with the same parser, and verifies the candidate
capabilities. It checks the exact ENSIP-25
`agent-registration[<ERC-7930 registry>][<agentId>]` record key and requires a
non-empty value; the value itself is not a serialized identity proof. The ENS
name, `a2a` protocol, and HTTPS execution endpoint must agree with the registration
file. It then fetches the public Agent Card and checks that its supported JSON-RPC
interface points to the same execution URL. The result contains `endpoint`,
`agentCardUrl`, and `a2aProtocolVersion`. ENS remains the execution endpoint
authority. Card retrieval is a public GET; it never sends Frely credentials or
executes a task. Failed identity checks never authorize execution or payment.

`supportsX402` reports the service's explicit native support declaration. A Frely
service with `false` can still be purchased through Network. B must independently
enforce Network payment and Frely authorization/reservation; neither a candidate
nor `verified: true` grants permission to execute. Network's payment ingress is
separate B-owned configuration, not derived from `endpoint` or `agentCardUrl`.

### Registration metadata profile

The shared parser accepts the A2A P0 manifest (`identity`, `capabilities`,
`interfaces`, `payment`) and ERC-8004 `registration-v1` files using `services`.
Runtime metadata must declare `active: true` and an explicit `x402Support`
boolean. For a services file, publish `ENS` and `A2A` entries: the A2A service
endpoint is the **Agent Card URL**, following ERC-8004. The required Frely
`interfaces` extension separately supplies the execution URL and matching Card
URL. Standard A2A service entries without this extension are not supported by
this P0 parser; it does not guess missing execution URLs. Frely's `capabilities` and `payment`
extensions may be top-level or in Agent0's `metadata` bag. These extensions are
project requirements, not fields guaranteed by ERC-8004 itself:

```json
{
  "capabilities": ["vision"],
  "interfaces": [{
    "protocol": "a2a",
    "endpoint": "https://provider.example/a2a",
    "agentCardUrl": "https://provider.example/agent-card.json"
  }],
  "payment": { "protocol": "x402", "network": "hedera:testnet" }
}
```

This snippet only illustrates the extensions; it is not a complete registration
file or a deployed Provider. `payment` describes the Network integration profile;
it does not supply a payment URL, quote, asset, or payee. `x402Support: true` does
not imply a payment network.
Conflicting duplicate ENS, identity, endpoint, or payment claims are rejected.
When `registrations` is present, it must include the exact configured chain,
Registry address, and token ID; conflicting entries for that Registry are rejected.
Without explicit Frely capabilities, OASF `skills` are exposed only as exact skill
IDs. OASF domains are not capabilities, and skill paths are not automatically
mapped to `vision` or `ocr`.

See the [ERC-8004 registration specification](https://eips.ethereum.org/EIPS/eip-8004)
and [Agent0 JSON writer](https://github.com/agent0lab/agent0-ts/blob/main/src/utils/registration-json.ts)
for the standard services and extension shapes.

### Verification limits

The identity/discovery tests use explicit fixtures, not live Graph or on-chain
acceptance evidence. This package handoff alone does not complete M3: real Agent0
results, W's deployed Provider and manifest, ERC-8004 registration/ENS linkage,
and joint review remain required. The current Graph query reads at most 1,000
agents without pagination, so discovery completeness is not guaranteed. No
upstream Graph availability claim is made by these offline tests.

Card discovery supports explicit A2A 0.3.0 `preferredTransport: "JSONRPC"` and
matching A2A 1.0 JSONRPC `supportedInterfaces`. Nonempty tenant routes, unknown
versions, malformed Cards, URL mismatches and retrieval failures are rejected.
This is minimum discovery validation, not full A2A schema or client conformance.
Literal private/reserved IPs and local names are blocked for Card/execution URLs;
DNS resolution is not pinned, so deployments must also restrict network egress.
The runtime has no Responses fallback. Legacy parser exports are for historical
identity management and migration only.

## ENSv2 subname preparation

`bun run provider:identity --help` describes the wallet-confirmed ERC-8004/ENS
registration flow. Its input contains a P0 `manifest` and explicit `active` and
`x402Support` booleans. `metadata` creates a registration-v1 data URI supported by
Agent0; `prepare-register` verifies ENS write access and the public Card, simulates the official
Sepolia Registry's `register(string)`, and outputs an unsigned transaction.
After wallet confirmation, use its hash with `prepare-ens --registration-tx` to
recover the actual `agentId` and prepare the exact ENSIP-25 and `agent-endpoint[a2a]` records.
`verify` reads back the original registration and ENS linkage. These registration
commands require `--input <file>`; optional `--output <file>` saves a new review artifact without
overwriting existing evidence. RPC and Registry use the discovery configuration;
`ENS_OPERATOR_ADDRESS` is the public wallet address that will confirm transactions.

No command signs or broadcasts. Do not reuse a simulated agent ID or repeat a
registration after an unknown wallet result: recover the confirmed transaction
by hash. ENS preparation skips existing matching records and rejects conflicting
endpoints. Keep registration inputs, transaction plans, and operator notes outside
the repository. Registration/ENS verification does not prove Graph indexing,
Provider execution, or payment. False flags remain false. Inactive or legacy
Responses identities remain excluded from runtime discovery until the Provider
is ready and its metadata is explicitly updated through `setAgentURI`; native
`x402Support: false` alone does not exclude an otherwise valid A2A service.

For an existing identity, `bun run provider:identity inspect-current --agent-id <id>`
reads the current ERC-8004 metadata and ENS records, including inactive Providers.
It returns an `updateInput` object containing the agent ID, expected metadata URI
and content hash, both expected ENS endpoint records (`ensEndpoints.responses`
and `ensEndpoints.a2a`), Resolver, and an empty `changes` object.
Save that object outside the repository and fill only the fields you intend to
change: `endpoint`, `agentCardUrl`, `description`, `active`, or `x402Support`.
To migrate a legacy Responses identity, explicitly provide `protocol: "a2a"`,
`endpoint` and `agentCardUrl` together. No field is enabled
by default; the Agent ID, ENS name, capabilities, payment network and additional
metadata fields are preserved. Setting support flags is a Provider declaration,
not evidence of execution or successful settlement.

Run `bun run provider:identity prepare-update --input <update-input.json>` to
preview `current` and `target`. Only `nextStep.transaction` is prepared and
simulated. Confirm that transaction using the wallet, then rerun **the same input**.
An endpoint, protocol or Card URL change pauses an active Provider first, writes
the target ENS endpoint if needed, then publishes final metadata using official
`setAgentURI`. Migration retains the Agent ID, ENSIP-25 association, and historical
Responses record; only `agent-endpoint[a2a]` is used by the new runtime. Inactive
Providers skip the pause. A Card-only or description/flags-only edit needs no ENS
transaction. Completed steps
are skipped; unexpected metadata, owner, Resolver, or ENS changes stop the update.
These are off-chain checks: official `setText`/`setAgentURI` have no atomic
compare-and-swap, so prepare again just before signing and avoid concurrent edits.
If a wallet result is unknown, inspect its original receipt and the current state
before resubmitting; this unsigned tool is not a pending-transaction journal.

`bun run provider:identity verify-update --input <update-input.json>` verifies the
final target without preparing another write. Preparation and verification require
a live A2A Card for route changes or active targets. Deactivation without a route
change remains possible when the Card is unavailable and reports
`agentCardVerified: false`. `verify-current --agent-id <id>`
verifies the currently published metadata/ENS without requiring the original
registration content to remain unchanged; this chain-only command does not fetch
or verify a live Card. Original `verify --registration-tx`
retains its original-registration semantics. Updates publish small inline data
URIs so Agent0 can reindex the existing Agent from its `URIUpdated` event.
Graph indexing must be checked separately by Agent ID, including for an inactive
Provider; these commands never claim Graph, execution, or payment verification.

`bun run ens:subnames --help` lists the read-only checks and unsigned transaction
preparation commands. No command signs or broadcasts a transaction.

The minimal local ENS registration page can be built with `bun run explorer:build`
and served locally with `bun run explorer:dev`. It requires a browser wallet on
Ethereum Sepolia and never handles private keys.
Set `PROVIDER_REGISTRATION_INPUT` to the original registration input file outside
the repository and `PROVIDER_REGISTRATION_TX` to its confirmed registration hash
to enable the local binding panel. The receipt identifies the Agent; the panel
reads current metadata and continues to work after a completed identity update.
Use the update script for changing existing values; the initial binding panel
still refuses to overwrite conflicting endpoint records.
