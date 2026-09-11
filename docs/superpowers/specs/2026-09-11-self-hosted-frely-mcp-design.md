---
title: Frely 自托管 MCP MVP 设计
mdq:
  profile: project-governance/governed-document-v1
---
# Frely 自托管 MCP MVP 设计

## FMCP-001 — 目标

Status: Draft
Review level: L3
Source: 2026-09-11 用户确认的 MVP 决策

发布一个可安装、自托管的本地 MCP 包 `frely-mcp`。它向 Host Agent 暴露
`find_capability` 和 `use_capability`，使用本地 Agent Wallet 完成 Hedera
x402 付款，并直接调用服务端选出的 Relay 能力入口。

本设计只覆盖比赛 MVP，不覆盖生产托管、多租户或通用能力市场。

## FMCP-002 — 当前基线

Status: Baseline
Review level: L3
Source: 本地 `B1wl7ch@5ec26e3`、`origin/main@30971ae` 与付款功能分支

设计分支以本地 `B1wl7ch@5ec26e3` 为基线。该分支已包含：

- 本地 stdio Broker MCP；
- Agent Wallet；
- file-backed signer；
- 钱包初始化与付款身份交接。

远端 `main` 与本地分支已经分叉。远端增加了 HTTP `/mcp` 和 A2A payment
admission；本地分支保留更完整的钱包与本地签名实现。远端不是本地开发线的
上位版本。

`feat/hedera-auto-payment@4ff5a5e` 包含官方 x402 Resource Server spike、付款
journal、请求指纹、恢复和报价绑定修复。实现时只移植已审查的相关代码，不把
旧分支整体覆盖到新基线。

## FMCP-003 — 两端边界

Status: Baseline
Review level: L3
Source: 用户确认的服务端与 MCP 端职责

| 能力 | 服务端 | 本地 MCP |
| --- | --- | --- |
| 查询 The Graph | 是 | 否 |
| 筛选 Provider | 是 | 否 |
| 验证 ENS / ERC-8004 | 是 | 否 |
| 返回已验证的 Relay 能力入口 | 是 | 校验响应 |
| 管理 Agent Wallet | 否 | 是 |
| 检查本地付款授权与预算 | 否 | 是 |
| 签署 x402 payment payload | 否 | 是 |
| 保存 payer journal 和恢复状态 | 否 | 是 |
| 返回 402、调用 Blocky verify/settle | Relay 服务端 | 处理报价和结果 |
| settled 后执行业务 | Relay / Swarm | 否 |

Frely Network 只接收 capability 查询，不接收 `task`、`input`、钱包引用或
付款签名。本地 MCP 获得已验证入口后，直接调用 Relay。它不通过 Frely Network
代理业务请求。

MCP 协议中的 “MCP Server” 是用户电脑上的本地进程；在 Frely 业务链路中，它
是 Network 和 Relay 的客户端。

## FMCP-004 — 最小调用时序

Status: Planned
Review level: L3
Source: 已确认的直连调用边界

```text
Host Agent
  -> 本地 frely-mcp: use_capability
  -> Frely Network: resolve(capabilities)
     -> The Graph: 查询候选
     -> ENS / ERC-8004: 验证身份与入口
  <- 已验证的 Relay endpoint
  -> Relay: 相同 requestId 的业务请求
  <- HTTP 402 + PAYMENT-REQUIRED
  -> 本地 MCP: 校验报价、预算与付款 profile
  -> Agent Wallet: 本地签名
  -> Relay: 原请求 + PAYMENT-SIGNATURE
     -> Blocky: verify -> settle
     -> Relay -> Swarm -> Frely base model -> Provider
  <- 业务结果 + PAYMENT-RESPONSE
  -> Mirror: 必要时核验原交易
  <- Host Agent: 业务结果 + 付款证据
```

Relay 必须在 settled 后才调度业务。业务失败不能把 settled 改回未付款。

## FMCP-005 — 冻结接口

Status: Planned
Review level: L3
Source: 两条并行开发路径的共享契约

并行开发前先冻结一个普通 HTTPS 接口。它不是远程 MCP 接口。

```http
POST /v1/capabilities/resolve
Authorization: Bearer <FRELY_API_KEY>
Content-Type: application/json
```

请求：

```json
{
  "schemaVersion": 1,
  "capabilities": ["vision"],
  "paymentNetwork": "hedera:testnet"
}
```

成功响应：

```json
{
  "schemaVersion": 1,
  "requestedCapabilities": ["vision"],
  "provider": {
    "id": "provider-1",
    "ensName": "vision.example.eth",
    "endpoint": "https://relay.example.com/v1/responses",
    "protocol": "responses"
  },
  "identity": {
    "verified": true,
    "chainId": 11155111,
    "registry": "0x1111111111111111111111111111111111111111"
  },
  "payment": {
    "supportsX402": true,
    "network": "hedera:testnet"
  }
}
```

服务端只返回一个已验证 Provider。MCP 必须校验 capabilities、chain、registry、
protocol 和 endpoint。endpoint 必须是无内嵌凭据的公网 HTTPS 地址；禁止重定向、
localhost、link-local 和私网目标。Host Agent 不能传入或覆盖 endpoint。

响应中的 payment 字段只是能力提示。真正的 asset、amount、payTo、fee payer、
timeout 和 resource 以 Relay 返回的标准 402 为准。

## FMCP-006 — MCP 工具

Status: Planned
Review level: L3
Source: 现有两工具接口与用户确认

### `find_capability`

输入非空 capabilities。MCP 调用 resolve 接口并返回服务端已验证的能力入口，不
调用 Relay，不读取钱包。

- `readOnlyHint: true`
- `destructiveHint: false`
- `idempotentHint: true`
- `openWorldHint: true`

### `use_capability`

MVP 只支持当前 Vision 输入：

```json
{
  "capabilities": ["vision"],
  "task": "Describe the image",
  "input": { "image_url": "https://images.example/demo.png" },
  "payment": {
    "requestId": "req-123",
    "budget": {
      "network": "hedera:testnet",
      "asset": "0.0.0",
      "maxAmountAtomic": "1000000"
    }
  }
}
```

每个新请求都重新 resolve，不复用 `find_capability` 的结果。相同 requestId 只有
在请求指纹和付款策略完全相同时才能复用。返回值包含 Provider 摘要、
`identityVerificationSource: "frely-network"`、付款结果和业务输出，不包含私钥、
原始签名、API Key 或本地路径。

- `readOnlyHint: false`
- `destructiveHint: true`
- `idempotentHint: true`，仅指完全相同的调用
- `openWorldHint: true`

## FMCP-007 — Agent Wallet 与付款授权

Status: Baseline
Review level: L3
Source: 已确认的单 Provider MVP

Agent Wallet 独立于 Network 配置和付款 profile。
`frely-mcp wallet init` 只初始化或恢复钱包，确认账户和 key 后输出付款身份；它
不自动启用付款或修改业务配置。

MVP 只允许一个本地批准的付款 profile，固定：

- Provider ID；
- Relay resource URL；
- `hedera:testnet` 与 HBAR `0.0.0`；
- `payTo`；
- Blocky fee payer 集合；
- 单次最大金额；
- Facilitator、Mirror、wallet 和 journal 引用。

profile 初始为 `enabled: false`。用户检查后显式开启。Network 的发现结果不能
修改 profile 或获得钱包消费权。

签名前，MCP 必须依次确认：Provider 与 resource、402 全部字段、工具预算、profile
预算、requestId 指纹、钱包 Ready 状态和 Blocky 支持。任一项不匹配就停止，不读取
私钥，不切换其他 Provider。

## FMCP-008 — 发布包

Status: Planned
Review level: L3
Source: 已确认的发布方式

首版发布一个 npm 包 `frely-mcp`：

- Bun 1.4 或更高版本；
- macOS 和 Linux；
- 本地 stdio MCP；
- 打包产物不含 `workspace:*` 运行依赖；
- 不包含钱包、密钥、journal、真实配置或验收记录。

CLI 只有三个入口：

```text
frely-mcp wallet init
frely-mcp check --config <绝对路径>
frely-mcp start --config <绝对路径>
```

`check` 只读检查 Network API、API Key 引用、钱包 Ready 状态、付款 profile 和
journal 路径；它不签名、不付款、不调用 Relay。

`start` 通过官方 MCP TypeScript SDK 运行 stdio。stdout 只输出 MCP 消息，诊断
写入 stderr。

## FMCP-009 — 两条并行开发路径

Status: Planned
Review level: L3
Source: 用户要求服务端与 MCP 端同时推进

### 契约门

先完成一个小型集成基线：以本地 `B1wl7ch` 为起点，只引入远端必要的服务端
admission 变化和已审查的 x402 变化，然后提交 resolve v1 类型、错误结构和 fixture。
该步骤不把远端 `main` 整体覆盖到本地。

### 路径 A — 服务端

服务端路径负责：

1. 实现 `POST /v1/capabilities/resolve` 与 Frely API Key 验证；
2. 执行 Graph 查询、完整 capability 过滤、ENS/ERC-8004 验证和确定性选择；
3. 只返回冻结的 resolve v1 响应或安全错误码；
4. 确保 endpoint 指向 Relay，不指向 Swarm 或最终模型 Provider；
5. 移除服务端 payer 私钥和付款 client；
6. 不把远程 HTTP `/mcp` 作为本 MVP 的公开入口；
7. 在 Relay 使用官方 x402 Resource Server 和 Blocky verify/settle；
8. settled 后调度业务，并阻止相同请求重复执行业务。

路径 A 不读取 Agent Wallet，不接收 capability resolve 之外的业务正文。

### 路径 B — 本地 MCP

MCP 路径负责：

1. 用 `FrelyNetworkClient` 替换本地 Graph、ENS、ERC-8004 调用；
2. 通过官方 MCP SDK 暴露两个 stdio 工具；
3. 集成 Agent Wallet、file signer、本地付款 profile；
4. 集成 payer journal、请求指纹、Mirror 恢复与 x402 client；
5. 直连已验证 Relay，并禁止重定向；
6. 实现 `wallet init`、`check`、`start`；
7. 打包并测试最终 npm tarball。

路径 B 使用冻结 fixture 和 fake Network Server 开发，不等待路径 A 的内部实现。

两条路径使用独立 branch/worktree，只共享 resolve v1 契约和 fixture。各自测试通过后，
再用真实 Network resolve 接口和配置后的 Relay/Swarm 做联合验收。

## FMCP-010 — 失败与验收

Status: Planned
Review level: L3
Source: 已确认的付款安全边界

服务端负责 `NO_PROVIDER`、`NETWORK_DISCOVERY_FAILED`、
`IDENTITY_VERIFICATION_FAILED` 和 `CAPABILITY_NOT_SUPPORTED`。

MCP 负责 `CONFIG_INVALID`、`NETWORK_UNAVAILABLE`、`WALLET_NOT_READY`、
`PAYMENT_DISABLED`、`PROVIDER_NOT_AUTHORIZED`、`QUOTE_MISMATCH`、
`BUDGET_EXCEEDED`、`PAYMENT_UNKNOWN` 和 `PROVIDER_EXECUTION_FAILED`。

付款提交后状态不明时，只查询原交易，不重新签名或付款。settled 后业务失败时保留
settled，不切换 Provider。相同 requestId 但请求指纹变化时返回冲突。

MVP 完成需要：

- 路径 A 的 resolve、身份拒绝、x402 settle-before-dispatch 和服务端幂等测试通过；
- 路径 B 的 MCP 握手、两工具、授权门禁、journal、恢复和 tarball 安装测试通过；
- 打包后的 MCP 能连接真实 resolve 接口和 synthetic Resource Server；
- 所有输出不泄露凭据、私钥、签名、配置正文或本地路径。

新的 0.01 HBAR 实付必须在无成本验收通过后重新获得用户明确授权。历史交易不能证明
新包已跑通；安装、`check`、测试和发布流程不得自动触发付款。

MVP 不包含 Node.js 兼容、Windows、Docker、远程 MCP、多租户、多钱包、多 Provider
授权、自动充值、数据库、管理后台或主网。

本 Draft 不授权实现、合并、npm 发布或真实付款。用户确认书面规格后，下一步才编写
双路径实施计划。
