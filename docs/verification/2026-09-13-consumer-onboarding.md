---
title: Consumer onboarding verification — 2026-09-13
mdq:
  profile: project-governance/governed-document-v1
---

# Consumer onboarding verification

## ONBOARD-VERIFY-001 — Scope and observed checks

Status: Passed within fixture scope
Review level: L3
Source: Test command outputs from the three implementation worktrees, 2026-09-13

| Worktree | Command | Observed result |
| --- | --- | --- |
| Network | `bun run typecheck` | Passed |
| Network | `bun test` | 694 passed, 0 failed; 50 files; 2,305 assertions |
| Network | `bun run build` | Passed |
| Network site | `npm exec astro build` | Passed; home, onboarding and connect pages generated |
| CLI | `npm run check` | Passed |
| CLI | `npm test` | 41 passed, 0 failed |
| CLI | `npm run build` | Passed; version 0.4.0 source output |
| Swarm | `bun run typecheck` | Passed |
| Swarm | `bun test` | 65 passed, 0 failed; 12 files; 353 assertions |

The Network suite includes 24 consumer authorization and execution tests and four account-billing qualification tests. The Swarm suite includes nine safety-tool tests and five executed-tool output tests. CLI tests use an injected credential store and temporary home directories, not the user's OS credential store.

Build and tests were executed in new worktrees. No result in this record implies production release. Test-only identity verification, source data and model responses are identified in the integration records below.

## ONBOARD-VERIFY-002 — Cross-repository fixture

Status: Passed
Review level: L3
Source: scripts/consumer-onboarding-smoke.ts; observed exit code 0

Reproduce from the Network worktree after building the CLI:

```sh
bun scripts/consumer-onboarding-smoke.ts \
  ../frely-cli-T-feat-agent-onboarding-20260913 \
  ../frely-swarm-T-feat-agent-onboarding-20260913
```

The fixture executes the implemented CLI, consumer authorization API, SIWE verifier, Broker, The Graph adapter, A2A invocation adapter, Swarm A2A handler, Mastra Agent and risk tool. A disposable test identity signs the SIWE message. A scripted test model requests the risk tool and then emits a contradictory prose verdict; the service returns the executed tool report.

Graph HTTP responses, registration metadata, ENS identity resolution, the Frely service edge and GoPlus intelligence are fixtures. There is no live RPC, model endpoint, paid API, wallet extension or OS Keychain access.

Observed result:

```json
{
  "status": "passed",
  "mode": "isolated_fixture",
  "liveGraph": false,
  "liveEns": false,
  "liveWallet": false,
  "liveGoPlus": false,
  "model": "scripted_test_model",
  "graphQueries": 2,
  "invocations": 1,
  "sourceQueries": 1
}
```

The first call returns source-backed risk data. Repeating its UUID returns the cached result without another service invocation. Removing the Graph fixture record makes a new request fail with `NO_PROVIDER`. Logout revokes the session and clears the fixture credential store.

## ONBOARD-VERIFY-003 — Browser fixture

Status: Passed
Review level: L3
Source: apps/site/scripts/onboarding-browser-smoke.mjs; observed exit code 0

Reproduce from `apps/site` with a built site, installed development dependencies and the Chrome browser channel:

```sh
npm exec astro build
node scripts/onboarding-browser-smoke.mjs
```

The script starts a loopback server with an in-memory authorization store, launches a fresh headless Chrome context and provides a test EIP-1193 wallet. Test signing uses a disposable key. The script does not attach to a user profile, invoke a wallet extension or write to the system clipboard. The fixture server and browser stop during cleanup.

Passed checks: exact prompt text; copy behavior; desktop and mobile overflow bounds; same-origin page requests; request-code confirmation; signature preview before signing; server validation of the test signature; absence of transfer methods; approved-state recovery after reload; missing-code error behavior.

Screenshots are saved under the Network worktree:

```text
.local/qa/onboarding-desktop.png
.local/qa/onboarding-mobile.png
.local/qa/wallet-signature-preview.png
.local/qa/wallet-connected.png
```

These are browser-fixture screenshots, not a recording of the target macOS ChatGPT App or a real wallet.

## ONBOARD-VERIFY-004 — Limitations and release acceptance

Status: Pending
Review level: L3
Source: User-approved non-deployment scope; implementation boundaries

Not performed: npm publication; production release; Agent registration transactions; live Graph/ENS/ERC-8004 checks; live GoPlus lookup; user-funded calls; Hedera settlement; OS Keychain acceptance under the user's account; target macOS ChatGPT App installation; Claude Code/OpenCode session loading; live wallet-extension authorization; production Mastra build/smoke.

The consumer flow uses platform demo quota and Frely account billing. `scamProbability` is null. Address checks target Ethereum mainnet. Login accepts Ethereum mainnet or Sepolia EOA signatures. WalletConnect, contract-account signatures, cross-host SQLite deployment and safety-model Responses streaming are outside the implemented profile.

The project-governance resolver failed because the existing v3 project configuration lacks a `tasks` section. That tooling issue is not hidden by rewriting the project configuration. Document contract and relative-link verification are separate from resolver execution.

Release and operational instructions: [consumer onboarding](../consumer-onboarding.md). Worktree and documentation scope: [implementation record](../superpowers/plans/2026-09-13-consumer-onboarding-implementation.md).
