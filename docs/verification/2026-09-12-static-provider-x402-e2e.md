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

最新核验时间：`2026-09-12T10:14:43.965Z`。工作树
`integration/frely-mcp-mvp-acceptance`，当前代码 HEAD `e718bb7`，Task 1–5 基线
`3af3a90`。现场付款门加固提交为 `e98f2f0` 与 `e718bb7`。

本记录只称静态 Provider 验收。The Graph、ENS 和 ERC-8004 未参与，也不能把
`static_allowlist` 写成身份验证。

## FXV-002 — Task 6 Relay canary（G0）

Status: Blocked
Review level: L3
Source: FXE2E-004、FXE2E-011、FXE2E-012 G0

现有 Relay API Key 已在本地受控环境中使用，未写入仓库、证据或日志。只读
`GET https://api.frely.cloud/health` 成功：

| 字段 | 值 |
| --- | --- |
| HTTP | 200 |
| version | `0.64.1` |
| instance | `frely-eu` |
| releaseId | `v0.65.29-2b4066c889bb` |
| sourceSha | `2b4066c889bb05543e16903d3f9b69713c3c6d96` |

验收图片固定为
`https://placehold.co/600x200/FFFFFF/000000/png?text=FRELY%20X402%20OK`：HTTP 200、
`image/png`、无重定向、6353 字节、SHA-256
`616e015cb9253ca2cf7fe78707b937f6efade9ee695164dc913a4f729c5fb763`。

认证 `GET /v1/models` 返回 200，但只列出 `gpt-5.3-codex`、`gpt-5.5`、
`gpt-5.6-luna`、`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-6-astra`，不含
`vision-basic`。随后以固定图片对 `POST /v1/responses` 做无 x402 canary，Relay
返回 HTTP 402、错误码 `plan_subscription_required`。响应没有
`PAYMENT-REQUIRED` 或 `PAYMENT-SIGNATURE`，因此这是 Relay 自己的 Plan/订阅准入
失败，不是 x402 付款要求。没有修改远端配置。

脱敏证据：`.local/acceptance/static-provider/relay-canary.json`（不提交）。

G0 结果：**fail**（`vision-basic` 没有可用 Plan/订阅）。Task 6 未通过。远端准入
修复前不得执行真实 1 HBAR。

## FXV-003 — G0 至 G12

Status: Draft
Review level: L3
Source: FXE2E-012；Task 7 live `bun run acceptance:static-preflight` exit 1

| Gate | 验收动作 | 实际结果 |
| --- | --- | --- |
| G0 Relay 入口基线 | health / models / vision-basic canary | fail：health 与认证正常；`vision-basic` 不在模型列表，canary 返回 `plan_subscription_required`，没有 x402 header |
| G1 本地静态 resolve | loopback Network v2 | pass：真实 `127.0.0.1:13600` 返回精确 `static_allowlist` |
| G2 endpoint 授权 | Provider / URL 正反例 | pass：冻结 Relay 上游和 loopback 执行入口；漂移负例由测试覆盖 |
| G3 Network 402 | 无付款头 vision-basic | pass：本地 Network 返回标准 402，报价与七项付款参数一致，`paymentSent=false` |
| G4 钱包与预算预检 | payer、余额、Blocky、图片 hash | pass：payer `0.0.10386782` 公钥与本地凭据、Mirror 一致；余额 `672777702` tinybar；Blocky、payTo、图片通过 |
| G5 真实结算 | 唯一一次 1 HBAR | Not run — authorized but not executed in preflight |
| G6 业务结果 | settled 后 Relay 与 `FRELY X402 OK` | Not run — authorized but not executed in preflight |
| G7 完全相同回放 | 零增量 | Not run — authorized but not executed in preflight |
| G8 冲突回放 | 同 requestId 改字段 | pass：测试双，sign=1，settle=0，dispatch=0 |
| G9 unknown 恢复 | settle 后超时模拟 | pass：测试双，只查询原 requestId，无第二笔交易 |
| G10 既有模型回归 | health/models/现有模型 | pass：`gpt-5.6-luna` 返回 200；现有六模型目录可读取 |
| G11 秘密与证据 | 扫描证据 | pass：证据文件无 API key、签名、私钥或本地秘密路径 |
| G12 声明边界 | 静态 Provider，无 Graph/ENS/ERC-8004 | pass：`static_allowlist`，`identityVerified: false` |

live preflight 输出：`paymentAuthorizationRecorded=true`，`paymentSent=false`。
本地证据 SHA-256：`preflight.json`
`5ea4413ab69ab22259753c296e82172c2e73b4f51ae4d61f524fd7114c519e2a`；
`relay-canary.json`
`8066335f1f8c78e8c47ffde166ca112796b54680188aab2661045987d52f8c71`。
原始 JSON 不提交。

既有专用 Agent Wallet `0.0.10431569` 保持不变且未用于本次付款。受控 runtime 从已有
Testnet payer 凭据建立本次验收 wallet 描述；本地派生 ECDSA 公钥与 Mirror 上
`0.0.10386782` 的公钥实时匹配。配置和 key 权限分别为 0700/0600，均在忽略目录，
未进入证据包。Task 8 未执行。

## FXV-004 — Task 7 无 HBAR runner

Status: Draft
Review level: L3
Source: FXPLAN-008

`scripts/static-provider-e2e` 与根脚本 `acceptance:static-preflight` /
`acceptance:static-live` 已实现。现场门只接受 15 分钟内的 live preflight、固定九项
参数和相同图片 hash；synthetic 证据不能放行。第一次调用若为 unknown 或传输不明，
先保存原 requestId，再停止且不执行回放。成功结果必须具备 Mirror transaction、
`settled`、`succeeded` 和 `FRELY X402 OK`，第二次结果必须完全相同。

最新聚焦回归：21 pass、0 fail、69 assertions；类型检查通过。最新全仓回归：
246 pass、0 fail、1082 assertions；packaged `frely-mcp@0.1.0` dry-run 仅含
`README.md`、`dist/frely-mcp.js`、`package.json`。

live preflight 未签名、未调用 settle、未调用 `use_capability`。除依赖 Task 6 的 G0
外，Task 7 所有要求的无付款 gate 已通过；由于 G0 仍红，不进入 Task 8。

## FXV-005 — 声明

Status: Draft
Review level: L3
Source: FXE2E-014、FXE2E-015

未发生真实 1 HBAR 付款，`live.json` 未创建。未 push、未 merge、未 publish、未部署
Relay/Swarm。
代码完成、health 200、402 测试双或计划文档都不等于全链路完成。The Graph、ENS
和 ERC-8004 未参与。

## FXV-006 — 当前唯一阻塞与恢复入口

Status: Blocked
Review level: L3
Source: Task 6 现场 canary；Task 8 付款停止条件

唯一外部阻塞是当前 API Key 对 `vision-basic` 没有活动 Plan/订阅。需要在现有 Relay
为该调用方启用 `vision-basic` AccessPoint 与有效 Plan/entitlement，且随后
`GET /v1/models` 能看到 `vision-basic`、OCR canary 返回 200 与
`FRELY X402 OK`。恢复时必须重新运行 Task 6 和完整 live preflight；旧 preflight
超过 15 分钟后自动失效。只有 G0-G4、G8-G12 全绿，才可使用现有唯一一次 1 HBAR
授权进入 Task 8。
