---
title: Hedera browser allowance authorization and x402 payment workflow
mdq:
  profile: project-governance/governed-document-v1
---
# 浏览器 allowance 授权与 x402 支付流程

## AWORK-001 — 输入、Trigger 与前置条件

Status: Draft
Review level: L3
Source: [ALLOW 规格](../docs/payment/x402-allowance-v1.md)

Loop 是用户授予本地 CLI 原生代付额度，并由 CLI 重复调用收费资源。授权变更由用户显式命令触发，支付由预算明确的业务请求触发；无定时自动续额。字段定义仅在 ALLOW 规格维护。

前置条件是 MetaMask owner 的 Testnet EVM/Hedera 身份、CLI spender 专用 key 及可核验账户、指定资产及精度、owner 余额、spender 手续费余额、获准 RPC/Mirror/Gateway/facilitator 配置、持久库可写。缺失条件先只读检查，不能自动注册 Frely 账户、换钱包、切主网或追加额度。

主钱包授权与付款使用独立持久记录。授权记录在申请钱包操作前保存 authOperationId、owner/spender/asset/目标额度、当前阶段；敏感 key 不进入浏览器。付款继承现有 journal 所有权、唯一 requestId、阶段和缓存规则，新增 allowance profile 快照。

## AWORK-002 — 首次浏览器授权

Status: Draft
Review level: L3
Source: ALLOW-003

| 阶段 | 输入/动作 | 输出/交接 |
| --- | --- | --- |
| 准备 | 创建或读取专用 key；解析 owner/spender 与网络；若 spender 未开户，由用户显式确认少量手续费转账至已展示 alias | Mirror 核实账户映射和余额，不能用浏览器 success 代替 |
| 构造授权 | 用户选择指定资产和绝对额度；CLI 保存意图；页面展示 owner、spender、资产、额度及手续费影响 | owner/chain 未变且用户决定继续 |
| 钱包确认 | MetaMask 提交已绑定 EVM approval；hash 立即持久化 | pending；连接成功不等于 allowance 生效 |
| 核验 | RPC 查原交易与 receipt，Mirror 查对应原生 allowance | 两者一致才 active；未知停在原操作 |
| 结束 | 返回经核实的账户/资产/额度/时间；关闭一次性本地会话 | 后续付款不依赖浏览器保持打开 |

Success signal：原交易 receipt 成功、调用参数完全匹配用户意图、可信原生 allowance 达到目标，CLI 原子保存 active。授权期间 CLI 对同一 owner/spender/asset 暂停新的付款；不能用变化中的余额推断授权成功。

用户拒绝且确认钱包未发送时 not_authorized；RPC、浏览器中断或 hash 丢失且不能排除发送时 unknown。已知 hash 只查原交易；未知 hash 的恢复查看该 owner 的交易历史并匹配完整意图，不能自动重新申请签名。无法唯一匹配时提供 Brief 交用户处理。重启使用原 authOperationId，不创建替代审批。

只读 RPC/Mirror 每次 10 秒、最多 3 次、间隔 2 秒；达到上限后停止。钱包交互总会话 10 分钟，超时不撤销可能已经提交的交易；RPC 查证仍可通过 recover-auth 完成。

## AWORK-003 — allowance 付费调用

Status: Draft
Review level: L3
Source: ALLOW-004；ALLOW-005；[现有阶段](hedera-auto-payment.md)

1. Admit：检查显式预算、paymentPath、key 引用和持久记录；同 ID 返回已有状态，异指纹拒绝。
2. Quote：记录 quote-intent，向获准资源发送一次原业务请求；402 必须提供明确 allowance profile。非 402 沿现有免费响应规则保存结果，不签名。
3. Authorize：匹配 profile/supported、网络、资产、精度和预算；只读核对 owner allowance/余额、spender key/手续费；只允许唯一合格报价。不支持 allowance 时停止，不回退 direct。
4. Sign：spender 生成唯一 ID 的 approved TransferTransaction；核对 owner debit、Merchant credit、签名、fee cap、有效期和请求承诺。
5. Dispatch：原子保存原交易 ID、字节摘要、报价和 intent 后，携 payload 重发原业务请求一次。发送失败或不能排除已发送时 unknown。
6. Gateway/Facilitator：Gateway 绑定业务请求及签名承诺；facilitator 校验并保存提交意图，提交原字节。相同 ID 只有一个提交者。Gateway 只有取得核实结算才执行服务，并在执行前持久化业务开始意图。
7. Capture/Verify：CLI 先保存服务观察与有效结果，再核对原交易；款项与服务分别确认。
8. Deliver：仅 settled+succeeded+有效输出为本次付费调用成功；不存在自动退款或新付款来补偿服务失败。

业务 HTTP 单次 30 秒；facilitator HTTP 单次 12 秒。两者不自动重发。facilitator 单次网络提交至多 10 秒，超时记 unknown，后续只查；不能在返回未知后后台重新提交。Mirror 查询每次 10 秒、最多 3 次、间隔 2 秒，每次恢复也以此为界。普通 SDK 自动重试、ID 再生和换节点重建交易禁用。

facilitator verify 不预留额度；链上执行会处理其他交易消耗余额、额度或撤销的竞态。CLI 仍限制同一 journal 一笔活跃付款，但不承诺跨机器共享额度的本地串行化。

## AWORK-004 — 撤销、设置额度与手续费补充

Status: Draft
Review level: L3
Source: ALLOW-003；ALLOW-006

撤销使用同一 MetaMask owner、资产和 spender 将额度设置为 0；用户可直接从钱包撤销，不依赖 CLI 存活。UI 本地暂停与链上撤销是两个状态。0 生效后只能阻止后续链上执行，不能追回已结算付款；与付款竞态由共识顺序裁决。

非零改非零：V1 不提供含糊的 increase(delta)。界面要求明确“新的可用额度”，先暂停本地新付款并核查已有 unknown，再由用户批准归零，核实归零后显示新的绝对额度，用户另行签署。归零失败/未知不继续非零批准；新的 approval 未确认前不恢复付款。此流程减少旧额度同时被花费的风险，但不能撤回归零之前已花资金，不能承诺跨客户端绝对消除竞态。怀疑 spender key 泄露时先撤销，不向同一泄露身份重新加额。

spender 手续费不足时阻止新付款并提示补充；本轮不自动充值。补充从 MetaMask 到 spender 的自有 HBAR，只影响手续费钱包余额，不增加 owner allowance。批准和补充手续费都必须由用户明确签名；钱包原始账户余额不随“设置额度”转入 spender。

授权会话失效、CLI 重启或用户断开 MetaMask 都不会自行撤销链上 allowance。status 只读查询实际额度，不能只使用本地授权文件。

## AWORK-005 — 失败、去重和恢复

Status: Draft
Review level: L3
Source: ALLOW-005；ALLOW-006；HPAY-004

沿用 HPAY-004 的发送前关闭、dispatch 之后核查原交易、settled 读取缓存规则。恢复不得要求 owner/spender 再签名。allowance 不足、耗尽或撤销是本次准入/执行条件，不能覆盖已有付款证据。

| 事件 | 状态与动作 |
| --- | --- |
| 明确未发送前发现余额/额度不足、报价不兼容 | not_paid；报告原因；不自动开户、补额或换支付路径 |
| dispatch-intent 已落盘但无结算证据 | unknown/query_original；保留原 ID；不重发、不重新签名 |
| 链上 SUCCESS 且精确资产/费用核验通过 | settled；独立保留 serviceStatus |
| 查到失败主记录或额度已减少，但不足以排除原支付成功 | 保守 unknown；人工核查，不以余额差替代证据 |
| Gateway 已结算但服务结果丢失 | settled+unknown/failed；不再付一次；从业务持久缓存恢复，有副作用可能时不自动重跑 |
| 同 transactionId 不同字节摘要 | 冲突，拒绝；不提交任一替代字节 |
| 已知交易重复请求 | 只读原记录/原链上结果；不得重复执行服务 |
| 授权交易未知 | pending/unknown；只核对原 approval，不自动签新额度 |

payer 在证据中继续表示资金 owner，新增 spender 与 feePayer；签名者不再假定等于资金 owner。所有恢复使用该交易持久化的 profile，不能按当前默认 direct 设置解析 allowance 历史。

## AWORK-006 — Success signal、Checkpoint 与验收

Status: Draft
Review level: L3
Source: ALLOW-007

单次付款成功信号：原 journal 和链上原交易一致、owner→Merchant 金额/资产正确、spender 手续费正确、serviceStatus=succeeded 且有效结果可返回。与授权成功分开验证。已结算但结果缺失不算调用完成，仍保留 settled。

只在首次钱包授权、明确改额/撤销/补手续费及无法自动恢复时打扰用户。正常额度内付款、查看额度及查询 unknown 不打开浏览器。Brief 必须包含操作/请求 ID、已核实付款和服务状态、原因、风险、下一项待决动作及完整证据位置；不展示私钥、payload 或原始服务日志。授权页同时展示完整 owner/spender 地址与网络，避免用户仅按昵称批准。

Spec 验收覆盖 ALLOW-007 的正反例，并分别取得 MetaMask→原生 allowance、单次 x402 allowance 支付、重复请求、超时恢复、撤销/改额五组证据；本地测试通过不能替代链上记录。不为验收预设真实金额，执行前使用操作者明确批准的测试配置。
