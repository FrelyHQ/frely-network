---
title: Agent wallet Testnet acceptance
mdq:
  profile: project-governance/governed-document-v1
---
# Agent Wallet 最小 Testnet 验收记录

## AWTEST-001 — 运行与输入核对

Status: Draft
Review level: L3
Source: ../superpowers/plans/2026-09-09-agent-wallet-sdk.md PLAN-006；2026-09-09 用户明确金额并要求执行

**执行结论：通过。** 本记录的 Draft 表示文档待审阅，不表示验收未执行。真实充值、AccountUpdate 激活、Ready 和同目录只读复跑均已核实。核验截止时间：`2026-09-09T03:51:54.602Z`。

- 实施分支：`feat/agent-wallet-sdk`；真实运行代码基线：`b71014c`；运行环境：Bun 1.4.0、SDK 2.85.0。
- 网络：`hedera:testnet`；资产：原生测试 HBAR。
- 源账户：`0.0.10386782`；地址：`0xfd3f529a111942370f17645e61c8b31400ecffd2`。
- 旧凭据引用：`/Users/bit/projects/FrelyHQ/frely-network/.local/payment/testnet.env` 内 `FRELY_HEDERA_TESTNET_PRIVATE_KEY`。SDK 本地派生公钥与官方 Mirror 单 ECDSA 公钥匹配，未输出或复制私钥。
- 用户授权：充值 **2 HBAR**；源转账费用上限 **1 HBAR**；新账户激活费用上限 **0.5 HBAR**；新账户保留余额 **1 HBAR**。费用上限不是估价。
- 新钱包目录：`/Users/bit/.frely/wallets/hedera-testnet/acceptance-20260909`；公开描述为该目录 `wallet.json`。该钱包由正式 CLI 本地生成 ECDSA 私钥，没有导入旧私钥。
- 新账户：`0.0.10431569`；地址：`0xb752095b49925786bbcd1bbe0fac16ee90e112e8`；公开公钥：`033bd1fe2258ef2aece75bbbd97008d2cdc32b0b8e7ab26ebf64ce87e72f23b13d`。
- 本次保留该钱包和充值意图。重复执行本任务必须先回读证据，不能再充值或创建第二笔激活交易。

## AWTEST-002 — 充值、自动开户及费用

Status: Draft
Review level: L3
Source: AWTEST-001；官方 Testnet Mirror 转账记录及账户余额

充值交易：`0.0.10386782@1788925683.134078544`，主记录共识时间 `1788925687.966524104`。SDK 在本地签名、限定费用并保存意图后只提交一次，Mirror 确认 SUCCESS。

[完整充值交易及自动开户子记录](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.10386782-1788925683-134078544)。必须把两条记录合并核算，不能只把主记录的 charged_tx_fee 当成总费用：

| 记录 | 结果 | 费用 HBAR | 源账户扣除 HBAR | 新账户收到 HBAR |
| --- | --- | --- | --- | --- |
| nonce 0 / CRYPTOTRANSFER | SUCCESS | 0.00126870 | 2.00126870 | 2 |
| nonce 1 / CRYPTOCREATEACCOUNT，entity_id=0.0.10431569 | SUCCESS | 0.63435407 | 0.63435407 | 0 |
| 本次充值合计 | 通过 | **0.63562277** | **2.63562277** | **2** |

合计费用低于源账户 1 HBAR 上限。CRYPTOCREATEACCOUNT 是网络自动开户的子记录，不是应用主动提交 AccountCreateTransaction；本次仍只提交了一笔充值交易。

源账户转账前余额 `9.37339979` HBAR，最终余额 `6.73777702` HBAR；差额恰为上述总扣款，无遗漏的额外转出。[源账户核验入口](https://testnet.mirrornode.hedera.com/api/v1/accounts/0.0.10386782)。

## AWTEST-003 — 激活、Ready 与不重发

Status: Draft
Review level: L3
Source: AWTEST-002；官方 Testnet Mirror；CLI 退出状态及钱包保存状态

初始化自动检测充值及空账户，使用新钱包自己的私钥、新账户自己的余额，提交账户 memo 更新。激活交易为 `0.0.10431569@1788925689.489949389`；共识时间 `1788925693.357042940`。

[完整激活交易记录](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.10431569-1788925689-489949389)：nonce 0 是 SUCCESS 的 CRYPTOUPDATEACCOUNT，payer 与 entity_id 均为新账户，交易 memo 为 `frely-agent-wallet`，费用 **0.00279114 HBAR**，低于 0.5 HBAR 上限；同 ID 下 nonce 1 是空账户补全子记录，费用为 0。它不是第二笔激活提交。

[新账户核验入口](https://testnet.mirrornode.hedera.com/api/v1/accounts/0.0.10431569)：账户未删除，数字账户 ID、EVM 地址、单 ECDSA 公钥与 wallet.json 一致，账户 memo 为 `frely-agent-wallet`。最终余额 **1.99720886 HBAR**，高于 1 HBAR reserve。充值及激活两步合计实际费用 **0.63841391 HBAR**。

| 检查 | 首次运行 | 同目录第二次运行 |
| --- | --- | --- |
| CLI 结果 | ready / exit 0 | ready / exit 0 |
| verifiedAt | 2026-09-09T03:48:18.956Z | 2026-09-09T03:48:54.237Z |
| 保存状态 | Ready，原 intent 及成功 evidence 已落盘 | 同一 intent、evidence、runId、账户和公钥 |
| 提交激活 | 一次 | 无 Activate 阶段，无新提交 |

第二次运行省略两项金额，以保存授权恢复。只读核验完成后检查运行窗口内账户交易列表：只有一个激活主记录，另有同 ID 的一个补全子记录；金额、余额及钱包身份均与第一次结果一致。Mirror 可能返回早于本次窗口的扫描游标，核验按时间窗口截止，而不是把任意非空 next 链接误判成存在第二笔交易。

paymentIdentity 正常输出 network、payerAccountId、keyType、signerRef 四个公开字段；未修改 Broker 配置、registry，未启用或执行业务支付。

## AWTEST-004 — 检查范围、修正与产物

Status: Draft
Review level: L3
Source: AWTEST-001 至 AWTEST-003；实测输出及 packages/wallet/agent-wallet/init.test.ts

实测发现一个非资金问题：账户查询为 404 时，每轮重复打印相同充值提示。原因是比较 undefined 与保存的零余额字符串；已统一归一化为零再比较。在已有正常路径测试中加入连续两次未开户查询，先观察断言失败（提示 2 次，预期 1 次），再验证修正通过。没有增加测试用例数量，也未为测试而再次充值。

- 仅重新运行受影响的 init.test.ts：2 pass、0 fail、11 assertions。
- 类型检查通过；未跑全仓回归。
- 公共证据快照与安全验收脚本保存在本工作树 `.local/acceptance-20260909/`：funding-intent.json、funding-complete-evidence.json、funding-transactions.json、activation.json、target-final.json、source-final.json、first-wallet.json、first-init-state.json、repeat.jsonl、activation-list-final.json、summary.json。该目录未进入版本控制，不保存私钥或可广播签名字节。
- 官方 Mirror 的查询由 Bun 验证 TLS 后完成。辅助 Python 查询曾因本机 CA 配置失败；未关闭证书校验，也未因此重发任何交易。

AccountUpdate 空账户激活组合的本次最小 Testnet 兼容性缺口已关闭。此结果不证明真实 x402 服务付款、HTS token 可用性、主网行为或所有故障恢复分支；原来的 unknown 不重发基础测试证据保留，不额外制造链上失败交易。
