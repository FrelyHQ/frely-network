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

Status: Planned
Review level: L9
Source: Existing sponsor integration requirement

The Graph is the discovery and eligibility-indexing layer. The Broker should
retrieve candidate Provider manifests through an adapter, normalize the
response, and apply the configured eligibility rules before selection.

The final Provider must not be hardcoded in the Broker as a substitute for live
discovery. A review-mode fixture may provide deterministic discovery data, but
it must be explicitly labelled as a fixture.

## ENS-1 — ENS

Status: Planned
Review level: L9
Source: Existing sponsor integration requirement

ENS supplies Provider namespace, identity records, endpoint resolution, and the
association used by the identity verification stage. ENS data is evidence for
selection; it is not a permission to bypass the Provider or Gateway boundary.

## ERC-8004-1 — ERC-8004

Status: Planned
Review level: L9
Source: Existing sponsor integration requirement

ERC-8004 supplies the agent/provider registration association used with ENS and
other configured identity checks. The Broker should preserve the registration
identity separately from the application request and payment identifiers.

## Hedera-x402-1 — Hedera x402

Status: Planned
Review level: L9
Source: Existing sponsor integration requirement

Hedera x402 is the pay-per-call settlement path for the P0 flow, using the
Hedera testnet in real integration mode and a deterministic payment fixture in
review mode. The payment adapter must return an accepted result before the
Broker invokes a paid capability.

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

The integration package directories are currently a scaffold. The presence of
these sponsor sections documents the intended contracts and verification order;
it does not claim that live The Graph, ENS, ERC-8004, or Hedera calls are
already wired into a runnable end-to-end service.
