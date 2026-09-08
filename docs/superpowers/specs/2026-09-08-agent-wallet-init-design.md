---
title: Standalone agent wallet initialization design
mdq:
  profile: project-governance/governed-document-v1
---
# 独立 Agent Wallet 初始化设计

## AWINIT-001 — 边界与唯一流程定义

Status: Draft
Review level: L3
Source: 2026-09-08 用户确认链上就绪、独立于 Broker、生成后引导充值，并允许限额内自动激活

独立 CLI 提供 `agent wallet init`；钱包模块负责本地密钥、身份、初始化进度和链上激活。运行阶段、输入、金额授权、失败恢复、Success signal 和人工 Brief 只维护在 [agent-wallet-init Workflow](../../../workflows/agent-wallet-init.md)，不在本文件重复定义。

拟新增 `apps/agent-cli` 与 `packages/wallet/agent-wallet`，CLI 依赖钱包模块；钱包模块只依赖本地存储和固定版本 Hedera SDK，不导入 Broker 或业务付款包。根 workspace 纳入钱包包并声明 CLI 入口，不自动安装全局命令。Broker 不参与 init，也不被 init 启动。

产物是独立 wallet.json。已完成的本地文件 signer 可在之后明确配置时使用其中 signerRef、keyType 和 accountId；本次不自动把钱包绑定到 Broker、不启用付款。已有 signer 的单 ECDSA 账户公钥核验保持不变，不能为初始化而放宽对空账户的付款限制。

## AWINIT-002 — 状态与下一步

Status: Draft
Review level: L3
Source: AWINIT-001；WINIT-007

当前交付为可审阅的设计草稿。用户已授权自动激活的原则，实际运行仍须显式提供 maxFee 和 reserve。Workflow 中列出了激活交易兼容性这一未决技术验证项；关闭前不宣告规格完成，也不进入完整实施计划。仅基础测试和一个最小链上兼容性验收，不运行全面回归。
