---
title: Sponsor integrations
mdq:
  profile: project-governance/governed-document-v1
---
# Sponsor integrations

The sponsor integrations are Broker-side adapters. They provide evidence and
settlement inputs to `frely-network`; they do not move private Relay or Swarm
runtime ownership into this repository.

## The-Graph-1 — The Graph

Status: Implemented
Review level: L9
Source: Current repository implementation (`packages/discovery/the-graph/index.ts`)

The Graph adapter queries a configured HTTPS endpoint, retrieves registration
metadata, normalizes the P0 manifest, and returns capability-filtered Provider
candidates. It validates the Sepolia registry and payment network, ENS
identity, x402 support, and registration consistency before selection.

The final Provider must not be hardcoded in the Broker as a substitute for live
discovery. A review-mode fixture may provide deterministic discovery data, but
it must be explicitly labelled as a fixture.

## ENS-1 — ENS

Status: Implemented
Review level: L9
Source: Current repository implementation (`packages/identity/ens/index.ts`)

The ENS reader resolves the canonical Universal Resolver on Sepolia, pins all
reads to one block, validates the ENSIP-25 registration key and
`agent-endpoint[a2a]`, and accepts only normalized HTTPS public endpoints. It
returns resolver, endpoint, protocol, and registration evidence for identity
verification. ENS data is evidence for selection; it is not a permission to
bypass the Provider or Gateway boundary.

## ERC-8004-1 — ERC-8004

Status: Planned
Review level: L9
Source: Existing sponsor integration requirement

ERC-8004 supplies the agent/provider registration association used with ENS and
other configured identity checks. The Broker should preserve the registration
identity separately from the application request and payment identifiers.

## Hedera-x402-1 — Hedera x402

Status: Implemented
Review level: L9
Source: Current repository implementation (`packages/payment/hedera-x402/index.ts`)

The Hedera x402 adapter implements Hedera testnet exact-payment signing and
HTTP challenge/retry for v1 and v2 payloads. It also provides Network-side
verification, replay protection, the official facilitator integration,
settlement, and an injected refund path. The payment adapter must return an
accepted result before the Broker invokes a paid capability.

The EVM identity network and Hedera payment network are coordinated by the
Broker. The P0 design does not require a token bridge.

## Integration-modes-1 — Integration modes and evidence

Status: Planned
Review level: L3
Source: Cross-project local integration plan

The local integration plan defines two modes:

- **Review mode:** public snapshot code plus deterministic fixtures for private
  runtimes, external indexing, identity, and payment where necessary. This
  validates contracts, routing, readiness, and redaction without real secrets.
- **Real-upstream mode:** approved private `friday-relay` and `frely-swarm`
  runtimes or approved hosted endpoints, plus explicit testnet/provider
  credentials. This validates actual cross-project behavior but is not
  reproducible from public snapshots alone.

See [`cross-project-integration.md`](cross-project-integration.md) for the
shared Docker network, startup order, readiness gates, smoke flow, and secret
ownership rules.

## Current-status-1 — Current implementation status

Status: Current limitation
Review level: L3
Source: Current repository checkout

The Graph, ENS, and Hedera x402 sponsor adapters have concrete implementations
in the mainline packages identified above. Live upstream calls are selected
through configuration and injected clients or facilitators; tests and
deterministic fixtures remain separate review aids. A clean checkout still
requires operator-supplied endpoints, credentials, and cross-project runtime
setup, so this document does not claim a seeded end-to-end deployment.
