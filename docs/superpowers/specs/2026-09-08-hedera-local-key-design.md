---
title: Hedera local agent key storage design
mdq:
  profile: project-governance/governed-document-v1
---
# Hedera Agent 私钥本地存储

## LKEY-001 — 决定与范围

Status: Draft
Review level: L3
Source: 2026-09-08 用户确认的独立本地 Agent 私钥管理范围

本地钱包模块读取 Agent 专用私钥并签名；Agent 通过现有付款接口使用钱包。私钥以明文文件保存，目录 0700、文件 0600，不引入 Keychain、加密 keystore、密码解锁或远程签名服务。同一系统用户下的程序和 Agent 仍可能读取私钥，本方案不承诺隔离它们或抵抗主机失陷。

本版为现有 Hedera Testnet 签名路径增加本地文件来源，文件类型仅支持 ECDSA secp256k1。预建 Agent 账户由现有 payerAccountId 标识；开户、密钥生成/导入命令、充值、备份同步、轮换和浏览器钱包交互不在本版范围。旧 env 配置保持原行为；选择 file 后不得自动回退 env。

本文件独立定义密钥存储和签名接入契约；付款接口沿用已有实现，不新增资金管理流程。当前是设计，尚未实现文件 signer。

## LKEY-002 — 文件与读取契约

Status: Draft
Review level: L3
Source: LKEY-001；现有 packages/payment/hedera-x402/config.ts、signer.ts、live.ts

- 建议位置为用户主目录下 `.frely/keys/hedera-testnet-agent.key`，位于仓库和同步目录之外。操作者预先准备文件，实际路径来自可信本地配置，不从报价、网页或模型参数接收。
- 文件仅含专用 ECDSA 私钥的 64 个十六进制字符（32 字节，大小写均可），可带一个末尾 LF 换行，不含 `0x`、JSON 或其他内容；还须通过 SDK 私钥有效性校验。不得复用用户主钱包私钥。
- 直接父目录为 0700，文件为 0600，均属于当前执行用户；仅支持可验证这些 POSIX 权限的本地环境。文件必须是普通文件，路径不得经符号链接解析；不自动修改权限。
- 复用现有配置字段：`signerRef="file:<绝对路径>"`、`keyType="ecdsa"`、`payerAccountId`。文件引用是本项目字面路径格式，不是 URL，不作百分号解码或 shell 展开。不新增另一套账户配置。
- `readAgentKey(ref: string): Promise<PrivateKey>` 负责有界读取、权限和格式检查；读取上限 1 KiB，失败不自动重试、不生成替代 key。校验已打开文件的所有者和权限，结束时关闭句柄。
- 配置加载和只读预检只检查引用语法，不读取 key。通过现有预算及交易策略检查、确需签名时才加载文件，并通过可信 Mirror 核对 payerAccountId 的未删除账户及单 ECDSA 公钥与本地 key 一致；不支持 hollow、key list 或 threshold key。
- 私钥仅用于当前请求的进程内签名；不跨请求缓存，不写入日志、错误详情、网页、数据库、工具结果或对话。继续从 journal/recovery 快照排除 signerRef；不承诺 JavaScript 运行时能立即擦除所有内存副本。

## LKEY-003 — 失败与停止使用

Status: Draft
Review level: L3
Source: LKEY-002；现有 read-only.ts、session.ts、recovery.ts

文件缺失、不可读、超限、权限不符或格式错误返回 `SIGNER_UNAVAILABLE`；已取得有效账户信息但账户公钥或类型不匹配返回 `SIGNER_MISMATCH`；绑定查询失败或响应结构不完整返回 `NETWORK_CHECK_FAILED`，不能把超时报为 key 不匹配。各错误均停止本次新签名，且不附原始错误、文件内容或秘密。

本地读取不自动重试。链上只读查询复用 readTwice：最多两次，每次最多 10 秒，间隔 1 秒；仍失败则停止本次操作。只有操作者修正问题后才发起新的明确请求，已有 requestId 仍按原记录去重，不因加载失败自动生成新付款。

付款恢复只依赖已有 journal 与只读网络配置，不要求当前 key 文件存在。保持既有发送前关闭、发送后 unknown 查询原交易、不重新签名或补付的行为。

停止使用时，停止当前付款进程并将已有配置设为 enabled=false，阻止后续重新加载该配置后发起新付款；本版不增加配置热更新，修改磁盘配置不能自动停用已持有旧配置的进程。删除文件只能阻止之后从该路径加载，不能取消已签名或在途交易，也不能使已复制的 key 失效。私钥泄露意味着对应 Agent 账户资产可能受损；本版不实现自动转移余额、链上换 key 或文件删除。

## LKEY-004 — 验收

Status: Draft
Review level: L3
Source: LKEY-001 至 LKEY-003

使用临时生成的测试 key、临时目录和模拟只读网络响应，验证：

1. 合法文件加载后，现有签名器产生可由匹配公钥验证的真实 SDK 交易签名；文件 key 不进入公开结果或 journal。
2. 缺失、权限错误、符号链接、超限、非法格式、无效私钥、错误账户公钥和不支持的 key 类型均在生成付款签名前拒绝。
3. 文件读取失败后不继续请求账户绑定或签名；查询失败保留固定错误类型；file 失败不回退 env；配置加载、预检和错误报价拒绝均不读取 key。
4. 每次需要新签名时重新读取文件；文件移除后新签名失败，但已有 journal 的恢复仍可执行，并且不重新签名或补付。
5. 既有 env signer、预算约束、重复请求、unknown 恢复及结算核验回归通过。

本文件是待审阅的设计规格，上述验收尚未执行。离线签名和回归通过不证明真实付款或服务交付；真实支付验收须另有明确运行配置与直接证据。
