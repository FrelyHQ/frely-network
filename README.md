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
