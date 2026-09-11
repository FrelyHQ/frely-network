---
title: Cross-project development integration
mdq:
  profile: project-governance/governed-document-v1
---
# Cross-project development integration

This document is the canonical public-safe plan for connecting the Frely
Network Broker to the public Frely Relay and Swarm competition snapshots. Its
sequence is subordinate to the milestone goals in
[`project-roadmap.md`](project-roadmap.md).

The target is a bounded hackathon development flow. It is not a production
deployment design and does not claim that a clean checkout already contains a
fully seeded, one-command environment.

## Repository-roles-1 — Repository roles and source relationships

Status: Baseline
Review level: L9
Source: Approved hackathon snapshot boundary

| Repository | Public role | Canonical relationship | Responsibility in this integration |
| --- | --- | --- | --- |
| `FrelyHQ/frely-network` | Broker and protocol project | Current project | Owns discovery, identity verification, selection, payment orchestration and the caller-side execution contract. |
| `FrelyHQ/frely` | Relay competition snapshot | Snapshot of private `friday-relay` | Owns the local Agent-model and base-model entries, AccessPoint routing, development Provider credentials and demo billing. |
| `FrelyHQ/swarm` | Swarm competition snapshot | Snapshot of private `frely-swarm` | Runs the local Responses-compatible `vision-basic` Agent and returns its internal model calls through Frely. |

These public repositories are development and review surfaces. They do not
publish private runtime state, production operations or credentials, and their
publication does not convert the private products into general open-source
distributions. Each repository's license and notice remain authoritative.

## Integration-scope-1 — Integration scope and non-goals

Status: Planned
Review level: L9
Source: Approved minimum Vision milestone

The minimum cross-project goal is to preserve one request boundary:

```text
Broker -> Frely Agent-model entry -> Swarm virtual model
       -> Frely base-model entry -> development Provider
       <- result and aggregate usage -> Frely development settlement
```

The plan includes configuration ownership, credential separation, readiness
gates and a safe smoke flow. It does not include:

- production ingress, DNS, TLS, backup, rollback or scaling;
- publication or synchronization of either private canonical repository;
- committed API keys, service tokens, wallets or real request bodies;
- a second Vision runtime in `frely-network` or Frely;
- a claim that the model MCP path or a complete combined local environment is
  delivered by this repository;
- any model invocation path that bypasses Frely on entry to or exit from
  Swarm.

## Service-boundaries-1 — Service ownership and anti-bypass rules

Status: Baseline
Review level: L3
Source: Current public snapshot contracts

| Boundary | Owner | Caller | API boundary | Anti-boundary |
| --- | --- | --- | --- | --- |
| Broker orchestration | `frely-network` | Host Agent through Broker MCP | Shared discovery, identity, payment and execution contracts | Do not read Relay or Swarm persistence or store their credentials. |
| Provider discovery | `frely-network` | Broker discovery stage | The Graph adapter and normalized Provider manifest | The paid `vision-basic` endpoint must resolve to Frely, not directly to Swarm. |
| Web3 identity | `frely-network` | Broker verification stage | ENS and ERC-8004 adapters | Do not execute an unverified Provider endpoint. |
| Network x402 resource | `frely-network` | x402 client | `POST /x402/frely/responses` | Payment headers terminate at Network; Frely receives a Bearer-authenticated Responses request. |
| Agent-model admission and billing | public `frely` snapshot | Broker or another local caller | Frely `POST /v1/responses` and the `vision-basic` AccessPoint | Do not expose the Swarm service identity or any downstream credential to the caller. |
| Virtual-model execution | public `swarm` snapshot | Local Frely Provider dispatch | Swarm `POST /v1/responses` with model `vision-basic` | Do not allow a caller to select a base-model URL, model or credential. |
| Agent base-model access | public `frely` snapshot | Swarm Agent runtime | A separately authorized Frely base-model AccessPoint | Do not accept an external caller identity or recurse into an Agent AccessPoint. |
| Development Provider | public `frely` snapshot | Frely Provider runtime | Operator-configured development Provider | Provider URLs and credentials never enter Swarm or `frely-network`. |

The Broker MCP is the Host Agent's orchestration boundary. A future model MCP
entry remains at Frely, with Swarm limited to an internal execution adapter.
The current minimum Vision path uses the Responses API and does not imply that
this MCP model path already exists.

## Integration-topology-1 — Target request topology

Status: Planned
Review level: L3
Source: Approved Broker, Relay and Swarm responsibility split

```text
Hackathon development path

Host Agent
  -> Broker MCP (frely-network)
  -> The Graph discovery
  -> ENS / ERC-8004 verification
  -> Provider selection
  -> Network `POST /x402/frely/responses`
     -> Hedera x402 verification + replay claim
     -> Frely `POST /v1/responses` with Network's Frely API key
     -> caller API-key authentication
     -> `vision-basic` AccessPoint and entitlement resolution
     -> demo pricing and billing admission
     -> Swarm Provider dispatch
  -> local Swarm `POST /v1/responses`
     -> `vision-basic` virtual-model execution
     -> local Frely base-model entry
        -> base-model AccessPoint and entitlement resolution
        -> configured development Provider dispatch
  <- bounded result and aggregate usage
  -> local Frely development settlement
```

Both snapshots are local development services. Health probes and component
stubs may verify an isolated boundary, but no model request may use them to
bypass either Frely entry.

## Workspace-layout-1 — Cross-project workspace layout

Status: Planned
Review level: L3
Source: Public snapshot integration design

A public review workspace can keep the repositories as sibling checkouts and
keep secrets in ignored local paths:

```text
review-workspace/
  frely-network/
  frely-review/       # clone of FrelyHQ/frely
  swarm-review/       # clone of FrelyHQ/swarm
  .local/             # ignored config, secrets and generated runtime data
```

The coordinator must pass only documented URLs and secret-file paths between
owners. It must not copy private source or mount private repository paths into
public containers.

## Docker-network-1 — Shared Docker network and ports

Status: Planned
Review level: L3
Source: Current snapshot ports and future coordinator boundary

A future coordinator may attach the owning Compose projects to one explicit
development network. Stable aliases should be declared instead of relying on
generated container names.

| Alias or endpoint | Owner | Container port | Optional host port | Use |
| --- | --- | ---: | ---: | --- |
| `frely-gateway` | Frely Relay snapshot | `43000` | `43000` on loopback | Caller-facing Gateway and health checks. |
| `frely-swarm-vision` | Swarm snapshot | `4111` | `4111` on loopback | Authenticated `vision-basic` Responses runtime. |
| PostgreSQL | Frely Relay snapshot | `5432` | `55432` on loopback, optional | Relay persistence; never a cross-project API. |

Container-to-container traffic should use the shared network. Host-published
ports are for explicit development diagnostics and remain loopback-bound by
default. The current repositories do not yet provide the combined coordinator.

## Startup-sequence-1 — Ordered startup sequence

Status: Planned
Review level: L3
Source: Dependency-first development flow

1. **Preflight.** Check the documented Bun and Docker requirements, the three
   sibling checkouts, ignored secret files and available loopback ports.
2. **Start Frely.** Require its database, Gateway and control configuration to
   be ready, then configure the development Provider and its base-model
   AccessPoint. A running container alone is not evidence of a usable model
   path.
3. **Start Swarm.** Configure its Agent model client to use the local Frely
   base-model entry with a separate Agent-scoped development key. Supply a
   separate Swarm service token, require `/healthz` and `/readyz`, then verify
   authenticated `/v1/models` contains `vision-basic`.
4. **Configure the Frely Agent-model entry.** Create the Swarm Provider and
   `vision-basic` Provider model, then create and price an enabled AccessPoint
   exposed as `vision-basic` and include it in the demo Plan.
5. **Check the closed loop.** Require both Frely AccessPoints and the Swarm
   service boundary to be ready before accepting a model request.
6. **Start Frely Network.** Run the Broker MCP with configured discovery,
   identity, planned payment and Frely execution endpoints.
7. **Run smoke checks.** Call Frely with a caller API key and a non-sensitive
   remote-image fixture. Record only status and correlation metadata.

The Frely snapshot does not currently ship a complete seeded local database,
so steps 2–5 are a configuration contract rather than a one-command clean-clone
promise.

## Runtime-modes-1 — Verification and configured-demo modes

Status: Planned
Review level: L9
Source: Public snapshot safety and current verification support

### Snapshot verification

Each repository is verified independently. Component tests may use local stubs
and no real credential. This mode can prove validation and adapter behavior,
but it cannot establish an alternate model path or prove the combined Frely
closed loop.

### Configured development demo

An operator supplies development credentials outside Git, configures both
Frely AccessPoint layers and sends a Frely-authenticated request through the
local snapshots. Swarm sends its Agent model call back through Frely. This
proves the bounded hackathon flow only; it is not a production or commercial
deployment mode.

There is no silent fallback between modes. Missing configuration must fail
visibly.

## Configuration-contract-1 — Configuration and secret ownership

Status: Baseline
Review level: L3
Source: Current Frely and Swarm configuration contracts

| Configuration or credential | Owner | Delivery and restriction |
| --- | --- | --- |
| Broker discovery, identity, payment and selected Provider endpoint | `frely-network` | Ignored local config; the paid endpoint is Frely. |
| Caller Frely API key | Broker operator / Frely | Supplied only to the Frely request. |
| Swarm `/v1` base URL | Frely Provider configuration | Non-secret URL on the explicit development network. |
| Swarm access token | Swarm and Frely CPA Provider credential | Secret file or private credential store; never sent to the Broker caller. |
| Frely base-model URL and model ID | Swarm | Must resolve to the local Frely base-model AccessPoint; never to a final Provider. |
| Agent model-access key | Swarm and Frely | Restricted to the configured Frely base-model path; never used as the caller or service identity. |
| Development Provider URL and credential | Frely only | Private Provider configuration; never copied into Swarm or `frely-network`. |
| Relay database configuration | Frely | Relay-owned ignored config or secret; never a Broker or Swarm input. |
| Testnet wallet/payment credential | Payment owner and operator | Local secret store only; never committed or logged. |

The caller key, Swarm service token, Agent model-access key and Provider
credential are distinct. They are not interchangeable, even in a local demo.

## Readiness-contract-1 — Readiness and health evidence

Status: Planned
Review level: L3
Source: Current snapshot health contracts and target request path

| Check | Required evidence | Failure behavior |
| --- | --- | --- |
| Swarm process | `/healthz` returns success. | Do not call the runtime. |
| Swarm configuration | `/readyz` returns success, authenticated `/v1/models` advertises `vision-basic`, and the Agent model target is the local Frely base-model entry. | Do not configure the Agent-model entry as ready. |
| Frely persistence and Gateway | Owning health checks pass. | Do not expose the demo entry. |
| Frely base-model path | Development Provider, base-model AccessPoint and Agent entitlement are enabled. | Do not start Agent execution. |
| Frely Agent-model path | `vision-basic` Provider model, price, Plan and caller entitlement are enabled. | Reject before Swarm dispatch. |
| Broker discovery | A verified manifest resolves the paid endpoint to Frely. | Abort before payment or invocation. |
| Identity | ENS/ERC-8004 checks accept the selected identity. | Abort before payment or invocation. |
| Network x402 resource | Requirements, verifier, settlement credentials and persistent replay path are configured. | Return a payment-resource error; do not call Frely. |
| Execution | Frely returns a bounded Responses result for an image request. | Report a safe category without secrets or raw bodies. |

Swarm `/readyz` confirms loaded configuration; it is not a live probe of the
Frely base-model path or development Provider. End-to-end execution evidence
is still required.

## Smoke-flow-1 — Cross-project smoke flow

Status: Planned
Review level: L3
Source: Minimum Vision request contract

1. Discover and verify the `vision-basic` Provider manifest.
2. Call Network `POST /x402/frely/responses` and satisfy its Hedera x402
   requirement.
3. Verify Network sends Frely `POST /v1/responses` with Network's Frely API key,
   model `vision-basic`, and no payment protocol headers.
4. Verify Frely performs admission and dispatches to Swarm using the separate
   service token.
5. Verify Swarm sends the Agent model call to the configured Frely base-model
   AccessPoint and never to a final Provider URL.
6. Verify Frely performs base-model admission and Provider dispatch, then
   receives the Agent result and aggregate usage.
7. Correlate status and request identifiers without logging Authorization
   headers, prompts, image contents, credentials or raw model responses.

## Security-boundary-1 — Public snapshot safety rules

Status: Baseline
Review level: L9
Source: Public competition snapshot boundary

- Public files contain placeholders or secret-file references, never real
  credentials, private deployment identifiers or production topology.
- The Broker receives only the Frely caller key. Swarm receives only the
  service identity and the restricted Frely Agent model-access identity.
  Final Provider credentials remain in Frely.
- Requests cannot select a Swarm base-model URL, base model or credential.
- Model invocations cannot enter Swarm or leave it toward a final Provider
  without crossing the corresponding Frely boundary.
- Host-published services bind to loopback by default.
- Logs and diagnostics exclude credentials, full request/response bodies,
  private filesystem paths and database URLs.
- The current Responses interface must not be described as a completed Swarm
  MCP implementation.
- Public snapshot success must not be presented as private production
  readiness or automatic synchronization to a private repository.

## Snapshot-validation-1 — Current snapshot validation

Status: Baseline
Review level: L3
Source: Current public repository verification contracts

The public Swarm component can be verified without a real Provider credential:

```bash
bun install --frozen-lockfile
bun run verify
docker compose config
```

The Frely snapshot must be checked with its repository-owned review commands
and configuration prerequisites. The current snapshots have no combined
one-command validation. Until both Frely AccessPoint layers, the development
Provider and the database are configured, successful Swarm verification is
evidence only for component behavior.

## Ownership-and-delivery-1 — Implementation ownership

Status: Planned
Review level: L3
Source: Cross-project responsibility split

| Deliverable | Owning project | Required evidence |
| --- | --- | --- |
| Broker discovery, identity, planned payment and execution contracts | `frely-network` | Contract tests and a manifest resolving to Frely. |
| Caller and Agent model admission, AccessPoint routing, Provider credentials and demo billing | `FrelyHQ/frely` | Review checks plus configured Agent-model and base-model paths. |
| Responses-compatible `vision-basic` Agent execution | `FrelyHQ/swarm` | Boundary scan, typecheck, unit tests, build and component verification. |
| Swarm-to-Frely model access | `FrelyHQ/swarm` and `FrelyHQ/frely` | A closed-loop smoke test proving the final Provider is reached only through Frely. |
| Future model MCP path | Frely external boundary and Swarm internal adapter | Separate implemented and verified interface; not inferred from Responses support. |
| Future combined coordinator | `frely-network` | Readiness, redaction and cleanup checks across owning projects. |

No repository may silently assume ownership of another repository's
persistence, credentials or cleanup lifecycle.

## Implementation-phases-1 — Minimal implementation sequence

Status: Planned
Review level: L3
Source: Current implementation state and remaining gaps

1. Keep repository roles, model names, credential ownership and request paths
   consistent across all three public snapshots.
2. Verify Swarm component behavior with local stubs without defining another
   model invocation path.
3. Configure and verify Frely's development Provider and base-model
   AccessPoint, then configure Swarm to use only that Frely entry.
4. Configure the Frely `vision-basic` Agent-model AccessPoint and add a
   closed-loop cross-project smoke check.
5. Point the Broker's selected execution endpoint at Frely and add the Broker
   stages to that verified loop.
6. Keep Hedera x402 verification, replay state and settlement in Network. Keep
   Frely billing and payment-protocol state separated.
7. Add a thin coordinator only when it can preserve each repository's config,
   readiness, secret and cleanup boundaries.

## Acceptance-criteria-1 — Completion criteria

Status: Planned
Review level: L9
Source: Approved minimum Vision goal and public safety boundary

The combined development flow is complete only when:

- the Broker discovers and verifies a `vision-basic` endpoint at Frely;
- the caller uses a Frely API key and cannot access downstream identities or
  Provider credentials;
- Frely admits, prices and bills the AccessPoint before dispatching to Swarm;
- Swarm authenticates the service call and uses only Frely's base-model entry;
- Frely performs the final development Provider dispatch and receives the
  Agent result and aggregate usage;
- missing Frely, Swarm, credential, AccessPoint or development Provider
  configuration fails
  visibly and safely;
- the Network x402 resource verifies payment, claims replay state, calls Frely without payment headers, and settles after a successful Frely response;
- validation output and logs contain no secrets or raw user/model bodies; and
- the documentation does not claim production readiness, a complete model MCP
  interface or a one-command environment that has not been verified.

## Current-gaps-1 — Current gaps and status

Status: Current limitation
Review level: L3
Source: Current public checkout audit

The Swarm snapshot implements component-level Responses-compatible
`vision-basic` behavior. The Frely snapshot contains generic Provider,
AccessPoint, pricing and billing mechanisms, but the Frely → Swarm → Frely
closed loop has not yet been evidenced in a complete seeded local environment.
`frely-network` exposes a Network-owned x402 Responses resource with persistent
single-instance replay claims and Hedera settlement. The combined Frely →
Swarm → Frely coordinator remains outside this slice. Multi-replica Network
requires a shared atomic replay store.

Those limits are intentional status statements. The current milestone aligns
the executable boundary and documentation; it does not claim that the full
cross-project demo or production environment is already delivered.
