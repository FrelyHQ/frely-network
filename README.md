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

## Release to ctb-eu

Network has its own release target and does not participate in the Friday
Relay seven-service release. The target contract is
[`ops/release/release-config.json`](ops/release/release-config.json): it binds
the `frely-network` Compose project to host `ctb-eu`, the production
environment file `/etc/frely-network/production.env`, and the public readiness
URL `https://network.frely.cloud/readyz`.

The temporary deployment policy permits an on-host Docker build. A release is
still identified by both a SemVer and the full 40-character source SHA, and
the build writes an integrity-checked manifest that deploy and verify must
consume:

```bash
bun run release --target frely-network --version 0.1.0 --sha "$(git rev-parse HEAD)"
```

For staged operation, use `--stage build`, then pass the generated manifest
and its `manifest_digest` to `--stage deploy` and `--stage verify`. The build
manifest is stored under `/var/lib/frely-network/releases` on `ctb-eu`. The
installed `/usr/local/sbin/release-frely-network` wrapper checks the host
identity before invoking the release runner. Deployment uses `docker compose
up -d --no-build --wait`, so it consumes the exact image tag recorded by the
manifest. The environment file is host-owned and must define the ordinary
Compose variables required by the service; secret values are not committed.

The release verification is intentionally a public contract check against
`/readyz`. Routing for `network.frely.cloud` remains an external host
prerequisite and is not changed by this repository's release command.

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
