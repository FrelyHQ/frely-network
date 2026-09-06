---
title: Cross-project local integration
mdq:
  profile: project-governance/governed-document-v1
---
# Cross-project local integration

This document is the canonical plan for local Docker integration across the
Frely Network project and the two public review snapshots. Its work sequence
is subordinate to the milestone goals and deadlines in
[`project-roadmap.md`](project-roadmap.md), synchronized from the external
Frely GitHub Project. It records the
repository boundary, the target orchestration contract, the review-safe and
real-upstream modes, and the evidence required before calling the environment
ready.

The plan is intentionally public-safe. It does not include private source,
private topology, production operations, credentials, Provider configuration,
or user data.

## Repository-roles-1 — Repository roles and source relationships

Status: Baseline
Review level: L9
Source: User-provided project boundary

The names below describe ownership and source relationships. A public GitHub
repository is a review surface; it is not automatically the canonical runtime
source and public visibility does not make private operational information safe
to publish.

| Repository or service | Public role | Canonical relationship | Responsibility in local integration |
| --- | --- | --- | --- |
| `FrelyHQ/frely-network` | Frely Network application and Broker project | Current project | Owns discovery, identity verification, selection, payment orchestration, execution contracts, and the thin cross-project coordinator. |
| `FrelyHQ/frely` | Public review snapshot | Snapshot of the private `friday-relay` repository | Provides reviewable Gateway/control-plane code and a public-safe Docker topology where available. It does not expose the private repository or private deployment operations. |
| `FrelyHQ/swarm` | Public review snapshot and basic debugging surface | Snapshot of the private `frely-swarm` repository | Provides the public, inspectable Snap/basic debug boundary. It is not a substitute for private Frely Swarm runtime state or private operational configuration. |
| `friday-relay` | Private canonical runtime | Canonical private source for `FrelyHQ/frely` | Owns real Gateway, model access, Provider credentials, persistence, and runtime readiness. |
| `frely-swarm` | Private canonical runtime | Canonical private source for `FrelyHQ/swarm` | Owns real Swarm capability execution and its private runtime dependencies. |

The public snapshots must remain useful for source review without implying that
their contents are a complete production distribution or a synchronization
channel back to the private repositories. Publishing a review snapshot does not
convert the private canonical product into a general open-source distribution;
repository-specific license and notice files remain authoritative for legal
permissions.

## Integration-scope-1 — Integration scope and non-goals

Status: Planned
Review level: L9
Source: User requirement for Docker-based local debugging

The target is a repeatable local environment in which a developer can start a
review-safe or real-upstream integration, observe dependency readiness, and
exercise the Broker-to-capability path without manually attaching containers or
copying private files into a public repository.

The integration plan does not include:

- production deployment, ingress, DNS, TLS termination, backups, or rollback;
- publication or synchronization of `friday-relay` or `frely-swarm` private code;
- committed credentials, Provider secrets, wallet keys, personal data, or real
  request/response bodies;
- a claim that the current scaffold already implements every planned service;
- bypassing the Gateway, identity checks, payment boundary, or capability owner.

## Service-boundaries-1 — Service ownership and anti-bypass rules

Status: Baseline
Review level: L3
Source: Current architecture and public snapshot review

| Boundary | Owner | Executor or caller | API boundary | Anti-boundary |
| --- | --- | --- | --- | --- |
| Network orchestration | `frely-network` | Broker MCP and future Broker workers | Shared protocol contracts and Broker operations | Do not read Friday Relay or Swarm databases directly. |
| Provider discovery | `frely-network` discovery adapters | Broker discovery stage | The Graph adapter and normalized provider manifest | Do not hardcode the final Provider as a replacement for discovery. |
| Web3 identity | `frely-network` identity adapters | Broker verification stage | ENS and ERC-8004 verification contracts | Do not treat an unverified name or address as an executable Provider identity. |
| Payment | `frely-network` payment adapter | Broker payment stage | Hedera x402 payment contract | Do not invoke a paid capability before the payment result is accepted. |
| Model Gateway | private `friday-relay` | Friday Relay Gateway/Provider runtime | Authenticated Gateway API | Do not send Provider credentials or private runtime calls from the Broker. |
| Swarm capability | private `frely-swarm` | Swarm executor | The capability/debug API exposed by the private runtime | Do not bypass the capability API with shell, database, Docker socket, or host access. |
| Public debug adapter | public `swarm` snapshot | Snap container | Bounded local debug HTTP endpoint and readiness probes | Do not treat the public adapter as the private Swarm runtime or allow request-selected upstream URLs. |

The public `swarm` snapshot may call the configured Gateway and perform the
configured readiness probe, but request data must not choose an upstream URL,
RPC endpoint, file, command, container, or credential.

## Integration-topology-1 — Target request topology

Status: Planned
Review level: L3
Source: Existing P0 architecture and public snapshot interfaces

The target topology has two related paths:

```text
Business capability path

Host Agent
  -> Broker MCP (frely-network)
  -> The Graph discovery
  -> ENS / ERC-8004 identity verification
  -> Provider selection
  -> Hedera x402 payment
  -> Friday Relay Gateway (private friday-relay)
  -> Frely Swarm capability (private frely-swarm)
  -> result

Public debug path

Web3 debug client
  -> Snap/basic debug boundary (public swarm snapshot)
  -> authenticated Friday Relay Gateway
  -> private Frely Swarm capability
  -> bounded debug result
```

The public snapshots are selected by mode. In review mode, a deterministic
contract stub may stand in for a private runtime that is not publishable. In
real-upstream mode, the coordinator addresses the private runtime through the
same narrow network aliases and documented HTTP contracts.

## Workspace-layout-1 — Cross-project workspace layout

Status: Planned
Review level: L3
Source: Integration orchestration design

A reviewer-safe workspace should keep projects as sibling checkouts and keep
private implementations outside the public workspace:

```text
review-workspace/
  frely-network/       # this repository
  frely-review/        # clone of FrelyHQ/frely
  swarm-review/        # clone of FrelyHQ/swarm
  .local/              # ignored generated config, secrets, and runtime data
```

Maintainers who have access to the private repositories may replace the two
review checkouts with private working copies. The coordinator must not require
private paths in committed configuration; only service URLs, network aliases,
and explicitly supplied secret-file paths cross the project boundary.

## Docker-network-1 — Shared Docker network and ports

Status: Planned
Review level: L3
Source: Existing public Compose ports and integration requirements

The coordinator should create one external network for the integration run,
for example `frely-integration`, and attach the participating project Compose
projects to it. Stable aliases must be declared explicitly rather than relying
on generated Compose container names.

| Alias or endpoint | Owner | Container port | Optional host port | Use |
| --- | --- | ---: | ---: | --- |
| `friday-relay-gateway` | Friday Relay | `43000` | `43000` on loopback | Gateway calls and health checks. |
| `friday-relay-web` | Friday Relay | `43001` | `43001` on loopback | Reviewer Web surface, when enabled. |
| `friday-relay-admin` | Friday Relay | `43002` | `43002` on loopback | Reviewer Owner surface, when enabled. |
| `frely-snap` | Public Snap snapshot | `8080` | `8787` on loopback | Local debug adapter. |
| `frely-swarm` | Private Frely Swarm | Contract-defined, commonly `4111` | Only when host access is required | Swarm readiness and capability calls. |
| PostgreSQL | Friday Relay | `5432` | `55432` on loopback, optional | Friday Relay persistence; never a cross-project application API. |

Container-to-container traffic should use aliases on the shared network instead
of host-published ports. Host ports are for a developer's browser, curl, or
explicit diagnostics and must remain loopback-bound by default. The public
`swarm` snapshot must not claim that its own adapter Compose file creates the
private `frely-swarm` backend.

## Startup-sequence-1 — Ordered startup sequence

Status: Planned
Review level: L3
Source: Cross-project Docker orchestration design

The coordinator should execute the following order and stop on the first
required readiness failure:

1. **Preflight.** Check Docker Compose v2, the required Bun/Node versions for
   each checkout, clean secret-file permissions, available ports, and the
   existence of all three project directories.
2. **Create the network.** Create or reuse the named external integration
   network and record that it is owned by the current integration run.
3. **Start Friday Relay.** Use the `frely` snapshot's or private
   `friday-relay`'s local Compose contract. Generate ignored local config and
   secret files, start PostgreSQL and application dependencies, wait for the
   database health check, then run migrations and the review bootstrap step.
4. **Check the Gateway.** Require the Gateway health endpoint and the private
   Provider/control readiness contract. Do not mark the project ready merely
   because its container is running.
5. **Start Frely Swarm.** Start the private `frely-swarm` runtime in real-upstream
   mode, or a clearly labelled deterministic contract stub in review mode. Attach
   it to the shared network with the `frely-swarm` alias and check its health
   contract.
6. **Start the public Snap surface.** Configure the public `swarm` snapshot to
   call `http://friday-relay-gateway:43000` and probe the `frely-swarm` alias.
   Require both `/healthz` and `/readyz` before running a debug request.
7. **Start Frely Network.** Install dependencies and run the Broker MCP using
   this repository's configuration. Its discovery, identity, payment, and
   execution adapters must use the configured test or review endpoints.
8. **Run smoke checks.** Execute the bounded debug request and the capability
   path checks described below. Emit correlation IDs and status codes only;
   never emit credentials or full request/response bodies.

The order is deliberately explicit because `started` is not equivalent to
`healthy`, and `healthy` is not equivalent to a usable Provider credential.

## Orchestrator-contract-1 — Thin coordinator contract

Status: Planned
Review level: L3
Source: Cross-project Docker orchestration design

The preferred implementation is a thin coordinator in this repository rather
than a second copy of either private runtime's Compose topology:

```text
scripts/integration-up.mjs
scripts/integration-down.mjs
scripts/integration-doctor.mjs
scripts/integration-smoke.mjs
compose.integration.yaml       # optional, only for shared coordinator helpers
```

The coordinator should:

- accept `--mode review|real` and explicit project-directory or URL inputs;
- create the shared network and pass stable aliases to each project owner;
- invoke each project's own Compose file or documented local runner;
- wait for health and readiness with bounded timeouts;
- run migration/bootstrap only through the owning project's documented command;
- register cleanup ownership and remove only resources created by this run;
- print a redacted summary of services, aliases, ports, and readiness states;
- fail closed when a required dependency is missing or ambiguous.

It must not copy private Dockerfiles, mount private host directories by default,
read another project's database, inject secrets into command-line arguments, or
silently fall back from a private runtime to a mock runtime.

## Command-contract-1 — Reviewer command interface

Status: Planned
Review level: L3
Source: Cross-project Docker orchestration design

The target command interface should be explicit and mode-aware. The commands
below are the proposed `frely-network` package scripts; they are a future
contract, not commands currently present in this scaffold:

```bash
bun run integration:setup -- --mode review
bun run integration:up -- --mode review
bun run integration:doctor -- --mode review
bun run integration:smoke -- --mode review
bun run integration:down -- --mode review
```

`--mode real` selects private or approved hosted upstreams and requires
explicit operator-supplied credentials. `integration:down` must use the same
run state as `integration:up` so that it removes only resources created by that
run. A lower-level operator may still invoke the individual project Compose
files, but the reviewer-facing path must not require undocumented manual
`docker network connect` operations.

## Runtime-modes-1 — Review and real-upstream modes

Status: Planned
Review level: L9
Source: User requirement that public snapshots remain reviewable

### Review mode

Review mode is self-contained at the protocol boundary. It uses only public
snapshot code and deterministic local stubs for dependencies that cannot be
published, such as a private Swarm runtime, a real Provider credential, or a
chain-side payment. The stubs must be named and documented as stubs, return
stable test data, and never be presented as production behavior.

Review mode proves:

- Docker build and service wiring;
- health/readiness propagation;
- request validation, authentication boundaries, and redaction;
- Broker protocol composition with deterministic discovery, identity, payment,
  and execution fixtures.

### Real-upstream mode

Real-upstream mode uses private `friday-relay` and `frely-swarm` checkouts or
approved hosted endpoints, plus explicitly supplied testnet/provider
credentials. Credentials remain in ignored env files or Docker secrets. This
mode proves the actual cross-project contracts but is not reproducible from the
public repositories alone.

## Configuration-contract-1 — Configuration and secret ownership

Status: Planned
Review level: L3
Source: Existing public snapshot configuration contracts

Configuration is layered as follows:

| Configuration | Owner | Delivery |
| --- | --- | --- |
| Broker discovery, identity, payment, and provider selection | `frely-network` | Local ignored env/config file with non-secret endpoint values. |
| Relay Gateway URL and runtime mode | Friday Relay owner | Public snapshot example or private deployment configuration. |
| Snap Gateway URL | Public `swarm` snapshot | `FRELY_GATEWAY_URL` or the equivalent documented adapter variable. |
| Snap Swarm probe URL | Public `swarm` snapshot | `SNAP_SWARM_URL` and `SNAP_REQUIRE_SWARM`. |
| Gateway/API keys and Provider credentials | Owning private runtime | Docker secrets or ignored local secret files only. |
| Database connection string | Friday Relay owner | Runtime secret file; never a Broker or Snap application input. |
| Testnet wallet/payment credentials | Payment owner and operator | Local secret store only; never committed or logged. |

`.env.example` files may document names and safe placeholders. They must not
contain credentials, private hostnames, real model identifiers that reveal
private routing, or commands that write secrets into tracked files.

## Readiness-contract-1 — Readiness and health evidence

Status: Planned
Review level: L3
Source: Existing public health/readiness endpoints and target orchestration

A run is ready only when all required checks pass:

| Check | Required evidence | Failure behavior |
| --- | --- | --- |
| PostgreSQL | Database health check is successful. | Do not run application migrations or claim Relay ready. |
| Friday Relay Gateway | Gateway health endpoint returns success and its required runtime/control checks pass. | Keep dependent services stopped or unhealthy. |
| Frely Swarm | Private runtime or labelled review stub returns its documented health result. | Snap readiness remains unavailable. |
| Public Snap | `/healthz` returns `200`; `/readyz` returns `200` with required probes enabled. | Do not send a debug request. |
| Broker discovery | A provider manifest is returned by the configured adapter. | Abort before selection. |
| Identity | ENS/ERC-8004 checks produce an accepted identity result. | Abort before payment or invocation. |
| Payment | Hedera x402 testnet or review fixture returns an accepted payment result. | Do not invoke the capability. |
| Execution | Provider result includes the expected bounded response and correlation metadata. | Report failure without exposing body or credentials. |

A container's `running` state is diagnostic evidence only. Readiness must be
computed from the owning service's contract.

## Smoke-flow-1 — Cross-project smoke flow

Status: Planned
Review level: L3
Source: P0 execution path and local debug requirement

The smoke flow should use a fixed, non-sensitive fixture:

1. Submit a bounded debug report through the public Snap endpoint.
2. Verify that Snap authenticates to the Gateway and does not contact a
   request-selected alternate upstream.
3. Verify that the Gateway reaches the configured Swarm capability through its
   owning interface.
4. Verify that the response contains only the documented result and local
   correlation identifier.
5. Run Broker discovery and assert that the final Provider was returned by the
   discovery adapter rather than hardcoded in the Broker.
6. Verify ENS/ERC-8004 identity acceptance.
7. Execute the Hedera x402 payment fixture or testnet payment.
8. Invoke the capability and correlate the result with the payment and request
   identifiers without putting prompts, API keys, or private URLs in logs.

Review mode must use deterministic fixtures for steps that require private
services or external networks. Real-upstream mode must label any external
request and use only test data.

## Failure-policy-1 — Failure handling and diagnostics

Status: Planned
Review level: L3
Source: Readiness-first orchestration principle

The coordinator must preserve the first actionable failure and expose a safe
category, for example:

- `network_unavailable`: the shared Docker network or stable alias is absent;
- `dependency_not_ready`: an owning service has not reached readiness;
- `configuration_missing`: an expected non-secret config value or file is absent;
- `credential_unavailable`: a private runtime has no usable credential;
- `discovery_failed`: provider discovery returned no acceptable result;
- `identity_failed`: ENS/ERC-8004 verification was not accepted;
- `payment_failed`: x402 payment was rejected or not confirmed;
- `execution_failed`: the capability failed after the required preconditions.

Diagnostics may include service name, phase, endpoint path, HTTP status, and
correlation ID. They must not include Authorization headers, secret values,
request bodies, response bodies, database URLs, or private filesystem paths.

## Security-boundary-1 — Public snapshot safety rules

Status: Baseline
Review level: L9
Source: User-provided public/private repository distinction

The following rules are non-negotiable:

- Public snapshots remain suitable for code inspection and basic debugging;
  private source and private operational details stay private.
- Public documentation must state that `frely` corresponds to private
  `friday-relay` and `swarm` corresponds to private `frely-swarm`.
- Public Compose files must use placeholders or secret-file references, never
  real credentials or private infrastructure identifiers.
- Host-published services bind to loopback by default. Internal services use
  the shared Docker network and are not published unnecessarily.
- The Broker must not receive, persist, or log Provider credentials or raw
  private runtime responses.
- Review stubs must be clearly labelled and must not be used as evidence of
  production readiness.
- A public snapshot must never imply that its source is automatically synced
  back to the private canonical repository.

## Snapshot-validation-1 — Current snapshot validation commands

Status: Baseline
Review level: L3
Source: Public `FrelyHQ/frely` and `FrelyHQ/swarm` snapshot audit

Before cross-project orchestration is implemented, each public snapshot can be
validated only within the boundary it actually publishes:

```bash
# Frely Relay snapshot: validate the Compose model after preparing ignored
# local config and secret-file paths required by that snapshot.
docker compose -f docker-compose.yml \
  -f docker-compose.postgres.yml config

# Snap/basic debug snapshot: validate its own adapter Compose model.
docker compose -f compose.yaml config

# After starting the adapter with its configured upstreams:
curl --fail http://127.0.0.1:8787/healthz
curl --fail http://127.0.0.1:8787/readyz
```

The first command does not create the missing local config or database secret
files, and the second project does not create the private `frely-swarm`
backend. A `503` from Snap `/readyz` is therefore an honest dependency failure,
not evidence that the complete integration is running. The future coordinator
must preserve this distinction and add the missing review-mode fixtures rather
than hiding it.

## Ownership-and-delivery-1 — Implementation ownership

Status: Planned
Review level: L3
Source: Cross-project delivery design

| Deliverable | Owning project | Review responsibility |
| --- | --- | --- |
| Broker protocol and adapters | `frely-network` | Network maintainers verify contracts and tests. |
| Thin cross-project coordinator | `frely-network` | Network maintainers verify network creation, readiness, redaction, and cleanup. |
| Friday Relay local Compose contract | `FrelyHQ/frely` snapshot or private `friday-relay` | Relay maintainers verify migrations, bootstrap, Gateway readiness, and secret handling. |
| Snap/basic debug local Compose contract | `FrelyHQ/swarm` snapshot or private `frely-swarm` | Swarm maintainers verify adapter validation, upstream routing, and readiness propagation. |
| Real private runtime behavior | `friday-relay` and `frely-swarm` | Private owners only; not inferred from public snapshot code. |
| Cross-project smoke evidence | `frely-network` coordinator | Must identify review versus real-upstream mode. |

No project may silently assume ownership of another project's persistence,
credentials, or cleanup lifecycle.

## Roadmap-alignment-1 — Milestone alignment

Status: Planned
Review level: L3
Source: Local roadmap synchronization and GitHub Project 1

The integration work is staged to support the external checkpoints rather than
being treated as an independent delivery track:

- M1–M2: preserve the scaffold, shared contracts, adapter boundaries, and
  reproducible local-start design needed for parallel Sponsor spikes.
- M3–M5: prioritize the real discovery, identity, payment, proof-retry, and
  Provider execution path; review-mode fixtures may validate boundaries but do
  not count as evidence of the real path.
- M6: reach Feature Freeze with the continuous P0 path and then stop adding
  core capabilities. Later work is limited to bug fixing, stability, docs,
  evidence, and submission preparation.
- M7–D3: keep the submitted commit, demo, docs, and evidence aligned; do not
  introduce unverified core behavior during judging.

A successful local Docker smoke run is implementation evidence only. It does
not by itself change the GitHub Project `Verification state` or satisfy a
checkpoint's named-verifier requirement.

## Implementation-phases-1 — Implementation phases

Status: Planned
Review level: L3
Source: Minimal delivery sequence

1. **Document and contract phase.** Keep repository roles, service aliases,
   environment names, health contracts, and review limitations consistent.
2. **Per-project local phase.** Add or repair each snapshot's local setup so a
   clean checkout can generate ignored state and validate its own Compose model.
3. **Coordinator phase.** Add the thin `frely-network` orchestration scripts,
   shared-network ownership, bounded waits, safe cleanup, and mode selection.
4. **Smoke phase.** Add review-mode deterministic fixtures and real-upstream
   smoke checks that never print secrets or raw bodies.
5. **CI/reviewer phase.** Validate Compose configuration, public-boundary scans,
   documentation links, and review-mode startup on a clean runner.

Each phase must preserve the private/public boundary and must not turn a plan
statement into a claim of current implementation.

## Acceptance-criteria-1 — Completion criteria

Status: Planned
Review level: L9
Source: User requirement for Docker local debugging and review safety

The cross-project integration is complete only when all of the following are
evidenced:

- A clean public workspace can start review mode with one documented command or
  one documented command per owning project plus one coordinator command.
- The command creates only declared local resources and does not require private
  files, undocumented manual network attachment, or credentials in tracked files.
- Every required service has a health/readiness check, and a missing private
  runtime fails visibly instead of being mistaken for success.
- The public `frely` and `swarm` snapshots are described as review surfaces and
  are mapped to private `friday-relay` and `frely-swarm` respectively.
- The real-upstream path accepts explicit test credentials without changing
  public source or public configuration.
- The smoke flow covers readiness, debug routing, discovery, identity, payment,
  execution, correlation, and redaction at the selected mode's evidence level.
- `down` removes only resources owned by the run and leaves unrelated Docker
  projects untouched.
- Documentation links, command examples, endpoint names, port assignments, and
  mode descriptions agree with the checked-in files.

## Current-gaps-1 — Current gaps and status

Status: Current limitation
Review level: L3
Source: Public snapshot audit and current `frely-network` checkout

The current `frely-network` checkout is a scaffold: it has protocol/package
folders and basic documentation but no cross-project Docker Compose or
coordinator scripts. The public `frely` snapshot contains a substantial local
Compose topology but explicitly excludes full local E2E orchestration and
requires runtime configuration that is not present in a clean clone. The public
`swarm` snapshot can build and start its Snap adapter, but its complete readiness
path depends on the external Gateway and private Swarm runtime.

Those facts are why this document is a target orchestration plan rather than a
claim that the end-to-end environment is already delivered. The next code
changes must implement the plan in the owning repositories and then update this
section with concrete verification evidence.
