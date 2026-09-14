# Frely Network

Frely Network is the Broker-side project for an agent capability network. It
lets a host agent discover, verify, purchase, and invoke an external
capability. The P0 design uses a Broker MCP interface, The Graph, ENS/ERC-8004
identity checks, and Hedera x402 pay-per-use settlement.

This repository is **not** the private Relay or Swarm runtime. The competition
review surfaces are separate public snapshots:

| Public repository | Public purpose | Private canonical counterpart |
| --- | --- | --- |
| [`FrelyHQ/frely`](https://github.com/FrelyHQ/frely) | Reviewable Relay snapshot providing both local Agent-model and base-model access boundaries | `friday-relay` |
| [`FrelyHQ/swarm`](https://github.com/FrelyHQ/swarm) | Reviewable local Swarm Agent runtime for `vision-basic` | `frely-swarm` |

The public snapshots are available for source inspection and the bounded
hackathon development flow. They do not publish private runtime state, private
credentials, production operations, or a claim that the private repositories
can be reconstructed from public files alone. Their public competition-review
publication must not be interpreted as a conversion of the private canonical
products into general open-source distributions; the license and notice in
each snapshot remain the legal authority for that repository.

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
- `examples`: Vision capability example scaffolds; not executable model runtimes
- `scripts/register-provider`: P0 provider registration script
- `docs`: architecture, roadmap/deadlines, sponsor integration, and
  cross-project integration documentation

## Development

```bash
bun install
bun run typecheck
bun test
```

The current checkout provides a bounded Broker MCP process and production
container. `/healthz` proves that the process is running; `/readyz` reports
readiness only when live Graph, ENS, ERC-8004, Hedera wallet, and Frely
configuration is valid. `/mcp` exposes only `find_capability` and
`use_capability`, and fails closed while the runtime is not ready. The target
cross-project startup contract and its readiness gates remain documented so
that the public snapshot boundary stays explicit.

## Production deployment

## Release and deploy

Production fields:

| Field | Value |
| --- | --- |
| Host | `ctb-eu` |
| Deployment | `frely-eu` |
| Compose file | `/opt/frely-eu/services/frely-network/compose.production.yaml` |
| Compose project | `frely-network` |
| Service | `broker-mcp` |
| Health | `https://network.frely.cloud/readyz` |

Entry:

```bash
./scripts/release-deploy --dry-run
./scripts/release-deploy
./scripts/release-deploy --version 0.1.1
```

Release fields:

| Field | Value |
| --- | --- |
| Branch | `main` |
| Version source | next patch from `release/ctb-eu/v*` |
| Release controller | `release:frely-eu` |
| Image policy | immutable GHCR digest |

Release flow:

```text
check
→ Compose contract
→ release tag
→ host preflight
→ GHCR image
→ immutable digest
→ broker-mcp update
→ /readyz
```

Release gates include clean worktree, `main`, Git ancestry, host identity, registry digest, container health, and readiness.

Controller diagnostics:

```bash
bun run release:frely-eu -- --version 0.1.1 --sha "$(git rev-parse HEAD)"
bun run release:frely-eu -- --version 0.1.1 --sha "$(git rev-parse HEAD)" --deploy
```

The operator entry is `./scripts/release-deploy`.
## Cross-project local integration

Read [`docs/cross-project-integration.md`](docs/cross-project-integration.md)
for the planned Docker orchestration across this repository, the public
`frely` snapshot and the public `swarm` snapshot. The document defines:

- repository ownership and public/private boundaries;
- sibling checkout layout and shared Docker network aliases;
- startup and readiness order;
- component verification versus the configured local Frely closed loop;
- secret ownership and redaction rules;
- cross-project smoke flow and acceptance criteria.

See [`docs/project-roadmap.md`](docs/project-roadmap.md) for the synchronized
milestones, goals, deadlines, and evidence gates. See
[`docs/architecture.md`](docs/architecture.md) for the Broker execution path
and [`docs/sponsor-integrations.md`](docs/sponsor-integrations.md) for The
Graph, ENS, ERC-8004, and Hedera responsibilities.

## Consumer onboarding

The public entry is `/SKILL.md`. Skill v2 is a host-neutral Network contract for chatbots, coding Agents, and local Agents. Native tools, MCP, HTTP/x402 clients, and the Frely CLI are adapters; the CLI is not the protocol.

The canonical paid Web3 flow uses the payment wallet as caller identity and follows `discover -> verify -> quote -> settle -> execute`. Frely-hosted Agents route x402 payment to the Network Web3 account; Frely charges the Network Web2 account for execution. Chain-discovered Agents route x402 payment to the verified Offering publisher.

The existing `/connect/`, consumer bearer session, `platform_demo` quota, and CLI 0.4.0 consumer mode form a legacy demo profile. They do not prove caller-funded Web3 settlement. See [Consumer onboarding](docs/consumer-onboarding.md) for the migration contract and [Architecture](docs/architecture.md) for payment ownership.