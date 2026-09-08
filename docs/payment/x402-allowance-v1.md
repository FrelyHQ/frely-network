---
title: Hedera x402 allowance V1 architecture and interface specification
mdq:
  profile: project-governance/governed-document-v1
---
# Hedera x402 allowance V1 架构与接口规格

## ALLOW-001 — 范围与安全承诺

Status: Draft
Review level: L3
Source: 2026-09-08 用户确认的 V1 边界；[S1]；[S2]

新增浏览器 MetaMask 授权、本地 CLI spender 与原生 allowance 付款路径。用户本金始终保留在主钱包，spender 只持有手续费 HBAR。不引入 Frely 账户、充值型 Agent Wallet 或 Grant 合约。用户可向任意满足网络转账条件的 Merchant 付款；身份核验不构成付款授权。

链上约束是指定 owner、spender、资产的剩余 allowance。单笔预算、时间策略及资源信任检查在 CLI 内执行，不能宣称抵抗专用密钥泄露。泄露者可直接使用剩余 allowance，并消耗 spender 自有 HBAR；多个 owner/资产对同一 spender 的授权应合计评估。追加授权会重新扩大可支用范围。主钱包私钥不进入 CLI、服务器或日志。此处的额度不是锁定余额，也不是贷款额度。

V1 只支持 hedera:testnet，MetaMask chainId=296（0x128）。允许 HBAR 或操作者明确配置的一个 HTS fungible token；不按 USDC 等符号推断 token ID，不支持 NFT、自动换币、token 自定义收费、主网或自动充值。首次配置必须明确 asset、精度、网络端点、手续费上限、资源 origin 和 facilitator。缺配置即拒绝，不能从 402 或发现结果反向生成信任配置。

这是目标设计，未实现 allowance 路径。已有 direct 的真实结算证据不作为新路径验收证据。

## ALLOW-002 — 组件与协议边界

Status: Draft
Review level: L3
Source: [S1]；现有 packages/payment/hedera-x402

| 组件 | 责任 | 不得承担的权限 |
| --- | --- | --- |
| 本地 CLI 授权模块 | 管理专用 ECDSA key、spender 绑定、浏览器会话及链上授权核对 | 不获取 owner 私钥，不自动扩大 allowance |
| MetaMask 授权页 | 展示网络、owner、spender、资产、额度和手续费；请求用户签署 EVM 交易 | 不以连接成功或前端回调冒充授权成功 |
| payment adapter | 选择支付路径、检查本地预算、创建原生批准转账、持久化和核验 | 不用 direct 的 owner 签名代替 allowance，不自动降级 |
| Gateway | 声明报价路径，匹配 payload，调用对应 facilitator，结算后执行服务 | 不把 verify 成功当作已结算 |
| allowance facilitator | 校验原交易、spender 签名、owner allowance 与资产流向，提交原字节 | 不持有 spender/owner 私钥，不改交易、补签或替换 fee payer |
| Hedera | 执行 allowance、余额、签名和转账规则 | 不执行 CLI 单笔预算、业务 requestId 或服务交付规则 |

exact/direct 与 exact/allowance 是本项目路径名称，不是已注册的两个 x402 标准 scheme。线上均使用 scheme="exact"，allowance 必须显式携带 extra.frelyPayment={version:1,path:"allowance",feePayerRole:"spender"}。这是项目私有能力协商，只有双方明确实现时启用。不能修改现有 SDK 全局默认 handler 来接受新载荷。

direct 缺少 frelyPayment 标记时仍按现有行为处理，继续使用其 facilitator feePayer；未知 version/path、allowance 标记不完整或 direct/allowance 字段混用均拒绝。客户端运行配置 paymentPath 明确选择 direct 或 allowance，不做静默回退。两条路径都可报价，但按配置筛选后仍须恰好一个合格候选。

运行阶段、时间边界、恢复和人工节点只在 [allowance workflow](../../workflows/hedera-allowance-payment.md) 维护；共用的现有阶段规则引用 [direct workflow](../../workflows/hedera-auto-payment.md)，本文件仅维护接口和约束。

## ALLOW-003 — MetaMask 授权接口

Status: Draft
Review level: L3
Source: [S2]；[S3]；[S4]

CLI 对外操作为 allowance init、authorize、status、set、revoke、recover-auth。authorize/set 接收资产和“新的可用额度”amountAtomic，revoke 等价设置 0。输出 authOperationId、network、ownerAccountId、spenderAccountId、asset、authorizationStatus、transactionHash、observedAllowanceAtomic、observedAt、reason；密钥和已签名交易不输出。

amountAtomic 使用规范非负十进制整数字符串，V1 统一限制到有符号 64 位上界；零仅用于撤销/设置额度。不得用 JavaScript Number 处理资产金额。

authorizationStatus=not_authorized|pending|active|revoked|unknown。它与单次付款 paymentStatus 独立。额度为 0 时，明确成功的撤销操作为 revoked；仅查询到耗尽为 not_authorized。余额不足不能解释为授权不存在。

本地专用 key 使用 ECDSA secp256k1。macOS V1 存入系统 Keychain；CLI 只保存引用，不退回明文 env/file。已存在 key 不自动轮换。初次 init 导出公钥及 EVM alias，通过可信 Mirror 查询 spender 身份。若无账户，本地授权页可请求用户向该 alias 转入明确的少量手续费 HBAR；这是单独显示的转账，不是授权本金。链上确认后保存账户 ID/alias/public key 绑定。已有 hollow account 允许作为待激活 spender，签名核验规则见 ALLOW-005。其他系统 Keychain 后端不在 V1 范围。

owner 来自 MetaMask 选中地址，经可信 Mirror 查询映射为数字账户 ID；要求未删除的 ECDSA/EVM 账户。不能把任意 20-byte EVM 地址直接转换为 Hedera 数字账户 ID。spender 的合约参数地址使用已经核实映射的 EVM alias；后台同时保存数字 ID。任何账户或网络切换使当前待签内容失效，重新展示；不自动提交到新账户。

HBAR：使用 owner 账户的 HIP-906 代理接口 hbarApprove(spenderEvmAddress, amountTinybar)，value=0，检查返回结果和原生 allowance。金额为 tinybar（8 位精度），不能当作 eth_sendTransaction 的 18 位 value。HTS：调用已核实 token 的 EVM facade approve(spenderEvmAddress, amountAtomic)，value=0，核对原生 token allowance；普通 ERC20 合约不自动当作 HTS 支持。

页面使用 MetaMask provider 的账户请求、chainId 检查及 eth_sendTransaction。首次连接不是支付权限；也不保证一次弹窗完成连接、手续费准备和 allowance 授权。owner 支付这些 EVM 操作的 gas；界面先显示估算，MetaMask 最终确认。HTTP 页面只监听 127.0.0.1 随机端口，CLI 打开含一次性随机 nonce 的本地 URL，前端移除 fragment 后以同源 POST 交换会话。禁用远端 CORS，检查 Host/Origin、CSRF nonce，静态资源本地打包；会话 10 分钟过期。服务端只接受预先保存的 owner/spender/asset/amount 对应操作，不暴露通用 RPC 转发或任意签名接口。

浏览器回传的交易 hash 仅用于查证。CLI 独立核对 chain、from、to、value、input、成功 receipt 和原生 allowance；不信任网页报告的 success。receipt 成功但 allowance 尚不可观察时保持 pending/unknown，不启动自动付款。

## ALLOW-004 — 报价与 payment payload

Status: Draft
Review level: L3
Source: [S1]；项目私有 profile 设计

Gateway 的 PaymentRequired 保留 v2 resource 和 accepts，allowance 候选例：

```json
{
  "scheme": "exact",
  "network": "hedera:testnet",
  "asset": "0.0.0",
  "amount": "1000000",
  "payTo": "0.0.1234",
  "maxTimeoutSeconds": 120,
  "extra": {
    "frelyPayment": {"version": 1, "path": "allowance", "feePayerRole": "spender"}
  }
}
```

示例账户仅为文档占位。报价不要求预知 owner/spender，不包含 facilitator feePayer。facilitator /supported 的对应 kind 必须声明相同 frelyPayment 对象；仅出现 scheme=exact、network=hedera:testnet 不足以证明 allowance 支持。客户端以本地批准的 facilitator 地址读取 supported，不使用报价指定的新端点。Gateway 也必须配置相同 profile 的 facilitator。

PAYMENT-SIGNATURE 仍是 x402 v2 编码的 PaymentPayload，resource 与 accepted 逐字段匹配报价；payload 定义为：

```json
{
  "transaction": "BASE64_NATIVE_SIGNED_TRANSFER",
  "frelyAllowance": {
    "version": 1,
    "owner": "0.0.1111",
    "spender": "0.0.2222",
    "requestHash": "SHA256_OF_BOUND_REQUEST"
  }
}
```

requestHash 为 UTF-8 JSON.stringify([method, resourceUrl, bodySha256, requestId]) 的 SHA-256 小写十六进制，放入签名交易 memo="frely1:"+requestHash（71 字节）。Gateway 从收到的原业务请求独立计算，facilitator 检查 memo 与 payload 一致；这绑定本次请求而不把授信变成 x402 标准字段。

owner/spender 是方便定位的声明，必须由原始交易、签名和链上授权独立验证，不能只信字符串。交易类型限原生 TransferTransaction，transactionId.accountId=spender，由 spender 专用 key 签名。owner!=spender、owner!=payTo、spender!=payTo；任意其他可转账收款地址均可，不设 Merchant allowlist。

HBAR：owner 的 -amount 使用 addApprovedHbarTransfer，payTo 的 +amount 使用普通 credit；HTS 同理使用 addApprovedTokenTransfer。只允许一个 owner 批准 debit 和一个 Merchant credit；其他 token、转账项、NFT、staking reward、batch/schedule/contract 操作均拒绝。交易只指定一个本地批准 node，交易有效期为报价 timeout（<=120 秒），显式设置操作者批准的 maxTransactionFeeTinybar。SDK 自动续期、自动重新生成 ID 和 transaction regeneration 均禁用。

签名前重新解码核对全部交易内容及 approval 标志；保留原字节摘要。CLI 发给 Gateway 的是可直接提交的 spender 已签名交易，不等待 facilitator 补签。请求头/body/资源绑定与现有 session 相同。CLI 本地 requestId 进入指纹，不宣称其得到 Hedera allowance 的业务级保护。

## ALLOW-005 — Facilitator verify、settle 与证据

Status: Draft
Review level: L3
Source: [S2]；现有 SDK 2.25.0 direct 实现边界

verify 与 settle 使用现有 v2 请求外壳 {paymentPayload,paymentRequirements}，但按 frelyPayment 选择专用 handler。不得交给默认 direct handler，也不得向不支持该 profile 的公共 facilitator 发送载荷。

verify 按顺序检查：

1. v2/schema/profile、canonical Base64、header <=64 KiB；HTTP JSON <=1 MiB；报价和资源绑定。
2. 原生交易类型、owner/spender/fee payer/node/有效期/fee cap、唯一资产、approval 标志及精确 debit/credit；金额使用无损整数。
3. spender 签名满足其链上 key。V1 只接受单 ECDSA key；不支持任意 threshold/key list。hollow spender 仅在 Mirror 显示 key 缺失、EVM alias 与恢复出的 secp256k1 公钥地址一致且签名实际覆盖交易时允许；如 SDK 无法可靠取出和验证公钥，应失败关闭，不能跳过签名校验。
4. owner→spender 对该资产的链上剩余额度 >=amount；owner 余额足够，spender HBAR 足够支付签名 fee cap；HTS 元数据、关联、冻结、KYC 条件可用且无自定义费。不自动关联、充值、换资产或扩大权限。
5. Gateway 端可信报价仍适用。报价或 key 状态变化时拒绝；只读查询不确定返回可重试查询错误，不声称已经撤销或未付款。

verify 返回 isValid、payer=owner；isValid 不是额度预留，也不是付款证明。到 settle 前 allowance 可能被撤销、余额可能变化；链上共识执行为最终裁决。

settle 再验证，按 (network, transactionId) 和原始字节 SHA-256 去重。已有同 ID 异摘要冲突；原字节重复提交只查询/返回已有结果。先持久化 submission-intent，再提交同一交易；facilitator 不签名、不修改 node、fee、validStart 或任何字节。提交器自动重试关闭。超时/crash 后仅查询原交易，不能再生成或发送新交易。

facilitator journal 不存 payload，仅存 ID/摘要/owner/spender/asset/amount/payTo/提交阶段和证据。标准回执 transaction 指向原 ID，payer=owner；证据增加 spender 与 feePayer=spender。无法确认时回 success=false、errorReason=SETTLEMENT_UNVERIFIED；Gateway 返回 503，不执行业务。即使 failure 回执存在，CLI 仍按其已持久的 dispatch 阶段保守处理 unknown。

settled 需要可信 Mirror 原交易 SUCCESS、未 scheduled、主记录 nonce=0、精确资产流向及网络费核对。HBAR 业务 owner 扣 amount、Merchant 收 amount；spender 另付 charged_tx_fee，费用只分配给允许的网络账户。HTS 同样核对 token 流向与独立 HBAR fee 流。不要把 facilitator 当作本路径的 fee payer；不要复用 direct 中 owner 签名或 feePayers 固定集合的断言。支付 evidence.source 仍为 testnet。

Gateway 等待已核实结算后才执行业务。以交易 ID+resource/request body 指纹持久去重，同交易换业务请求拒绝。服务结果缓存复用既有 24 小时规则。业务开始意图之后崩溃且无结果时不自动重跑工作；付款和服务状态分开报告，不自动退款。

## ALLOW-006 — 配置与状态迁移

Status: Draft
Review level: L3
Source: ALLOW-002 至 ALLOW-005

direct policy 和 journal 历史记录行为保持兼容；缺 paymentPath 的旧记录解释为 direct。allowance policy 新增 paymentPath=allowance、ownerAccountId、spenderAccountId、spenderSignerRef、maxTransactionFeeTinybar、allowedNodeAccountIds、authorizationRecordRef；asset/network/precision/resource/origin/facilitator/Mirror/credential 仍显式配置。allowance 不要求固定 payTo allowlist，只核对本次可信资源报价与签名实际收款方一致。每个已准入请求持久化本次 payTo。

journal schema 版本迁移必须保留旧记录、tombstone、交易 ID 和缓存，不把 direct 记录改成 allowance。新指纹包含路径、owner、spender、资产、金额预算、本次报价 payTo 及原业务绑定；Quote 之前的 admitted 指纹与之后的报价快照分开保存，不能因缺 quote 重新准入同 ID。已发送请求恢复仅依赖持久策略/报价/原交易，不依赖当前 MetaMask 会话或 keychain 可用。

付款状态仍为 not_paid/unknown/settled；授权状态见 ALLOW-003。余额、allowance 消耗不能代替原交易证据；其他客户端消费或用户调额也会改变 allowance。CLI 不用本地“初始额度减已花”作为权威余额。

独立新的付款仍需要明确预算。本地每日额度、有效期和 Merchant allowlist 不在本轮新增功能内；既有单请求预算保留，但不承诺对恶意 CLI 强制有效。

## ALLOW-007 — 验收与未决边界

Status: Draft
Review level: L3
Source: ALLOW-001 至 ALLOW-006；[workflow](../../workflows/hedera-allowance-payment.md)

必要可观察验收：MetaMask 授权交易与原生 allowance 一致；CLI 无 owner key 可支付；精确 owner→Merchant 扣款及 spender 费用；耗尽/撤销拒绝；追加使用绝对额度；direct 回归不变；未知和重复请求不产生新交易；错误 spender、伪造 approval、金额/资产/收款替换、超高 fee cap、交易换字节均拒绝；hollow spender 首次签名与完成登记可核对；浏览器回调篡改/账户切换不能激活授权。

上线前必须独立验证 MetaMask 的 HIP-906 返回码/receipt/原生 allowance 一致性、HTS facade 的原生 allowance、hollow spender 原始签名解析及网络执行。这些是尚未验证的兼容性风险，不是已实现事实；失败时停止该路径，不替换为主钱包本地签名或充值本金方案。

文档阶段未选择正式部署 facilitator/Gateway 的地址、HTS token ID、用户授权额度或手续费金额；它们均是操作者必填部署/运行输入，不是隐式默认值。实际部署归属与验收环境须在实施计划中落实。本稿须用户审阅后才进入实施计划，不因本稿存在而授权创建账户、充值、授信或付款。

## ALLOW-008 — 依据

Status: Draft
Review level: L3
Source: 2026-09-08 只读核查

- [S1: x402 v2](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md)：客户端预算和会话位于协议范围外；本项目 allowance profile 是新增约定。
- [S2: Hedera 原生 allowance](https://docs.hedera.com/native/accounts/approve-allowance)：spender、owner、金额及原生交易 fee payer 约束。
- [S3: HIP-906](https://github.com/hiero-ledger/hiero-improvement-proposals/blob/main/HIP/hip-906.md)：HBAR 账户代理的 hbarApprove/hbarAllowance。
- [S4: Hedera 官方示例](https://github.com/hedera-dev/tutorial-js-hip-206-906-hbar-allowances-and-atomic-transfers)：HBAR/HTS EVM approve 与 approved cryptoTransfer。
- [S5: MetaMask 与 Hedera](https://hedera.com/blog/how-to-create-an-hbar-token-faucet-for-metamask/)：Hedera Testnet chainId=0x128。
- 当前锁定 @x402/hedera 2.25.0 的 client/facilitator 代码只证明 direct 路径；新 handler 须自行实现并验证，不宣称 Blocky 已支持。
