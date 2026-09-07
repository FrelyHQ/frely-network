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
| `FrelyHQ/frely` | Relay competition snapshot | Snapshot of private `friday-relay` | Owns the caller-facing API key, AccessPoint routing, demo pricing and billing, and dispatch to an `openai-compatible` Provider. |
| `FrelyHQ/swarm` | Swarm competition snapshot | Snapshot of private `frely-swarm` | Owns the Responses-compatible `vision-basic` virtual-model runtime and its backing-model credential. |

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
Broker -> Frely billed entry -> Swarm virtual model -> backing model API
```

The plan includes configuration ownership, credential separation, readiness
gates and a safe smoke flow. It does not include:

- production ingress, DNS, TLS, backup, rollback or scaling;
- publication or synchronization of either private canonical repository;
- committed API keys, service tokens, wallets or real request bodies;
- a second Vision runtime in `frely-network` or Frely;
- a claim that Swarm MCP, the Hedera x402 path or a complete combined local
  environment is already implemented;
- treating a direct Swarm call as evidence of Frely routing or billing.

## Service-boundaries-1 — Service ownership and anti-bypass rules

Status: Baseline
Review level: L3
Source: Current public snapshot contracts

| Boundary | Owner | Caller | API boundary | Anti-boundary |
| --- | --- | --- | --- | --- |
| Broker orchestration | `frely-network` | Host Agent through Broker MCP | Shared discovery, identity, payment and execution contracts | Do not read Relay or Swarm persistence or store their credentials. |
| Provider discovery | `frely-network` | Broker discovery stage | The Graph adapter and normalized Provider manifest | The paid `vision-basic` endpoint must resolve to Frely, not directly to Swarm. |
| Web3 identity | `frely-network` | Broker verification stage | ENS and ERC-8004 adapters | Do not execute an unverified Provider endpoint. |
| Planned payment | `frely-network` | Broker payment stage | Hedera x402 contract | Do not claim the combined payment flow before it is implemented and evidenced. |
| Relay admission and billing | public `frely` snapshot | Broker or another caller | Frely `POST /v1/responses` and the `vision-basic` AccessPoint | Do not expose the Swarm or backing-model credential to the caller. |
| Virtual-model execution | public `swarm` snapshot | Frely `openai-compatible` Provider | Swarm `POST /v1/responses` with model `vision-basic` | Do not allow a request to select the backing URL, backing model or credential. |
| Backing model | Swarm configuration | Swarm only | Operator-configured OpenAI-compatible Responses API | `MODEL_API_KEY` must never enter Frely or `frely-network`. |

The Broker MCP and the future Swarm MCP surface are separate boundaries. The
current minimum Vision path uses the Responses API; it does not imply that a
Swarm MCP server or MCP pass-through already exists.

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
  -> planned Hedera x402 payment gate
  -> Frely `POST /v1/responses`
     -> caller API-key authentication
     -> `vision-basic` AccessPoint and entitlement resolution
     -> demo pricing and billing admission
     -> `openai-compatible` Provider dispatch
  -> Swarm `POST /v1/responses`
     -> `vision-basic` virtual-model execution
  -> configured model API (`gpt-5.6-luna` by default)
  -> bounded result

Runtime-only test path

Developer
  -> Swarm `POST /v1/responses`
  -> configured model API
  -> bounded result
```

The runtime-only path authenticates with the Swarm service token, but it
bypasses Frely admission and billing. It must be labelled as a Swarm runtime
test and never presented as the paid-model demonstration.

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
2. **Start Swarm.** Supply its backing-model credential and a separate Swarm
   access token. Require `/healthz` and `/readyz`, then verify authenticated
   `/v1/models` contains `vision-basic`.
3. **Configure Frely.** Create an `openai-compatible` Provider whose `/v1` base
   is Swarm and whose CPA-managed credential is the Swarm access token. Enable
   Provider model `vision-basic`.
4. **Configure the Frely entry.** Create and price an enabled AccessPoint
   exposed as `vision-basic`, route it to the Swarm Provider model and include
   it in the demo Plan.
5. **Check Frely.** Require its database, Gateway and control configuration to
   be ready. A running container alone is not evidence of a usable AccessPoint.
6. **Start Frely Network.** Run the Broker MCP with configured discovery,
   identity, planned payment and Frely execution endpoints.
7. **Run smoke checks.** Call Frely with a caller API key and a non-sensitive
   remote-image fixture. Record only status and correlation metadata.

The Frely snapshot does not currently ship a complete seeded local database,
so steps 3–5 are a configuration contract rather than a one-command clean-clone
promise.

## Runtime-modes-1 — Verification and configured-demo modes

Status: Planned
Review level: L9
Source: Public snapshot safety and current verification support

### Snapshot verification

Each repository is verified independently. Swarm's automated smoke test uses a
fake backing model and no real credential. Frely's review checks inspect its
published boundary. This mode can prove validation, authentication and routing
contracts but not the combined billed request.

### Configured development demo

An operator supplies test credentials outside Git, configures the Frely
Provider and AccessPoint, and sends a Frely-authenticated request through the
full public snapshot boundary. This proves the bounded hackathon flow only; it
is not a production or commercial deployment mode.

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
| `MODEL_BASE_URL`, `MODEL_NAME`, `SWARM_PUBLIC_MODEL` | Swarm | Safe local config; defaults are OpenAI `/v1`, `gpt-5.6-luna` and `vision-basic`. |
| `MODEL_API_KEY` | Swarm only | Prefer `MODEL_API_KEY_FILE`; never copy into Frely or `frely-network`. |
| Relay database configuration | Frely | Relay-owned ignored config or secret; never a Broker or Swarm input. |
| Testnet wallet/payment credential | Payment owner and operator | Local secret store only; never committed or logged. |

The caller key, Swarm service token and backing-model key are three distinct
credentials. They are not interchangeable, even in a local demo.

## Readiness-contract-1 — Readiness and health evidence

Status: Planned
Review level: L3
Source: Current snapshot health contracts and target request path

| Check | Required evidence | Failure behavior |
| --- | --- | --- |
| Swarm process | `/healthz` returns success. | Do not call the runtime. |
| Swarm configuration | `/readyz` returns success and authenticated `/v1/models` advertises `vision-basic`. | Do not configure Frely as ready. |
| Frely persistence and Gateway | Owning health checks pass. | Do not expose the demo entry. |
| Frely Provider and AccessPoint | `vision-basic` Provider model, price, Plan and entitlement are enabled. | Reject before dispatch. |
| Broker discovery | A verified manifest resolves the paid endpoint to Frely. | Abort before payment or invocation. |
| Identity | ENS/ERC-8004 checks accept the selected identity. | Abort before payment or invocation. |
| Planned payment | Hedera x402 result is accepted when that stage is implemented. | Do not invoke the paid entry. |
| Execution | Frely returns a bounded Responses result for an image request. | Report a safe category without secrets or raw bodies. |

Swarm `/readyz` confirms loaded configuration; it is not a live probe of the
backing model. End-to-end execution evidence is still required.

## Smoke-flow-1 — Cross-project smoke flow

Status: Planned
Review level: L3
Source: Minimum Vision request contract

1. Discover and verify the `vision-basic` Provider manifest, whose execution
   endpoint is Frely.
2. Run the planned Hedera x402 gate only when its implementation is available;
   otherwise label the demo gap explicitly.
3. Send Frely `POST /v1/responses` with the caller's Frely API key, model
   `vision-basic`, at least one `input_image` with an HTTP(S) URL, and bounded
   text instructions.
4. Verify Frely performs admission and dispatches to Swarm using the separate
   service token.
5. Verify Swarm forces its configured backing model and non-streaming,
   non-stored execution, while returning the public model ID.
6. Correlate status and request identifiers without logging Authorization
   headers, prompts, image contents, credentials or raw model responses.

A direct Swarm request can be run separately to isolate runtime failures. Its
result must not satisfy steps 1–4.

## Security-boundary-1 — Public snapshot safety rules

Status: Baseline
Review level: L9
Source: Public competition snapshot boundary

- Public files contain placeholders or secret-file references, never real
  credentials, private deployment identifiers or production topology.
- The Broker receives only the Frely caller key; Frely receives only the Swarm
  service token; Swarm alone receives the backing-model key.
- Requests cannot select a Swarm backing URL, backing model or credential.
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

The public Swarm runtime can be verified without a real model credential:

```bash
bun install --frozen-lockfile
bun run verify
docker compose config
```

The Frely snapshot must be checked with its repository-owned review commands
and configuration prerequisites. The current snapshots have no combined
one-command validation. Until the Frely Provider, AccessPoint and database are
configured, successful Swarm verification is evidence only for the runtime
boundary.

## Ownership-and-delivery-1 — Implementation ownership

Status: Planned
Review level: L3
Source: Cross-project responsibility split

| Deliverable | Owning project | Required evidence |
| --- | --- | --- |
| Broker discovery, identity, planned payment and execution contracts | `frely-network` | Contract tests and a manifest resolving to Frely. |
| Caller admission, AccessPoint routing, demo pricing and billing | `FrelyHQ/frely` | Review checks plus configured `vision-basic` path. |
| Responses-compatible `vision-basic` execution | `FrelyHQ/swarm` | Boundary scan, typecheck, unit tests, build and fake-upstream smoke test. |
| Backing-model credential handling | `FrelyHQ/swarm` | Secret-file configuration and redacted failure behavior. |
| Future Swarm MCP | Swarm owner | Separate implemented and verified interface; not inferred from Responses support. |
| Future combined coordinator | `frely-network` | Readiness, redaction and cleanup checks across owning projects. |

No repository may silently assume ownership of another repository's
persistence, credentials or cleanup lifecycle.

## Implementation-phases-1 — Minimal implementation sequence

Status: Planned
Review level: L3
Source: Current implementation state and remaining gaps

1. Keep repository roles, model names, credential ownership and request paths
   consistent across all three public snapshots.
2. Verify Swarm independently with its fake-upstream smoke test.
3. Configure and verify the Frely Provider, `vision-basic` AccessPoint, price,
   Plan and caller entitlement in an operator-owned development environment.
4. Point the Broker's selected execution endpoint at Frely and add an honest
   cross-project smoke check.
5. Implement and evidence the Hedera x402 stage separately; do not substitute
   Frely's internal demo billing for that sponsor integration.
6. Add a thin coordinator only when it can preserve each repository's config,
   readiness, secret and cleanup boundaries.

## Acceptance-criteria-1 — Completion criteria

Status: Planned
Review level: L9
Source: Approved minimum Vision goal and public safety boundary

The combined development flow is complete only when:

- the Broker discovers and verifies a `vision-basic` endpoint at Frely;
- the caller uses a Frely API key and cannot access either downstream secret;
- Frely admits, prices and bills the AccessPoint before dispatching to Swarm;
- Swarm authenticates the service call, executes the configured backing model
  and returns the public virtual-model ID;
- missing Frely, Swarm, credential or backing-model configuration fails
  visibly and safely;
- the Hedera x402 state is described truthfully as implemented or still a gap;
- direct Swarm tests are labelled as billing-bypassing runtime diagnostics;
- validation output and logs contain no secrets or raw user/model bodies; and
- the documentation does not claim production readiness, a complete Swarm MCP
  interface or a one-command environment that has not been verified.

## Current-gaps-1 — Current gaps and status

Status: Current limitation
Review level: L3
Source: Current public checkout audit

The Swarm snapshot now implements and verifies the minimum Responses-compatible
`vision-basic` runtime. The Frely snapshot already contains the generic
Provider, AccessPoint, pricing and billing mechanisms needed to route to it,
but the public snapshot does not include a complete seeded local database or a
combined deployment reproduction. `frely-network` remains a Broker/protocol
scaffold without the combined coordinator, and the continuous Hedera x402 path
has not been evidenced in this slice.

Those limits are intentional status statements. The current milestone aligns
the executable boundary and documentation; it does not claim that the full
cross-project demo or production environment is already delivered.
