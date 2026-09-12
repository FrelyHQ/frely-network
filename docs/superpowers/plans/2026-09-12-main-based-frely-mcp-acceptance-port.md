---
title: Main-based frely-mcp acceptance slice implementation plan
mdq:
  profile: project-governance/governed-document-v1
---

# Main-Based frely-mcp Acceptance Slice Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从执行时最新的 `origin/main` 交付一个隔离的本地 static-provider 验收 profile：`frely-mcp → local Network → Hedera x402 → remote Relay`，保留下午最终能力但不合并 B1/integration 历史。

**Architecture:** 保持 main 的生产 Broker、Graph/ENS/ERC-8004 和公开 x402 资源不变。新增可发布的 stdio `frely-mcp`、私有 `static-network` composition、static resolution v2、local agent wallet、payer session/journal，以及与现有 `X402Gateway` 并列的 upfront gate。付款在本地 Network 结算后才允许 Relay 业务调用；Relay 只接收普通 Bearer JSON。

**Tech Stack:** Bun 1.4.0；Node >=22.13.0；TypeScript 6.0.3；bun:test；MCP SDK 1.30.0；Zod 4.5.4；x402 core/Hedera 2.25.0；Hiero SDK 2.85.0；Bun SQLite；现有 Fetch/Request/Response API。

**Spec:** [基于最新 main 的 frely-mcp 验收切片移植规格](../specs/2026-09-12-main-based-frely-mcp-acceptance-port-design.md)。实施者必须先完整阅读。

## 执行快照 — 2026-09-12 23:30 Asia/Shanghai

目标实现 SHA：`7c332ca6a95d747ede0ee7471a25832c2293b2ed`。Grok 完成前四个基础提交后因 Grok Build 额度耗尽停止；当前分支已由本地执行者接手并完成其余实现、安全加固与无费用验证。详细证据见 [验证记录](../../verification/2026-09-12-main-based-frely-mcp-acceptance-port.md)。

- [x] FPLAN-002 至 FPLAN-008：main 基线/来源护栏和七个实现切片已落地。
- [x] G0、G1、G2、G4、G5：通过；全量结果为 662 tests pass、0 fail、build pass。
- [x] G3：公开 health、认证 models 和 `gpt-5.6-luna` 最小业务请求均成功；HTTP 200、状态 `completed`、输出包含 `FRELY X402 OK`，且没有 payment headers。
- [ ] G6：用户已授权新分支的一次、最多 1 HBAR Testnet 逻辑请求；live runner、target SHA 绑定和付款证据仍待完成。

G0–G5 已关闭，可确认“基于 main 的功能移植与无费用本地链路通过”。G6 仍是单独证据层：本轮授权只在 FPLAN-011 的约束下执行，完成前不能报告真实 Hedera x402 验收通过。

## FPLAN-001 — Global Constraints

Status: Planned
Review level: L3
Source: FMAP-001 至 FMAP-014

- 执行前 `git fetch origin --prune`；目标分支必须以当时最新 `origin/main` 为祖先。当前文档基线是 `259c79f1e854382d43e64e4e0e3d963d4d955de7`，来源审计 tip 固定为 `a854f545afabaa5ea56c5b3925ca231d8d7c5018`。
- 禁止 merge/cherry-pick B1 或 integration，禁止整目录恢复，禁止覆盖 root lockfile、shared types、现有 `packages/payment/hedera-x402` 或 `apps/broker-mcp`。
- 只参考来源 tip 的最终文件；不重放中间提交，不继承其 `Verified/Completed` 文档状态。
- 保留 main 当前 `X402Gateway.handle()` 的 business-before-settlement 语义。static-local profile 使用新增 `UpfrontX402Gateway`，不改生产调用点。
- 只支持 `vision`、Responses、`hedera:testnet`、x402 v2 exact、单个显式资产和单机 journal。金额和预算用规范十进制字符串/BigInt。
- static allowlist 永远输出 `identityVerified:false`；不声称 Graph/ENS/ERC-8004 验证。
- Network 只监听 `127.0.0.1`；Relay 必须是获准的公网 HTTPS `/v1/responses`。支付头、Network 凭据、钱包信息不得发往 Relay。
- secret 只从 env/file reference 延迟读取，不写入配置样本、日志、响应、journal、测试快照或包产物。
- request ID 由调用方持久化并复用。同 ID 异指纹拒绝；付款结果 unknown 时只查询原交易，不重签、不补付、不换 ID。
- tests-first：每个行为先写失败测试，观察正确失败，再实现最小代码。完成一个任务后运行局部测试和 typecheck；最后运行全量 `bun run check`。
- live 入口默认关闭。用户已于 2026-09-12 授权新分支的一次、最多 `100000000` tinybar Testnet 请求；实际付款只按 FPLAN-011 执行，并在首次有 proof 的 dispatch 后耗尽授权。
- 每个任务末尾的 commit 是实施阶段建议步骤，不代表当前已获授权推送。绝不自动 push。

## FPLAN-002 — 执行前重基线与来源护栏

Status: Planned
Review level: L3
Source: FMAP-002 至 FMAP-005

**Files:** 本任务不改产品文件；只确认 Git 状态和后续允许路径。

- [ ] **1. 核验工具和工作区。** 在隔离 worktree 中运行：

```bash
bun --version
node --version
git status --short --branch
git fetch origin --prune
```

要求 Bun 为 1.4.x、Node 满足 >=22.13.0、工作树只含本计划预期改动。若有未知用户改动，停止并保留，不清理或覆盖。

- [ ] **2. 将设计分支更新到执行时 main。** 先记录 SHA，再 rebase；若冲突来自本规格/计划，只手工保留当前文档；若冲突涉及用户代码，停止请求处理。

```bash
git rev-parse origin/main
git rebase origin/main
git merge-base --is-ancestor origin/main HEAD
```

最后一条必须 exit 0。

- [ ] **3. 固定来源证据，不移动来源分支。** 核验下午范围和 B1 祖先关系：

```bash
git rev-parse a854f545afabaa5ea56c5b3925ca231d8d7c5018
git rev-list --count f26f031^..a854f54
git diff --shortstat f26f031^..a854f54
git merge-base --is-ancestor B1wl7ch a854f54
```

预期分别可解析来源 tip、19 commits、72 files/+5758/-507、B1 ancestor。值不符时更新审计说明并让用户确认，不能悄悄扩大来源。

- [ ] **4. 建立变更路径白名单。** 实施期只允许以下新增/修改范围：

```text
package.json
bun.lock
packages/protocol/capability-resolution/**
packages/wallet/agent-wallet/**
packages/payment/x402-payer-session/**
packages/gateway/x402/package.json
packages/gateway/x402/index.ts
packages/gateway/x402/upfront.ts
packages/gateway/x402/upfront.test.ts
apps/static-network/**
apps/frely-mcp/**
scripts/static-provider-e2e/**
docs/superpowers/specs/2026-09-12-main-based-frely-mcp-acceptance-port-design.md
docs/superpowers/plans/2026-09-12-main-based-frely-mcp-acceptance-port.md
docs/verification/2026-09-12-main-based-frely-mcp-acceptance-port.md
```

若实现确需修改 `apps/broker-mcp`、shared-types、现有 payment `index.ts` 或 production docs，先修订规格并请求用户批准。

- [ ] **5. 跑未修改基线。** 执行 `bun install --frozen-lockfile`、`bun run check`。当前参考结果为 typecheck PASS、573 tests PASS、build PASS；执行时以退出码和完整输出为准。失败时先确认是否为最新 main 的既有失败，不能进入功能移植后再归因。

本任务不创建提交。

## FPLAN-003 — 切片 1：static capability resolution v2

Status: Planned
Review level: L3
Source: FMAP-005、FMAP-007

**Files:**

- Create: `packages/protocol/capability-resolution/package.json`
- Create: `packages/protocol/capability-resolution/index.ts`
- Create: `packages/protocol/capability-resolution/index.test.ts`
- Create: `packages/protocol/capability-resolution/fixtures/static-success-v2.json`
- Create: `packages/protocol/capability-resolution/fixtures/no-provider.json`
- Modify: root `package.json`
- Modify: `bun.lock`

**Interfaces:** 实现 spec 的 `StaticResolveRequest`、`StaticResolveResult`、`parseStaticResolveRequest`、`parseStaticResolveResult`。协议 parser 不内置 Provider ID、Relay URL 或端口；调用方另做 exact config authorization。

- [ ] **1. 先写 schema 失败测试。** 从 `a854f54` 的 fixture 形状派生脱敏 fixture；测试合法 v2、错误 schema、额外 capability、重复 capability、`identityVerified:true`、execution/resource 不同、非 loopback execution、非公网 HTTPS Provider、query/credentials/hash。

```ts
import { expect, test } from "bun:test";
import { parseStaticResolveResult } from "./index.ts";

test("never upgrades a static allowlist to verified identity", () => {
  const value = structuredClone(validResult);
  value.resolution.identityVerified = true;
  expect(() => parseStaticResolveResult(value)).toThrow("INVALID_RESPONSE");
});
```

Run: `bun test packages/protocol/capability-resolution/index.test.ts`。Expected first: module/export missing。

- [ ] **2. 实现最小 Zod parser。** 固定协议枚举，使用 URL parser 和 `node:net.isIP`；execution 只接受 hostname 恰为 `127.0.0.1`、无 credentials/query/hash、path 恰为 `/v1/responses`、显式合法端口。Provider endpoint 必须 HTTPS、公网 hostname、path `/v1/responses`。

```ts
export function parseStaticResolveResult(value: unknown): StaticResolveResult {
  const parsed = staticResultSchema.safeParse(value);
  if (!parsed.success) throw new Error("INVALID_RESPONSE");
  if (parsed.data.execution.endpoint !== parsed.data.payment.resource) {
    throw new Error("INVALID_RESPONSE");
  }
  return parsed.data;
}
```

- [ ] **3. 接入 workspace。** root `workspaces` 增加 `packages/wallet/*`、`apps/static-network`、`apps/frely-mcp`；现有 `packages/protocol/*` 和 `scripts/*` 已覆盖本包/脚本，不改成笼统 `apps/*`，避免把独立 npm site 意外纳入 Bun workspace。package 依赖精确固定 `zod: 4.5.4`。

- [ ] **4. 验证正反例和包边界。** 运行：

```bash
bun install
bun test packages/protocol/capability-resolution
bun run typecheck
```

确认 `git diff -- package.json bun.lock` 只含预期 workspace/依赖变化。

- [ ] **5. 提交本切片。**

```bash
git add package.json bun.lock packages/protocol/capability-resolution
git commit -m "feat(protocol): add configurable static capability resolution v2"
```

## FPLAN-004 — 切片 2：本地 agent wallet 的安全读写边界

Status: Planned
Review level: L3
Source: FMAP-005、FMAP-010

**Files:**

- Create: `packages/wallet/agent-wallet/package.json`
- Create: `packages/wallet/agent-wallet/types.ts`
- Create: `packages/wallet/agent-wallet/chain.ts`
- Create: `packages/wallet/agent-wallet/init.ts`
- Create: `packages/wallet/agent-wallet/read-ready.ts`
- Create: `packages/wallet/agent-wallet/local-wallet.ts`
- Create: `packages/wallet/agent-wallet/index.ts`
- Create: `packages/wallet/agent-wallet/test-support.ts`
- Create: `packages/wallet/agent-wallet/init.test.ts`
- Create: `packages/wallet/agent-wallet/read-ready.test.ts`
- Create: `packages/wallet/agent-wallet/local-wallet.test.ts`
- Modify: `bun.lock`

**Interfaces:** 从下午 tip 选择性移植钱包文件行为，但重新核对 main 的依赖版本和错误码。

```ts
export type AgentWalletDescriptor = {
  version: 1;
  network: "hedera:testnet";
  accountId: string;
  keyType: "ecdsa";
  publicKey: string;
  privateKeyRef: string;
};

export function initAgentWallet(input: {
  directory: string;
  network: "hedera:testnet";
}): Promise<AgentWalletDescriptor>;

export function readReadyAgentWallet(directory: string): Promise<AgentWalletDescriptor>;
```

- [ ] **1. 写权限与故障红灯测试。** 覆盖首次 init、重复 init 返回同一钱包、已有冲突文件拒绝、目录非 0700/密钥非 0600 拒绝、symlink 拒绝、截断/额外字段/错误 network/key type 拒绝、错误不回显私钥。

Run: `bun test packages/wallet/agent-wallet`。Expected first: package missing。

- [ ] **2. 实现原子初始化。** 使用同目录临时文件、`open(..., "wx", 0o600)`、fsync、rename；目录以 0700 创建。发现未知已有状态时 fail closed，不覆盖、不轮换、不自动修复用户文件。

- [ ] **3. 实现 read-ready。** 先 `lstat` 拒绝 symlink，再校验 owner/mode/JSON schema，使用 Hiero SDK 验证 ECDSA private/public key 一致。对外只返回 descriptor；需要签名时才通过窄 signer adapter 读取 key。

- [ ] **4. 明确账户证据边界。** `local-wallet.ts` 可以提供 `createHederaSigner()`，但不得把 key 文件存在映射为 `funded:true`、`activated:true` 或余额。账户/余额检查留给 payer preflight/recovery 的只读端口。

- [ ] **5. 运行并提交。**

```bash
bun test packages/wallet/agent-wallet
bun run typecheck
git add packages/wallet/agent-wallet bun.lock
git commit -m "feat(wallet): add local Hedera agent wallet"
```

## FPLAN-005 — 切片 3：持久 payer session、签名前策略与只查原交易恢复

Status: Planned
Review level: L3
Source: FMAP-009 至 FMAP-011

**Files:**

- Create: `packages/payment/x402-payer-session/package.json`
- Create: `packages/payment/x402-payer-session/types.ts`
- Create: `packages/payment/x402-payer-session/policy.ts`
- Create: `packages/payment/x402-payer-session/signer.ts`
- Create: `packages/payment/x402-payer-session/journal.ts`
- Create: `packages/payment/x402-payer-session/session.ts`
- Create: `packages/payment/x402-payer-session/recovery.ts`
- Create: `packages/payment/x402-payer-session/index.ts`
- Create: `packages/payment/x402-payer-session/test-support.ts`
- Create: `packages/payment/x402-payer-session/policy.test.ts`
- Create: `packages/payment/x402-payer-session/signer.test.ts`
- Create: `packages/payment/x402-payer-session/journal.test.ts`
- Create: `packages/payment/x402-payer-session/session.test.ts`
- Create: `packages/payment/x402-payer-session/recovery.test.ts`
- Modify: `bun.lock`

**Core types:**

```ts
export type PayerPolicy = {
  network: "hedera:testnet";
  asset: string;
  amountAtomic: string;
  maxAmountAtomic: string;
  payerAccountId: string;
  payTo: string;
  feePayer: string;
  facilitatorUrl: string;
  resourceUrl: string;
  walletDirectory: string;
  journalPath: string;
};

export type PaymentStatus = "not_paid" | "unknown" | "settled";
export type ServiceStatus = "not_started" | "unknown" | "succeeded" | "failed";

export type PayerSessionResult = {
  requestId: string;
  paymentStatus: PaymentStatus;
  serviceStatus: ServiceStatus;
  retryAction: "none" | "query_original";
  transactionId?: string;
  output?: unknown;
};
```

- [ ] **1. 先写策略红灯。** 覆盖金额缺失/0/前导零/小数/科学计数/超 64-bit、预算不足、network/asset/payTo/feePayer/resource/timeout 不匹配、多报价 0/1/2 个合格候选。所有拒绝发生在 `ports.sign` 之前。

```ts
test("never signs when the quote exceeds the request budget", async () => {
  const ports = recordingPorts({ amount: "2" });
  await expect(session(ports).execute(requestWithBudget("1"))).rejects.toThrow("PAYMENT_LIMIT_EXCEEDED");
  expect(ports.calls.sign).toBe(0);
  expect(ports.calls.paidFetch).toBe(0);
});
```

- [ ] **2. 实现严格 quote policy。** 复用 `@frely-network/hedera-x402` 导出的 `decodePaymentHeader` 和类型；外部对象仍做 runtime validation。只接受恰好一个完全匹配的 v2 exact quote，拒绝由 402 响应改变本地 allowlist。

- [ ] **3. 先写 signer 红灯，再适配下午最终 signer。** signer 使用 `@x402/hedera` 创建交易，反序列化后核对 transaction payer/fee payer、唯一净转账、asset、amount、payTo、key signature；计算 signed bytes SHA-256。将请求正文的小写 SHA-256 写入 `payload.extensions.bodySha256` 后编码 `PAYMENT-SIGNATURE`。

```ts
export type SignedPayment = {
  paymentHeader: string;
  transactionId: string;
  payloadDigest: string;
};
```

测试包括篡改 body hash、错误 transfer、错误 key、额外 operation、payer=payTo、header 过大。私钥和完整 header 不进入 snapshot。

- [ ] **4. 先写 SQLite journal 状态测试。** schema 对 `request_id` 唯一；保存 `fingerprint`、phase、policy snapshot、quote digest、transaction ID、payload digest、payment/service status、response digest、受限 output cache、timestamps。用事务/唯一约束覆盖同 ID 并发、同 ID 异指纹、崩溃重开、单调状态、文件权限和写失败。

```sql
CREATE TABLE payment_requests (
  request_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  phase TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  transaction_id TEXT,
  payload_digest TEXT,
  payment_status TEXT NOT NULL,
  service_status TEXT NOT NULL,
  response_digest TEXT,
  output_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

journal 禁止保存 private key、API key、完整 payment header、完整签名交易或 Relay authorization。

- [ ] **5. 实现 session 的两次 HTTP 边界。** 第一次 POST 不带 payment header，得到 402 后校验 quote；签名前重新读取 journal；签名后先提交 `paid_dispatch_started` 及 transaction/digest，再发完全相同 body 的第二次 POST。两次都带同一个 `x-frely-request-id`。

```ts
const first = await ports.fetch(unpaidRequest(input));
const quote = selectQuote(await readChallenge(first), policy);
const signed = await ports.sign({ requirement: quote, resourceUrl, bodySha256 });
journal.beforePaidDispatch(requestId, fingerprint, quote, signed);
const paid = await ports.fetch(paidRequest(input, signed.paymentHeader));
```

第二次响应先把服务观察和 output 摘要写 journal，再核验 `PAYMENT-RESPONSE`/原交易。没有可信 settlement 时不得返回 settled。

- [ ] **6. 实现重复与错误矩阵。** 测试同 ID 成功重复直接返回 cache，sign/paid fetch/Relay 间接调用均不增加；不同 body/provider/budget 冲突；paid fetch 超时得到 unknown；settled+Relay 5xx 保留交易；收到成功业务但 settlement 不可核实仍 unknown。

- [ ] **7. 实现 recovery。** 输入仅 `{requestId, journalPath}`。`phase < paid_dispatch_started` 可关闭为 not_paid；之后只用已存 transaction ID/digest/quote 调 `verifyOriginal`。pending/查询失败保持 unknown；SUCCESS 且金额/账户匹配才 settled；不得构造 signer、不得 fetch resource/Relay。

- [ ] **8. 运行局部回归并提交。**

```bash
bun test packages/payment/x402-payer-session
bun test packages/payment/hedera-x402
bun run typecheck
git add packages/payment/x402-payer-session bun.lock
git commit -m "feat(payment): add journaled x402 payer session"
```

## FPLAN-006 — 切片 4：隔离的 upfront x402 gateway

Status: Planned
Review level: L3
Source: FMAP-008、FMAP-009

**Files:**

- Create: `packages/gateway/x402/upfront.ts`
- Create: `packages/gateway/x402/upfront.test.ts`
- Modify: `packages/gateway/x402/index.ts`
- Modify: `packages/gateway/x402/package.json`

**Interfaces:**

```ts
export type UpfrontAdmission =
  | { kind: "response"; response: Response }
  | {
      kind: "settled";
      settlement: GatewaySettlement;
      finish(response: Response): Promise<Response>;
    };

export interface X402AttemptStore {
  claim(input: {
    requestId: string;
    fingerprint: string;
    proofDigest: string;
    expiresAt: string;
  }): Promise<"claimed" | "duplicate" | "conflict">;
  markSettled(requestId: string, settlement: GatewaySettlement): Promise<void>;
  markDelivered(requestId: string, responseDigest: string): Promise<void>;
}

export class UpfrontX402Gateway {
  admit(request: Request, body: Uint8Array, requirements: PaymentRequired): Promise<UpfrontAdmission>;
}
```

- [ ] **1. 写顺序红灯。** 用 recording verifier/settler/handler 断言：无 proof 只有 challenge；invalid proof 不 settle；valid proof 顺序为 `claim → verify → settle → handler`；settle 失败时 handler 调用次数为 0。

- [ ] **2. 写请求绑定红灯。** 覆盖 method/path/resource、request ID 格式、body SHA-256、scheme/network/asset/amount/payTo/feePayer/timeout、payment header 大小、同 ID 同/异指纹。body hash 缺失或大写都拒绝。

- [ ] **3. 实现最小 upfront gate。** 复用 main 已导出的 `X402GatewayVerifier`、`X402GatewaySettler`、`GatewaySettlement` 和 payment types。可以从现有文件提取纯 helper 为 package-private export，但不得修改 `X402Gateway.handle()` 的控制流或返回语义。

- [ ] **4. 实现持久 attempt store。** 使用 file/SQLite store，状态 `claimed → settled → delivered` 单调推进。claim 在 verify 前发生；store 不可用返回 503 且不 verify/settle/调用业务。相同 proof/request 重放必须在 facilitator 前拒绝。

- [ ] **5. 实现 finish。** 只把 allowlisted `PAYMENT-RESPONSE` 和 cache-control 合并到业务 Response；不能覆盖业务 status/body/content-type。Relay 失败时仍附 settlement evidence，使 payer 能区分 settled+failed。

- [ ] **6. 回归现有 gateway 并提交。**

```bash
bun test packages/gateway/x402/upfront.test.ts
bun test packages/gateway/x402/index.test.ts
bun run typecheck
git add packages/gateway/x402
git commit -m "feat(gateway): add isolated upfront x402 admission"
```

必须保留现有测试“handler 先于 settle”的预期；新测试单独证明 static profile “settle 先于 handler”。

## FPLAN-007 — 切片 5：本地 static-network composition

Status: Planned
Review level: L3
Source: FMAP-006 至 FMAP-008、FMAP-010

**Files:**

- Create: `apps/static-network/package.json`
- Create: `apps/static-network/config.ts`
- Create: `apps/static-network/config.test.ts`
- Create: `apps/static-network/static-resolver.ts`
- Create: `apps/static-network/static-resolver.test.ts`
- Create: `apps/static-network/upstream.ts`
- Create: `apps/static-network/upstream.test.ts`
- Create: `apps/static-network/service.ts`
- Create: `apps/static-network/service.test.ts`
- Create: `apps/static-network/runtime.ts`
- Create: `apps/static-network/runtime.test.ts`
- Create: `apps/static-network/server.ts`
- Create: `apps/static-network/index.ts`

- [ ] **1. 写 config 红灯。** 输入使用 env reference，不使用下午硬编码值。拒绝非 127.0.0.1 bind/base URL、端口缺失、Relay 非 HTTPS 或 path 不符、Provider/amount/account 缺失、secret 内联到 JSON、journal 路径含 NUL/不可写。

```ts
export type StaticNetworkConfig = {
  listen: { hostname: "127.0.0.1"; port: number };
  provider: { id: string; relayUrl: string };
  auth: { apiKeyRef: `env:${string}`; relayKeyRef: `env:${string}` };
  payment: {
    network: "hedera:testnet";
    resourceUrl: string;
    asset: string;
    amountAtomic: string;
    payTo: string;
    feePayer: string;
    facilitatorUrl: string;
    attemptStorePath: string;
  };
};
```

- [ ] **2. 迁移 static resolver 行为。** `resolve()` 只接受 v2/vision/testnet；返回配置值并经 `parseStaticResolveResult` 校验。测试明确 `identityVerified:false`，错误能力不回退 Graph。

- [ ] **3. 实现 Relay upstream allowlist。** 只转发 method/body 和 `authorization: Bearer <relay key>`、accept/content-type、已验证安全 request ID。显式删除 `PAYMENT-REQUIRED`、`PAYMENT-SIGNATURE`、`PAYMENT-RESPONSE`、`X-PAYMENT*`、Network Authorization。限制响应大小和允许响应头；网络错误统一 `UPSTREAM_FAILED`。

- [ ] **4. 写 service 路由/顺序红灯。** 覆盖 health/ready、404/405/415/413、Bearer timing-safe auth、resolve、无 proof 402、invalid proof、settlement failure、settled then Relay success/failure。recording calls 必须断言 Relay 只在 settle 成功之后出现。

- [ ] **5. 组合 runtime。** 从 config 创建 resolver、Hedera verifier/settler、持久 attempt store、`UpfrontX402Gateway` 和 Relay upstream。`/readyz` 只表示本地依赖已构造，不宣称链上结算或 Relay 业务成功。

- [ ] **6. 启动入口只绑定 loopback。** `server.ts` 使用 `Bun.serve({ hostname: "127.0.0.1", ... })`；启动日志写 stderr，仅打印 profile 名、端口和 readiness，不打印账户/金额之外的敏感配置。SIGINT/SIGTERM 关闭 store/server。

- [ ] **7. 运行并提交。**

```bash
bun test apps/static-network
bun run typecheck
git add apps/static-network
git commit -m "feat(network): add local static-provider acceptance profile"
```

## FPLAN-008 — 切片 6：可发布的 stdio frely-mcp

Status: Planned
Review level: L3
Source: FMAP-006、FMAP-007、FMAP-009 至 FMAP-011

**Files:**

- Create: `apps/frely-mcp/package.json`
- Create: `apps/frely-mcp/README.md`
- Create: `apps/frely-mcp/config.ts`
- Create: `apps/frely-mcp/config.test.ts`
- Create: `apps/frely-mcp/network-client.ts`
- Create: `apps/frely-mcp/network-client.test.ts`
- Create: `apps/frely-mcp/runtime.ts`
- Create: `apps/frely-mcp/runtime.test.ts`
- Create: `apps/frely-mcp/server.ts`
- Create: `apps/frely-mcp/server.test.ts`
- Create: `apps/frely-mcp/index.ts`
- Create: `apps/frely-mcp/check.ts`
- Create: `apps/frely-mcp/check.test.ts`
- Create: `apps/frely-mcp/build-package.ts`
- Create: `apps/frely-mcp/package.test.ts`
- Create: `apps/frely-mcp/fixtures/fake-server.ts`
- Create: `apps/frely-mcp/fixtures/network-server.ts`
- Modify: `bun.lock`

- [ ] **1. 写 config 与 start-gate 红灯。** 只接受 loopback Network、完全匹配的 Provider/Relay/resource、`env:` secret ref、wallet/journal 路径和显式 `livePaymentEnabled:false` 默认值。缺任何支付字段时 `use_capability` 不可启动；`find_capability` 可在无 wallet 时工作。

- [ ] **2. 实现 Network client。** `/v1/capabilities/resolve` 10 秒超时、redirect error、1 MiB 有界 JSON；解析 v2 后再次与本地 allowlist 完全比较。非 200 只映射 allowlisted code，其余为 `NETWORK_UNAVAILABLE`。

- [ ] **3. 写 runtime 红灯。** 覆盖 `find_capability`、合法 vision use、非法 image URL/task/capability、Provider mismatch、payment disabled、重复 request ID、unknown recovery 提示。付款 executor 延迟创建；只查 capability 不读取 wallet。

```ts
export type FrelyMcpRuntime = {
  findCapability(capabilities: string[]): Promise<StaticResolveResult>;
  useCapability(input: {
    requestId: string;
    capabilities: ["vision"];
    task: string;
    input: { image_url: string };
    maxAmountAtomic: string;
  }): Promise<StaticCapabilityUseResult>;
  close(): void;
};
```

- [ ] **4. 实现 stdio MCP server。** 只注册 `find_capability` 与 `use_capability`。stdout 只供 MCP protocol；所有诊断写 stderr。Zod schema 对额外字段 fail closed。MCP error data 只含稳定 code，不回显输入 URL query、secret 或 payment header。

- [ ] **5. 构建与自检。** `check.ts` 验证配置/钱包/journal 可用性，但不请求付费资源、不签名、不查询余额即宣称 ready。`build-package.ts` 生成单入口 `dist/frely-mcp.js`，package 只发布 `dist` 与 README；runtime dependencies 与 bundled imports 由 package test 核对。

- [ ] **6. tarball 黑盒测试。** 用 `bun pm pack --destination <temp>`，解包到临时目录，在 repo 外启动 bin；发送 initialize/listTools/callTool 到 stdio，确认 stdout 无日志、两个工具可用、进程可关闭。检查 tarball 不含 source fixture、wallet、journal、`.env`、API key、私钥。

- [ ] **7. 运行并提交。**

```bash
bun test apps/frely-mcp
bun run typecheck
git add apps/frely-mcp bun.lock
git commit -m "feat(mcp): add local static-provider frely MCP"
```

## FPLAN-009 — 切片 7：无费用全链路、回归与 live 隔离门槛

Status: Planned
Review level: L3
Source: FMAP-012 至 FMAP-014

**Files:**

- Create: `scripts/static-provider-e2e/package.json`
- Create: `scripts/static-provider-e2e/preflight.ts`
- Create: `scripts/static-provider-e2e/preflight.test.ts`
- Create: `scripts/static-provider-e2e/live.ts`
- Create: `scripts/static-provider-e2e/live.test.ts`
- Create: `docs/verification/2026-09-12-main-based-frely-mcp-acceptance-port.md`
- Modify: root `package.json`
- Modify: `bun.lock`

- [ ] **1. 先写无费用真实进程 E2E。** 测试启动 fake Relay、static-network 和打包后的 frely-mcp，通过 stdio 调用工具。注入 synthetic signer/verifier/settler，但使用真实 HTTP/MCP/journal 代码。

必须断言：

- find 返回 static_allowlist / identity false；
- 首次 paid use 的调用顺序严格为 challenge → sign → settle → Relay；
- Relay 收不到任何 payment/Network/wallet header；
- 结果分别包含 synthetic settlement 与业务 output，证据标为 `synthetic`；
- 同 request ID 第二次返回缓存，sign/settle/Relay 计数均不增加；
- 同 ID 改 body 返回 conflict；
- settle 成功后 Relay 失败保留 payment settled；
- paid response 丢失返回 unknown，recovery 只查询原交易；
- 全场景没有外部 Hedera/facilitator 请求。

- [ ] **2. 实现 preflight runner。** `preflight.ts` 只运行无费用 fixture，输出包含 `mode:"synthetic"`、target SHA、组件版本和每个 call counter。它不得读取真实 wallet secret 或 Relay credential。

- [ ] **3. 先写 live gate 测试，再保留关闭的 live runner。** `live.ts` 在任何 network/signer 初始化之前要求本地未跟踪 approval 文件，其内容必须精确绑定 `targetSha`、`amountAtomic`、`requestId`、`authorizedAt`、`expiresAt`。缺失、过期、SHA/金额/ID 不符时 exit 2 且所有外部调用计数为 0。

```ts
export type LiveApproval = {
  targetSha: string;
  amountAtomic: string;
  requestId: string;
  authorizedAt: string;
  expiresAt: string;
};
```

approval 文件和 live output 必须位于 `.local/`；`.gitignore` 已忽略该目录。测试只验证 gate，不创建伪造用户授权，不执行 live runner。

- [ ] **4. 添加根命令但不添加自动 live 命令。** root scripts 只增加：

```json
{
  "frely:mcp:build": "bun apps/frely-mcp/build-package.ts",
  "frely:static:e2e": "bun test scripts/static-provider-e2e/preflight.test.ts"
}
```

不把 live 加入 `check`、CI、postinstall 或默认 script。

- [ ] **5. 运行 G0 来源/路径检查。**

```bash
git merge-base --is-ancestor origin/main HEAD
git log --merges --oneline origin/main..HEAD
git diff --name-only origin/main...HEAD
```

第一条 exit 0；第二条为空；第三条每个路径都属于 FPLAN-002 白名单。另检查提交 message/patch 中没有 `cherry picked from`。

- [ ] **6. 运行 G1–G5。**

```bash
bun test packages/protocol/capability-resolution
bun test packages/wallet/agent-wallet
bun test packages/payment/x402-payer-session
bun test packages/gateway/x402
bun test apps/static-network
bun test apps/frely-mcp
bun test scripts/static-provider-e2e/preflight.test.ts
bun run check
git diff --check origin/main...HEAD
```

G3 另需使用获准的 Relay canary credential 执行 authenticated models 与 minimal request。credential 缺失时必须把 G3 标为 Partial，不能因为 health 或本地 fake Relay 通过而将其视为完成。

执行 secret/hardcode scan；允许 fixture 使用明显保留值，禁止真实账户、私钥、Bearer value 和下午 FROZEN 常量：

```bash
rg -n --hidden --glob '!bun.lock' --glob '!*.test.ts' --glob '!fixtures/**' '(private.?key|authorization).*[:=].*[A-Za-z0-9]' apps/frely-mcp apps/static-network packages scripts/static-provider-e2e
rg -n 'FROZEN|amountAtomic:\s*"[0-9]+"|payTo:\s*"0\.0\.[0-9]+"|feePayer:\s*"0\.0\.[0-9]+"' apps/frely-mcp apps/static-network packages scripts/static-provider-e2e
```

第一项人工审阅所有命中；第二项必须无命中。不要把 scan 无命中表述为形式化秘密检测保证。

- [ ] **7. 写入验证记录。** 新文档使用 `governed-document-v1`，状态只反映实际执行：记录 target/source SHA、命令、退出码、测试总数、synthetic call counters、tarball 文件清单摘要和明确的 `Live payment: Not run / Not authorized`。不复制旧 `a854f54` 的 Verified 状态。

- [ ] **8. 文档与规格一致性检查。**

```bash
rg -n 'T''BD|TO''DO|implement lat''er|fill i''n|Add appropria''te|add valida''tion|handle edge ca''ses|Write tests f''or|Similar t''o' docs/superpowers docs/verification
rg -n '^## (FMAP|FPLAN)-[0-9]{3}' docs/superpowers
git diff --check
```

占位符 scan 必须无命中；ID 唯一且 FMAP-014 映射覆盖所有需求；Spec/Plan 相互链接可解析。

- [ ] **9. 提交无费用验收切片。**

```bash
git add package.json bun.lock scripts/static-provider-e2e docs/verification docs/superpowers
git commit -m "test(e2e): verify main-based static provider acceptance"
```

- [x] **10. 停在 live 边界并报告。** 已完成并取得用户的新分支一次性授权。后续动作转入 FPLAN-011；旧授权和旧交易不适用。

## FPLAN-010 — 计划完成判据

Status: Planned
Review level: L3
Source: FMAP-014；FPLAN-002 至 FPLAN-009

实施者只有在以下全部成立时，才能把“移植实现”报告为完成：

- 所有任务 checkbox 对应的代码和验证真实执行，不能凭来源分支状态勾选。
- branch 基于执行时最新 main，且没有 B1/integration merge 或 cherry-pick。
- 生产路径保持回归；static profile 的 settlement-before-Relay 有可观察顺序证据。
- 同 request ID 重复、冲突、unknown 和 recovery 的副作用计数满足规格。
- 打包后的 frely-mcp 在 repo 外通过 stdio 黑盒验证。
- verification 文档保持证据分层，并明确 live 未授权/未运行或记录新授权后的独立结果。

如果 G0–G5 通过但没有 G6，推荐结论是：“基于 main 的功能移植与无费用验收完成；真实 Hedera 付款未执行。”如果某个门槛失败，记录具体 gate 和观察结果，不把任务状态提升为完成。

## FPLAN-011 — 一次性 G6 真实 HBAR 验收

Status: Planned
Review level: L3
Source: FMAP-015；用户于 2026-09-12 的一次性新分支授权

**Files:**

- Modify: `scripts/static-provider-e2e/live.ts`
- Modify: `scripts/static-provider-e2e/live.test.ts`
- Modify: `docs/verification/2026-09-12-main-based-frely-mcp-acceptance-port.md`
- Modify: 本规格与计划的执行快照
- Local only: `.local/runtime/static-provider/**`、`.local/acceptance/static-provider/**`

- [ ] **1. 先测试 live 编排行为。** 测试必须运行真实 gate 和结果校验，仅替换外部 MCP transport：授权完全匹配时首次调用一次，第二次使用完全相同的 request ID/参数；只有两次结果都为 settled/succeeded、交易 ID 相同、输出包含 `FRELY X402 OK` 时才写成功证据。缺授权、结果 unknown、业务失败或重放不一致时必须失败且不得尝试新的逻辑请求。

- [ ] **2. 实现最小 live runner。** 复用已有 approval gate，读取受限本地 runtime 配置，启动本地 static-network 与打包后的 frely-mcp，再调用 stdio `use_capability`。runner 不保存或打印 secret、payment proof 或私钥；输出只含 target SHA、request ID、状态、交易 ID、Relay request ID/业务断言和重放断言。

- [ ] **3. 固定目标实现并重跑无费用验证。** 提交 live runner 代码，记录该实现 commit 为 target SHA；至少运行 live tests、synthetic preflight、typecheck 和全量 `bun run check`。真实付款证据文档的后续提交不改变这次执行代码身份。

- [ ] **4. 准备一次性本地运行材料。** 将已有本地受限凭据转换为当前 main-native config schema，不修改旧脏 worktree；目录权限 0700、secret/key/config/journal 文件 0600。生成一个稳定 request ID 和 15 分钟内有效的 `.local/` approval，精确绑定 target SHA 与 `100000000`。

- [ ] **5. 付款前只读预检。** 从 Mirror Node 读取 payer 当前账户、公钥与余额；公钥必须匹配本地 signer，余额必须覆盖 1 HBAR 与手续费。再确认 Relay `gpt-5.6-luna` canary 已通过、Network 只监听 127.0.0.1、journal 对该 request ID 尚无记录。

- [ ] **6. 执行且只执行一次首个付费 dispatch。** 启动本地 Network 与 MCP，运行 live runner。若返回明确 settled/succeeded，runner 使用相同 request ID 和完全相同参数执行缓存重放；若结果 unknown/异常，立即停止，不重新发起，转入原交易查询。

- [ ] **7. 核验三类独立证据。** 查询 Mirror 原交易确认 `SUCCESS` 和双方 1 HBAR 净变化；核验 Relay 输出包含 `FRELY X402 OK`；核验重放交易 ID 与业务结果相同、journal 一条记录且 Mirror 没有第二笔授权金额转账。

- [ ] **8. 更新验证记录。** 记录实际 target SHA、request ID、交易 ID、Mirror 结果、业务结果和重放结果；不记录 token、私钥或 payment proof。失败或 unknown 必须保留真实状态，不能用旧分支结果补齐。

- [ ] **9. 最终回归与提交文档。** 运行相关 tests、`bun run check`、`git diff --check` 和 secret scan，再提交验证文档。除非用户另行要求，不 push、不部署、不 merge。
