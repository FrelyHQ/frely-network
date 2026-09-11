---
title: Frely 本地 MCP 路径 MVP 实施计划
mdq:
  profile: project-governance/governed-document-v1
---
# Frely 本地 MCP 路径 MVP 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 发布前构建一个可打包的 `frely-mcp` 本地 stdio 服务，让 Host Agent 通过 Frely Network 取得已验证 Relay，并使用本地 Agent Wallet 在唯一授权 profile 下完成 x402 付款调用。

**Architecture:** 单个 Bun CLI 提供 `wallet init`、`check` 和 `start`。`find_capability` 与 `use_capability` 每次都调用 Network resolve v1；只有 `use_capability` 在 Provider、endpoint、402 和预算全部匹配本地 profile 后读取签名密钥，并直接调用 Relay。

**Tech Stack:** Bun 1.4、TypeScript、官方 MCP TypeScript SDK 1.30.0、现有 Agent Wallet、现有 Hedera x402 payer journal、`@x402/core@2.25.0`、`@x402/hedera@2.25.0`、npm tarball。

**Spec:** [Frely 自托管 MCP MVP 设计](../specs/2026-09-11-self-hosted-frely-mcp-design.md)

## Global Constraints

- 本计划必须从服务端计划 Task 1 的 `feat(protocol): freeze capability resolution v1` 提交建立 worktree；不得从 `origin/main` 起分支。
- MVP 只有本地 stdio，不创建 Streamable HTTP MCP 或远程 `/mcp`。
- `find_capability` 和 `use_capability` 是唯一 MCP tools；每个 `use_capability` 都重新 resolve。
- 本地 MCP 不查询 The Graph，不访问 ENS/ERC-8004，不选择第二个 Provider。
- Agent Wallet 私钥、付款 profile、journal、Network API Key 和 Relay API Key 都留在本机。
- `find_capability` 不读取钱包；`check` 不签名、不付款、不调用 Relay；`start` 本身不自动发起工具调用。
- `use_capability` 只支持 `vision`、非流式 Responses、Hedera Testnet、HBAR 和一个已批准 Provider/Relay profile。
- stdout 只允许 MCP 协议消息；诊断只写 stderr，且不包含凭据、私钥、原始签名、配置正文和本地路径。
- 包支持 Bun >=1.4、macOS 与 Linux；打包产物不得有 `workspace:*` 运行依赖。
- 实施验收只用 synthetic Resource Server；npm 发布和真实 `0.01 HBAR` 都需要新的用户授权，不属于本计划。
- 每个任务使用独立提交，不顺带重构 Graph、ENS、ERC-8004 或 Swarm。

---

## FMCPPLAN-001 — 文件结构与依赖

Status: Draft
Review level: L3
Source: FMCP-006 至 FMCP-009

| 文件 | 职责 | 任务 |
| --- | --- | --- |
| `apps/frely-mcp/config.ts` | 外层配置、env 引用和唯一 Provider 授权 | 1 |
| `apps/frely-mcp/network-client.ts` | 调用并校验 resolve v1 | 1 |
| `apps/frely-mcp/runtime.ts` | resolve、profile 门禁、payer session 与业务结果组合 | 2 |
| `apps/frely-mcp/server.ts` | 注册两个 MCP tools | 2 |
| `apps/frely-mcp/index.ts` | `wallet init`、`check`、`start` CLI 路由 | 3 |
| `apps/frely-mcp/check.ts` | 只读配置/Network/Wallet/profile 检查 | 3 |
| `packages/wallet/agent-wallet/read-ready.ts` | 不创建、不加锁的 Ready 身份读取 | 3 |
| `packages/payment/hedera-x402/approval.ts` | 显式 registryPath，避免进程全局配置切换 | 3 |
| `apps/frely-mcp/build-package.ts`、`package.json` | 单包构建与 npm tarball 元数据 | 4 |
| `apps/frely-mcp/fixtures/*` | fake Network 与 synthetic Resource Server | 1、2、4 |

实现时将现有 `apps/broker-mcp` 用 `git mv` 改名为 `apps/frely-mcp`，保留可复用的 stdio 测试骨架；删除它对本地 Graph、ENS 与 ERC-8004 的运行依赖。`apps/agent-cli` 暂时保留，`frely-mcp` 复用其 `main()` 实现 wallet 子命令，避免复制钱包初始化逻辑。

## FMCPPLAN-002 — Task 1：配置与 Frely Network client

Status: Draft
Review level: L3
Source: FMCP-005、FMCP-007、FMCP-008

**Files:**

- Move: `apps/broker-mcp/` → `apps/frely-mcp/`
- Create: `apps/frely-mcp/config.ts`
- Create: `apps/frely-mcp/config.test.ts`
- Create: `apps/frely-mcp/network-client.ts`
- Create: `apps/frely-mcp/network-client.test.ts`
- Create: `apps/frely-mcp/fixtures/network-server.ts`
- Modify: `apps/frely-mcp/package.json`
- Modify: `bun.lock`

**Interfaces:**

- Consumes: 共享 `ResolveCapabilitiesRequest`、`ResolvedCapability` 和解析器。
- Produces: `loadFrelyMcpConfig(path)`、`resolveSecret(ref)`、`FrelyNetworkClient.resolve(capabilities)`。

```ts
export type FrelyMcpConfig = {
  schemaVersion: 1;
  network: {
    baseUrl: string;
    apiKeyRef: `env:${string}`;
    chainId: 11155111;
    registry: `0x${string}`;
  };
  relay: { apiKeyRef: `env:${string}` };
  walletDir: string;
  approvedProviderId: string;
  paymentConfigPath: string;
  paymentRegistryPath: string;
};

export class FrelyNetworkClient {
  constructor(config: FrelyMcpConfig["network"], fetcher?: typeof fetch);
  resolve(capabilities: string[]): Promise<ResolvedCapability>;
}
```

- [ ] **Step 1: 移动 app 并写配置 RED 测试。**

Run first: `git mv apps/broker-mcp apps/frely-mcp`

```ts
import { expect, test } from "bun:test";
import { loadFrelyMcpConfig } from "./config.ts";

test("loads one absolute local authorization without secrets", async () => {
  const fixture = await writeConfigFixture();
  const config = await loadFrelyMcpConfig(fixture.configPath);
  expect(config.approvedProviderId).toBe("provider-1");
  expect(config.network.apiKeyRef).toBe("env:FRELY_API_KEY");
  expect(JSON.stringify(config)).not.toContain("network-secret");
  await fixture.cleanup();
});

test("rejects embedded secrets, relative paths and extra fields", async () => {
  for (const mutate of [
    (base: Record<string, any>) => ({ ...base, network: { ...base.network, apiKeyRef: "network-secret" } }),
    (base: Record<string, any>) => ({ ...base, walletDir: "relative/wallet" }),
    (base: Record<string, any>) => ({ ...base, unexpected: true }),
  ]) {
    const fixture = await writeConfigFixture(mutate);
    await expect(loadFrelyMcpConfig(fixture.configPath)).rejects.toThrow("CONFIG_INVALID");
    await fixture.cleanup();
  }
});
```

- [ ] **Step 2: 运行配置 RED。**

Run: `bun test apps/frely-mcp/config.test.ts`

Expected: FAIL，因为 config loader 尚不存在。

- [ ] **Step 3: 实现安全配置读取。**

复用 `readBoundedJson` 的 O_NOFOLLOW 与 1 MiB 上限，但错误统一映射为 `CONFIG_INVALID`。外层对象和每个内层对象都拒绝额外字段。四个路径必须是规范绝对路径；Network base URL 必须是无凭据、无 search/hash 的公网 HTTPS origin；两个 secret 字段只接受 `env:[A-Z_][A-Z0-9_]*`。

```ts
export function resolveSecret(ref: `env:${string}`): string {
  if (!/^env:[A-Z_][A-Z0-9_]*$/.test(ref)) throw new Error("CONFIG_INVALID");
  const value = process.env[ref.slice(4)];
  if (!value) throw new Error("CONFIG_INVALID");
  return value;
}
```

测试中的 `writeConfigFixture(mutate = base => base)` 在临时目录构造基础配置，让 mutate 返回待写入值，并返回 `{configPath, cleanup}`；基础对象使用该临时目录生成规范绝对路径。fixture 只保存 env 引用，不保存真实值，测试结束必须删除临时目录。

本任务把移动后的 package 暂定为 `name=frely-mcp`、`private=true`。删除 `@frely-network/the-graph`、`@frely-network/ens`、`@frely-network/erc8004` 依赖；保留 Broker、Hedera payer、Agent Wallet、MCP SDK 与 Zod，并增加共享 capability-resolution package。Task 4 再切换最终发布字段。

- [ ] **Step 4: 写 Network client RED 测试。**

```ts
import { expect, test } from "bun:test";
import successFixture from "../../packages/protocol/capability-resolution/fixtures/success.json";
import { FrelyNetworkClient } from "./network-client.ts";

const networkConfig = {
  baseUrl: "https://network.example",
  apiKeyRef: "env:FRELY_API_KEY" as const,
  chainId: 11155111 as const,
  registry: "0x1111111111111111111111111111111111111111" as const,
};

test("posts only capabilities and validates the frozen response", async () => {
  let captured: Request | undefined;
  const client = new FrelyNetworkClient(networkConfig, async request => {
    captured = request;
    return Response.json(successFixture);
  });
  const result = await client.resolve(["vision"]);
  expect(await captured!.json()).toEqual({
    schemaVersion: 1,
    capabilities: ["vision"],
    paymentNetwork: "hedera:testnet",
  });
  expect(captured!.headers.get("authorization")).toBe("Bearer network-secret");
  expect(result.provider.id).toBe("provider-1");
});

test("rejects redirects and identity configuration drift", async () => {
  const drifted = { ...successFixture, identity: { ...successFixture.identity, registry: "0x2222222222222222222222222222222222222222" } };
  const client = new FrelyNetworkClient(networkConfig, async () => Response.json(drifted));
  await expect(client.resolve(["vision"])).rejects.toThrow("IDENTITY_VERIFICATION_FAILED");
});
```

- [ ] **Step 5: 运行 Network RED。**

Run: `FRELY_API_KEY=network-secret bun test apps/frely-mcp/network-client.test.ts`

Expected: FAIL，因为 client 尚不存在。

- [ ] **Step 6: 实现 Network client。**

每次调用都构建新的 10 秒超时 POST，请求 URL 固定为 `new URL("/v1/capabilities/resolve", baseUrl)`，使用 `redirect: "error"`、JSON Content-Type 和 Bearer。响应体上限 1 MiB。只接受 200；已知服务端 code 原样映射，其余 HTTP、JSON 和网络错误统一为 `NETWORK_UNAVAILABLE`。

调用 `parseResolvedCapability` 后再次确认：

```ts
if (!sameCapabilities(result.requestedCapabilities, capabilities)) throw new Error("CAPABILITY_NOT_SUPPORTED");
if (result.identity.chainId !== this.config.chainId || result.identity.registry.toLowerCase() !== this.config.registry.toLowerCase()) {
  throw new Error("IDENTITY_VERIFICATION_FAILED");
}
if (result.payment.network !== "hedera:testnet") throw new Error("CAPABILITY_NOT_SUPPORTED");
```

client 不记录请求或响应正文；错误不包含 URL、API Key 或服务端 body。

- [ ] **Step 7: 运行 GREEN。**

Run: `FRELY_API_KEY=network-secret bun test apps/frely-mcp/config.test.ts apps/frely-mcp/network-client.test.ts && bun run typecheck`

Expected: 配置与 Network client 测试 PASS；类型检查 PASS。

- [ ] **Step 8: 提交配置与 client。**

```bash
git add apps/frely-mcp bun.lock
git commit -m "feat(mcp): add local config and Network client"
```

## FMCPPLAN-003 — Task 2：实现两个 MCP tools 与付款门禁

Status: Draft
Review level: L3
Source: FMCP-004、FMCP-006、FMCP-007

**Files:**

- Create: `apps/frely-mcp/runtime.ts`
- Create: `apps/frely-mcp/runtime.test.ts`
- Modify: `apps/frely-mcp/server.ts`
- Modify: `apps/frely-mcp/server.test.ts`
- Modify: `apps/frely-mcp/payment.test.ts`
- Modify: `apps/frely-mcp/fixtures/payment-server.ts`
- Modify: `packages/broker/execution/request.ts`

**Interfaces:**

- Consumes: `FrelyNetworkClient`、`Policy`、`createPaidExecutor`、`ResolvedCapability`。
- Produces: `createFrelyMcpRuntime(options)` 与 `createFrelyMcpServer(runtime)`。

```ts
export type FrelyMcpRuntime = {
  findCapability(capabilities: string[]): Promise<ResolvedCapability>;
  useCapability(request: CapabilityRequest): Promise<CapabilityResult & {
    identityVerificationSource: "frely-network";
  }>;
  close(): void;
};

export type FrelyMcpRuntimeOptions = {
  config: FrelyMcpConfig;
  paymentPolicy: Policy;
  networkClient: Pick<FrelyNetworkClient, "resolve">;
  createPaymentExecutor(): {
    execute(provider: ResolvedProvider, request: CapabilityRequest): Promise<PaymentOutcome>;
    close(): void;
  };
};
```

- [ ] **Step 1: 写 runtime RED 测试。**

```ts
import { expect, test } from "bun:test";
import { createFrelyMcpRuntime } from "./runtime.ts";

test("resolves on every use and pays only the approved provider endpoint", async () => {
  let resolves = 0;
  const h = harness({ onResolve: () => resolves += 1 });
  const runtime = createFrelyMcpRuntime(h.options);
  await runtime.findCapability(["vision"]);
  const result = await runtime.useCapability(visionRequest("req-1"));
  expect(resolves).toBe(2);
  expect(result.identityVerificationSource).toBe("frely-network");
  expect(result.paymentOutcome?.paymentStatus).toBe("settled");
  expect(result.output).toEqual({ output_text: "synthetic output" });
});

test("does not sign when provider or resource differs from the local profile", async () => {
  for (const drift of ["provider", "endpoint"] as const) {
    const h = harness({ drift });
    const runtime = createFrelyMcpRuntime(h.options);
    await expect(runtime.useCapability(visionRequest("req-" + drift))).rejects.toThrow("PROVIDER_NOT_AUTHORIZED");
    expect(h.signCalls()).toBe(0);
    expect(h.relayCalls()).toBe(0);
  }
});
```

同一测试文件定义下面的输入和 harness；这里的 executor 是 runtime 单元测试替身，真实 payer session 继续由 `payment.test.ts` 覆盖：

```ts
const visionRequest = (requestId: string): CapabilityRequest => ({
  capabilities: ["vision"],
  task: "Describe",
  input: { image_url: "https://images.example/a.png" },
  payment: {
    requestId,
    budget: { network: "hedera:testnet", asset: "0.0.0", maxAmountAtomic: "1000000" },
  },
});

const validConfig: FrelyMcpConfig = {
  schemaVersion: 1,
  network: {
    baseUrl: "https://network.example",
    apiKeyRef: "env:FRELY_API_KEY",
    chainId: 11155111,
    registry: "0x1111111111111111111111111111111111111111",
  },
  relay: { apiKeyRef: "env:FRELY_RELAY_API_KEY" },
  walletDir: "/tmp/frely-mcp-runtime-test/wallet",
  approvedProviderId: "provider-1",
  paymentConfigPath: "/tmp/frely-mcp-runtime-test/payment.json",
  paymentRegistryPath: "/tmp/frely-mcp-runtime-test/registry.json",
};
const validPolicy: Policy = {
  enabled: true,
  network: "hedera:testnet",
  asset: "0.0.0",
  assetDecimals: 8,
  payerAccountId: "0.0.1234",
  payTo: "0.0.4321",
  feePayers: ["0.0.9999"],
  facilitatorUrl: "https://facilitator.example",
  resourceUrl: "https://relay.example/v1/responses",
  journalPath: ":memory:",
  mirrorNodeUrl: "https://testnet.mirrornode.hedera.com",
  signerRef: "env:PAYMENT_TEST_KEY",
  keyType: "ecdsa",
  credentialRef: "test-only",
};

function harness(settings: {
  drift?: "provider" | "endpoint";
  onResolve?: () => void;
}) {
  let signCalls = 0;
  let relayCalls = 0;
  const resolved = structuredClone(successFixture);
  if (settings.drift === "provider") resolved.provider.id = "provider-2";
  if (settings.drift === "endpoint") resolved.provider.endpoint = "https://other.example/v1/responses";
  const options: FrelyMcpRuntimeOptions = {
    config: validConfig,
    paymentPolicy: validPolicy,
    networkClient: { resolve: async () => { settings.onResolve?.(); return parseResolvedCapability(resolved); } },
    createPaymentExecutor: () => ({
      execute: async (_provider, request) => {
        signCalls += 1;
        relayCalls += 1;
        return {
          requestId: request.payment?.requestId ?? null,
          decision: "completed",
          paymentStatus: "settled",
          serviceStatus: "succeeded",
          reason: "PAYMENT_COMPLETED",
          retryAction: "none",
          evidence: { source: "synthetic", network: "hedera:testnet", transactionId: "synthetic-tx" },
          output: { output_text: "synthetic output" },
        };
      },
      close: () => {},
    }),
  };
  return { options, signCalls: () => signCalls, relayCalls: () => relayCalls };
}
```

runtime 单元测试不读取这些路径；文件与权限行为由配置、钱包和 package 测试使用临时目录覆盖。

- [ ] **Step 2: 运行 runtime RED。**

Run: `bun test apps/frely-mcp/runtime.test.ts`

Expected: FAIL，因为 runtime 尚不存在。

- [ ] **Step 3: 实现单 Provider runtime。**

`findCapability` 只调用 Network client。`useCapability` 先验证 Vision 输入，再调用 Network client；随后严格比较 `provider.id === approvedProviderId`、`provider.endpoint === policy.resourceUrl`、`provider.protocol === "responses"`、Network chain/registry 和付款网络。任一不匹配返回 `PROVIDER_NOT_AUTHORIZED`，且不得调用 `createPaymentExecutor()`、打开 journal 或读取 signer。

授权通过后，`createPaymentExecutor()` 才解析 Relay API Key、打开 journal，并组合现有 `createPaidExecutor`：

```ts
const executePaid = createPaidExecutor({
  policy,
  ports,
  executionConfig: {
    mode: "integration",
    origin: new URL(policy.resourceUrl).origin,
    callerKey: resolveSecret(config.relay.apiKeyRef),
  },
});
const paymentOutcome = await executePaid(resolved.provider, request);
return {
  provider: { id: resolved.provider.id, ensName: resolved.provider.ensName },
  identityVerificationSource: "frely-network",
  paymentOutcome,
  ...(paymentOutcome.evidence?.network ? {
    payment: {
      network: paymentOutcome.evidence.network,
      ...(paymentOutcome.evidence.transactionId ? { transactionId: paymentOutcome.evidence.transactionId } : {}),
    },
  } : {}),
  output: paymentOutcome.output,
};
```

`prepareFrelyRequest` 继续生成 `model: "vision-basic"`、`stream:false`、`store:false`，并添加 `x-frely-request-id`。禁止把 Network API Key 发给 Relay，也禁止把 Relay API Key 发给 Network。

- [ ] **Step 4: 改写 MCP server RED 测试。**

```ts
const tools = await client.listTools();
expect(tools.tools.map(tool => tool.name)).toEqual(["find_capability", "use_capability"]);
expect(tools.tools.find(tool => tool.name === "find_capability")?.annotations).toMatchObject({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
});
expect(tools.tools.find(tool => tool.name === "use_capability")?.annotations).toMatchObject({
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
});
```

同时把现有 discovery candidate 断言改为已验证的 `ResolvedCapability`，并保留支付 structuredContent 断言。已知错误只允许规格 FMCP-010 中的 code；未识别异常统一为 `EXECUTION_FAILED`。

- [ ] **Step 5: 运行 MCP RED。**

Run: `bun test apps/frely-mcp/server.test.ts apps/frely-mcp/payment.test.ts`

Expected: FAIL，因为 server 仍使用旧 discovery/broker 接口。

- [ ] **Step 6: 注册两个工具。**

`createFrelyMcpServer` 固定 `{name:"frely-mcp", version:"0.1.0"}`，始终注册两个工具。`find_capability` 输入只有 capabilities；`use_capability` 输入与规格 FMCP-006 一致，不再接受 legacy `maxAmount` 和 `acceptIndex`。返回同时设置 JSON text content 与 structuredContent；不得输出原始签名、完整 policy、API Key、walletDir、journalPath 或 signerRef。

- [ ] **Step 7: 运行 GREEN 与付款包回归。**

Run: `bun test apps/frely-mcp packages/payment/hedera-x402 packages/broker && bun run typecheck`

Expected: MCP 握手、两个工具、Provider 门禁、journal 重放、unknown 恢复和既有 payer 测试 PASS。

- [ ] **Step 8: 提交 runtime 与 tools。**

```bash
git add apps/frely-mcp packages/broker/execution/request.ts
git commit -m "feat(mcp): resolve remotely and invoke one approved Relay"
```

## FMCPPLAN-004 — Task 3：统一 CLI、只读 check 与钱包交接

Status: Draft
Review level: L3
Source: FMCP-007、FMCP-008、FMCP-010

**Files:**

- Create: `packages/wallet/agent-wallet/read-ready.ts`
- Create: `packages/wallet/agent-wallet/read-ready.test.ts`
- Modify: `packages/wallet/agent-wallet/local-wallet.ts`
- Modify: `packages/wallet/agent-wallet/index.ts`
- Modify: `packages/payment/hedera-x402/approval.ts`
- Modify: `packages/payment/hedera-x402/config.test.ts`
- Create: `apps/frely-mcp/check.ts`
- Create: `apps/frely-mcp/check.test.ts`
- Modify: `apps/frely-mcp/index.ts`
- Create: `apps/frely-mcp/cli.test.ts`
- Modify: `apps/frely-mcp/README.md`

**Interfaces:**

```ts
export function readReadyWalletIdentity(walletDir: string): Promise<Identity>;

export function loadApprovedPaymentConfig(
  configPath: string,
  registryPath?: string,
): Promise<Policy>;

export type CheckResult = {
  status: "ready" | "blocked";
  paymentEnabled: boolean;
  providerId: string;
  reason: string | null;
};
```

- [ ] **Step 1: 写只读钱包 RED 测试。**

```ts
test("reads a Ready identity without creating or changing wallet files", async () => {
  const h = await createReadyWalletFixture();
  try {
    const before = await fileSnapshot(h.walletDir);
    const identity = await readReadyWalletIdentity(h.walletDir);
    const after = await fileSnapshot(h.walletDir);
    expect(identity).toEqual({
      network: "hedera:testnet",
      payerAccountId: "0.0.12345",
      keyType: "ecdsa",
      signerRef: "file:" + join(h.walletDir, "agent.key"),
    });
    expect(after).toEqual(before);
  } finally {
    await h.cleanup();
  }
});

async function fileSnapshot(walletDir: string) {
  return Promise.all(["wallet.json", "init-state.json", "agent.key"].map(async name => {
    const path = join(walletDir, name);
    const [info, bytes] = await Promise.all([stat(path), readFile(path)]);
    return { name, mode: info.mode & 0o777, size: info.size, digest: createHash("sha256").update(bytes).digest("hex") };
  }));
}
```

`createReadyWalletFixture()` 使用现有 wallet test-support 在临时目录生成钱包，再保存 `phase:"Ready"`、synthetic accountId 与 verifiedAt，返回 `{walletDir, cleanup}`。测试导入 `stat`、`readFile`、`createHash` 和 `join`；任何断言失败仍执行 cleanup。

- [ ] **Step 2: 运行钱包 RED。**

Run: `bun test packages/wallet/agent-wallet/read-ready.test.ts`

Expected: FAIL，因为只读入口尚不存在。

- [ ] **Step 3: 实现只读 Ready 读取。**

把现有 local-wallet 的严格 JSON、权限、owner、symlink 和文件元数据读取抽成未从 package index 导出的 `readExistingWalletFiles(walletDir, { readSecret: boolean })`；`openLocalWallet` 使用 `readSecret:true`，`readReadyWalletIdentity` 使用 `readSecret:false`，避免在拿到并校验 402 前读取私钥。只读入口不得创建目录、文件、SQLite 锁或链上请求。只有 `state.phase === "Ready"`、`wallet.accountId` 非空、`verifiedAt` 非空、signerRef 指向该钱包的 0600 普通 key 文件时返回公开 Identity；真正的私钥解析与公钥匹配仍由现有 file signer 在签名前最后执行。其余统一 `WALLET_NOT_READY`。

把 `loadApprovedPaymentConfig` 改为优先使用显式 `registryPath`；只有调用方未传时才沿用 `FRELY_PAYMENT_REGISTRY`。测试并行执行时不得修改全局 env 来切换 registry。

- [ ] **Step 4: 写 check RED 测试。**

```ts
test("check is read-only and never contacts Relay", async () => {
  const calls: string[] = [];
  const h = createCheckHarness({
    networkResolve: async () => { calls.push("network"); return successFixture; },
    relayFetch: async () => { calls.push("relay"); throw new Error("FORBIDDEN"); },
  });
  const result = await checkFrelyMcp(h.configPath, h.ports);
  expect(result.status).toBe("ready");
  expect(calls).toEqual(["network"]);
  expect(h.signCalls()).toBe(0);
  expect(h.journalCreated()).toBe(false);
  await h.cleanup();
});
```

- [ ] **Step 5: 运行 check RED。**

Run: `bun test apps/frely-mcp/check.test.ts`

Expected: FAIL，因为 check 尚不存在。

- [ ] **Step 6: 实现三个 CLI 入口。**

CLI 路由固定为：

```text
frely-mcp wallet init --network hedera:testnet [wallet options]
frely-mcp check --config /absolute/config.json
frely-mcp start --config /absolute/config.json
```

`wallet init` 调用现有 `apps/agent-cli/index.ts` 导出的 `main()`；不得实现第二套钱包流程。`check` 依次读取外层配置、确认两个 env 引用存在、读取 Ready wallet、读取 payment profile、比较 payer/signer/provider/resource，然后调用一次 Network resolve；它不打开 journal、不调用 Relay、不签名。profile 为 disabled 时返回 `status:"ready", paymentEnabled:false`，不擅自改成 enabled。

`start` 加载配置和 profile，创建 runtime，再用官方 `StdioServerTransport` 连接。付款 executor 的 `ports.checkNetwork` 先调用 `readReadyWalletIdentity` 并比较 payerAccountId 与 signerRef，再调用既有 Hedera network check；该顺序发生在 402 与预算通过之后、私钥读取之前。除 MCP 协议外不写 stdout。退出时关闭 journal/runtime。启动不触发 resolve 或付款。

- [ ] **Step 7: 验证 CLI 输出边界。**

Run: `bun test apps/frely-mcp/cli.test.ts apps/frely-mcp/check.test.ts packages/wallet/agent-wallet/read-ready.test.ts packages/payment/hedera-x402/config.test.ts`

Expected: 三个命令解析 PASS；check 无 Relay/签名/journal 副作用；start 的 stdout 只有 MCP 帧；错误只含固定 code。

- [ ] **Step 8: 提交 CLI。**

```bash
git add apps/frely-mcp packages/wallet/agent-wallet packages/payment/hedera-x402/approval.ts packages/payment/hedera-x402/config.test.ts
git commit -m "feat(mcp): add wallet check and stdio CLI"
```

## FMCPPLAN-005 — Task 4：构建并验证 npm tarball

Status: Draft
Review level: L3
Source: FMCP-008、FMCP-010

**Files:**

- Create: `apps/frely-mcp/build-package.ts`
- Create: `apps/frely-mcp/package.test.ts`
- Modify: `apps/frely-mcp/package.json`
- Modify: `.gitignore`
- Modify: `bun.lock`

**Interfaces:**

- Consumes: 完整 CLI entrypoint。
- Produces: `apps/frely-mcp/dist/frely-mcp.js` 和可安装但尚未发布的 `.tgz`。

- [ ] **Step 1: 写 package RED 测试。**

```ts
test("packed artifact is a Bun CLI without workspace dependencies or secrets", async () => {
  const packed = await buildAndPack();
  const manifest = await Bun.file(join(packed.unpackDir, "package/package.json")).json();
  expect(manifest.name).toBe("frely-mcp");
  expect(manifest.bin).toEqual({ "frely-mcp": "dist/frely-mcp.js" });
  expect(JSON.stringify(manifest.dependencies ?? {})).not.toContain("workspace:");
  expect(packed.files).toEqual(["README.md", "dist/frely-mcp.js", "package.json"]);
  expect((await run([join(packed.installDir, "node_modules/.bin/frely-mcp"), "--help"], packed.installDir)).exitCode).toBe(0);
  await packed.cleanup();
});
```

测试文件同时实现下面两个 helper，不依赖全局安装状态：

```ts
type CommandResult = { exitCode: number; stdout: string; stderr: string };
async function run(command: string[], cwd: string): Promise<CommandResult> {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env } });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function buildAndPack(): Promise<{
  unpackDir: string;
  installDir: string;
  files: string[];
  cleanup(): Promise<void>;
}> {
  const temporary = await mkdtemp(join(tmpdir(), "frely-mcp-pack-"));
  const unpackDir = join(temporary, "unpacked");
  const installDir = join(temporary, "installed");
  await mkdir(unpackDir);
  await mkdir(installDir);
  const built = await run([process.execPath, "build-package.ts"], import.meta.dir);
  if (built.exitCode !== 0) throw new Error("PACKAGE_BUILD_FAILED");
  const packed = await run(["npm", "pack", "--json"], import.meta.dir);
  if (packed.exitCode !== 0) throw new Error("PACKAGE_BUILD_FAILED");
  const metadata = JSON.parse(packed.stdout)[0] as {
    filename: string;
    files: Array<{ path: string }>;
  };
  const archive = join(import.meta.dir, metadata.filename);
  if ((await run(["tar", "-xzf", archive, "-C", unpackDir], temporary)).exitCode !== 0) {
    throw new Error("PACKAGE_BUILD_FAILED");
  }
  if ((await run(["npm", "install", "--ignore-scripts", archive], installDir)).exitCode !== 0) {
    throw new Error("PACKAGE_BUILD_FAILED");
  }
  return {
    unpackDir,
    installDir,
    files: metadata.files.map(file => file.path).sort(),
    cleanup: async () => {
      await rm(temporary, { recursive: true, force: true });
      await rm(archive, { force: true });
    },
  };
}
```

该测试导入 `mkdtemp`、`mkdir`、`rm`、`tmpdir` 和 `join`。它不得读取或复制用户配置目录，也不可用仓库源码直接替代解包后的 bin。

- [ ] **Step 2: 运行 package RED。**

Run: `bun test apps/frely-mcp/package.test.ts`

Expected: FAIL，因为构建脚本和发布 manifest 尚未完成。

- [ ] **Step 3: 实现单文件 Bun 构建。**

`build-package.ts` 使用 `Bun.build` 把 CLI 与 workspace 代码打进 `dist/frely-mcp.js`，target=`bun`、format=`esm`、minify=true。构建后保证第一行是 `#!/usr/bin/env bun`、权限 0755；构建日志不得包含环境变量值。

发布 manifest 固定：

```json
{
  "name": "frely-mcp",
  "version": "0.1.0",
  "type": "module",
  "bin": { "frely-mcp": "dist/frely-mcp.js" },
  "files": ["dist", "README.md"],
  "engines": { "bun": ">=1.4.0" },
  "os": ["darwin", "linux"],
  "publishConfig": { "access": "public" }
}
```

最终 manifest 不列 `workspace:*` 运行依赖。`.gitignore` 忽略 `apps/frely-mcp/dist/` 和本地 `.tgz`，但测试在临时目录中检查产物。

- [ ] **Step 4: 构建、打包和临时安装。**

Run:

```bash
bun apps/frely-mcp/build-package.ts
cd apps/frely-mcp
npm pack --json
```

然后在 `mktemp -d` 创建的目录中安装该 tarball，运行 `bunx --bun frely-mcp --help` 与一个 fake Network 的 stdio handshake。不得运行 `npm publish`。

Expected: tarball 只含 manifest、README 和单个 CLI；临时安装后列出两个 tools。

- [ ] **Step 5: 全仓回归。**

Run: `bun run check`

Expected: typecheck PASS；全仓测试 PASS。若旧 `apps/broker-mcp` 路径仍被脚本引用，只修正明确引用，不保留第二个 MCP app。

- [ ] **Step 6: 提交打包能力。**

```bash
git add apps/frely-mcp/package.json apps/frely-mcp/build-package.ts apps/frely-mcp/package.test.ts .gitignore bun.lock
git commit -m "build(mcp): produce installable Bun package"
```

## FMCPPLAN-006 — Task 5：双路径 synthetic 联合验收

Status: Draft
Review level: L3
Source: FMCP-004、FMCP-009、FMCP-010

**Files:**

- Create: `apps/frely-mcp/full-chain.test.ts`
- Create: `apps/frely-mcp/fixtures/full-chain-preload.ts`
- Create: `docs/verification/2026-09-11-frely-mcp-mvp-acceptance.md`

**Interfaces:**

- Consumes: 打包后的 MCP、真实 resolve v1 接口兼容 fixture、Relay 官方 x402 synthetic gate。
- Produces: 一次同 requestId 的无成本端到端证据和重复调用证据。

- [ ] **Step 1: 写联合 RED 测试。**

本任务在两条功能分支都完成后执行：从共享契约提交创建 `integration/frely-mcp-mvp-acceptance` worktree，只合并 `feat/frely-service-mvp` 与 `feat/frely-local-mcp-mvp`，不合并 `main`、不推送。测试通过 Bun `--preload` 把全局 fetch 路由到两个进程内 fixture：Network 端使用真实 `createCapabilityServiceFetch` 加 fake resolver；Relay 端使用官方 x402 server 加 synthetic Facilitator。配置仍使用 `https://network.example` 和 `https://relay.example/v1/responses`，因此产品代码的公网 HTTPS 校验不放宽，测试 hook 也不会进入 tarball。

随后从临时安装的打包产物启动 stdio MCP，并执行：

```ts
const visionArguments = (requestId: string) => ({
  capabilities: ["vision"],
  task: "Describe the image",
  input: { image_url: "https://images.example/demo.png" },
  payment: {
    requestId,
    budget: { network: "hedera:testnet", asset: "0.0.0", maxAmountAtomic: "1000000" },
  },
});
const h = await createFullChainHarness();
try {
  const found = await h.client.callTool({ name: "find_capability", arguments: { capabilities: ["vision"] } });
  expect(found.isError).not.toBe(true);

  const first = await h.client.callTool({ name: "use_capability", arguments: visionArguments("mvp-e2e-1") });
  expect(first.structuredContent).toMatchObject({
    identityVerificationSource: "frely-network",
    paymentOutcome: { paymentStatus: "settled", serviceStatus: "succeeded" },
    output: { output_text: "synthetic vision result" },
  });

  const repeated = await h.client.callTool({ name: "use_capability", arguments: visionArguments("mvp-e2e-1") });
  expect(repeated.structuredContent).toEqual(first.structuredContent);
  expect(h.counts()).toEqual({ resolve: 3, sign: 1, settle: 1, dispatch: 1 });
} finally {
  await h.close();
}
```

`createFullChainHarness()` 在同一测试文件中返回 `{client, counts, close}`：client 用 `bun --preload <full-chain-preload.ts> <installed-bin> start --config <temp-config>` 启动临时安装目录中的 tarball bin；counts 从 preload 写入的临时 JSON 事件文件读取；close 关闭 MCP transport 并删除临时目录。

`resolve:3` 来自一次 find 和两次 use；重复 use 仍重新发现，但 payer journal 不重新签名、结算或执行业务。

- [ ] **Step 2: 运行联合 RED。**

Run: `bun test apps/frely-mcp/full-chain.test.ts`

Expected: 在 fixture 或 tarball 尚未接齐时 FAIL；不得改成直接调用内部 runtime 来规避打包入口。

- [ ] **Step 3: 接齐 fixture 与打包入口。**

fixture 只使用 synthetic 账户、交易 ID 和输出。Network fixture 只看到 capability 请求；Relay fixture 只看到业务请求与 payment header；断言两端都没有收到私钥、wallet path 或另一端 API Key。付款 pending 用例必须返回 `PAYMENT_UNKNOWN`，且第二次调用只查询原 synthetic 交易，不重新签名或 settle。

- [ ] **Step 4: 运行最终无成本验证。**

Run:

```bash
bun test apps/frely-mcp/full-chain.test.ts
bun run check
```

Expected: 全链 synthetic 测试、全仓测试和类型检查 PASS；计数固定为 sign=1、settle=1、dispatch=1。

- [ ] **Step 5: 写验收记录。**

记录实施分支 commit、Relay 分支 commit、tarball 文件清单、测试命令、退出码、请求计数和以下结论边界：

```text
MCP install/handshake: verified
Network resolve contract: verified against fixture and service tests
Wallet/profile gate: verified without exposing secrets
x402 verify/settle ordering: synthetic verified
Business result: synthetic verified
npm registry publication: not executed
real 0.01 HBAR settlement: not authorized and not executed
```

- [ ] **Step 6: 提交联合验收。**

```bash
git add apps/frely-mcp/full-chain.test.ts docs/verification/2026-09-11-frely-mcp-mvp-acceptance.md
git commit -m "test(mcp): verify packaged synthetic full chain"
```
