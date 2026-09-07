---
title: Frely Network architecture
mdq:
  profile: project-governance/governed-document-v1
---
# Architecture

Frely Network is the Broker-side project in the Frely capability flow. This
repository contains the protocol and adapter scaffold for discovering,
verifying, purchasing, and invoking an external capability. The cross-project
Docker plan is documented in
[`cross-project-integration.md`](cross-project-integration.md).

The package and application directories are currently the source scaffold for
the P0 contracts. Delivery order and scope are governed by
[`project-roadmap.md`](project-roadmap.md), which synchronizes the external
GitHub Project milestones and deadlines. The sections below describe the
intended boundaries and must not be read as evidence that every runtime has
already been implemented.

## Execution-path-1 — P0 execution path

Status: Planned
Review level: L9
Source: Existing project architecture and sponsor requirements

```text
Host Agent
  -> Broker MCP
  -> The Graph discovery
  -> ENS / ERC-8004 verification
  -> Provider selection
  -> Hedera x402 payment
  -> local Frely Agent-model entry
     -> API-key admission, AccessPoint routing and demo billing
  -> local Swarm Agent runtime
     -> `vision-basic` virtual-model execution
     -> local Frely base-model entry
        -> base-model admission and development Provider dispatch
  <- result and aggregate usage
  -> local Frely development settlement
```

The Broker coordinates the identity/discovery and payment networks off-chain.
It does not require an Agent Runtime as a core dependency and does not require
a token bridge between the EVM identity network and Hedera payment network.

## Public-private-boundary-1 — Public snapshot boundary

Status: Baseline
Review level: L9
Source: User-provided repository relationship

The public repositories used for competition review are source-review surfaces:

- `FrelyHQ/frely` is the public snapshot corresponding to the private
  `friday-relay` repository. For the hackathon development flow, it is the
  local caller-facing Agent-model entry and the local base-model entry. It owns
  API-key admission, routing, Provider credentials and demo billing.
- `FrelyHQ/swarm` is the public snapshot corresponding to the private
  `frely-swarm` repository. It runs the Responses-compatible `vision-basic`
  Agent locally and sends every Agent model call back through Frely.

The public snapshots may be inspected and used for the bounded development
demo, but they do not expose private runtime state, private credentials,
private deployment operations, or a guarantee of production reproducibility.
Public visibility is not a reason to place private topology or secrets in this
repository.

The Broker endpoint discovered for the `vision-basic` path must be the Frely
entry, not the Swarm runtime. Model invocations cannot enter Swarm outside that
boundary, and Swarm cannot call a final model Provider outside the Frely
base-model boundary. Health probes and component stubs are verification aids,
not alternate invocation paths. Each local trust boundary uses a separate
identity, and Provider credentials remain inside Frely.

## Component-ownership-1 — Component ownership

Status: Baseline
Review level: L3
Source: Repository layout and P0 design

| Component | Responsibility | Boundary |
| --- | --- | --- |
| `packages/protocol` | Manifest schema and shared contracts | Stable data shape between Broker stages and capability providers. |
| `packages/discovery` | The Graph discovery adapters | Normalize externally indexed provider information; do not hardcode the final Provider. |
| `packages/identity` | ENS and ERC-8004 verification adapters | Accept a Provider only after the configured identity checks pass. |
| `packages/payment` | Hedera x402 client integration | Return an accepted payment result before paid invocation. |
| `packages/broker` | Discover, select, pay, and execute orchestration | Coordinate services through contracts; do not access private runtime persistence. |
| `packages/gateway` | Provider-side x402 gateway contract | Keep Provider-side admission separate from Broker-side selection. |
| `apps/broker-mcp` | Host-agent MCP boundary | Expose Broker operations without exposing credentials or private service internals. |
| `apps/explorer` | Future/provider exploration surface | Consume normalized manifests and verification results rather than private databases. |
| `examples` | Vision capability example scaffolds | Reserve example package boundaries without claiming an executable provider or duplicating the Swarm runtime. |

## Failure-boundaries-1 — Failure and side-effect boundaries

Status: Planned
Review level: L3
Source: P0 failure policy

The Broker must fail closed in this order:

1. Discovery failure prevents selection.
2. Identity verification failure prevents payment.
3. Payment failure prevents invocation.
4. Provider or capability failure returns a bounded execution error.
5. An unavailable Frely entry, Swarm runtime, Frely base-model entry, or
   development Provider keeps the cross-project environment unready.

Requests must carry correlation metadata without carrying secrets between
projects. Logs and error responses must not include credentials, wallet keys,
raw Provider responses, or private filesystem paths.

## Integration-reference-1 — Cross-project integration reference

Status: Planned
Review level: L3
Source: Cross-project local integration plan

The authoritative local orchestration plan, including sibling checkout layout,
Docker network aliases, service ports, startup order, review/real modes,
readiness checks, smoke flow, ownership, and acceptance criteria, is
[`docs/cross-project-integration.md`](cross-project-integration.md).
Implementation sequencing must also be checked against the milestone gates in
[`project-roadmap.md`](project-roadmap.md), especially M4, M5, and the M6
Feature Freeze.

That document is intentionally a plan. It does not claim that the current
scaffold already supplies a complete Docker environment.
