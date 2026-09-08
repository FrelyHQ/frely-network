---
title: Agent wallet initialization workflow
mdq:
  profile: project-governance/governed-document-v1
---
# Agent Wallet 初始化 Workflow

## WINIT-001 — 范围、Trigger 与输入

Status: Draft
Review level: L3
Source: 2026-09-08 用户要求本地生成、引导充值、链上账户就绪、与 Broker 隔离，并允许在明确手续费上限内自动激活；loop-me

本文件是 `agent-wallet-init` 的唯一流程定义。Loop 是为新设备或新的 Agent 身份准备专用钱包；同一钱包的重复运行是恢复，不是新建。Trigger 为用户执行 `agent wallet init`，不建立定时任务，不由 Broker 或业务请求触发。

第一版仅支持 Hedera Testnet、ECDSA secp256k1、本地 POSIX 文件权限和 HBAR 初始化资金。CLI 与钱包模块独立运行，不依赖 Broker、Provider、x402 报价、付款授权 registry 或业务付款 journal。初始化不会开启业务支付、修改 Broker 配置、导入主钱包、关联指定 HTS token 或发送业务付款。

首次运行输入：显式 `--network hedera:testnet`、`--max-fee-hbar`、`--reserve-hbar`；后两项分别是一次激活交易的最高手续费和初始化后要求保留的 HBAR，必须为正数、最多 8 位小数，内部转为 tinybar 整数。不得由 Agent 静默填写或提高金额。交互模式缺少金额时在本地提示用户输入；非交互模式缺少金额则退出。本文不把手续费上限当作预计费用。

默认钱包目录为当前用户真实主目录下 `.frely/wallets/hedera-testnet/default`；允许显式 `--wallet-dir` 指定规范绝对路径。路径是本地操作者输入，不能由网页、报价或模型生成内容覆盖。网络端点使用版本内固定的官方 Testnet Mirror `https://testnet.mirrornode.hedera.com` 和 SDK `Client.forTestnet()`；第一版不接受自定义链或 RPC。恢复时读取已保存的网络、地址、金额和权限，不因命令缺省值变化而覆盖。

## WINIT-002 — 本地状态与幂等

Status: Draft
Review level: L3
Source: WINIT-001；../docs/superpowers/specs/2026-09-08-hedera-local-key-design.md

目录属于当前用户、权限 0700；`agent.key`、`wallet.json`、`init-state.json` 均为 0600。私钥采用已有文件 signer 接受的 64 hex 格式。密钥仅由 SDK 在本地生成，不打印、上传、进入错误详情或进度文件；同一系统用户仍可读取密钥。

`wallet.json` 保存 schemaVersion、network、keyType、publicKey、evmAddress、signerRef、accountId（初始 null）及最后核验时间。`init-state.json` 保存 workflowId、稳定 runId、阶段、金额授权、交易 ID、交易体摘要、提交意图时间和核验结果；不保存私钥或签名交易字节。钱包目录及网络共同确定运行身份。

首次生成必须取得独占执行权，再以排他创建写入私钥，落盘后回读并验证公钥；只有钱包元数据和状态持久化后才展示充值地址。新建路径拒绝符号链接，既有文件权限异常则停止，不自动修复。状态更新采用同目录临时文件、落盘和原子替换。并发运行返回 `INIT_IN_PROGRESS`，不得同时生成或激活。

独占执行使用钱包目录内单独的 `init-lock.sqlite`（0600），由 Bun SQLite 连接持有 `BEGIN IMMEDIATE` 事务，busy timeout 为 0；竞争者直接退出，正常结束回滚并关闭连接，进程退出由 SQLite/操作系统释放锁。该数据库只用于锁，不承担业务 journal，也不通过锁文件年龄或 PID 推断可抢占。所有 init 入口在读取或修改钱包状态前均须遵守此锁。重复运行必须核对已保存公钥、地址及本地私钥一致。发现残缺状态、旧密钥或冲突时停止并保留文件；不得覆盖密钥、重新生成地址或删除恢复证据。

## WINIT-003 — 阶段与交接

Status: Draft
Review level: L3
Source: WINIT-001；WINIT-002；WINIT-007

| 阶段 | 输入与动作 | 输出与交接条件 |
| --- | --- | --- |
| LocalReady | 校验参数、取得独占权、生成或读取同一钱包 | 私钥回读成功、公开身份和金额授权已落盘 |
| AwaitFunding | 输出充值 Brief；按 EVM 地址查询 Mirror 账户和 HBAR 余额 | 网络、地址、账户 ID 一致；未删除；余额至少为 maxFee + reserve |
| InspectAccount | 检查账户 key 与本地身份 | 单 ECDSA 公钥完全匹配则跳过激活；key=null 且 EVM 地址匹配则进入激活；其他类型或不匹配停止 |
| Activate | 保存固定交易 ID 与提交意图，然后由新账户付费、使用其私钥签名并提交一次激活交易 | 记录原交易；查询结果不能单凭 SDK execute 返回值认定成功 |
| Verify | 查询原交易记录和账户状态 | 激活记录成功且 payer 匹配；账户 key、地址匹配；当前余额至少 reserve |
| Ready | 持久保存账户 ID、证据及时间 | 返回 `ready`、exit 0、钱包描述文件位置 |

充值查询返回 404 只表示当前尚未观察到账户；网络错误不能当作未到账。仅观察用户向地址充值，不代替用户操作主钱包或水龙头。充值发送方自行承担其转账及自动开户成本，本次激活费用授权不包含发送方费用。

## WINIT-004 — 自动激活权限与交易

Status: Draft
Review level: L3
Source: 用户已允许到账后在明确上限内自动激活；WINIT-007

金额在首次运行明确后，到账无需再次确认。权限只覆盖当前钱包、Testnet、一次固定目的激活交易；不能借此授权其他付款、提款、授信或账户换 key。单笔 maxTransactionFee 必须等于保存的 maxFee；任何失败、超时、恢复或重新运行不得自动提高上限或产生第二笔新激活交易。

拟采用 `AccountUpdateTransaction` 更新该账户的 memo 为 `frely-agent-wallet`，目标账户和 transactionId 的 payer 都是新账户的数字 ID；不设置新 key、不更改 staking 或 token association、不包含资产转账。使用匹配 EVM 地址的本地 ECDSA 私钥签名。交易有效期固定 120 秒，提交总超时 30 秒，关闭 SDK 自动生成新 transactionId 的重试；代码必须解码核对交易类型、账户、memo、payer、费用上限和有效期后才允许提交。

这是基于官方“空账户作为 payer 并使用匹配 ECDSA 签名可补全”规则作出的设计选择；官方示例使用 TopicCreate，不直接证明本方案的 AccountUpdate 组合已验证。该组合需先完成最小 Testnet 兼容性验收，未通过不得改用向第三方转账或创建额外实体作静默回退。此项当前仍是会影响实现的未决验证，规格尚未完成。

## WINIT-005 — Success signal、失败与恢复

Status: Draft
Review level: L3
Source: WINIT-002 至 WINIT-004；loop-me

本次运行成功须同时满足：本地密钥与描述一致；可信 Mirror 返回未删除的数字账户 ID、匹配 EVM 地址与单 ECDSA 公钥；HBAR 余额至少 reserve；如本流程已有提交意图，必须核实原激活交易 SUCCESS、payer 和实际 transactionFee 不超过授权上限；证据与最终状态已落盘。若已有完整匹配账户且从未提交激活，则记录 `activation=not_needed`，不制造交易。成功表示该 HBAR 钱包账户在核验时可用，不包含服务调用或特定 token 可用性证明。

充值等待每 5 秒检查一次，单请求 10 秒超时，整个等待窗口最多 10 分钟；连续 3 次查询错误则提前暂停。只在首次显示、余额或阶段变化、失败及完成时输出信息，不逐次打印原始响应。交易及最终核验最多 6 轮、每轮间隔 5 秒、每次请求 10 秒；全部受 120 秒总时限约束。响应结构异常、重定向或地址不匹配停止，不继续签名。

| 保存状态或失败 | 恢复动作 | 对外结果 |
| --- | --- | --- |
| AwaitFunding / 查询超时 | 同一钱包重新查询；仍不足则继续有界等待 | `waiting_funds` 或 `paused`，exit 3 |
| 无提交意图 | 核对文件和账户，继续原阶段 | 不生成第二把 key |
| 存在提交意图，无确定结果 | 仅查询原 transactionId 和账户，不重新提交 | `activation_unknown`，exit 3 |
| 原交易明确失败或超费 | 保存错误与原证据，停止自动执行 | `blocked`，exit 2；新尝试需要新的明确授权，不在本版自动实现 |
| 原交易 SUCCESS，Mirror 尚未反映 key | 继续有界只读核验；超时保留已成功交易证据 | `paused`，exit 3，不再激活 |
| 账户正确但 reserve 不足 | 显示差额，等待补充 HBAR，之后仅重新核验 | 不再激活 |
| 密钥、状态、权限或身份冲突 | 保留原始文件并停止 | 固定错误码，exit 2；不附秘密或原始异常 |
| 已 Ready 再运行 | 只读重新核验账户、密钥和余额，更新时间 | 通过后 exit 0；查询失败不能声称当前 ready |

原交易长期查不到仍是 unknown，不能凭 404 或过期判为未执行。提交前先持久化意图会产生“可能未发送却需人工处理”的保守窗口，本版接受这个边界。进程中断释放独占权；恢复读取原状态，不依赖 Broker journal。

## WINIT-006 — Checkpoint Brief 与基础验收

Status: Draft
Review level: L3
Source: WINIT-001 至 WINIT-005；2026-09-08 用户只要求基础测试

用户真正需要操作的节点是充值。Brief 必须包含：已生成钱包及完整 wallet.json 路径；Hedera Testnet 与 0x 收款地址；当前余额、最低所需余额 maxFee+reserve、充值差额；maxFee 是上限而不是估价；生成及回读证据；到账后自动更新自身 memo 并核验账户；错误网络、密钥备份责任和发送方费用提示；待用户完成的动作及同一条恢复命令。不显示私钥，也不要求把私钥粘回聊天。

基础自动测试限定为：临时钱包生成后可按既有格式读取；重复初始化保留同一 key；到账→激活→核验的模拟正常路径；提交后中断只查原交易；固定错误不泄露私钥。另作一次最小 Testnet 激活兼容性验收，使用专用测试钱包及另行明确的实际金额配置；设计阶段不生成真实钱包或发起交易。不扩大为全仓库测试矩阵。

## WINIT-007 — 依据、未决事项与文档维护

Status: Draft
Review level: L3
Source: 2026-09-08 官方文档及本地 SDK 只读检查

- [生成 ECDSA 密钥](https://docs.hedera.com/native/keys/generate-key-pair)：本地 SDK 已具有 generateECDSAAsync。
- [自动开户与空账户补全](https://docs.hedera.com/learn/core-concepts/accounts/auto-account-creation)：充值到 EVM 地址自动开户；由新账户付费并签署交易完成补全。
- [账户更新](https://docs.hedera.com/native/accounts/update)：可更新 memo。
- [官方 SDK 空账户示例](https://github.com/hiero-ledger/hiero-sdk-js/blob/main/examples/account/transfer-using-evm-address.js)：展示新账户付费并签名完成补全，其具体交易为 TopicCreate。

仍需关闭的设计项：AccountUpdate 激活组合的最小兼容性证据。实际 maxFee、reserve 是每次首次运行的必填授权输入，并非要由实施者猜测的默认值。

文档维护范围仅为本文件和配套设计入口；既有付款、allowance、Broker 文档不随本次改写。维护顺序：核对用户范围与官方依据→写入单一流程定义和边界引用→检查 ID、生命周期、链接、未决项及权限→请求用户审阅。当前为 Draft，未实现、未运行，未完成 Workflow Definition of Done。
