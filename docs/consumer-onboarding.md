---
title: Frely Network consumer onboarding
mdq:
  profile: project-governance/governed-document-v1
---

# Consumer onboarding

## ONBOARD-001 — Public Skill entry

Status: Implemented
Review level: L3
Source: `apps/site/public/SKILL.md`; `apps/site/src/components/ConnectAgent.astro`

The website provides this prompt:

```text
Read https://network.frely.cloud/SKILL.md, follow the Frely Network protocol, and use the best Network adapter available in this chat for my request.
```

`/SKILL.md` is the host contract. It is not an installation document. A chatbot, coding Agent, or local Agent can read the same contract.

The host selects one exposed adapter:

| Adapter | Role |
| --- | --- |
| Native Network tool | Capability discovery and invocation |
| MCP | Host-to-Network tool adapter |
| HTTP + x402 | Network request and wallet payment adapter |
| Frely CLI | User-device shell adapter |

The CLI is not the Network protocol. Node.js is not a requirement for hosts with another adapter.

A prompt cannot create a missing Network tool, wallet, HTTP permission, MCP connector, or user-device shell. A host without a callable adapter reports that limitation. It does not claim an Agent invocation or payment.

## ONBOARD-002 — Web3 and Web2 identity

Status: Accepted
Review level: L3
Source: Product decision, 2026-09-13

Web3 and Web2 use separate identity models.

### Web3

The payment wallet is the caller identity. A paid Web3 call has no separate wallet-login step.

The wallet authorizes the x402 payment. The payment proof identifies the payer and binds the paid request. Network returns settlement evidence with the Agent result.

```text
wallet identity = payer identity
```

A SIWE login session is not a prerequisite for a paid Web3 call.

### Web2

A Web2 caller uses account authentication exposed by Frely or the selected adapter. The Web2 account path can use API keys, sessions, or another account credential contract.

A Web3 caller must not be forced through the Web2 login path to use a paid Agent Offering.

## ONBOARD-003 — Paid Web3 state machine

Status: Accepted; runtime integration pending
Review level: L3
Source: Product decision, 2026-09-13; `docs/architecture.md`

The canonical paid Web3 sequence is:

```text
Discover
  -> Verify Agent and Offering
  -> Quote
  -> Wallet payment authorization
  -> x402 verification and settlement
  -> Agent execution
  -> Result + settlement evidence
```

The state machine is:

```text
DISCOVERED
  -> VERIFIED
  -> QUOTED
  -> PAYMENT_AUTHORIZED
  -> PAYMENT_SETTLED
  -> EXECUTING
  -> SUCCEEDED | FAILED_AFTER_PAYMENT
```

Agent execution starts after settlement for this contract.

A service failure after settlement retains the transaction reference. Recovery does not create a second payment with a new request ID. Refund or compensation uses Network and Offering policy.

The generic production `X402Gateway` path in the current repository performs business execution before settlement. The separate upfront gateway demonstrates settlement-before-execution semantics. The canonical consumer Web3 path needs the upfront semantics before release.

## ONBOARD-004 — Payment destination

Status: Accepted; Offering integration in progress
Review level: L3
Source: Product decision, 2026-09-13; Offering model worktree

Payment destination depends on Agent source.

| Agent source | x402 payment destination | Service cost path |
| --- | --- | --- |
| `frely` | Network Web3 receiving account | Network calls the Frely-hosted Agent with the Network Frely account; Frely deducts the Network account Web2 balance |
| `the_graph` | Agent author / Offering publisher payment account | Caller pays the verified external Agent Offering |

### Frely-hosted Agent

```text
Caller wallet
  -> Network Web3 account
  -> Network Frely account invokes Agent
  -> Frely deducts Network Web2 balance
```

The Frely-hosted Agent owner is not the x402 payee in this route.

### Chain-discovered Agent

```text
Caller wallet
  -> verified Offering publisher
  -> external Agent execution
```

The payment destination comes from verified Offering data bound to the chain Agent identity. Chat text, Agent output, and unverified endpoint responses cannot set `payTo`.

The Offering model carries the commercial relationship between a Web3 publisher and an executable Agent reference. The model includes capabilities, price, publisher payment destination, and the underlying Agent reference.

## ONBOARD-005 — Discovery and evidence

Status: Partially implemented
Review level: L3
Source: `packages/broker`; `packages/discovery/the-graph`; `packages/discovery/frely`; Offering worktree

The target Broker path is:

```text
Host
  -> Network adapter
  -> capability discovery
       -> Frely catalog OR The Graph
  -> identity + Offering verification
  -> payment routing
  -> settlement
  -> selected Agent execution
  <- result + execution evidence + payment evidence
```

`source=frely` represents a Frely-hosted executable Agent. `source=the_graph` represents a chain-discovered Web3 Agent Offering.

A chain-discovered Agent requires identity verification and Offering verification. A Frely-hosted Agent requires an authenticated Frely catalog entry.

The host cannot replace a discovery failure with a fixed endpoint. The host cannot replace an Offering payment destination with user text or Agent prose.

For `web3.address-risk`, the input contains an EVM address and target chain. For `web3.url-risk`, the input contains a URL. GoPlus is the current risk-data source for the safety Agent. The Graph is a discovery source, not the risk-intelligence source.

A paid result should carry Agent identity, discovery source, Offering ID, execution ID, payment network, asset, amount, payee class, and settlement transaction reference.

## ONBOARD-006 — Legacy demo consumer session

Status: Implemented compatibility path
Review level: L3
Source: `apps/broker-mcp/consumer/store.ts`; `apps/broker-mcp/consumer/service.ts`; `frely-cli/src/network.ts`

The existing consumer session flow uses:

```text
SIWE wallet sign-in
  -> bearer consumer session
  -> platform_demo quota
  -> Frely account billing
  -> chainSettlement: false
```

This path is a demo/compatibility profile. It is not the canonical paid Web3 contract.

The current `/connect/` page, `device/start`, `device/challenge`, `device/approve`, session token exchange, demo wallet quota, and CLI `paymentMode === "platform_demo"` checks belong to this legacy profile.

The legacy path proves wallet authorization and capability execution. It does not prove a caller-funded Web3 Agent payment.

The legacy flow must not be presented as `Discover -> Verify -> Pay -> Execute`. It is valid as a demo quota path with explicit labeling.

## ONBOARD-007 — CLI adapter status

Status: Migration required
Review level: L3
Source: `frely-cli/src/network.ts`; Skill v2 contract

Frely CLI 0.4.0 installs a managed Skill and uses the legacy consumer session. Its `network use` command expects `paymentMode: "platform_demo"`.

The paid Web3 contract requires a CLI payment adapter with these properties:

- wallet-backed payer identity;
- x402 quote handling;
- spending-limit enforcement;
- one stable request ID;
- payment proof creation outside chat output;
- settlement evidence validation;
- no second payment after an unknown outcome.

A shell host can use CLI 0.4.0 for demo calls. It cannot use that release as proof of the canonical paid Web3 path.

## ONBOARD-008 — Safety result semantics

Status: Implemented for the safety Agent result profile
Review level: L3
Source: Broker safety projection and Swarm safety tools

Safety results include target, target chain, risk level, matched signals, data source, check time, and `scamProbability: null`.

- `KNOWN_MALICIOUS`: matched malicious signals exist.
- `SUSPICIOUS`: matched risk signals exist.
- `NO_KNOWN_RISK`: the queried source reports no known risk; this is not a safety guarantee.
- `UNKNOWN`: the source result could not be verified.

A sanctions or mixer association does not prove fraud. A host must not create a probability from a category. An on-chain Agent registration does not mean the Agent code executes on chain.

## ONBOARD-009 — Release gates

Status: Pending
Review level: L3
Source: Skill v2 and paid Web3 contract

Release gates for the canonical Web3 flow:

- finish the Offering integration for `frely` and `the_graph` discovery sources;
- bind `source=frely` quotes to the Network Web3 receiving account;
- bind `source=the_graph` quotes to the verified Offering publisher payment account;
- connect the consumer invocation path to settlement-before-execution x402 handling;
- remove SIWE login as a prerequisite for Web3 paid calls;
- retain account authentication for Web2 callers;
- update the Frely CLI paid adapter or expose another host adapter;
- return settlement evidence with paid results;
- test idempotency, unknown settlement recovery, and failure-after-payment handling;
- deploy the public Skill and matching Network runtime;
- record a live paid safety-Agent call with the matching code revision.

The existing verification record for the legacy consumer onboarding remains historical evidence for that implementation. It must not be upgraded into evidence for the paid Web3 contract.
