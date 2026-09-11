---
title: Self-hosted Frely MCP and service boundary design
mdq:
  profile: project-governance/governed-document-v1
---
# Self-hosted Frely MCP and service boundary design

## FMCP-001 — Status and objective

Status: Draft
Review level: L3
Source: User-confirmed MVP decisions on 2026-09-11

This design splits Frely capability use into two products that can be developed
in parallel:

1. a Frely service path that discovers, verifies, and selects a capability
   endpoint; and
2. a self-hosted local MCP package that owns the user's Agent Wallet,
   authorization policy, x402 signature, payment journal, recovery, and direct
   capability invocation.

The first release is a hackathon MVP. It publishes one Bun-based `frely-mcp`
package for local stdio use. It does not add remote MCP hosting, multi-tenant
wallets, a server-side wallet, or production operations.

## FMCP-002 — Confirmed decisions

Status: Baseline
Review level: L3
Source: User confirmations during design review

The following decisions govern both development paths:

- Users install and self-host the MCP package.
- The MCP transport is local stdio. The MVP has no MCP HTTP endpoint.
- The published package contains one bundled CLI and no `workspace:*` runtime
  dependencies.
- The package requires Bun 1.4 or later and targets macOS and Linux.
- Frely's service queries The Graph, filters candidates, verifies ENS/ERC-8004
  identity, and selects the capability endpoint.
- The local MCP calls the selected public HTTPS Relay or capability endpoint
  directly. Frely Network does not proxy the business body or payment
  signature.
- The local Agent Wallet remains the payer. Frely's service never receives or
  loads the Agent Wallet private key.
- Discovery does not grant payment authority. The MVP permits payment to one
  locally approved Provider/Relay profile.
- Blocky remains the Hedera x402 Facilitator.
- The Relay/capability endpoint is the x402 Resource Server. It settles before
  dispatching business work.
- The MCP payer journal and the Resource Server's execution idempotency are
  separate responsibilities.

## FMCP-003 — Current-state gap

Status: Baseline
Review level: L3
Source: Local `B1wl7ch` at `5ec26e3`, `origin/main` at `30971ae`, and inspected feature branches

The design branch starts from local `B1wl7ch` at `5ec26e3`, not from
`origin/main`. This local baseline contains the standalone Agent Wallet,
file-backed signer, and stdio Broker MCP. It is the authoritative MCP-side
reference for this design.

The branches have diverged. Compared with their merge base, local `B1wl7ch`
contains 12 commits absent from `origin/main`; `origin/main` contains 9 commits
absent from `B1wl7ch`. The remote line adds the HTTP `/mcp` service and A2A
payment-admission work. Its runtime performs discovery and identity resolution
and loads `X402_PRIVATE_KEY`. Those service changes are inputs to Path A, but
they are not a newer superset of the local wallet and MCP work.

The official x402 Resource Server spike and hardened payer journal work remain
on `feat/hedera-auto-payment` at `4ff5a5e`. Implementation must form an explicit
integration base from the approved local MCP/wallet work, the required remote
service/admission changes, and the reviewed x402 changes. It must resolve their
contracts deliberately and must not replace the local baseline with
`origin/main` or infer integration from prior branch tests.

The existing `scripts/payment-spike/mock-gateway.ts` is an acceptance harness.
It will not ship as the production Relay Resource Server or as part of the npm
package.

## FMCP-004 — Runtime ownership

Status: Baseline
Review level: L3
Source: Confirmed service and MCP boundary

| Component | Owner | Responsibility | Excluded responsibility |
| --- | --- | --- | --- |
| Host Agent adapter | Local `frely-mcp` | Expose `find_capability` and `use_capability` over stdio | Graph, ENS, and ERC-8004 access |
| Frely Network capability service | `frely-network` service path | Discover, verify, filter, and select a capability endpoint | Wallet keys, payment signing, task body, and Provider proxying |
| Agent Wallet | Local `frely-mcp` | Generate or reuse the payer identity and sign after authorization | Discovery, pricing, and automatic policy changes |
| Payer policy and journal | Local `frely-mcp` | Approve one target, enforce budget, deduplicate payment, and recover the original transaction | Resource Server settlement and Provider execution |
| x402 Resource Server | Frely Relay/capability service | Issue a standard 402, verify, settle, and admit work | Payer policy and wallet custody |
| Blocky | External Facilitator | Report supported Hedera schemes and perform verify/settle for the Resource Server | MCP configuration and Agent Wallet custody |
| Relay | `FrelyHQ/relay` | Authenticate the caller, apply access and pricing rules, and dispatch settled work | Agent Wallet signing and Graph identity resolution |
| Swarm | `FrelyHQ/swarm` | Execute the selected Agent workflow and call the base model through Frely | Public payment, discovery, pricing, and payer identity |

The term MCP Server refers to the local process from the Host Agent's point of
view. In the Frely business flow, that process is a client of Frely Network and
the selected Relay endpoint.

## FMCP-005 — End-to-end sequence

Status: Planned
Review level: L3
Source: Confirmed direct-invocation boundary

```text
Host Agent
  -> local frely-mcp: use_capability(capabilities, task, input, payment)
  -> Frely Network: resolve requested capabilities
     -> The Graph: query registrations and service declarations
     -> ENS / ERC-8004: verify identity and endpoint binding
     <- one verified Relay/capability endpoint
  <- local frely-mcp: validate the resolution against the request and local profile
  -> selected Relay: POST the business request with caller credential and request ID
  <- selected Relay: HTTP 402 + PAYMENT-REQUIRED
  -> local frely-mcp: validate quote and budget, persist intent, load Agent Wallet, sign
  -> selected Relay: retry the unchanged body and request ID + PAYMENT-SIGNATURE
     -> Blocky: verify then settle
     -> Relay -> Swarm -> Frely base-model entry -> Provider
     <- business result and usage
  <- local frely-mcp: business result + PAYMENT-RESPONSE
  -> Mirror: independently verify the original transaction when required
  <- Host Agent: provider summary, payment outcome, and business output
```

The Network service receives capabilities and authentication metadata. It does
not receive `task`, `input`, a raw payment signature, or a wallet reference.
The selected Relay receives the business body and signed payment payload. It
does not receive the private key or local policy.

## FMCP-006 — Frozen capability-resolution contract

Status: Planned
Review level: L3
Source: Parallel-development seam approved in design review

Both development paths depend on one versioned contract. A small contract
commit must land before the two paths branch. This gate is not a third product
path.

The service exposes:

```http
POST /v1/capabilities/resolve
Authorization: Bearer <FRELY_API_KEY>
Content-Type: application/json
```

Request:

```json
{
  "schemaVersion": 1,
  "capabilities": ["vision"],
  "paymentNetwork": "hedera:testnet"
}
```

Successful response:

```json
{
  "schemaVersion": 1,
  "requestedCapabilities": ["vision"],
  "provider": {
    "id": "provider-1",
    "ensName": "vision.example.eth",
    "endpoint": "https://relay.example.com/v1/responses",
    "protocol": "responses"
  },
  "identity": {
    "verified": true,
    "chainId": 11155111,
    "registry": "0x1111111111111111111111111111111111111111"
  },
  "payment": {
    "supportsX402": true,
    "network": "hedera:testnet"
  }
}
```

The canonical TypeScript schema and success/error fixtures live in the shared
protocol package. The service path produces the response. The MCP path consumes
it without importing service implementation modules.

The service must return one selected Provider. It must reject an empty result,
an identity mismatch, an unsupported protocol, or an unsupported payment
network. It must not return an unverified candidate as executable.

The MCP must require an exact `requestedCapabilities` match, `verified: true`,
the configured chain and registry, protocol `responses`, and a safe public
HTTPS endpoint without embedded credentials. It must reject redirects,
localhost, link-local addresses, and private-network destinations. The Host
Agent cannot supply or override the endpoint.

The payment metadata is advisory. Only the later standard 402 quote defines the
amount, asset, payee, fee payer, timeout, and resource binding.

## FMCP-007 — MCP tool contract

Status: Planned
Review level: L3
Source: Existing two-tool surface and confirmed local boundary

The package exposes exactly two tools.

### `find_capability`

Input is a non-empty array of non-blank capability strings. The local MCP calls
the resolution endpoint and returns the selected verified service metadata.
It does not call the Provider or load the Agent Wallet.

Annotations:

- `readOnlyHint: true`
- `destructiveHint: false`
- `idempotentHint: true`
- `openWorldHint: true`

### `use_capability`

The MVP accepts the current Vision request shape:

```json
{
  "capabilities": ["vision"],
  "task": "Describe the image",
  "input": { "image_url": "https://images.example/demo.png" },
  "payment": {
    "requestId": "req-123",
    "budget": {
      "network": "hedera:testnet",
      "asset": "0.0.0",
      "maxAmountAtomic": "1000000"
    }
  }
}
```

The tool resolves a fresh Provider for each new request. It does not trust a
previous `find_capability` result or accept a result object as input. The stable
request ID belongs to the payer journal and is required for paid execution.

Annotations:

- `readOnlyHint: false`
- `destructiveHint: true`
- `idempotentHint: true` only for the same request ID, request fingerprint, and
  policy
- `openWorldHint: true`

The result contains the selected Provider summary, the statement
`identityVerificationSource: "frely-network"`, the normalized payment outcome,
and the business output. It excludes the private key, raw signature, caller
credential, full policy, and private filesystem paths.

## FMCP-008 — Local Agent Wallet and authorization

Status: Baseline
Review level: L3
Source: Confirmed one-profile MVP and existing Agent Wallet design

The Agent Wallet remains independent from the Broker and payment policy.
`frely-mcp wallet init` may generate or recover a local Hedera Testnet wallet,
wait for funding, verify the account and key, and output a payment identity. It
must not enable a profile, edit the Network service configuration, or initiate
a business payment.

The first release supports one approved payment profile. The profile pins:

- Provider ID;
- exact Relay resource URL;
- `hedera:testnet`;
- HBAR asset `0.0.0`;
- expected `payTo`;
- allowed Blocky fee payer set;
- per-request maximum amount;
- configured Facilitator and Mirror endpoints;
- wallet reference; and
- journal path.

The profile starts disabled. The operator enables it after reviewing the
public fields. Network discovery cannot add a payee, modify the profile, or
grant spending authority.

Before reading the private key, `use_capability` must verify the selected
Provider and resource URL, the complete 402 quote, the tool-call budget, the
profile budget, the request fingerprint, the wallet's Ready state, and the
configured Blocky support. A mismatch stops the call before signing. There is
no automatic fallback to a different Provider.

## FMCP-009 — Package and CLI

Status: Planned
Review level: L3
Source: Confirmed distribution choice

The public package name is `frely-mcp`. The package is published to the npm
registry and requires Bun 1.4 or later. Registry lookup on 2026-09-11 did not
show a public package with that name; release authorization and ownership still
require explicit verification before publication.

The package contains compiled distribution files, README, license, and package
metadata. It contains no `workspace:*` runtime dependency, source checkout
path, wallet, private key, payment journal, real configuration, or acceptance
evidence.

The CLI provides:

```text
frely-mcp wallet init
frely-mcp check --config <absolute path>
frely-mcp start --config <absolute path>
```

`wallet init` initializes or resumes a wallet. `check` performs a read-only
configuration, endpoint, wallet, policy, and journal check. It must not sign,
pay, or invoke a Provider. `start` runs the stdio MCP server. Stdout carries MCP
messages only; diagnostics go to stderr.

The MVP excludes Node.js compatibility, Windows acceptance, automatic Bun
installation, Docker, remote MCP HTTP, automatic funding, multiple wallets,
multiple authorized Providers, and a management UI.

## FMCP-010 — Failure and recovery semantics

Status: Baseline
Review level: L3
Source: Existing payment safety decisions and confirmed service split

The service path owns `NO_PROVIDER`, `NETWORK_DISCOVERY_FAILED`,
`IDENTITY_VERIFICATION_FAILED`, and `CAPABILITY_NOT_SUPPORTED`.

The MCP path owns `CONFIG_INVALID`, `NETWORK_UNAVAILABLE`, `WALLET_NOT_READY`,
`PAYMENT_DISABLED`, `PROVIDER_NOT_AUTHORIZED`, `QUOTE_MISMATCH`,
`BUDGET_EXCEEDED`, `PAYMENT_UNKNOWN`, and `PROVIDER_EXECUTION_FAILED`.

Both paths return stable public error codes and correlation IDs. They do not
return credentials, keys, raw signatures, configuration bodies, internal
stacks, or private paths.

The MVP follows these retry rules:

1. A discovery or identity error stops before Provider invocation.
2. A resolution mismatch stops before key access.
3. A quote or budget mismatch stops before signing.
4. A pre-sign network error returns without an automatic retry.
5. An uncertain signed or submitted payment becomes `unknown`; recovery queries
   the original transaction and never creates a new payment.
6. A settled payment remains settled when business execution fails.
7. A repeated request ID with a changed fingerprint returns a conflict.
8. The client never switches to another Provider after signing or settlement.

The payer journal prevents duplicate signing and payment. The Relay Resource
Server must independently prevent duplicate business dispatch for the same
request and accepted payment proof. The MVP may implement that guarantee with
the Relay's existing durable request execution boundary; it must not reuse or
read the payer's local journal.

## FMCP-011 — Two parallel development paths

Status: Planned
Review level: L3
Source: User instruction to divide and advance service and MCP work in parallel

### Contract gate

Before parallel work starts, one small integration-base change reconciles the
local `B1wl7ch` baseline with the required service/admission changes from
`origin/main`, then freezes the version-1 resolution request, success response,
error envelope, and fixtures. It does not merge unrelated remote changes by
default. Both paths test against the frozen contract. Any contract change
requires both path owners to approve it before merge.

### Path A — Frely service

Path A owns service-side work across `FrelyHQ/frely-network` and the Relay
Resource Server boundary:

1. expose `POST /v1/capabilities/resolve` behind the Frely API key;
2. query The Graph, filter by all requested capabilities and payment network,
   verify ENS/ERC-8004, and select one Provider;
3. return only the frozen resolution schema and safe error envelope;
4. ensure the selected endpoint is the Frely Relay/capability entry, never the
   Swarm runtime or a final model Provider;
5. remove the payer private key and payer x402 client from the service runtime;
6. remove the public remote `/mcp` path from this MVP boundary;
7. implement the production Relay 402 boundary with the official x402 Resource
   Server and Blocky verify/settle;
8. settle before Relay dispatch and preserve Relay-side execution idempotency;
9. prove the path with contract fixtures and synthetic payment admission before
   any authorized live test.

Path A does not import Agent Wallet code, read MCP config, or receive the
business task during capability resolution.

### Path B — Self-hosted MCP

Path B owns the local package:

1. replace local Graph/ENS/ERC-8004 adapters with `FrelyNetworkClient`;
2. expose the two tools through the official MCP TypeScript SDK and stdio;
3. port the reviewed Agent Wallet and local-key signer onto the current base;
4. port the payer policy, journal, recovery, Mirror verification, and hardened
   x402 client without the mock Gateway;
5. enforce the one-profile authorization gate before key access;
6. call the selected Relay endpoint directly and reject redirects;
7. implement `wallet init`, `check`, and `start`;
8. bundle the CLI as `frely-mcp` without workspace runtime dependencies; and
9. verify an installed package tarball through a real MCP subprocess.

Path B develops against a fake Network server that serves the frozen contract
fixtures. It does not wait for Path A's internal implementation.

### Parallel isolation and join

The two paths use separate branches and worktrees. Path A does not edit local
MCP, wallet, payer journal, or package files. Path B does not edit Graph, ENS,
ERC-8004, Network service, Relay, or Swarm implementation files. The frozen
contract and fixtures are the only shared code seam.

The paths join only after each passes its own tests. The integration gate runs
the packaged local MCP against the real Network resolution endpoint and a
configured Relay/Swarm path. A successful fixture or mock call cannot satisfy
that gate.

## FMCP-012 — Verification and release gates

Status: Planned
Review level: L3
Source: Confirmed evidence requirements

Path A must verify:

- authenticated capability resolution;
- all-capability filtering and deterministic selection;
- ENS/ERC-8004 rejection before returning an endpoint;
- no Swarm or final Provider endpoint leakage;
- stable safe errors and correlation IDs;
- official x402 402, verify, settle, and settle-before-dispatch behavior; and
- duplicate-request business-dispatch prevention.

Path B must verify:

- MCP initialize, `tools/list`, and both `tools/call` operations over stdio;
- strict Network response validation and safe public HTTPS enforcement;
- wallet-not-ready, unauthorized Provider, quote mismatch, and over-budget
  rejection before key access;
- unchanged-body retry, payment journal, request conflict, unknown recovery,
  and same-ID cache behavior;
- stdout protocol purity and secret-safe errors; and
- installation and startup from the final npm tarball.

The combined no-cost gate runs the packaged MCP against the real resolution
service and a synthetic or fixture-backed Resource Server. It records the last
successful boundary instead of claiming a full business chain from component
tests.

A live 0.01 HBAR acceptance requires fresh user authorization after the new
package and service paths pass their no-cost gates. Prior transactions prove
their original path only. The release process, test suite, `check`, and package
installation must never trigger a live payment.

## FMCP-013 — Documentation lifecycle

Status: Planned
Review level: L3
Source: Repository documentation governance

This Draft records the approved design conversation but does not change the
current Architecture Baseline by itself. After written review, the
implementation plan must identify the exact baseline sections that change.
The implementation merge must update `docs/architecture.md` and
`docs/cross-project-integration.md` so they no longer describe discovery,
identity, payer signing, and MCP transport as one runtime.

No implementation, npm publication, branch merge, or live payment is authorized
by this document alone.
