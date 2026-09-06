---
title: Frely project roadmap and delivery gates
mdq:
  profile: project-governance/governed-document-v1
---
# Frely project roadmap and delivery gates

This document records the locally synchronized working constraints from the
[Frely — ETHOnline 2026 Checkpoints project](https://github.com/orgs/FrelyHQ/projects/1/views/1).
The GitHub Project and the repository plan it references remain the external
planning authority. This document is a local implementation reference; it must
not be treated as evidence that a checkpoint is complete.

## Roadmap-authority-1 — Authority and working rules

Status: Baseline
Review level: L9
Source: GitHub Project 1, synchronized 2026-09-06T03:24:53Z

All work in this repository must be prioritized and sequenced against the
Project's milestones, goals, schedule dates, and official DDLs. Before starting
or expanding an implementation, maintainers must identify the applicable
milestone and its required evidence.

The Project's `Status` is an execution-flow signal only. A checkpoint is not
complete unless its `Verification state` is `Passed`, the required evidence is
linked in `Evidence link`, and the named verifier has confirmed it. No code,
test, demo, or passing local command may be described as checkpoint completion
without that evidence.

The Project's current schedule interpretation is China Standard Time (UTC+8).
Project date fields are date-only; exact event times come from the checkpoint
issue bodies. Verify the official event page before making a submission.

## Checkpoint-schedule-1 — Milestones and deadlines

Status: Baseline
Review level: L9
Source: GitHub Project 1 fields and checkpoint issues

| ID | Checkpoint | Goal / required outcome | Schedule / DDL | Scope | Owner | Evidence gate |
| --- | --- | --- | --- | --- | --- | --- |
| M1 | 架构与骨架 | Repository, shared types, Broker MCP skeleton, Vision Provider skeleton, frozen integration interfaces, clean start, no production fallback | 2026-09-05 00:00 — Hacking Begins | P0 | Shared | Hard deadline; joint G/B/W verification |
| M2 | Sponsor 路径拆分 | Reproducible ENSv2, ERC-8004, Graph, Broker/x402/Hedera, Vision Provider, and handoff spikes | 2026-09-06 | P0 | Shared | Internal target; joint verification |
| M3 | 首次纵向集成 | Real Broker → Graph → ENS → Provider path, with payment gap explicitly recorded | 2026-09-07 | P0 | Shared | Internal target; live-demo evidence |
| M4 | Check-in #1 | Real discovery and Provider execution plus a runnable or reproducibly evidenced Hedera payment prototype | 2026-09-08 11:59 — Project Check-in #1 | P0 | B | Hard deadline; B primary review |
| M5 | 完整商务链路 | Discover → Verify → 402 → Pay → Execute, including proof retry and structured Vision result | 2026-09-10 | P0 | B | Internal target; trace and transaction evidence |
| M6 | P0 Feature Freeze | Continuous final P0 acceptance path; after freeze only bug fixing, stability, docs, and submission work | 2026-09-11 11:59 — Check-in #2 / Feature Freeze | P0 | Shared | Hard deadline; joint verification |
| M7 | 发布硬化与提交包 | Reproducible release package, aligned docs/demo/Sponsor claims, recording, and risk evidence | 2026-09-12–09-13 | P0 | W | Submission window; third-party clean-start evidence |
| M8 | 正式提交 | Submit the matching code, video, README, and public materials before the deadline | 2026-09-14 00:00 — Project Submissions Due | Submission | W | Hard deadline; submission record |
| D1 | Judging Round 1 | Keep review materials and commit SHA aligned with M8 | 2026-09-14 03:00 | Submission | W | Post-submission review record |
| D2 | Judging Round 2 | Use the M8 version for live judging; do not add unverified core features | 2026-09-15 00:00 | Submission | W | Post-submission review record |
| D3 | ETHOnline Finale | Preserve final submission, results, feedback, and closeout evidence | 2026-09-17 00:00 | Submission | W | Post-submission review record |

The milestone names and dates above are a synchronized snapshot. If the
external Project or its checkpoint issue bodies change, update this document
and review affected implementation plans before proceeding.

## Frely-network-application-1 — This repository's application to the roadmap

Status: Planned
Review level: L3
Source: Current repository scope and Project checkpoint goals

For `frely-network`, the immediate implementation order is:

1. Map the current scaffold to M1/M2 and close only the missing P0 contracts,
   shared interfaces, and reproducible local start path.
2. Implement the real discovery, identity, Provider execution, and payment
   boundaries needed for M3–M5 without hardcoding a production Provider or
   using mock payment as proof of the real path.
3. Treat M6 as a scope boundary: after Feature Freeze, do not add new core
   capabilities; limit work to bug fixing, stability, documentation, evidence,
   and submission preparation.
4. Keep M7–D3 focused on reproducibility, review materials, submission
   identity, and evidence continuity rather than post-freeze feature expansion.

The existing architecture and cross-project integration documents describe
technical boundaries and target orchestration only. Their planned sections
must be evaluated against this schedule before implementation work is claimed
to satisfy a checkpoint.

## Evidence-and-change-control-1 — Required change control

Status: Baseline
Review level: L3
Source: GitHub Project working agreement

Before claiming a milestone contribution, record the applicable checkpoint,
commit or test/demo evidence, and any unresolved gap. Do not put tokens,
private keys, payment credentials, or other secrets in issues, comments,
repository documentation, or evidence links.

Changes to deadlines, P0/P1 scope, payment/security constraints, or milestone
closure require human review. A local implementation may be marked complete
for engineering purposes while its Project checkpoint remains `Unverified`;
these are separate states and must be reported separately.
