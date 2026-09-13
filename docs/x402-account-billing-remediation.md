---
mdq:
  version: 1
  dialect: gfm
  records:
    boundary:
      source: heading
      levels: [2]
    key:
      source: heading
  fields:
    title:
      source: heading
    raw:
      source: body
  tolerance:
    incomplete: false
---

# Frely account billing remediation

## XAB-001 — Scope and intended payment model

Status: Accepted
Review level: L3

`frely-network` is intended to use a normal Frely account and API key. The
Network calls the Frely LLM API with that key, and Frely charges the account's
balance or usage allowance. The Network is not intended to receive Web3
payments from callers in this deployment model.

The current implementation contains two independent payment directions:

- upstream payment through `X402_ACCOUNT_ID`, `X402_PRIVATE_KEY`, and
  `X402_MAX_AMOUNT`;
- inbound Web3 charging through `X402_FACILITATOR_*` and
  `FRELY_NETWORK_X402_*`.

The second direction is outside the intended production model. The first
direction also does not match ordinary Frely account billing and must be
replaced by the Frely API contract before production readiness is restored.

## XAB-002 — Findings

Status: Verified
Review level: L3

1. `apps/broker-mcp/runtime.ts` requires `X402_ACCOUNT_ID` and
   `X402_PRIVATE_KEY`, constructs a Hedera signer, and passes an
   `HederaX402Client` to `ResponsesInvocation`. This makes Hedera payment a
   startup prerequisite even when the intended upstream contract is ordinary
   API-key billing.
2. `apps/broker-mcp/frely-x402-resource.ts` constructs an inbound Hedera
   gateway from `X402_FACILITATOR_*` and `FRELY_NETWORK_X402_*`. This exposes a
   caller-paid Web3 resource that is not part of the intended production
   model.
3. `apps/broker-mcp/server.ts` sets `requireX402Responses` whenever
   `NODE_ENV=production`. A missing inbound gateway therefore turns readiness
   into `X402_RESOURCE_NOT_CONFIGURED`, coupling service availability to an
   unused payment mode.
4. `compose.production.yaml` injects both payment directions and mounts an
   x402 replay volume. The production contract does not distinguish an
   optional compatibility route from the primary account-billing path.
5. Existing tests assert the inbound x402 challenge, settlement, replay, and
   payment headers. Those tests describe the current implementation, not the
   intended account-billing contract, so they must be replaced or explicitly
   moved to an opt-in compatibility profile.

## XAB-003 — Required code changes

Status: Implemented
Review level: L3

- Replaced the `HederaX402Client` dependency in the upstream Responses path
  with `FrelyAccountBillingClient`. The transport sends the configured API key
  to the Frely endpoint and leaves balance/usage charging to Frely.
- Runtime readiness now depends on the ordinary Frely API contract and the
  discovery/identity dependencies, without requiring a Hedera payer account or
  private key.
- Removed the production requirement for `x402Responses`; the inbound Web3
  resource is created only when `ENABLE_INBOUND_X402=true`.
- The default production Compose profile no longer injects inbound facilitator
  variables or mounts the x402 replay volume. The compatibility implementation
  remains isolated behind the explicit opt-in flag.
- Update error codes, startup logging, and public readiness checks so missing
  ordinary Frely configuration is reported directly and unused Web3 payment
  configuration cannot block startup.

## XAB-004 — Required configuration changes

Status: Implemented
Review level: L3

Primary production configuration contains the ordinary Frely account
credential and the endpoints required by discovery and identity. It must not
require these unused inbound-payment variables:

- `X402_FACILITATOR_ACCOUNT_ID`
- `X402_FACILITATOR_PRIVATE_KEY`
- `FRELY_NETWORK_X402_AMOUNT`
- `FRELY_NETWORK_X402_ASSET`
- `FRELY_NETWORK_X402_PAY_TO`

`FRELY_API_KEY` remains the runtime credential name for the service
until the ordinary account-billing transport is implemented. The
`FRELY_SERVICE_API_KEY` name from the deployment notes must either be mapped
to `FRELY_API_KEY` by the host secret contract or removed in favor of one
canonical name.

## XAB-005 — Verification gates

Status: Verified
Review level: L3

- `FrelyAccountBillingClient` tests verify API-key forwarding, payment-header
  removal, and invalid-key rejection.
- Broker service tests verify that the optional Web3 resource is not required
  for readiness.
- Verify that `/healthz` and `/readyz` pass with the ordinary account-billing
  configuration.
- Verify that an upstream request uses the Frely API key and does not create,
  sign, or send a Hedera payment.
- Verify that the default production image does not expose an inbound Web3
  payment route or require an x402 replay store.
- `bun run check` passes: 666 tests, 0 failures, 2199 assertions, typecheck
  and production bundle succeed.
- Only after these checks pass, rebuild and redeploy through the existing
  `frely-eu` host controller.

## XAB-006 — Explicitly excluded changes

Status: Accepted
Review level: L3

This remediation does not create a Web3 receiving account, rotate or invent
credentials, modify Frely account balances, or change the shared `frely-eu`
and `frely-swarm` topology.
