---
title: Hedera local spender key storage design
mdq:
  profile: project-governance/governed-document-v1
---
# Hedera Agent 私钥本地存储

## LKEY-001 — 决定与范围

Status: Draft
Review level: L3
Source: 2026-09-08 用户确认使用本地明文文件、目录 0700、文件 0600 的简化方案

本地钱包模块读取专用 spender 私钥并签名；Agent 通过付款接口使用钱包。私钥以明文文件保存，不引入 Keychain、加密 keystore、密码解锁或远程签名服务。同一系统用户下的程序和 Agent 仍可能读取私钥，本方案不承诺隔离它们或抵抗主机失陷。

适用于现有 Hedera Testnet allowance MVP 的单个预建 ECDSA spender；账户和密钥仍由操作者在付款流程外准备。不新增开户、密钥生成/导入命令、备份同步、轮换或其他链支持。现有 direct 入口的 env signer 不在本次变更范围。

本轮维护顺序：核对现有规格与计划 → 写明存储契约 → 同步 ALLOW/AWORK 引用并标注旧计划 → 检查 ID、状态、链接与一致性 → 用户审阅。此文是密钥存储契约的单一来源；付款流程只在 [allowance workflow](../../../workflows/hedera-allowance-payment.md) 维护。当前仅形成设计，尚未实现文件 signer。

## LKEY-002 — 文件与读取契约

Status: Draft
Review level: L3
Source: LKEY-001；[ALLOW-003/006](../../payment/x402-allowance-v1.md)

- 建议位置为用户主目录下 `.frely/keys/hedera-testnet-spender.key`，位于仓库和同步目录之外。实际路径由操作者提供，不从报价、网页或模型参数接收。
- 文件仅含专用 ECDSA secp256k1 私钥的 64 个十六进制字符（32 字节，大小写均可），可带一个末尾 LF 换行，不含 `0x`、JSON、账户信息或其他内容；内容还须通过 SDK 私钥有效性校验。禁止使用 owner 主钱包私钥。
- 私钥所在目录权限为 0700，文件为 0600，均属于当前执行用户。第一版支持能验证这些 POSIX 权限的本地环境；无法验证时拒绝加载。
- allowance 配置的 `spenderSignerRef` 格式为 `file:<绝对路径>`；账户 ID、EVM alias 等公开绑定保留在现有独立字段。不在配置或环境变量内存放私钥正文。
- 钱包模块的读取接口为 `readSpenderKey(ref): Promise<PrivateKey>`。只接受本地普通文件，拒绝符号链接；核对目录和打开文件的所有者、权限及格式。读取上限 1 KiB，读取失败不自动重试、不自动修权限、不尝试其他密钥来源。
- 新授权和新付款前，派生公钥并按 ALLOW-003 核对预建 spender 绑定。签名由本地钱包模块在进程内完成，Agent 工具只返回公开结果或固定错误码。
- 私钥不写入日志、错误详情、网页、数据库、工具结果或对话。不添加跨请求私钥缓存；本版不承诺 JavaScript 运行时能立即擦除所有内存副本。

## LKEY-003 — 失败与停用边界

Status: Draft
Review level: L3
Source: LKEY-002；AWORK-004/005

文件缺失、不可读、超出大小限制、权限不符或格式错误返回 `SIGNER_UNAVAILABLE`；合法私钥与配置/已查明的链上 spender 不一致返回 `SIGNER_MISMATCH`。均停止新授权和新付款，修复后由操作者重新发起操作；不自动生成替代密钥或账户。链上绑定查询超时按既有只读查询失败规则处理，不能误报为密钥不匹配。已存在付款记录的去重、unknown 和恢复规则继续按 AWORK-005 执行，不因密钥错误重新付款。

status、付款恢复和主钱包发起的 revoke 不依赖 spender 私钥文件。revoke 使用已保存的公开账户绑定，经 MetaMask 签名，并独立核验链上结果；私钥丢失不得阻止撤销入口。

停用时先暂停新付款，通过主钱包撤销 allowance 并核实为 0，再由操作者处理 spender 剩余自有 HBAR、备份需求和本地文件删除。删除文件不撤销链上额度，也不证明备份或已泄露副本失效；本版不自动删除密钥、转走余额或轮换身份。

## LKEY-004 — 实施验收

Status: Draft
Review level: L3
Source: LKEY-001 至 LKEY-003

使用临时生成的测试密钥和临时目录，验证以下结果，不读取真实私钥：

1. 合法文件可加载并产生能由匹配公钥验证的签名；配置及工具输出无私钥正文。
2. 文件缺失、宽松权限、符号链接、错误格式和错误绑定均在签名前拒绝，不回退 env/Keychain、不产生资金操作。
3. 错误路径的 stdout/stderr、错误对象和记录无测试私钥；公开配置快照不包含 `spenderSignerRef`。
4. 移除测试密钥后，status/recover/revoke 仍可进入各自流程；恢复不签名、不补付，撤销仍由 owner 钱包确认。链上成功与本地测试分别报告。

设计验收只覆盖密钥存储与调用边界。真实 allowance、结算、业务输出与重复请求验收继续由 ALLOW-007 定义；本文件不构成任何真实账户或资金操作授权。
