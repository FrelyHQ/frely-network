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

Production `frely-network` is hosted on `ctb-eu` as a service owned by the
`frely-eu` deployment. The authoritative Compose file is
`/opt/frely-eu/services/frely-network/compose.production.yaml`; the running
Compose project is `frely-network`. The `ops/release/release-config.json`
file describes a standalone controller for local release tooling and is not
the production entry point for this host.

Do not deploy by creating `/opt/frely-network`, installing a project-specific
runner, or invoking the local release script directly on `ctb-eu`. A
production update must use the existing `frely-eu` host-governance release
controller, its immutable image/manifest flow, and its target-specific
verification. Read the current deployed manifest before selecting a new
version or image.

Use the repository wrapper for the complete handoff. It runs the host preflight,
builds the image, pushes an immutable GHCR tag, and writes a local manifest. By
default it stops before changing production:

```bash
bun run release:frely-eu -- --version 0.1.0 --sha "$(git rev-parse HEAD)"
```

After reviewing the reported image and manifest, add `--deploy` to pull that
same digest on `ctb-eu`, update only the `broker-mcp` service in the existing
`frely-eu` Compose project, wait for Docker health, and verify `/readyz`:

```bash
bun run release:frely-eu -- --version 0.1.0 --sha "$(git rev-parse HEAD)" --deploy
```

The command fails closed on a host mismatch, missing registry digest, unhealthy
container, or failed readiness check. It never changes the shared `frely-eu`
topology or `frely-swarm` service.

The service verification remains a public contract check against `/readyz`.
Routing for `network.frely.cloud` and the shared `frely-eu` Compose topology
remain host-owned prerequisites and are not changed by this repository's local
release command.

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
