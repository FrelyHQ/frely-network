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
`PAYMENT_NETWORK`. Run Bun from the repository root to load a local `.env`, or
inject these variables in the server environment. Do not bundle this entry or
Graph credentials into the browser, or log URLs containing API keys.

This entry is an integration handoff, not M3 acceptance evidence. The existing
ERC-8004 reader currently needs an HTTP(S) registration URI and a top-level
`capabilities` array; general ERC-8004 services/OASF normalization and IPFS are
not yet supported end to end. Strict ENSIP-25 association checks, metadata/ENS
endpoint consistency, and live Graph network/registry validation still need to
be completed and tested before treating the existing resolver as M3-ready.
Unit-test fixtures prove wiring only. Real Agent0 results, W's deployed Provider
and manifest, registration/ENS linkage, and joint review remain required.

## ENSv2 subname preparation

`bun run ens:subnames --help` lists the read-only checks and unsigned transaction
preparation commands. No command signs or broadcasts a transaction.

The minimal local ENS registration page can be built with `bun run explorer:build`
and served locally with `bun run explorer:dev`. It requires a browser wallet on
Ethereum Sepolia and never handles private keys.
