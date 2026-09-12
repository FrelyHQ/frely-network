---
title: 静态 Provider Hedera x402 全链路验收
mdq:
  profile: project-governance/governed-document-v1
---
# 静态 Provider Hedera x402 全链路验收

## FXV-001 — 运行基线

Status: Draft
Review level: L3
Source: FXE2E-012、FXE2E-013；plan Task 6–8

核验开始时间：`2026-09-12T09:32:05.325Z`。工作树
`integration/frely-mcp-mvp-acceptance`，起始 HEAD `4c76f0f`，Task 1–5 基线
`3af3a90`。`bun run check` 基线：225 pass、0 fail、1013 assertions，exit 0。

本记录只称静态 Provider 验收。The Graph、ENS 和 ERC-8004 未参与，也不能把
`static_allowlist` 写成身份验证。

## FXV-002 — Task 6 Relay canary（G0）

Status: Draft
Review level: L3
Source: FXE2E-004、FXE2E-011、FXE2E-012 G0

只读 `GET https://api.frely.cloud/health` 成功：

| 字段 | 值 |
| --- | --- |
| HTTP | 200 |
| version | `0.64.1` |
| instance | `frely-eu` |
| releaseId | `v0.65.27-1592fbde9897` |
| sourceSha | `1592fbde9897e2fd48f2c8280f1abad419a7e1e0` |

验收图片未设置 `FRELY_ACCEPTANCE_IMAGE_URL`，运行时复核候选
`https://placehold.co/600x200/FFFFFF/000000/png?text=FRELY%20X402%20OK`：HTTP 200、
`image/png`、无重定向、6353 字节、SHA-256
`616e015cb9253ca2cf7fe78707b937f6efade9ee695164dc913a4f729c5fb763`。

认证 canary 未执行。当前进程、`~/.frely`、仓库忽略的本地配置、Claude/Grok
settings 和 macOS keychain 中都不存在 `FRELY_RELAY_API_KEY`。按规格不得伪造该
key，因此 `GET /v1/models` 与 `POST /v1/responses` 停止。没有向 Relay 发送 402
或 x402 付款头。`vision-basic` 可用性仍为 unknown。

脱敏证据：`.local/acceptance/static-provider/relay-canary.json`（不提交）。

G0 结果：**fail**（`FRELY_RELAY_API_KEY_MISSING`）。Task 6 未通过。未修改远程状态。

## FXV-003 — G0 至 G12

Status: Draft
Review level: L3
Source: FXE2E-012

| Gate | 验收动作 | 实际结果 |
| --- | --- | --- |
| G0 Relay 入口基线 | health / models / vision-basic canary | fail：health 200；models 与 vision-basic canary 因缺少 Relay API key 未跑 |
| G1 本地静态 resolve | loopback Network v2 | 未跑 — Task 6 未通过 |
| G2 endpoint 授权 | Provider / URL 正反例 | 未跑 — Task 6 未通过 |
| G3 Network 402 | 无付款头 vision-basic | 未跑 — Task 6 未通过 |
| G4 钱包与预算预检 | payer、余额、Blocky、图片 hash | 未跑 — Task 6 未通过 |
| G5 真实结算 | 唯一一次 1 HBAR | Not run — authorized but not executed in preflight |
| G6 业务结果 | settled 后 Relay 与 `FRELY X402 OK` | Not run — authorized but not executed in preflight |
| G7 完全相同回放 | 零增量 | Not run — authorized but not executed in preflight |
| G8 冲突回放 | 同 requestId 改字段 | 待 Task 7 测试双 |
| G9 unknown 恢复 | settle 后超时模拟 | 待 Task 7 测试双 |
| G10 既有模型回归 | health/models/现有模型 | 未跑 — 缺 Relay API key |
| G11 秘密与证据 | 扫描证据 | 待 Task 7 |
| G12 声明边界 | 静态 Provider，无 Graph/ENS/ERC-8004 | 本文遵守；全链路未完成 |

既有 Ready Agent Wallet 账户为 `0.0.10431569`，冻结 payer 为 `0.0.10386782`。
该差异在任何签名或付款前记录；不得用钱包账户替换授权 payer。

## FXV-004 — 声明

Status: Draft
Review level: L3
Source: FXE2E-014、FXE2E-015

未发生真实 1 HBAR 付款。未 push、未 merge、未 publish、未部署 Relay/Swarm。
代码完成、health 200 或计划文档都不等于全链路完成。
