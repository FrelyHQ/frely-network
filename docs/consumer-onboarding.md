---
title: Frely Network consumer onboarding
mdq:
  profile: project-governance/governed-document-v1
---

# Consumer onboarding

## ONBOARD-001 — Scope and entry point

Status: Implemented
Review level: L3
Source: User approval to implement the consumer onboarding plan in new worktrees, 2026-09-13

The website provides this prompt:

```text
Fetch https://network.frely.cloud/SKILL.md and follow the setup instructions.
```

`/onboarding/` contains the prompt and setup overview. `/SKILL.md` contains the host adaptation, installation, authorization, invocation and recovery instructions. `/connect/` contains the device authorization UI. The navigation entry does not depend on the Spline scene.

This implementation extends the scope of the [placeholder plan](superpowers/plans/2026-09-13-network-skill-onboarding.md). That historical plan remains unchanged. Installation guidance is implemented; CLI publication and production activation remain release gates.

## ONBOARD-002 — Host and command contract

Status: Implemented
Review level: L3
Source: frely-cli 0.4.0 source worktree; apps/site/public/SKILL.md

| Host | Execution mechanism | Instruction persistence |
| --- | --- | --- |
| ChatGPT with FrelyMCP | Existing bridge executes the CLI on the user's device | Current conversation; no native ChatGPT Skill claim |
| Claude Code | Host shell | Managed `.claude/skills/frely-network/SKILL.md` |
| OpenCode | Host shell | Managed `.config/opencode/skills/frely-network/SKILL.md` |
| Other shell hosts | Host shell | Managed `.agents/skills/frely-network/SKILL.md` |

A prompt does not grant missing tools. A cloud sandbox is not the user's Mac. A client without a device shell or bridge requires a tool-connection step. This implementation does not create ChatGPT Actions, change model providers or register a connector inside a running conversation.

Node.js 22 or newer and the Frely CLI 0.4.0 release are prerequisites. The 0.4.0 package is an unreleased worktree version in this change.

```sh
frely network setup --host chatgpt --json
frely network status --json
frely network find --capability web3.address-risk --json
frely network use --capability web3.address-risk \
  --input-json '{"address":"<EVM_ADDRESS>","chainId":"1"}' \
  --request-id '<REQUEST_UUID>' --json
frely network logout --json
```

The examples contain placeholders. `setup` returns a link and request code without waiting for browser interaction. The next `status`, `find` or `use` call retrieves the approved session. Setup resumes a pending authorization. Session validation precedes a ready result. Commands do not require a TTY and do not restart the FrelyMCP service.

`--network <HTTPS-origin>` selects a deployment and persists its origin. Credentials remain origin-scoped in the OS credential store under service `frely-network`. They do not share the Frely account credential namespace. A managed-file hash protects an installed Skill from overwriting user edits. File locks serialize grant exchange on the device.

## ONBOARD-003 — Device authorization API

Status: Implemented
Review level: L3
Source: apps/broker-mcp/consumer/store.ts; apps/broker-mcp/consumer/service.ts

All routes use the `/api/network/` prefix and JSON responses with `Cache-Control: no-store`.

| Route | Request | Result |
| --- | --- | --- |
| `POST device/start` | `clientName`, `host` | Private `deviceCode`, public `userCode`, `verificationUri`, expiry, polling interval |
| `GET device/request?user_code=…` | Public request code | Client, host, expiry and permissions |
| `POST device/challenge` | `userCode`, address, login chain ID | Server-created SIWE message |
| `POST device/approve` | Request code, exact message, signature | Approval; no access token in the browser response |
| `POST device/reject` | Request code | Rejection |
| `POST device/token` | Private device code | `202 awaiting_wallet` or `200 ready` with access token |
| `GET session` | Bearer session | Session metadata and remaining demo quota |
| `DELETE session` | Bearer session | Revocation |
| `POST capabilities/find` | Bearer session, capabilities | Broker discovery result |
| `POST capabilities/use` | Bearer session, request UUID, capabilities, task, input | Service result and execution evidence |

`use` requires an `Idempotency-Key` header matching the request UUID. The consumer MCP adapter enforces the same authorization and quota gates. Production MCP tool execution without a configured consumer gateway returns a configuration error; it cannot use the anonymous legacy call path.

The browser mutation routes require the configured Origin. The page requires request-code confirmation and displays the SIWE message before signing. An EOA signature binds the configured domain, URI, nonce, expiry, address, login chain and device request. Signing does not grant transfer or token-spending permissions. WalletConnect and contract-account signatures are outside this release.

Device grants expire after 10 minutes; sessions expire after one hour. Grant exchange is single-use. SQLite stores credential hashes, not bearer tokens or wallet signatures. The CLI stores private device codes and access tokens in the OS credential store; output excludes them. A failed credential save is not successful setup.

## ONBOARD-004 — Discovery, execution and result evidence

Status: Implemented
Review level: L3
Source: packages/broker; packages/discovery/the-graph; frely-swarm source worktree

```text
Host → Frely CLI → authenticated Network consumer gateway
     → Broker → The Graph discovery → ENS/ERC-8004 verification
     → Frely A2A service entry → Swarm Agent → GoPlus risk tool
     ← structured tool result + Agent identity + execution evidence
```

The current registration parser accepts the A2A service profile. A new risk Agent registration must publish `web3.address-risk`, a Frely A2A execution endpoint, AgentCard metadata and matching identity records. A legacy Responses-only registration is not a replacement for that profile. Native `x402Support` must describe the service truthfully: account-billing discovery accepts `false`; the x402 profile requires `true` and payment evidence.

The host cannot provide a model override or service endpoint. The gateway maps the capability to `web3/address-risk` or `web3/url-risk`. Identity resolution selects the service; a configured Frely-origin boundary protects the platform credential. The runtime does not forward that credential to another origin or follow service redirects.

The address-check target profile is Ethereum mainnet, chain ID `1`. Login supports Ethereum mainnet and Sepolia; login chain does not choose the target chain. URL checks accept credential-free HTTP(S) URLs; the Agent queries GoPlus rather than fetching the supplied website.

Swarm projects executed `check_address_risk` or `check_url_risk` tool records into the service result. Generated prose, JSON without a tool record and missing evidence cannot supply the verdict. Responses streaming for these two safety models is rejected; the non-streaming Responses and A2A paths return tool JSON. Other model streaming behavior is unchanged.

Results include target, target chain, status, risk level, matched signals, GoPlus source, check time and `scamProbability: null`. The Network envelope adds Agent identity, discovery source, registration chain, identity verification, execution ID and payment mode. The Graph is the discovery source, not the risk intelligence source. A chain registration does not prove that the Agent code executes on chain.

Empty, malformed, API-error and timed-out source responses yield `UNKNOWN`. No-known-risk results are not safety guarantees. Mixer or sanctions associations are not proof of fraud. This release has no calibrated probability model.

## ONBOARD-005 — Quota, retry and runtime configuration

Status: Implemented
Review level: L3
Source: ConsumerStore; createConsumerGatewayFromEnv; createBrokerRuntimeFromEnv

The payment mode is `platform_demo`. Frely account billing funds the service call; wallet sign-in does not fund it. The result sets `chainSettlement: false`. Hedera x402 resources remain a separate path and this flow does not claim a Hedera settlement.

Default limits are 10 attempts per wallet per UTC day and 100 attempts per deployment per UTC day. Wallet limits span sessions and login chains. A claimed attempt consumes quota even when execution fails. The global limit bounds wallet cycling. Successful duplicates return the stored result. Unknown or failed attempts cannot trigger a second invocation under the same UUID. Old IDs retain tombstones after result retention ends.

```text
NETWORK_ONBOARDING_ENABLED=true
NETWORK_PUBLIC_ORIGIN=https://network.frely.cloud
NETWORK_SESSION_DB=/private-mounted-directory/consumer.sqlite
NETWORK_DEMO_WALLET_CALL_LIMIT=10
NETWORK_DEMO_GLOBAL_CALL_LIMIT=100
FRELY_API_ORIGIN=https://api.frely.cloud
```

These are configuration examples, not deployed settings. `FRELY_API_ORIGIN` must match the published Frely service origin. Existing Graph, ENS, registry and Frely service-credential configuration remains required. Credential values must not appear in this document or test logs.

The SQLite parent directory requires mode `0700`; the database uses `0600`. Symlinked paths are rejected. Use a persistent private volume and one broker replica for this SQLite profile. A multi-host deployment requires a shared transactional quota and idempotency store. State loss can lose deduplication guarantees; do not replace the volume during retries.

Loopback HTTP requires `FRELY_NETWORK_ALLOW_LOOPBACK=1` and is a development setting. Public onboarding without the feature flag returns an unavailable error. The server must not expose the legacy unauthenticated MCP mode as a workaround.

## ONBOARD-006 — Verification and release gates

Status: Live acceptance pending
Review level: L3
Source: docs/verification/2026-09-13-consumer-onboarding.md

See the [verification record](verification/2026-09-13-consumer-onboarding.md) for commands, fixtures and results.

Release gates remain: resolve worktree merge conflicts; publish CLI 0.4.0; release the Swarm safety tools through the Frely service boundary; configure the Frely model/service admission; publish and verify Agent identity metadata; observe the risk Agent in the live Graph index; provision the consumer database and quota configuration; deploy the website and API; test the target macOS ChatGPT App with FrelyMCP and a user-approved wallet signature.

This change does not publish npm packages, modify production hosts, register chain records, move funds or prove live ChatGPT/Claude Code/OpenCode onboarding. An unavailable prerequisite must remain visible to the user rather than become a simulated success.
