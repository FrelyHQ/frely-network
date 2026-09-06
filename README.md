# Frely Network

Frely Network is the Broker-side project for an agent capability network. It
lets a host agent discover, verify, purchase, and invoke an external
capability. The P0 design uses a Broker MCP interface, The Graph, ENS/ERC-8004
identity checks, and Hedera x402 pay-per-use settlement.

This repository is **not** the private Relay or Swarm runtime. The competition
review surfaces are separate public snapshots:

| Public repository | Public purpose | Private canonical counterpart |
| --- | --- | --- |
| [`FrelyHQ/frely`](https://github.com/FrelyHQ/frely) | Reviewable snapshot of the Relay/control-plane implementation | `friday-relay` |
| [`FrelyHQ/swarm`](https://github.com/FrelyHQ/swarm) | Reviewable snapshot providing the basic Snap/debug surface | `frely-swarm` |

The public snapshots are available for source inspection and basic debugging.
They do not publish private runtime state, private credentials, production
operations, or a claim that the private repositories can be reconstructed from
public files alone. Their public competition-review publication must not be
interpreted as a conversion of the private canonical products into general
open-source distributions; the license and notice in each snapshot remain the
legal authority for that repository.

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
- `packages/gateway`: provider-side x402 gateway contract
- `apps/broker-mcp`: MCP interface for host agents
- `apps/explorer`: P1 explorer application
- `examples`: minimal Vision capability providers
- `scripts/register-provider`: P0 provider registration script
- `docs`: architecture, roadmap/deadlines, sponsor integration, and
  cross-project integration documentation

## Development

```bash
bun install
bun run typecheck
bun test
```

The current checkout is the Broker/protocol scaffold; it does not yet provide a
single runnable Docker service. The target cross-project startup contract and
its readiness gates are documented before implementation so that the public
snapshot boundary remains explicit.

## Cross-project local integration

Read [`docs/cross-project-integration.md`](docs/cross-project-integration.md)
for the planned Docker orchestration across this repository, the public
`frely` snapshot, the public `swarm` snapshot, and their private canonical
runtimes. The document defines:

- repository ownership and public/private boundaries;
- sibling checkout layout and shared Docker network aliases;
- startup and readiness order;
- review mode with deterministic fixtures versus real-upstream mode;
- secret ownership and redaction rules;
- cross-project smoke flow and acceptance criteria.

See [`docs/project-roadmap.md`](docs/project-roadmap.md) for the synchronized
milestones, goals, deadlines, and evidence gates. See
[`docs/architecture.md`](docs/architecture.md) for the Broker execution path
and [`docs/sponsor-integrations.md`](docs/sponsor-integrations.md) for The
Graph, ENS, ERC-8004, and Hedera responsibilities.
