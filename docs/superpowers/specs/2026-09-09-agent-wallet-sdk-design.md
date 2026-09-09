---
title: SDK agent wallet initialization and Hedera x402 signer integration
mdq:
  profile: project-governance/governed-document-v1
---
# SDK Agent Wallet 初始化与 Hedera x402 signer 接入

## AWS-001 — 已确认决定

Status: Draft
Review level: L3
Source: 2026-09-09 用户最终确认；WINIT-001

正式方案：SDK 本地生成 ECDSA 密钥和 EVM 地址，用户转入 Testnet HBAR，Hedera 自动创建账户，SDK 使用新账户自付费完成激活并核验，最后输出可供现有 x402 signer 使用的账户与私钥引用。初始化独立于 Broker；Hiero CLI 仅做开发验证，不进入产品依赖。

不再执行之前讨论的 AccountCreateTransaction。充值已经触发自动开户，再显式创建同一地址会与现有账户冲突。本方案不需要用户把充值钱包的私钥交给 Agent。

唯一运行规格是 [agent-wallet-init Workflow](../../../workflows/agent-wallet-init.md)。本文件只定义代码边界、数据交接、修改范围及验证证据，不重复维护阶段、超时或恢复规则。

## AWS-002 — 已读取的本地代码与分支前提

Status: Draft
Review level: L3
Source: 2026-09-09 对 B1wl7ch/e208620 和 feat/hedera-local-key/7659c31 的只读检查

| 现有位置 | 当前行为 | 对本设计的约束 |
| --- | --- | --- |
| apps/broker-mcp/index.ts | 从 PAYMENT_CONFIG_PATH 加载已授权 Policy，再构造 createLivePorts 和 createPaidExecutor | 不在 Broker 启动时生成钱包或等待充值 |
| packages/payment/hedera-x402/approval.ts | FRELY_PAYMENT_REGISTRY 限定 configPaths、journalPaths；加载完整 Policy | wallet.json 不能直接当付款配置传入 |
| packages/payment/hedera-x402/config.ts、types.ts | 字段白名单、payerAccountId、signerRef、keyType、enabled 及业务资源参数 | 复用已有字段，不引入 walletRef 隐式加载链 |
| packages/payment/hedera-x402/signer.ts | 先检查策略，再加载 key；createClientHederaSigner + ExactHederaScheme 构造并核对真实签名交易 | 保留签名前策略和签后交易检查 |
| feat/hedera-local-key 的 key-file.ts | 限制目录/文件权限、路径、格式和读取上限 | 新初始化输出的 agent.key 必须直接兼容 |
| 同分支 file-signer.ts、live.ts | file 引用惰性读取、Mirror 单 ECDSA 公钥绑定，不回退 env | 激活先完成，付款 signer 不放宽对空账户的拒绝 |
| session.ts、journal.ts、recovery.ts | 已有付款去重、unknown、恢复及结算核验 | 新初始化记录不得混入业务 journal |

主工作区 B1wl7ch 当前没有文件 signer。其已实现代码位于独立分支 feat/hedera-local-key，提交 e7c0637、7659c31；此前报告的测试和审查属于该分支，本次未重复运行。后续实现必须从包含这两个提交的基线开始，或先明确集成它们，不可把文档中的 file 支持当作主分支已具备。

本地 @x402/hedera 2.25.0 锁定 @hiero-ledger/sdk 2.85.0；已检查该 SDK 具备 ECDSA 生成、地址派生及账户更新能力。钱包包直接声明相同精确 SDK 版本，避免无意升级 x402 依赖图。

## AWS-003 — 模块与依赖方向

Status: Draft
Review level: L3
Source: AWS-001；AWS-002

新增 packages/wallet/agent-wallet，依赖 @hiero-ledger/sdk 2.85.0、Bun 本地存储和 Node 文件 API；新增 apps/agent-cli，作为其薄命令入口。根 package.json 的 workspaces 纳入 packages/wallet/*；apps/* 和 tsconfig 已覆盖相应源文件。只为 SDK 直接依赖和 workspace 元数据更新 lockfile，不升级其他包。

钱包包按职责分为 local-wallet（生成、保存、回读与元数据）、chain（固定 Testnet 查询和限定激活交易）、init（运行状态与恢复）。CLI 负责输入、充值 Brief 与结构化输出，不将业务逻辑放在参数解析中。公开 initWallet 接口接收可信本地配置和可替换的网络端口；测试可注入响应，不创建真实付款。

依赖方向为 agent-cli → agent-wallet → SDK。钱包包不导入 Broker、MCP、业务 payment session 或付款 registry。现有 Broker → hedera-x402 → 本地文件 signer 路径继续成立，两者只通过磁盘钱包描述和明确的配置交接连接。

密钥生成使用 PrivateKey.generateECDSAAsync；保存 toStringRaw 格式并派生 publicKey 与 0x EVM 地址。签名对象只在需要时存在于进程内，私钥不进入终端输出、MCP 响应、日志或状态记录。沿用 0700/0600 明文文件规范，同一系统用户可读取；不声称与其他同用户进程隔离。开发 CLI 使用的加密 KMS 不是正式产品存储格式。

## AWS-004 — Broker 交接契约

Status: Draft
Review level: L3
Source: AWS-002；WINIT-005

只有 Workflow 达到 Ready 才输出 paymentIdentity，字段固定为 network=hedera:testnet、payerAccountId=经核验的数字账户 ID、keyType=ecdsa、signerRef=file:规范绝对路径；这些字段从已核验钱包派生，不允许用户输入另一个账户替换。输出同时附 verifiedAt 与 wallet.json 位置。未 Ready 时不输出可用付款身份。

paymentIdentity 是配置片段，不是 Policy，也不是业务付款授权。操作者将片段明确合入已有受信的付款配置；保留 asset、assetDecimals、payTo、feePayers、facilitatorUrl、resourceUrl、journalPath、mirrorNodeUrl、credentialRef 等现有业务字段。缺失这些字段则继续由既有验证拒绝，不填假地址或默认服务。

新付款配置首次交接保持 enabled=false。已有 FRELY_PAYMENT_REGISTRY 必须包含配置和 journal 路径，操作者另行明确启用付款；init 不修改 registry、不设置 enabled=true、不启动或热更新 Broker。本版交接为公开字段输出及文档步骤，不增加自动编辑命令。

真正签名时仍由 file-signer 重新读取 key 并核对链上账户，不能把先前的 Ready 当作永久有效凭证。Agent 是业务资金来源，对应 payerAccountId；x402 报价中的 feePayer 仍由既有策略匹配，不能替换为开户/激活时的角色或静默重写。

## AWS-005 — 最小修改范围

Status: Draft
Review level: L3
Source: AWS-002 至 AWS-004

| 文件/范围 | 修改内容 |
| --- | --- |
| packages/wallet/agent-wallet/* | 新增独立钱包、激活、初始化状态和配置片段输出；几个基础测试 |
| apps/agent-cli/* | 新增 agent wallet init，显式网络/金额输入、人类 Brief 和 JSON 输出 |
| 根 package.json、bun.lock | 注册钱包 workspace、精确 SDK 依赖、入口；不自动全局安装 |
| packages/payment/hedera-x402/file-signer.test.ts | 基础交接测试：初始化格式的文件与数字账户 ID 可被现有 signer 使用 |
| scripts/payment-spike/README.md、apps/broker-mcp/README.md（实现时按实际入口核对） | 描述已就绪钱包字段如何合入现有授权配置 |

不改写 signer.ts 的交易算法、Broker 业务调度、Graph/身份发现、付款去重、业务恢复或结算核验。若 file-signer 分支已集成，Broker 入口预计不需要源代码改动；不得为了“接入”添加无行为价值的新层。

## AWS-006 — CLI 快速验证的实际结果

Status: Draft
Review level: L3
Source: 2026-09-09 本机 npm CLI 及 Testnet Mirror 实测

实现状态：最小钱包模块、薄 CLI 与四项基础检查已完成。2026-09-09 正式 SDK/CLI 已完成真实 Testnet 充值、AccountUpdate 激活及同目录不重发验收，详见 [验收记录](../../verification/2026-09-09-agent-wallet-testnet-acceptance.md)。下述 Hiero CLI 探测是较早的独立开发记录，不与已激活的 SDK 钱包混淆；本规格保持 Draft 等待文档审阅。

使用 npm exec 调用已发布 @hiero-ledger/hiero-cli@1.2.0，没有全局安装。已执行 help、credentials list、credentials generate，并再次 list 证实存储存在。生成参数为 alias=frely-init-probe-20260909、key-type=ecdsa、key-manager=local_encrypted、network=testnet；密钥由 CLI 写入本地 KMS，未读取或导出私钥。

公开证据：keyRefId=kr_014973f3c811d298；publicKey=02902497c7e750448e6cb09810fcb57bfe0a6dacf1ca435fc256eec62353ce9f22。用本地 SDK 2.85.0 的 PublicKey.toEvmAddress 派生地址 0x9ac65750f18aebf9c14b164f0592aec32a977304。该地址的官方 Testnet Mirror 查询返回 HTTP 404，当前尚未观察到账户。

这证明 CLI 能本地生成并保存 ECDSA 密钥，以及 SDK 可从该公钥派生地址；不证明已开户、到账、激活、Broker 集成或真实 x402 付款。没有发送交易。

已发布 CLI 1.2.0 的实际 help 未暴露仓库 main README 描述的 max-transaction-fee 或 default_max_transaction_fee 选项；本次不据 main 文档假设已安装版本能可靠限制费用。不在明确金额和费用控制未就绪时请求用户充值或执行 CLI 收费操作。验证钱包保留，后续继续必须复用同一 alias，不能静默再生成。

## AWS-007 — 验证、未决项与文档维护

Status: Draft
Review level: L3
Source: WINIT-004 至 WINIT-007；AWS-006

验证仅包括基本密钥文件兼容、模拟到账激活正常路径、重复运行不换 key、提交未知不重发、交接到现有 signer 的离线签名，以及新增包类型检查。基础测试通过后，专用 Testnet 钱包的充值、激活交易和 Mirror 公钥核验分别记录，不能用原生开户或激活交易替代真实 x402 付费验收。

已验证：AccountUpdate memo 方式在 Testnet 新账户 `0.0.10431569` 的空账户激活、最终 Ready 及同目录复跑；充值和激活是两笔分别核验的交易，总费用含网络自动开户子记录。尚未验证的 Hiero CLI 1.2.0 费用控制只影响独立开发验证工具，不阻塞已采用的 SDK 路径。仍不得静默以转账第三方或创建额外实体作为激活回退。

实际 maxFee、reserve 仍是运行时必填用户授权，不由本次验收值设置默认额度。该次链上验收通过不等于真实 x402 服务付款、主网适用性或完整 Workflow Definition of Done 自动完成。

本轮文档维护范围：新建本设计入口，更新唯一 Workflow 的用户决定和账户发现交接，给 2026-09-08 设计加入当前入口链接。其余旧付款/allowance 文档和未提交改动不动。本次维护仅更新本规格和唯一 Workflow 的验收状态，并加入独立验收记录；保留 Draft 生命周期，核对链接和公开证据，不修改旧 allowance 或 Broker 配置。
