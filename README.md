# Frely Network

Open-source Agent Capability Network for ETHOnline 2026.

The project lets a host agent discover, verify, purchase, and invoke an
external capability. The P0 implementation uses a Broker MCP interface,
The Graph and ENS/ERC-8004 for discovery and identity, and Hedera x402 for
pay-per-use settlement.

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
- `packages/gateway`: provider-side x402 gateway
- `apps/broker-mcp`: MCP interface for host agents
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
// Only after successful resolution may B call provider.endpoint.
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
with an explicit gateway; HTTP and data URIs are not supported by this P0 reader.
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
name, `responses` protocol, and HTTPS endpoint must agree with the registration
file. ENS remains the execution endpoint authority. Failed identity checks never
authorize Provider execution or payment.

### Registration metadata profile

The shared parser accepts the existing P0 manifest (`identity`, `capabilities`,
`interfaces`, `payment`) and ERC-8004 `registration-v1` files using `services`.
For a services file, publish `ENS` and `responses` service entries, plus
`active: true` and `x402Support: true`. Frely's `capabilities` and `payment`
extensions may be top-level or in Agent0's `metadata` bag. These extensions are
project requirements, not fields guaranteed by ERC-8004 itself:

```json
{
  "capabilities": ["vision"],
  "payment": { "protocol": "x402", "network": "hedera:testnet" }
}
```

This snippet only illustrates the extensions; it is not a complete registration
file or a deployed Provider. `x402Support: true` does not imply a payment network.
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

## ENSv2 subname preparation

`bun run ens:subnames --help` lists the read-only checks and unsigned transaction
preparation commands. No command signs or broadcasts a transaction.

The minimal local ENS registration page can be built with `bun run explorer:build`
and served locally with `bun run explorer:dev`. It requires a browser wallet on
Ethereum Sepolia and never handles private keys.
