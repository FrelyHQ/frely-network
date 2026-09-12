---
title: Main-based frely-mcp acceptance slice port design
mdq:
  profile: project-governance/governed-document-v1
---

# 基于最新 main 的 frely-mcp 验收切片移植规格

## FMAP-001 — 状态、目标与文档维护范围

Status: Draft
Review level: L3
Source: 用户要求从最新 main 新建整合分支，只移植 2026-09-12 下午 `integration/frely-mcp-mvp-acceptance` 的内容

本规格定义一次“能力移植”，不是 Git 历史合并：以 `origin/main@259c79f1e854382d43e64e4e0e3d963d4d955de7` 为目标基线，参考 `origin/integration/frely-mcp-mvp-acceptance@a854f545afabaa5ea56c5b3925ca231d8d7c5018` 的最终树，将本地 `frely-mcp → Network → x402 → Relay` 验收能力按当前 main 的架构重新实现。

本规格先定义 main-native 移植，后续以追加条款记录获准的验收阶段。2026-09-12 23:30 Asia/Shanghai，用户已允许在新分支上再执行一次真实付款，并要求同步更新计划与规格；本次授权的精确范围由 FMAP-015 固定。它不授权 merge、push、部署或第二次付款。仓库未提供可调用的 `project-governance` 工具，因此继续按仓库既有 `governed-document-v1` 结构维护并执行可用的静态校验。

## FMAP-002 — 已核验的源与目标基线

Status: Draft
Review level: L3
Source: 2026-09-12 Asia/Shanghai 本地 fetch 后的 Git 对象

| 项目 | 当前证据 | 设计含义 |
| --- | --- | --- |
| 目标 main | `259c79f`；未修改基线通过 typecheck、573 tests、build | 后续实现必须从此提交或执行时更新后的 main 开始 |
| 下午切片 | `f26f031` 14:28 至 `a854f54` 18:49，共 19 个提交 | “下午版本”有明确时间和提交边界 |
| 下午净变化 | 以 `f26f031^`（`4e72758`）到 `a854f54` 计算：72 files，+5758/-507 | 只用于建立能力清单，不作为可直接应用的补丁 |
| 缺失文件 | 下午净变化中的 65 个路径在当前 main 不存在 | 直接 cherry-pick 会同时引入大量新模块和旧接口假设 |
| 整合分支分叉 | 相对当前 main：main 独有 45 个提交，整合分支独有 54 个提交 | 整分支合并不是“小范围下午移植” |
| B1 关系 | `B1wl7ch` 是整合分支祖先；相对当前 main 为 45 behind / 12 ahead，净改 93 files | 合并整合分支会隐含带入 B1，不符合本次授权 |

执行计划开始时必须重新 fetch 并重算这些值。若 `origin/main` 前进，实施分支应 rebase 到新的 main 后再编码；若来源 tip 改变，仍以本规格固定的 `a854f54` 为审计来源，除非用户另行扩大范围。

## FMAP-003 — 为什么原三分支合并显示高风险

Status: Draft
Review level: L3
Source: FMAP-002；当前 main 与来源代码审阅

风险高不是因为下午实现完全不可用，而是因为三个维度同时耦合：

1. **历史范围失真。** `integration/frely-mcp-mvp-acceptance` 包含 B1 的祖先历史和下午前的改动；整分支合并会把 72 文件的下午切片扩展成 148 文件的分支差异。
2. **主线已独立演化。** main 已有生产 Broker、Graph/ENS/ERC-8004、公开 Network x402 资源、A2A 支付边界和新网站；旧分支基于更早的架构。
3. **支付顺序语义冲突。** 当前 main 的公开 `X402Gateway.handle()` 是“校验 → 业务调用 → 成功后结算”；下午验收是“校验 → 结算 → Relay 业务调用”。这不能靠解决文本冲突决定。
4. **相同路径承担不同责任。** 来源重写了 `packages/payment/hedera-x402`、shared types、Broker/MCP 入口；直接覆盖会回退 main 当前的支付与身份契约。
5. **验收配置被写死。** 下午网关把资源、金额、收款方、fee payer 与 facilitator 固定在源码中；它能锁定一次实验，但不适合作为 main 的可维护运行配置。
6. **历史证据不可继承。** 来源分支上的测试与一次真实支付，只证明该来源 SHA 当时的行为；它们不能证明重建后的新分支仍已付款、已交付或可重复。

因此 B1 的正确处理是：作为风险来源和行为参考审阅，不作为合并、cherry-pick 或文件恢复来源。若某个最终能力只存在于 B1 祖先中，必须先证明它仍被下午 tip 使用，再按 main 接口重写。

## FMAP-004 — 方案比较与决定

Status: Draft
Review level: L3
Source: FMAP-002、FMAP-003

| 方案 | 优点 | 主要风险 | 决定 |
| --- | --- | --- | --- |
| 合并 integration 或 B1 | 快速保留提交历史 | 带入无关历史；语义冲突由 Git 偶然决定；回退 main 模块 | 拒绝 |
| 逐提交 cherry-pick 下午 19 个提交 | 表面上限定时间范围 | 提交之间依赖旧基线和合并提交；仍覆盖共享文件；难以区分最终状态与中间修复 | 拒绝 |
| 将下午最终树整体复制到 main | 不受提交依赖影响 | 仍会恢复旧 package、shared types、硬编码和已完成声明 | 拒绝 |
| **main-native 功能重建，选择性参考最终叶子模块** | 保留 main 责任边界；每项能力可测试；来源可追溯 | 需要显式映射和更多验证 | **采用** |

“选择性参考”允许读取 `a854f54:<path>` 作为行为样本，但实现提交只能基于 main。禁止执行：

- `git merge origin/integration/frely-mcp-mvp-acceptance`
- `git cherry-pick` 来源提交
- `git checkout a854f54 -- .` 或恢复整个目录
- 用来源 `package.json`、`bun.lock`、shared types 或 `packages/payment/hedera-x402` 整体覆盖 main

## FMAP-005 — 移植清单与排除清单

Status: Draft
Review level: L3
Source: `a854f54` 最终树；当前 main 文件地图

| 来源最终能力 | main-native 落点 | 动作 |
| --- | --- | --- |
| `packages/protocol/capability-resolution` 的 schema v2 | 同名新 workspace package | 移植 schemaVersion 2、static allowlist、`identityVerified:false` 语义；移除源码中的具体账户和可变 URL 字面量 |
| `packages/wallet/agent-wallet` | 同名新 workspace package | 选择性移植本地钱包初始化/读取和权限校验；保持“有 key 不代表账户已激活或有余额” |
| payer journal/session/recovery | 新建 `packages/payment/x402-payer-session` | 按 main 的 `HederaPaymentSigner`/`HederaX402Client` 接口重建；不覆盖现有 payment 包 |
| `NetworkX402Gate` 的 upfront 行为 | `packages/gateway/x402/upfront.ts` | 新增隔离的 settle-before-business gate；现有 `X402Gateway.handle()` 保持不变 |
| `apps/capability-service` 静态 resolver/resource | 新建私有 `apps/static-network` | 只组合本地静态验收路由；不替换生产 `apps/broker-mcp` |
| `apps/frely-mcp` | 新建可打包 `apps/frely-mcp` | 移植 stdio MCP、config、Network client、两工具和包验收；适配 main 类型 |
| `scripts/static-provider-e2e` | 同名新 workspace script | 移植无费用全链路与 live gate；不继承旧付款授权或旧已完成状态 |

明确排除：B1 旧 Broker 改造、旧 allowance/payment 文档、旧 shared-types 的 `PaymentInput`/`PaymentOutcome` 整体恢复、Graph/ENS/ERC-8004 替换、生产公开资源语义变更、来源验证报告的 `Verified/Completed` 状态、账户 ID/私钥/API key、任何自动执行的真实付款。

## FMAP-006 — 目标架构与责任边界

Status: Draft
Review level: L3
Source: 用户认可的本地 Network / 远端 Relay 边界；FMAP-004

```text
Agent host
  └─ stdio ──> frely-mcp（本地；付款方策略、钱包引用、payer journal）
                  │
                  ├─ POST /v1/capabilities/resolve
                  └─ POST /v1/responses + x402 proof
                           │ 仅 127.0.0.1
                           v
                    static-network（本地 Network profile）
                      1. 认证与输入绑定
                      2. 无 proof 返回 402
                      3. 校验 proof、请求 ID、body hash
                      4. Hedera testnet 结算
                      5. 仅结算成功后调用远端 Relay
                           │ 普通 Bearer JSON；不转发支付头/钱包信息
                           v
                    https://api.frely.cloud/v1/responses
```

- `frely-mcp` 是本地 MCP/付款客户端，不承担 Provider 身份验证或远端服务托管。
- `static-network` 是 Network 的隔离验收 composition，不是新生产部署，也不是 Relay。
- Relay 是唯一远端业务入口；它接收结算后的普通业务请求，不接收 x402 proof、钱包密钥、Network API key 或 payer journal。
- static allowlist 只表示操作者明确允许此 Provider，必须返回 `identityVerified:false`；不得改写成 ERC-8004/ENS 已验证。
- 当前 main 的生产 `apps/broker-mcp`、Graph/ENS/ERC-8004 和公开 `/x402/frely/responses` 路径不变。将生产路径改成 upfront 是另一项架构决定，不包含在本规格。

## FMAP-007 — capability resolution v2 契约

Status: Draft
Review level: L3
Source: 下午最终 schema v2；FMAP-006

新 package 导出以下稳定类型和解析函数：

```ts
export type StaticResolveRequest = {
  schemaVersion: 2;
  capabilities: ["vision"];
  paymentNetwork: "hedera:testnet";
};

export type StaticResolveResult = {
  schemaVersion: 2;
  requestedCapabilities: ["vision"];
  provider: {
    id: string;
    endpoint: string;
    protocol: "responses";
  };
  execution: {
    endpoint: string;
    managedBy: "network";
  };
  resolution: {
    source: "static_allowlist";
    identityVerified: false;
  };
  payment: {
    supportsX402: true;
    network: "hedera:testnet";
    resource: string;
  };
};
```

解析器只验证协议形状与安全类别：Provider endpoint 必须是无 credentials/query/hash 的公网 HTTPS；execution/resource 必须是同一个 `http://127.0.0.1:<port>/v1/responses`；能力必须恰好为 `vision`。具体 Provider ID、远端 endpoint、端口和资源 URL 由 `static-network` 与 `frely-mcp` 各自从可信配置读取，并在使用前做完全相等校验，不能由远端 resolve 响应扩大允许列表。

`find_capability` 返回该结构；`use_capability` 只接受非空 task、单个 `vision` 能力和公网 HTTPS `image_url`。所有其他能力在付款前返回 `CAPABILITY_NOT_SUPPORTED`。

## FMAP-008 — static-network HTTP 与结算契约

Status: Draft
Review level: L3
Source: 下午 `apps/capability-service`、`NetworkX402Gate`；当前 main gateway

`apps/static-network` 只提供四个路由：

| 路由 | 行为 |
| --- | --- |
| `GET /healthz` | 进程存活；不宣称付款或 Relay 就绪 |
| `GET /readyz` | 配置、journal、facilitator adapter 与 Relay credential 均可构造后才 200 |
| `POST /v1/capabilities/resolve` | Bearer 认证；返回配置绑定的 static v2 结果 |
| `POST /v1/responses` | Bearer 认证；执行 upfront x402；结算成功后调用 Relay |

付费请求固定顺序：

1. 验证 method/path/content type、64 KiB 内 JSON、允许的 model/profile、`x-frely-request-id`。
2. 对无 proof 请求返回规范 x402 v2 `PAYMENT-REQUIRED`，不调用 Relay、不结算。
3. 对有 proof 请求绑定 method、规范资源 URL、request ID、body SHA-256、scheme、network、asset、amount、payTo、fee payer 与 timeout。
4. 先原子占用 proof/request fingerprint，再调用 verifier；验证失败不得结算或调用 Relay。
5. 调用 settler。只有得到可信 `success:true`、匹配网络和交易标识后，状态才是 settled。
6. 结算成功后，以普通 Bearer JSON 调用 Relay；删除 `PAYMENT-*`、`X-PAYMENT*`、Network auth 和 wallet 相关头。
7. 将 settlement header 附到业务响应；Relay 失败与已结算状态并存，不能自动补付。

新的 `UpfrontX402Gateway` 与现有 `X402Gateway` 并列导出。禁止通过修改现有 `handle()` 顺序复用，因为那会改变当前生产资源的可观察语义。

## FMAP-009 — payer session、journal 与重试规则

Status: Draft
Review level: L3
Source: 下午 payer journal/session/recovery；当前 main payment client

新 `@frely-network/x402-payer-session` 组合当前 main payment client、钱包 signer 与持久 journal。每个逻辑请求由调用方提供稳定 `requestId`，指纹至少包含 method、完整 Network resource URL、body hash、Provider ID、payer、network、asset、预算和配置 profile 摘要。

状态单调前进：

```text
new → challenged → signed → paid_dispatch_started
                           ├→ settled → service_succeeded
                           ├→ settled → service_failed
                           └→ unknown
```

- 同 request ID、同指纹、已有完整成功缓存：直接返回缓存，不重新解析报价、不签名、不访问 Network/Relay。
- 同 request ID、不同指纹：`REQUEST_ID_CONFLICT`。
- 同 ID 正在执行：`REQUEST_IN_PROGRESS`；不得并发付款。
- 在发送可结算载荷前必须持久化 quote 摘要、payload 摘要、原始交易标识（可取得时）和 `paid_dispatch_started` intent；持久化失败则禁止发送。
- 发送后超时、连接中断或 settlement 响应不可判定：`paymentStatus:unknown`、`retryAction:query_original`；普通调用不得重新签名或重发。
- recovery 只按 journal 的原交易线索做只读查询；不接收新 body、预算或 request ID，不构造 signer，不调用 Relay。
- 已核实 settled 但 Relay 结果未知/失败：保留支付证据，返回 `SERVICE_RESULT_UNKNOWN` 或 `SERVICE_FAILED_AFTER_PAYMENT`，不得补付。
- journal 不保存私钥、API key、完整 payment proof 或可再次广播的交易字节；目录 0700，文件 0600，错误和日志不得回显配置值。

为支持 journal 的发送前屏障且不改变生产客户端，payer-session 使用独立的窄端口；当前 `HederaX402Client` 保持不变：

```ts
export interface PayerSessionPorts {
  fetch(request: Request): Promise<Response>;
  sign(input: {
    requirement: PaymentRequirement;
    resourceUrl: string;
    bodySha256: string;
  }): Promise<{
    paymentHeader: string;
    payloadDigest: string;
    transactionId: string;
  }>;
  verifyOriginal(input: {
    transactionId: string;
    payloadDigest: string;
    requirement: PaymentRequirement;
  }): Promise<"settled" | "pending" | "failed">;
}
```

正式 signer 选择性适配下午最终版本对签名交易的反序列化检查，并把小写 `bodySha256` 写入 v2 extensions；它返回可持久化的 transaction ID 和摘要，但不返回给日志。任何 journal 写入或端口调用失败都必须按状态机停止。现有 payment package 的公共接口及 573-test 基线行为不变。

## FMAP-010 — 配置、钱包与秘密边界

Status: Draft
Review level: L3
Source: 下午配置与钱包实现的安全审阅

验收配置必须显式提供：Network loopback base URL、Network API key 引用、Provider ID、Relay HTTPS endpoint、Relay credential 引用、Hedera network、asset、amountAtomic、payTo、feePayer、facilitator URL、payer account、wallet file、journal 目录、最大请求字节和超时。所有可变值都从配置读取；代码内不保留下午来源的账户或金额常量。

- Network 只能绑定 `127.0.0.1`，不能绑定 `0.0.0.0`、局域网或公网地址。
- `frely-mcp` 只能连接配置中完全匹配的 loopback Network；禁止重定向和代理环境变量改变目标。
- Relay endpoint 必须是无 credentials/query/hash 的公网 HTTPS，path 精确为 `/v1/responses`。
- secret 配置只允许 `env:NAME` 或本地受限文件引用；解析后的值不写入日志、响应、journal 或打包产物。
- 钱包初始化只创建/读取本地 key material；它不证明 Hedera 账户已创建、激活、关联资产或有余额。
- real payment 默认关闭。金额没有默认值；每次 live 验收必须由用户针对目标分支的一次逻辑请求和最高金额明确授权，并在付款前把授权绑定到实际执行 SHA 与稳定 request ID。

来源分支曾使用的 1 HBAR 授权和交易证据只属于 `a854f54` 的历史验收，不能用于新分支。实现、离线 E2E、Relay canary 或钱包余额均不能替代新授权。本轮新授权见 FMAP-015；旧交易只能作为对照，不能作为本轮 G6 证据。

## FMAP-011 — 对外结果与错误映射

Status: Draft
Review level: L3
Source: FMAP-007 至 FMAP-010

MCP 对外结果保持业务、付款和身份来源分离：

```ts
export type StaticCapabilityUseResult = {
  requestId: string;
  provider: { id: string };
  resolution: { source: "static_allowlist"; identityVerified: false };
  payment: {
    status: "not_paid" | "unknown" | "settled";
    network: "hedera:testnet";
    transactionId?: string;
  };
  service: { status: "not_started" | "unknown" | "succeeded" | "failed" };
  retryAction: "none" | "query_original";
  output?: unknown;
};
```

| 错误码 | HTTP/MCP 分类 | 副作用要求 |
| --- | --- | --- |
| `INVALID_REQUEST`、`CAPABILITY_NOT_SUPPORTED` | 客户端输入错误 | 不解析/签名付款 |
| `UNAUTHORIZED`、`PROVIDER_NOT_AUTHORIZED` | 配置/授权错误 | 不付款、不调用 Relay |
| `STATIC_PROVIDER_NOT_CONFIGURED`、`JOURNAL_UNAVAILABLE` | 本地配置不可用 | 不付款 |
| `PAYMENT_REQUIRED`、`PAYMENT_REJECTED`、`PAYMENT_LIMIT_EXCEEDED` | x402/预算拒绝 | 未结算时不调用 Relay |
| `REQUEST_ID_CONFLICT`、`REQUEST_IN_PROGRESS` | 幂等冲突 | 不产生第二次付款 |
| `PAYMENT_PROCESSING_UNKNOWN` | 结算结果未知 | 只允许查询原交易 |
| `UPSTREAM_FAILED` | Relay 在结算后失败 | 保留 settled 证据，不补付 |
| `OUTPUT_UNAVAILABLE` | 已付款但无可返回缓存 | 不重新调用付费路径 |

错误消息只暴露稳定 code，不包含 URL query、authorization、payment proof、私钥、账户配置全文或上游响应正文。

## FMAP-012 — 验证层级与证据规则

Status: Draft
Review level: L3
Source: 用户要求降低合并风险；项目证据边界

| Gate | 必须观察到的结果 | 明确不证明 |
| --- | --- | --- |
| G0 来源审计 | 目标从最新 main；来源固定 `a854f54`；无 merge/cherry-pick；变更路径都在清单内 | 功能正确 |
| G1 单元/契约 | resolution schema、配置、journal、gateway、MCP 正反例通过 | 真实网络/真实付款 |
| G2 无费用全链路 | 真实进程：stdio MCP → loopback Network → synthetic x402 → fake Relay；无外部付款调用 | Hedera settlement 或远端 Relay 可用 |
| G3 Relay canary | 只读 health/model/minimal request 成功且不带 payment headers | 已结算或业务计费正确 |
| G4 包验收 | `bun pm pack` 后从 tarball 启动 stdio MCP；只含允许文件 | 用户环境全部兼容 |
| G5 安全与回归 | secret scan、loopback 限制、故障测试、main 全量 check 通过 | 生产就绪 |
| G6 live 付款 | 新授权后，目标 SHA 上结算、业务结果、重复与恢复分别有证据 | 未授权时不得运行 |

G1–G5 是移植实现的完成边界。G6 是独立验收动作，只有 FMAP-015 这类新授权才允许执行；没有 G6 时只能报告“实现与无费用验收通过”，不能报告“真实 x402 支付已验证”。G3 也不等于 G6。

必须保留三份独立证据：链上 settlement、Relay 业务结果、同 request ID 重复/恢复行为。任何一份不能由另一份推断。

## FMAP-013 — 非目标与后续决策边界

Status: Draft
Review level: L3
Source: FMAP-004、FMAP-006

本规格不做：

- 不把静态 allowlist 升级为 Graph/ENS/ERC-8004 身份验证。
- 不改变 production Broker 的 provider discovery、A2A 或公开 x402 路径。
- 不部署新的远端 Network/Relay，不改 DNS、云配置或生产密钥。
- 不支持 Hedera mainnet、多币种、动态汇率、自动充值或无限预算。
- 不保证跨主机/分布式 journal 幂等；本版为单机本地 MCP。
- 不自动重新发送已可能付款的请求，不用新 request ID 绕过 unknown。
- 不将旧来源的 commit、测试报告、钱包、余额或交易升级为新分支验收结果。

若未来要把 upfront 结算推广到 main 的公开生产资源，必须另写架构决策，明确“结算成功但业务失败”的退款/补偿、持久状态和运营责任；不能借本地 profile 悄然改变。

## FMAP-014 — 完成定义与计划追踪

Status: Draft
Review level: L3
Source: FMAP-005 至 FMAP-013

实施层完成必须同时满足：

- 分支最终基于执行时最新的 origin/main，Git 历史不包含 integration/B1 merge 或 cherry-pick。
- G0–G5 全部通过；现有 `apps/broker-mcp`、Graph/ENS/ERC-8004、gateway、site 和 build 回归通过。
- `frely-mcp`、`static-network`、resolution、agent-wallet、payer-session、upfront gateway 与 E2E 都有正反例。
- 无费用 E2E 证明 payment-before-Relay 顺序、支付头不跨 Relay、重复 request ID 不再签名/结算/调用 Relay。
- 文档和输出清楚标记 static allowlist、`identityVerified:false`、live 未执行状态。
- 源码、fixtures、日志、journal、包产物和 Git diff 不含 secret 或来源账户硬编码。

计划映射：

| 需求 | 实施计划 |
| --- | --- |
| FMAP-002 至 FMAP-005 | FPLAN-002、FPLAN-003 |
| FMAP-006、FMAP-007 | FPLAN-003、FPLAN-007 |
| FMAP-008 | FPLAN-006 |
| FMAP-009、FMAP-011 | FPLAN-004、FPLAN-005、FPLAN-007 |
| FMAP-010 | FPLAN-004、FPLAN-006、FPLAN-007 |
| FMAP-012 至 FMAP-014 | FPLAN-008、FPLAN-009 |
| FMAP-015 | FPLAN-011 |

写完规格或计划不表示实现完成；用户对 FMAP-015 的一次性授权也不表示 G6 已通过。只有新分支目标实现、链上 settlement、Relay 业务结果和同 request ID 重放证据均被重新验证，才能报告本轮真实 x402 验收完成。

## FMAP-015 — 新分支一次性真实付款验收追加条款

Status: Draft
Review level: L3
Source: 用户于 2026-09-12 明确允许“新分支再执行一次”，并要求更新计划和规格

本次授权只覆盖 `design/frely-mcp-acceptance-main-port` 的下一次 G6 逻辑请求，最高 `100000000` tinybar（1 HBAR，Hedera Testnet）。固定业务路径为本地 `frely-mcp → 127.0.0.1 static-network → https://api.frely.cloud/v1/responses`，Relay 模型为 `gpt-5.6-luna`；付款账户、收款账户和 fee payer 使用操作者本地受限运行配置，不写入跟踪文件。授权不覆盖旧 integration/B1 分支，不继承 `a854f54` 的交易，也不允许第二个 request ID、超额、mainnet、push、部署或合并。

付款前必须：

- 完成 live runner 的测试与实现并通过目标测试；把实际执行代码提交固定为 target SHA；
- 在 `.local/` 生成单次授权记录，包含该 target SHA、`100000000`、一个稳定 request ID、授权时间和短期有效期；
- 只读核验付款账户公钥与本地 signer 一致，并确认 Testnet HBAR 余额足以覆盖 1 HBAR 与手续费；
- 使用已通过直接 canary 的 `gpt-5.6-luna` 请求形状；2026-09-12 的 canary 为 HTTP 200、`completed`，Relay request ID 为 `req_083ee16e60203bd8aa8d9e1e`，输出包含 `FRELY X402 OK`，且没有支付请求/响应头。该 canary 关闭 G3，但不证明 G6。

本次只允许首次 `use_capability` 触发一个可结算请求。首次结果若明确 settled 且业务成功，runner 必须用完全相同的 request ID 和请求体重放一次；重放只能读取 payer journal 缓存，不得再次签名、结算或调用 Relay。最终 G6 必须分别记录：

1. 新交易 ID 与 Mirror Node `SUCCESS`；
2. payer/payTo 的精确 1 HBAR 净变化（手续费单独识别）；
3. Relay 业务响应包含精确验收文本 `FRELY X402 OK`；
4. 同 request ID 重放返回同一交易与同一业务结果，journal 仍只有一条逻辑记录，链上无第二笔授权金额转账。

若首次有 proof 的请求超时、断线或缺少可信 settlement header，状态必须保持 `unknown`。此时停止业务重放，只按 journal 中的原交易 ID 查询 Mirror；不得重新签名、重发付款请求或生成新 request ID。无论成功、失败还是 unknown，本授权在首次有 proof 的 dispatch 后即消耗。

本次实际执行绑定如下，授权已经消耗：

| 字段 | 值 |
| --- | --- |
| target SHA | `cb87175a74737e7e88bf51db3c28c216564849f2` |
| amountAtomic | `100000000` |
| request ID | `main-port-03127143-4062-426f-9d43-b2cf0be1dfaa` |
| transaction ID | `0.0.7162784@1789227538.623873938` |
| 最终状态 | payment `settled`；service `succeeded`；replay `succeeded` |

该表记录执行身份，不把运行结果本身定义成规格要求；完整证据和独立核验见验证记录 FVFY-009。
