---
title: 静态 Provider Hedera x402 全链路验收
mdq:
  profile: project-governance/governed-document-v1
---
# 静态 Provider Hedera x402 全链路验收

## FXV-001 — 运行基线

Status: Verified
Review level: L3
Source: FXE2E-012、FXE2E-013；plan Task 6–8

最新核验时间：`2026-09-12T10:47:19Z`。工作树
`integration/frely-mcp-mvp-acceptance`，验收实现提交 `64c3f99`，Task 1–5 基线
`3af3a90`。现场付款门加固提交为 `e98f2f0` 与 `e718bb7`。

本记录只称静态 Provider 验收。The Graph、ENS 和 ERC-8004 未参与，也不能把
`static_allowlist` 写成身份验证。

## FXV-002 — Task 6 Relay canary（G0）

Status: Verified
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

认证 `GET /v1/models` 返回 200，列出 `gpt-5.3-codex`、`gpt-5.5`、
`gpt-5.6-luna`、`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-6-astra`。用户明确允许使用
任一可用模型后，本轮冻结 `gpt-5.6-luna`。随后以固定图片对
`POST /v1/responses` 做无 x402 canary，Relay 返回 HTTP 200，业务输出精确为
`FRELY X402 OK`，且没有 `PAYMENT-REQUIRED` 或 `PAYMENT-SIGNATURE`。没有修改远端配置。

脱敏证据：`.local/acceptance/static-provider/preflight.json`（不提交）。

G0 结果：**pass**。该 canary 只证明 Relay 普通业务入口与模型可用；真实 x402 付款
仍由后续 G5 的本地 Network 链路单独证明。

## FXV-003 — G0 至 G12

Status: Verified
Review level: L3
Source: FXE2E-012；Task 7 live preflight exit 0；Task 8 live runner exit 0

| Gate | 验收动作 | 实际结果 |
| --- | --- | --- |
| G0 Relay 入口基线 | health / models / `gpt-5.6-luna` canary | pass：health 与认证正常；图片 canary 返回 200 与精确文本，没有 x402 header |
| G1 本地静态 resolve | loopback Network v2 | pass：真实 `127.0.0.1:13600` 返回精确 `static_allowlist` |
| G2 endpoint 授权 | Provider / URL 正反例 | pass：冻结 Relay 上游和 loopback 执行入口；漂移负例由测试覆盖 |
| G3 Network 402 | 无付款头 `gpt-5.6-luna` | pass：本地 Network 返回标准 402，报价与七项付款参数一致，`paymentSent=false` |
| G4 钱包与预算预检 | payer、余额、Blocky、图片 hash | pass：payer `0.0.10386782` 公钥与本地凭据、Mirror 一致；余额 `672777702` tinybar；Blocky、payTo、图片通过 |
| G5 真实结算 | 唯一一次 1 HBAR | pass：Mirror `SUCCESS`；payer 净转出、payTo 净收到 `100000000` tinybar |
| G6 业务结果 | settled 后 Relay 与 `FRELY X402 OK` | pass：`paymentStatus=settled`、`serviceStatus=succeeded`；Relay 返回完成响应与精确文本 |
| G7 完全相同回放 | 零增量 | pass：相同 requestId 的 structuredContent 完全一致，复用原 transactionId；journal 仅一条完成记录 |
| G8 冲突回放 | 同 requestId 改字段 | pass：测试双，sign=1，settle=0，dispatch=0 |
| G9 unknown 恢复 | settle 后超时模拟 | pass：测试双，只查询原 requestId，无第二笔交易 |
| G10 既有模型回归 | health/models/现有模型 | pass：`gpt-5.6-terra` 返回 200；现有六模型目录可读取 |
| G11 秘密与证据 | 扫描证据 | pass：证据文件无 API key、签名、私钥或本地秘密路径 |
| G12 声明边界 | 静态 Provider，无 Graph/ENS/ERC-8004 | pass：`static_allowlist`，`identityVerified: false` |

live preflight 输出：`paymentAuthorizationRecorded=true`，`paymentSent=false`。
本地证据 SHA-256：`preflight.json`
`2e07522a7b7458303a9db438f2afc9a7378f7cc7fd4121be2a32bd5bb41bf364`；
`live.json`
`d83317b85b09e536b580afc677f8fabf4d79f75fd25ca97b1e121dea4f326856`。
原始 JSON 不提交。

既有专用 Agent Wallet `0.0.10431569` 保持不变且未用于本次付款。受控 runtime 从已有
Testnet payer 凭据建立本次验收 wallet 描述；本地派生 ECDSA 公钥与 Mirror 上
`0.0.10386782` 的公钥实时匹配。配置和 key 权限分别为 0700/0600，均在忽略目录，
未进入证据包。Task 8 已执行并消费本次唯一付款授权。

真实运行使用 requestId `7b07793c-7eb5-48fd-9457-0421d5f87083`，transactionId
`0.0.7162784@1789209798.357109298`，共识时间
`1789209805.560413060`。独立 Mirror 查询返回 `CRYPTOTRANSFER / SUCCESS`：payer
`0.0.10386782` 为 `-100000000` tinybar，payTo `0.0.10403579` 为
`+100000000` tinybar。公开核验入口：
[Mirror transaction](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7162784-1789209798-357109298)。

## FXV-004 — Task 7 无 HBAR runner

Status: Verified
Review level: L3
Source: FXPLAN-008

`scripts/static-provider-e2e` 与根脚本 `acceptance:static-preflight` /
`acceptance:static-live` 已实现。现场门只接受 15 分钟内的 live preflight、固定九项
参数和相同图片 hash；synthetic 证据不能放行。第一次调用若为 unknown 或传输不明，
先保存原 requestId，再停止且不执行回放。成功结果必须具备 Mirror transaction、
`settled`、`succeeded` 和 `FRELY X402 OK`，第二次结果必须完全相同。

最新 live runner 回归：10 pass、0 fail、28 assertions；类型检查通过。最新全仓回归：
248 pass、0 fail、1088 assertions；packaged `frely-mcp@0.1.0` dry-run 仅含
`README.md`、`dist/frely-mcp.js`、`package.json`。

live preflight 未签名、未调用 settle、未调用 `use_capability`，要求的无付款 gate
全部通过。首次启动 packaged MCP 时，live runner 先后暴露 SDK ESM 路径和 child
环境变量传递问题；两次都发生在付款记录创建前，journal 行数为零，没有 transactionId。
补充 RED 测试并修复后才进入真实付款。最终 journal 只有一个 requestId，状态为
`finished / settled / succeeded`，锁已释放；完全相同回放返回同一远端 response 与
transactionId。

## FXV-005 — 声明

Status: Verified
Review level: L3
Source: FXE2E-014、FXE2E-015

已发生且仅验收一笔真实 Hedera Testnet 1 HBAR x402 付款，`live.json` 已创建并脱敏。
settlement、业务输出和完全相同回放均通过。未 push、未 merge、未 publish、未部署
Relay/Swarm。The Graph、ENS 和 ERC-8004 未参与。

## FXV-006 — 最终验收结论

Status: Verified
Review level: L3
Source: Task 6 现场 canary；Task 8 付款停止条件

G0-G12 均已取得对应证据，静态 Provider Hedera x402 MVP 全链路通过。结论范围是：
packaged 本地 `frely-mcp` → 本地 Network 标准 402 → Blocky/Hedera Testnet 结算 →
现有 Relay `gpt-5.6-luna` → 精确 OCR 输出 → payer journal 相同请求回放。

本轮唯一一次 1 HBAR 授权已经使用，不得再次运行 live 付款。后续若要重跑真实链路，
必须使用新的精确付款授权。该结论不覆盖 Graph 动态发现、ENS/ERC-8004 身份、远程
Network 部署、跨 Network 重启幂等、Mainnet、npm 发布、push 或 merge。
