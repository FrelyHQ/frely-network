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

## Boundary-optimization-1 — Broker, A2A, and payment ownership

Status: Baseline
Review level: L9
Source: Sponsor acceptance `ACC-001`–`ACC-006`, technical decisions
`DEC-003`–`DEC-012`, and the P0 implementation plan

`frely-network` is an external capability Broker, not a second Frely Gateway,
Agent Runtime, or billing system. Its stable responsibility is:

```text
discover → verify → qualify → select → quote → pay → invoke → return evidence
```

`apps/broker-mcp` is the Host Agent adapter. It exposes the P0
`find_capability` and `use_capability` operations and does not expose Graph,
ENS, ERC-8004, or payment primitives directly to the Host Agent.

A future A2A adapter is the Agent-facing invocation protocol. It should be a
transport-neutral client package called by Broker core, not an implementation
inside the MCP adapter. MCP is the local Host Agent surface; A2A is the remote
Agent-to-Agent task and result protocol.

Broker core may invoke a verified A2A Agent, Responses endpoint, or another
explicitly allowlisted capability transport through a common invocation port.
It must not copy Mastra/Swarm workflows, hold model credentials, or call a final
Provider outside the Frely boundary.

`packages/payment` owns the consumer-side Hedera x402 flow required by P0:
decode real HTTP 402 requirements, enforce `maxAmount`, sign the payment,
retry the unchanged request body, and retain settlement evidence.
`packages/gateway/x402` is payee-side protocol support only: verify and settle
payment requirements at a capability endpoint. It must not own Frely users,
Plans, AccessPoints, Provider credentials, CPA routing, usage billing, or an
internal ledger.

Sponsor constraints remain authoritative for P0. Live The Graph discovery must
change the selected endpoint, ENSv2/ERC-8004 verification must change execution
eligibility, and real Hedera testnet/Blocky402 402 → payment → unchanged-body
retry must complete the Vision call. A2A is an additive protocol seam and does
not replace the P0 Broker MCP → Responses Provider acceptance path before that
chain is complete.

## Boundary-optimization-2 — Frely products, Swarm execution, and direct x402

Status: Baseline
Review level: L9
Source: Cross-project product boundary and current Frely/Swarm design

Frely is the owner of the four user-callable product surfaces:

| Product | Meaning | Public owner |
| --- | --- | --- |
| `model` | Direct model access such as `gpt-5` | Frely |
| `virtual-model` | A model-shaped product backed by an Agent, prompt wrapper, or renamed model | Frely |
| `a2a-service` | A standard Agent-to-Agent service endpoint | Frely |
| `mcp-service` | An MCP projection of a virtual-model or A2A service | Frely |

All four surfaces are exposed through Frely's public API host. `a2a-service`
must continue to work when `frely-network` is unavailable; Network is not a
required runtime hop for A2A execution.

Swarm only executes Agent runtime work. It does not publish user billing facts,
calculate prices, reserve balances, collect Web2 or Web3 payments, or decide
what a user owes. Frely derives one virtual-model/MCP invocation's billable
consumption from the Swarm execution inputs it sent to Frely base-model APIs and
the Swarm-produced output token count, then applies Frely pricing and performs
Web2 charging. Swarm remains an internal execution dependency.

Network exposes `POST /x402/frely/responses` as the paid resource. The resource
uses x402 v2 `exact` requirements. Network configuration owns the x402 amount,
asset, recipient, expiry, verifier, settlement and replay state. Frely does not
receive the payment proof or payment protocol headers.

The request boundary is:

```text
Client -> Network x402 resource
       <- PAYMENT-REQUIRED
Client -> Network payment proof
       -> verify + replay claim
Network -> Frely POST /v1/responses with Bearer API key
Frely   -> Network service response
Network -> Hedera settlement
       -> Client service response + PAYMENT-RESPONSE
```

A non-success Frely response prevents settlement. Network A2A invocation uses
Frely's Bearer-authenticated A2A JSON-RPC endpoint and carries no x402 headers.
The production Compose profile persists replay claims in the `x402-replay`
volume. A multi-replica deployment requires a shared atomic replay store.

The project separation is:

```text
Frely: service endpoint + execution admission + usage + Web2 billing
Swarm: Agent execution
Network: Web3 discovery + x402 verification + replay + settlement
```

The term `provider` is reserved for model/provider infrastructure where needed.
User-facing and cross-project contracts should use `model`, `virtual-model`,
`a2a-service`, `mcp-service`, `Agent`, `Capability`, `Service Endpoint`, and
`Payment Recipient` instead of using `provider` as a generic synonym.

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
| `packages/protocol` | Manifest schema and shared contracts | Stable data shape between Broker stages and capability providers; future A2A shared types remain transport-neutral. |
| `packages/discovery` | The Graph discovery adapters | Normalize externally indexed provider information; do not hardcode the final Provider. |
| `packages/identity` | ENS and ERC-8004 verification adapters | Accept a Provider only after the configured identity checks pass. |
| `packages/payment` | Hedera x402 client integration | Return an accepted payment result before paid invocation. |
| `packages/broker` | Discover, verify, qualify, select, pay, and invoke orchestration | Transport-neutral and stateless; do not access private runtime persistence or reproduce Frely commercial rules. |
| `packages/a2a` (planned) | Agent-facing A2A client and shared task projection | AgentCard/Task/Message transport only; no Agent Runtime or Frely authorization ownership. |
| `packages/gateway` | Provider-side x402 gateway contract | Payment admission/settlement only; keep payee-side verification separate from Broker-side selection. |
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
