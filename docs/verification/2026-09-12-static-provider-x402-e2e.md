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
Source: FXE2E-012；Task 7 live `bun run acceptance:static-preflight` exit 1

| Gate | 验收动作 | 实际结果 |
| --- | --- | --- |
| G0 Relay 入口基线 | health / models / vision-basic canary | fail：`FRELY_RELAY_API_KEY_MISSING`。health 200 已记录；models 与 OCR canary 未跑 |
| G1 本地静态 resolve | loopback Network v2 | fail：`FRELY_NETWORK_API_KEY_MISSING`，未启动 Network |
| G2 endpoint 授权 | Provider / URL 正反例 | fail：resolve unavailable。单元测试覆盖漂移拒绝 |
| G3 Network 402 | 无付款头 vision-basic | fail：`FRELY_NETWORK_API_KEY_MISSING`。单元测试覆盖无 `PAYMENT-SIGNATURE` |
| G4 钱包与预算预检 | payer、余额、Blocky、图片 hash | fail：`WALLET_PAYER_MISMATCH`。Ready wallet 账户 `0.0.10431569`，冻结 payer `0.0.10386782` |
| G5 真实结算 | 唯一一次 1 HBAR | Not run — authorized but not executed in preflight |
| G6 业务结果 | settled 后 Relay 与 `FRELY X402 OK` | Not run — authorized but not executed in preflight |
| G7 完全相同回放 | 零增量 | Not run — authorized but not executed in preflight |
| G8 冲突回放 | 同 requestId 改字段 | pass：测试双，sign=1，settle=0，dispatch=0 |
| G9 unknown 恢复 | settle 后超时模拟 | pass：测试双，只查询原 requestId，无第二笔交易 |
| G10 既有模型回归 | health/models/现有模型 | fail：`FRELY_RELAY_API_KEY_MISSING`。mock 路径覆盖 `gpt-5.6-luna` 200 |
| G11 秘密与证据 | 扫描证据 | pass：证据文件无 API key、签名、私钥或本地秘密路径 |
| G12 声明边界 | 静态 Provider，无 Graph/ENS/ERC-8004 | pass：`static_allowlist`，`identityVerified: false` |

live preflight 输出：`paymentAuthorizationRecorded=true`，`paymentSent=false`。
本地证据 SHA-256：`preflight.json`
`9332c6130c08c8d5db5fe0ae93a105b229c355cb44aecd6d59f103e75a9d232f`；
`relay-canary.json`
`a8f39373bff2cebcccedd14cd80ada8983bf1e0fa4120b01a2cd84a9016b2b1d`。
原始 JSON 不提交。

既有 Ready Agent Wallet 账户为 `0.0.10431569`，冻结 payer 为 `0.0.10386782`。
该差异在任何签名或付款前记录；不得用钱包账户替换授权 payer。Task 8 未执行。

## FXV-004 — Task 7 无 HBAR runner

Status: Draft
Review level: L3
Source: FXPLAN-008

新增 `scripts/static-provider-e2e` 与根脚本 `acceptance:static-preflight` /
`acceptance:static-live`。聚焦测试 14 pass / 43 assertions。`bun run check`
239 pass、0 fail、1056 assertions，exit 0。
packaged `frely-mcp@0.1.0` tarball 仅 `README.md`、`dist/frely-mcp.js`、
`package.json`；`--help` exit 0；无效 `--config` 的 stdio 启动 stdout 为空，
stderr 为固定 `CONFIG_INVALID`，exit 2。

live preflight 未签名、未调用 settle、未调用 `use_capability`。Task 7 未全绿，
不进入 Task 8。

## FXV-005 — 声明

Status: Draft
Review level: L3
Source: FXE2E-014、FXE2E-015

未发生真实 1 HBAR 付款。未 push、未 merge、未 publish、未部署 Relay/Swarm。
代码完成、health 200、402 测试双或计划文档都不等于全链路完成。The Graph、ENS
和 ERC-8004 未参与。
