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
  -> Frely Relay snapshot `POST /v1/responses`
     -> API-key admission, AccessPoint routing, demo pricing and billing
  -> Swarm snapshot `POST /v1/responses`
     -> `vision-basic` virtual-model execution
  -> configured model API (`gpt-5.6-luna` by default)
  -> result
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
  caller-facing entry and owns API-key admission, routing and demo billing.
- `FrelyHQ/swarm` is the public snapshot corresponding to the private
  `frely-swarm` repository. It exposes the Responses-compatible
  `vision-basic` virtual model and owns the backing-model credential.

The public snapshots may be inspected and used for the bounded development
demo, but they do not expose private runtime state, private credentials,
private deployment operations, or a guarantee of production reproducibility.
Public visibility is not a reason to place private topology or secrets in this
repository.

The Broker endpoint discovered for the paid `vision-basic` path must be the
Frely entry, not the Swarm runtime. A direct call to Swarm is permitted only as
a local runtime test because it bypasses Frely admission and billing. The
Broker-facing Frely API key, the Frely-to-Swarm service token and Swarm's
backing-model API key are distinct credentials.

## Component-ownership-1 — Component ownership

Status: Baseline
Review level: L3
Source: Repository layout and P0 design

| Component | Responsibility | Boundary |
| --- | --- | --- |
| `packages/protocol` | Manifest schema and shared contracts | Stable data shape between Broker stages and capability providers. |
| `packages/discovery` | The Graph discovery adapters | Normalize externally indexed provider information; do not hardcode the final Provider. |
| `packages/identity` | ENS and ERC-8004 verification adapters | Accept a Provider only after the configured identity checks pass. |
| `packages/payment` | Hedera x402 client integration | Own the client payment lifecycle; Gateway settles before paid work. |
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
3. The Gateway must confirm settlement before executing paid work; the client preserves uncertain payment outcomes for recovery.
4. Provider or capability failure returns a bounded execution error.
5. An unavailable Frely entry, Swarm runtime, or backing model keeps the
   cross-project environment unready.

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


## X402-architecture-1 — Client and Gateway responsibilities

Status: Implemented
Review level: L3
Source: packages/payment/hedera-x402; packages/broker/payment

The Broker is the payer-side x402 client. It sends the prepared business request,
parses a v2 `PAYMENT-REQUIRED` response, checks explicit policy and budget, then
resends the unchanged request with `PAYMENT-SIGNATURE`. The Gateway issues the
quote and calls its approved facilitator to verify and settle the transaction
before executing paid work. The Broker does not call `/settle` directly and
never owns the facilitator key. A signed payload is not settlement proof.

| Module | Responsibility | Boundary |
| --- | --- | --- |
| `packages/payment/hedera-x402` | Quote validation, budgets, signing, journal, settlement verification and recovery | Injected HTTP, signer, journal, network checker and verifier; no discovery or business mapping |
| `packages/broker/payment` | Map a validated capability request to a payment session | Preserve payment evidence independently of service output |
| `packages/broker/execution` | Provider/origin checks and business request/response mapping | Preserve the exact URL and replayable body across payment |
| `packages/protocol/shared-types`, `apps/broker-mcp` | Request ID, explicit budget and structured result contracts | Return payment and service states independently; do not expose keys |
| `scripts/payment-spike` | Independent offline/preflight/live/recovery entry points | No Graph or ENS dependency for the check; local mock replaces business output only |

The client implementation supports Hedera Testnet only. The local mock waits
for real facilitator settlement before returning fixed output; it does not
establish the actual external Gateway's delivery or failure guarantees.
The authoritative stages, handoffs, retries and recovery rules are maintained
only in [the payment workflow](../workflows/hedera-auto-payment.md).

## X402-contract-1 — Input, policy and adapter result

Status: Implemented
Review level: L3
Source: packages/payment/hedera-x402/types.ts; packages/payment/hedera-x402/preflight.ts

A paid request contains `payment: {requestId, budget: {network, asset,
maxAmountAtomic}}`. Request IDs contain 1–128 ASCII letters, digits, dots,
underscores or hyphens and identify one logical call. With payment enabled,
missing budgets fail before business HTTP. Legacy-only `maxAmount` is rejected;
mixing it with the new budget is also rejected. `acceptIndex` is unsupported.

Amounts are canonical decimal integer strings, compared without JavaScript
Number conversion. Quotes must be positive and within signed 64-bit range;
a zero budget is valid but cannot authorize a positive quote. Network and asset
must match before comparing amount. The limit applies to one logical request,
not aggregate wallet or daily spend. Exactly one acceptable quote is required:
none yields `NO_ACCEPTABLE_QUOTE`, multiple yield `QUOTE_AMBIGUOUS`.

Operator policy binds enabled state, payer, recipient, network, asset and
precision, allowed fee payers, full HTTPS resource URL, facilitator, Mirror
endpoint, journal path and credential references. It cannot be derived from
untrusted quotes or discovery output. Only v2 exact on `hedera:testnet` is
supported; quote timeout must be positive and at most 120 seconds. HBAR uses
asset `0.0.0` and precision 8; an explicitly selected fungible HTS token needs
matching metadata and account readiness. There is no automatic asset switching.

`FRELY_PAYMENT_REGISTRY` selects an operator-controlled registry containing
`version: 1`, canonical `configPaths`, `journalPaths`, and approved
`captureSha256` values. Policy loading validates these approvals and rejects
symlink aliases. Capture approval hashes the JSON array `[source, capturedAt,
method, url, bodySha256, status, paymentRequiredHeader]` in that order.
`signerRef` is an `env:VARIABLE_NAME` reference, with explicit `ecdsa` or
`ed25519` key type. The key is resolved only at signing. Optional service
credentials use separate environment references through
`FRELY_PAYMENT_CREDENTIALS`; business credentials are never reused for a
facilitator or Mirror query. Policy files contain no secret values.

The adapter returns `{requestId, decision, paymentStatus, serviceStatus, reason,
retryAction, evidence, output}`. Decision is prepared/blocked/completed/paused;
payment is not_paid/unknown/settled; service is not_started/unknown/succeeded/failed.
`retryAction` is none or query_original. Broker exposes the complete result as
`paymentOutcome`, including settled payments with failed service delivery.
The legacy `payment` field is derived only from verified settled evidence.

The verifier associates the original signed transaction ID and digest with a
trusted Mirror SUCCESS record and exact asset movement from payer to recipient.
HBAR network fees are accounted for separately. Native HBAR records may omit
`assessed_custom_fees`; when present it must be an empty array. HTS requires
explicit empty custom-fee information. Extra receivers, unknown fee collectors,
staking rewards, mismatched amounts and conflicting transaction IDs fail closed.
`PAYMENT-RESPONSE` is an optional query hint; its absence never requires a new
payment, and `success: true` alone never establishes settlement.

## X402-storage-1 — Persistence and ownership

Status: Implemented
Review level: L3
Source: packages/payment/hedera-x402/journal.ts; packages/payment/hedera-x402/recovery.ts

SQLite stores a unique request ID and fingerprint over method, URL, body hash,
Provider, payer, budget and policy. Different inputs under an existing ID are a
conflict. Each journal permits one active paid operation, with cross-process
ownership and fencing. Multi-host shared-wallet coordination is out of scope.
Transaction ID, digest, quote and dispatch intent are durable before sending;
keys, authorization headers and complete signed payloads are never persisted.

Service state and validated output are saved before settlement lookup. Output
is cached for 24 hours from the first cache write; reads do not renew it.
Expired output does not erase settlement or the permanent request-ID tombstone.
Journal directories use 0700, database and sidecar files 0600. A missing output
cannot be reconstructed from chain success. The workflow defines all recovery
transitions; neither a restart nor a missing response permits automatic repayment.


## X402-allowance-design-1 — Browser allowance extension

Status: Draft
Review level: L3
Source: 2026-09-08 approved allowance scope

The proposed MetaMask authorization path keeps principal in the owner account
and uses a local Hedera spender for native allowance transfers and transaction
fees. It introduces an explicit project allowance profile alongside existing
direct payment; it is not implemented or supported by default facilitators.
Contracts are in the [allowance V1 specification](payment/x402-allowance-v1.md);
runtime handoffs and recovery are maintained only in the
[allowance workflow](../workflows/hedera-allowance-payment.md).
