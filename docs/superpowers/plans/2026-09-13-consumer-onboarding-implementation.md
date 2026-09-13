---
title: Consumer onboarding implementation and documentation maintenance
mdq:
  profile: project-governance/governed-document-v1
---

# Consumer onboarding implementation

## ONBOARD-PLAN-001 — Authorization and scope

Status: Implementation recorded
Review level: L3
Source: User approved implementation in new worktrees on 2026-09-13

The approved scope covers the Network website and Skill, consumer wallet authorization, Frely CLI integration, Broker invocation and Swarm wallet-risk tools. It excludes production deployment, package publication, transfers, chain registration and changes to the original working directories.

The worktrees use branch `feat/agent-onboarding-20260913` in their respective repositories:

| Repository | Worktree | Base commit |
| --- | --- | --- |
| Network | `frely-network-T-feat-agent-onboarding-20260913` | `6638d9e` |
| CLI | `frely-cli-T-feat-agent-onboarding-20260913` | `0d6885d` |
| Swarm | `frely-swarm-T-feat-agent-onboarding-20260913` | `7831b75` |

The original Network working directory contained changes in `frely-x402-resource.ts`, its test, `server.ts`, `service.ts` and its test. They are outside this change. Merge review must account for overlapping Broker files.

## ONBOARD-PLAN-002 — Documentation maintenance scope

Status: Implemented
Review level: L3
Source: Repository AGENTS.md; project-governance document-maintenance workflow

Inspection included the repository guidance, architecture, existing placeholder onboarding plan, README files and shared governed-document profile. The placeholder plan describes an earlier static-file scope; it remains a historical record. The approved consumer implementation is documented in a separate record rather than rewriting that history.

The authorized documentation changes are the Network consumer guide, this implementation/maintenance record, a verification record, links in the Network README, CLI command/prerequisite guidance, and Swarm safety-output guidance. They do not change global project lifecycle states, sponsor claims or production deployment records.

Verification checks cover profile contracts, record identifiers, relative links, test evidence and the boundary between fixture results and live acceptance. README files remain ordinary Markdown without persistent MDQ declarations.

The project-governance resolver reported `project-governance v3 config must define tasks` for the checked-out project configuration. The implementation does not change that configuration. The scoped record and contract checks provide the maintenance evidence; the resolver error remains recorded as a tooling limitation.

## ONBOARD-PLAN-003 — Implementation sequence and acceptance

Status: Code implemented; live acceptance pending
Review level: L3
Source: Approved plan; consumer guide; verification record

| Stage | Implementation | Evidence |
| --- | --- | --- |
| Risk service | Mastra tools, GoPlus normalization, executed-tool output projection | Swarm unit and adapter tests |
| Consumer identity | Device request, SIWE challenge, one-time exchange, revocation, quota | Network consumer tests |
| Client | Managed Skill, non-TTY commands, origin-scoped credential state, retry ID | CLI tests and build |
| Website | Prompt copy, setup page, wallet authorization, responsive layouts | Astro build and browser fixture |
| Integration | CLI, real Broker/Graph adapter, Swarm tool loop, repeated-call protection | Cross-repository fixture smoke |

See [consumer onboarding](../../consumer-onboarding.md) and the [verification record](../../verification/2026-09-13-consumer-onboarding.md). A fixture pass is not live Graph registration, Frely billing, wallet funding or target-client acceptance. Production release gates remain in the consumer guide.
