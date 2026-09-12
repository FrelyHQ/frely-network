---
title: 静态 Provider Hedera x402 全链路 MVP 实施计划
mdq:
  profile: project-governance/governed-document-v1
---
# 静态 Provider Hedera x402 全链路 MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不使用 The Graph、ENS 或 ERC-8004 的前提下，让本地 `frely-mcp` 向本地 Network 完成一次精确 1 HBAR Hedera Testnet x402 付款，由 Network 在结算后安全调用 `https://api.frely.cloud/v1/responses`，完成可回放、可核验的 OCR 业务链路。

**Architecture:** 两条开发路径都在 `frely-network` 仓库并通过固定契约汇合：路径 A 是 `frely-mcp`、Agent Wallet、payer journal 和 x402 client；路径 B 是本地 Network 的静态 resolve、官方 x402 Resource Server、Blocky 结算和结算后 Relay 调度。Relay 与 Swarm 只承接普通业务请求，不包含付款代码；所有无 HBAR 付款检查通过后，才执行一次需用户单独授权的真实付款。

**Tech Stack:** Bun 1.4、TypeScript、Zod 4.5.4、官方 MCP TypeScript SDK 1.30.0、`@x402/core@2.25.0`、`@x402/hedera@2.25.0`、Hedera Testnet、Blocky、SQLite payer journal、Frely Relay、Frely Swarm。

**Spec:** [本地 Network 静态 Provider 与 Hedera x402 全链路 MVP 设计](../specs/2026-09-12-local-network-static-provider-x402-e2e-design.md)

**Document Governance:** 本计划落实 FXE2E-002 的文档范围与 governed frontmatter；
当前环境没有 `mdq` 可执行文件，因此提交前执行 YAML、ID、链接、术语和结构检查，
但不声称通过了外部 profile 校验。

## Global Constraints

- 实施基线是 `frely-network` 的 `integration/frely-mcp-mvp-acceptance@45cfd54` 和 Swarm 的 `main@3fb9371`；Relay 的 `feat/x402-resource-mvp@52e286d` 不进入本方案，也不部署。执行前重新核对工作树和 HEAD，不覆盖用户未提交改动。
- `resolve v2` 只表示 `static_allowlist`，必须返回 `identityVerified: false`；不得填造 ENS、chain ID、registry 或 `verified: true`。
- 本地 Network 只监听 `http://127.0.0.1:13600`；MCP 只接受该字面 origin，不接受 localhost、IPv6、局域网地址、其他端口或重定向。
- 唯一 x402 resource 是 `http://127.0.0.1:13600/v1/responses`；唯一远程上游是 `https://api.frely.cloud/v1/responses`，唯一外部模型是 `vision-basic`。Host Agent 和 Network 响应均不能覆盖两个地址。
- 付款固定为 x402 v2 `exact`、`hedera:testnet`、HBAR `0.0.0`、`100000000` tinybar、payer `0.0.10386782`、payTo `0.0.10403579`、fee payer `0.0.7162784`、Blocky `https://api.testnet.blocky402.com`。
- MCP → Network key、Network → Relay caller key、Swarm service token、Swarm Agent key 和 Provider credential 必须分离。已在聊天中出现的 Relay key 必须在远程测试前撤销并轮换。
- `find_capability` 不读取钱包、不调用 Relay；`frely-mcp check` 不签名、不付款、不调用 Relay；`use_capability` 只请求本地 Network，并且只有通过 resolve、白名单、报价、预算、余额和 signer 检查后才读取私钥。
- MCP 保持本地 stdio；stdout 只输出 MCP 消息，诊断写 stderr。工具继续使用 `find_capability` 与 `use_capability` 两个既有名称，不为比赛改名或增加 resources、prompts、远程 MCP、分页和通用市场接口。
- 全部 x402 client/server、Blocky、报价、结算、请求绑定和恢复代码位于 `frely-network`。Relay 不返回 402、不解析付款头、不调用 Blocky、不保存付款状态。
- Network Resource Server 使用进程内付款占位；真实付款与回放期间不得重启 Network。跨 Network 重启服务端幂等不在 MVP 内，MCP payer journal 仍必须持久。
- 无 HBAR 付款 gate 全部通过后，仍须再次向用户展示网络、payer、payTo、金额和 resource，并取得对单次 1 HBAR 的明确授权。计划、测试、部署或 402 均不构成付款授权。
- 不执行 npm publish、git push、main merge、Mainnet、自动退款或自动重试；这些动作需要独立范围和授权。

---

## FXPLAN-001 — 文件结构、路径与并发关系

Status: Draft
Review level: L3
Source: FXE2E-001 至 FXE2E-015；当前三个本地仓库

| 路径 | 文件 | 职责 | 任务 |
| --- | --- | --- | --- |
| 共享契约门 | `packages/protocol/capability-resolution/index.ts`、`fixtures/static-success-v2.json` | 新增并严格解析 Provider 元数据与本地执行地址，保留 v1 原语义 | 1 |
| 共享契约门 | `packages/protocol/shared-types/index.ts`、`packages/broker/execution/request.ts` | 区分身份验证与静态白名单授权，不伪造 verified | 1 |
| 路径 B：Network 服务端 | `apps/capability-service/static-resolver.ts`、`runtime.ts`、`service.ts`、`index.ts` | 固定 loopback Network、唯一 Provider 元数据与本地执行地址 | 2 |
| 路径 A：MCP payer | `apps/frely-mcp/config.ts`、`network-client.ts`、`runtime.ts`、`server.ts`、`check.ts` | 静态 v2 client、MCP 工具和只调用 Network 的白名单门禁 | 3 |
| 路径 A：MCP payer | `packages/payment/hedera-x402/*`、`packages/wallet/agent-wallet/read-ready.ts`、MCP fixtures | 精确金额、余额保留额、body hash、payer journal 和 synthetic 验收 | 4 |
| 路径 B：Network 服务端 | `packages/gateway/x402/*`、`apps/capability-service/upstream.ts`、`service.ts`、`runtime.ts` | 官方 Resource Server、Blocky 结算、请求绑定和 settled-before-Relay | 5 |
| 远端业务链 | Relay/Swarm 当前部署配置与 `docs/runbooks/static-provider-x402-deploy.md` | 轮换密钥、配置无 x402 的 `vision-basic` route | 6 |
| 联合验收 | `scripts/static-provider-e2e/*`、`docs/verification/2026-09-12-static-provider-x402-e2e.md` | G0 至 G12 无 HBAR 付款及真实付款证据 | 7、8 |

Task 1 是两条路径的共享契约门。之后路径 A 执行 Task 3-4，路径 B 执行 Task 2、5，
可使用同一基线的两个独立 worktree 并发开发；Task 6 等待 Network 上游契约冻结，
但不包含 x402 代码。Task 7 等待两条本地路径和远程业务 route 就绪；Task 8 等待
Task 7 全部通过及用户单次付款授权。Swarm 不设第三条代码路径，只做配置和回归。

## Task 1 — FXPLAN-002：新增 resolve v2 与静态授权语义

Status: Draft
Review level: L3
Source: FXE2E-005、FXE2E-006、FXE2E-012 G1-G2

**Files:**

- Modify: `packages/protocol/capability-resolution/index.ts`
- Modify: `packages/protocol/capability-resolution/index.test.ts`
- Create: `packages/protocol/capability-resolution/fixtures/static-success-v2.json`
- Modify: `packages/protocol/shared-types/index.ts`
- Modify: `packages/broker/execution/request.ts`
- Modify: `packages/broker/execution/index.test.ts`

**Interfaces:**

- Consumes: 现有 v1 `ResolveCapabilitiesRequest`、`ResolvedCapability` 和 identity parser；不改变它们的字段或 `verified: true` 语义。
- Produces: `StaticResolveCapabilitiesRequest`、`StaticResolvedCapability`、`parseStaticResolveCapabilitiesRequest(value)`、`parseStaticResolvedCapability(value)`，以及内部执行字段 `authorizationSource?: "identity_verified" | "static_allowlist"`。

- [ ] **Step 1: 写 resolve v2 RED 测试和精确 fixture。**

`static-success-v2.json` 内容固定为：

```json
{
  "schemaVersion": 2,
  "requestedCapabilities": ["vision"],
  "provider": {
    "id": "frely-vision-basic",
    "endpoint": "https://api.frely.cloud/v1/responses",
    "protocol": "responses"
  },
  "execution": {
    "endpoint": "http://127.0.0.1:13600/v1/responses",
    "managedBy": "network"
  },
  "resolution": {
    "source": "static_allowlist",
    "identityVerified": false
  },
  "payment": {
    "supportsX402": true,
    "network": "hedera:testnet",
    "resource": "http://127.0.0.1:13600/v1/responses"
  }
}
```

在 `index.test.ts` 增加：

```ts
import staticSuccess from "./fixtures/static-success-v2.json";
import {
  parseStaticResolveCapabilitiesRequest,
  parseStaticResolvedCapability,
} from "./index.ts";

test("accepts the static resolve v2 pair without an identity claim", () => {
  expect(parseStaticResolveCapabilitiesRequest({
    schemaVersion: 2,
    capabilities: ["vision"],
    paymentNetwork: "hedera:testnet",
  }).capabilities).toEqual(["vision"]);
  expect(parseStaticResolvedCapability(staticSuccess).resolution).toEqual({
    source: "static_allowlist",
    identityVerified: false,
  });
});

test("rejects identity claims and endpoint drift in static v2", () => {
  for (const change of [
    { resolution: { source: "static_allowlist", identityVerified: true } },
    { provider: { ...staticSuccess.provider, id: "other" } },
    { provider: { ...staticSuccess.provider, endpoint: "https://other.example/v1/responses" } },
    { execution: { ...staticSuccess.execution, endpoint: "http://127.0.0.1:13601/v1/responses" } },
    { payment: { ...staticSuccess.payment, network: "hedera:mainnet" } },
  ]) {
    expect(() => parseStaticResolvedCapability({ ...staticSuccess, ...change }))
      .toThrow("INVALID_RESPONSE");
  }
});
```

- [ ] **Step 2: 运行协议 RED。**

Run: `bun test packages/protocol/capability-resolution/index.test.ts`

Expected: FAIL，明确显示 v2 类型、parser 或 fixture 尚不存在；v1 测试必须继续通过。

- [ ] **Step 3: 实现并列的严格 v2 parser。**

在现有 v1 代码旁新增，不把 v1 响应解释成静态信任：

```ts
export type StaticResolveCapabilitiesRequest = {
  schemaVersion: 2;
  capabilities: ["vision"];
  paymentNetwork: "hedera:testnet";
};

export type StaticResolvedCapability = {
  schemaVersion: 2;
  requestedCapabilities: ["vision"];
  provider: {
    id: "frely-vision-basic";
    endpoint: "https://api.frely.cloud/v1/responses";
    protocol: "responses";
  };
  execution: {
    endpoint: "http://127.0.0.1:13600/v1/responses";
    managedBy: "network";
  };
  resolution: {
    source: "static_allowlist";
    identityVerified: false;
  };
  payment: {
    supportsX402: true;
    network: "hedera:testnet";
    resource: "http://127.0.0.1:13600/v1/responses";
  };
};
```

Zod schema使用 `.strict()`，并把字段值收窄到上述字面量。两个 parser 在 Zod
失败时分别抛 `INVALID_REQUEST` 和 `INVALID_RESPONSE`。`CapabilityResolutionErrorCode`
增加 `STATIC_PROVIDER_NOT_CONFIGURED`，但 v1 parser、v1 fixture 和 v1 测试不改名。

- [ ] **Step 4: 写内部静态授权 RED 测试。**

在 `packages/broker/execution/index.test.ts` 增加：

```ts
test("accepts only an explicitly static-authorized provider when verified is false", async () => {
  const execute = createFrelyExecutor(config, async () =>
    Response.json({ output_text: "static-ok" }));
  await expect(execute({
    ...provider,
    verified: false,
    authorizationSource: "static_allowlist",
  }, request)).resolves.toBeDefined();
  await expect(execute({ ...provider, verified: false }, request))
    .rejects.toThrow("IDENTITY_VERIFICATION_FAILED");
});
```

`provider`、`request` 和 `config` 复用该测试文件已有常量，不创建第二套网络调用。

- [ ] **Step 5: 实现不伪造身份的执行授权。**

给 `ResolvedProvider` 增加可选字段：

```ts
authorizationSource?: "identity_verified" | "static_allowlist";
```

在 `prepareFrelyRequest` 中保持既有 identity 路径，并显式允许静态路径：

```ts
const identityAuthorized = provider.verified === true;
const staticAuthorized = provider.verified === false
  && provider.authorizationSource === "static_allowlist";
if (!identityAuthorized && !staticAuthorized) {
  throw new Error("IDENTITY_VERIFICATION_FAILED");
}
```

该字段只是 Broker 内部执行输入。Host Agent 不能直接构造 `ResolvedProvider`；后续
Task 3 只有完成精确白名单比较后才能产生 `static_allowlist`。

- [ ] **Step 6: 运行共享契约 GREEN。**

Run: `bun test packages/protocol/capability-resolution packages/broker/execution && bun run typecheck`

Expected: v1 和 v2 协议测试 PASS；identity 与 static 两种内部授权测试 PASS；类型检查 PASS。

- [ ] **Step 7: 提交契约门。**

```bash
git add packages/protocol/capability-resolution packages/protocol/shared-types packages/broker/execution
git commit -m "feat(protocol): add static capability resolution v2"
```

## Task 2 — FXPLAN-003：路径 B 建立本地静态 Network

Status: Draft
Review level: L3
Source: FXE2E-003、FXE2E-005、FXE2E-012 G1

**Files:**

- Create: `apps/capability-service/static-resolver.ts`
- Create: `apps/capability-service/static-resolver.test.ts`
- Modify: `apps/capability-service/service.ts`
- Modify: `apps/capability-service/service.test.ts`
- Modify: `apps/capability-service/runtime.ts`
- Modify: `apps/capability-service/runtime.test.ts`
- Modify: `apps/capability-service/index.ts`
- Modify: `apps/capability-service/index.test.ts`

**Interfaces:**

- Consumes: Task 1 的 `StaticResolveCapabilitiesRequest`、`StaticResolvedCapability` 和两个 static parser。
- Produces: `createStaticCapabilityResolver(config)` 与只监听 `127.0.0.1:13600` 的 `createCapabilityServiceRuntime(environment)`。

- [ ] **Step 1: 写静态 resolver RED 测试。**

```ts
import { expect, test } from "bun:test";
import { createStaticCapabilityResolver } from "./static-resolver.ts";

const resolver = createStaticCapabilityResolver({
  providerId: "frely-vision-basic",
  endpoint: "https://api.frely.cloud/v1/responses",
  executionEndpoint: "http://127.0.0.1:13600/v1/responses",
});

test("returns the one static vision provider without identity fields", async () => {
  const result = await resolver.resolve({
    schemaVersion: 2,
    capabilities: ["vision"],
    paymentNetwork: "hedera:testnet",
  });
  expect(result.resolution).toEqual({
    source: "static_allowlist",
    identityVerified: false,
  });
  expect(JSON.stringify(result)).not.toMatch(/ensName|registry|chainId/);
});
```

再测试 Provider ID、endpoint 缺失或不精确时构造器抛
`STATIC_PROVIDER_NOT_CONFIGURED`；请求版本、能力或网络不符时抛
`CAPABILITY_NOT_SUPPORTED` 或 `INVALID_REQUEST`，且没有 Graph/RPC dependency 可调用。

- [ ] **Step 2: 运行静态 resolver RED。**

Run: `bun test apps/capability-service/static-resolver.test.ts`

Expected: FAIL，因为 `static-resolver.ts` 尚不存在。

- [ ] **Step 3: 实现最小静态 resolver。**

```ts
export function createStaticCapabilityResolver(config: {
  providerId: string;
  endpoint: string;
  executionEndpoint: string;
}) {
  if (
    config.providerId !== "frely-vision-basic"
    || config.endpoint !== "https://api.frely.cloud/v1/responses"
    || config.executionEndpoint !== "http://127.0.0.1:13600/v1/responses"
  ) throw new Error("STATIC_PROVIDER_NOT_CONFIGURED");

  return {
    async resolve(request: StaticResolveCapabilitiesRequest): Promise<StaticResolvedCapability> {
      if (
        request.schemaVersion !== 2
        || request.paymentNetwork !== "hedera:testnet"
        || request.capabilities.length !== 1
        || request.capabilities[0] !== "vision"
      ) throw new Error("CAPABILITY_NOT_SUPPORTED");
      return parseStaticResolvedCapability({
        schemaVersion: 2,
        requestedCapabilities: ["vision"],
        provider: {
          id: "frely-vision-basic",
          endpoint: "https://api.frely.cloud/v1/responses",
          protocol: "responses",
        },
        execution: {
          endpoint: "http://127.0.0.1:13600/v1/responses",
          managedBy: "network",
        },
        resolution: { source: "static_allowlist", identityVerified: false },
        payment: {
          supportsX402: true,
          network: "hedera:testnet",
          resource: "http://127.0.0.1:13600/v1/responses",
        },
      });
    },
  };
}
```

- [ ] **Step 4: 切换 HTTP service 和 runtime 到 v2。**

`service.ts` 使用 `parseStaticResolveCapabilitiesRequest` 解析请求，并把
`STATIC_PROVIDER_NOT_CONFIGURED` 映射为 503 的无细节 JSON 错误。保留 64 KiB body
上限、`cache-control: no-store`、等长 Bearer 比较、health/ready 路由和通用 500
脱敏。

`runtime.ts` 删除 Graph、ENS 和 ERC-8004 的运行时构造，按以下精确规则读取环境：

```ts
const mode = required(environment, "FRELY_NETWORK_MODE");
const providerId = required(environment, "FRELY_STATIC_PROVIDER_ID");
const endpoint = required(environment, "FRELY_STATIC_PROVIDER_ENDPOINT");
const executionEndpoint = required(environment, "FRELY_NETWORK_EXECUTION_URL");
const apiKey = required(environment, "FRELY_SERVICE_API_KEY");
if (mode !== "static-local") throw new Error("SERVICE_CONFIG_INVALID");
if (providerId !== "frely-vision-basic") throw new Error("STATIC_PROVIDER_NOT_CONFIGURED");
if (endpoint !== "https://api.frely.cloud/v1/responses") {
  throw new Error("STATIC_PROVIDER_NOT_CONFIGURED");
}
if (executionEndpoint !== "http://127.0.0.1:13600/v1/responses") {
  throw new Error("STATIC_PROVIDER_NOT_CONFIGURED");
}
const host = environment.HOST?.trim() || "127.0.0.1";
const port = environment.PORT?.trim() || "13600";
if (host !== "127.0.0.1" || port !== "13600") throw new Error("SERVICE_CONFIG_INVALID");
```

不读取 `GRAPH_ENDPOINT`、`ENS_SEPOLIA_RPC_URL` 或
`ERC8004_IDENTITY_REGISTRY`。保留旧 v1 parser 和 Graph resolver 源码作为未调用的
legacy 模块，本任务不删除相关包或重构历史代码。

- [ ] **Step 5: 更新 service/runtime/index 测试。**

测试必须证明：无 Bearer 为 401；v1 请求为 400；v2 精确请求为 200；错误体不含
API Key 或 endpoint；health/ready 为 200；设置 `HOST=0.0.0.0`、`PORT=13601`、
错误 Provider ID、错误上游 endpoint 或错误 execution endpoint 均在 `Bun.serve` 前失败。

- [ ] **Step 6: 运行路径 B Network GREEN。**

Run: `bun test apps/capability-service packages/protocol/capability-resolution && bun run typecheck`

Expected: capability service 与协议测试 PASS；类型检查 PASS；resolve 测试进程没有 Graph、RPC 或 Relay 请求。

- [ ] **Step 7: 提交本地 Network。**

```bash
git add apps/capability-service
git commit -m "feat(network): resolve the static Frely provider"
```

## Task 3 — FXPLAN-004：路径 A 改造本地 MCP 静态信任边界

Status: Draft
Review level: L3
Source: FXE2E-006、FXE2E-007、FXE2E-012 G2、G8、G11-G12

**Files:**

- Modify: `apps/frely-mcp/config.ts`
- Modify: `apps/frely-mcp/config.test.ts`
- Modify: `apps/frely-mcp/network-client.ts`
- Modify: `apps/frely-mcp/network-client.test.ts`
- Modify: `apps/frely-mcp/runtime.ts`
- Modify: `apps/frely-mcp/runtime.test.ts`
- Modify: `apps/frely-mcp/server.ts`
- Modify: `apps/frely-mcp/server.test.ts`
- Modify: `apps/frely-mcp/check.ts`
- Modify: `apps/frely-mcp/check.test.ts`
- Modify: `apps/frely-mcp/index.ts`
- Modify: `apps/frely-mcp/fixtures/fake-server.ts`
- Modify: `apps/frely-mcp/fixtures/network-server.ts`
- Modify: `apps/frely-mcp/fixtures/payment-server.ts`
- Modify: `packages/broker/execution/request.ts`
- Modify: `packages/broker/execution/index.test.ts`

**Interfaces:**

- Consumes: Task 1 的 v2 parser 和 `authorizationSource`，Task 2 的真实 loopback service。
- Produces: `FrelyMcpConfig` v2、`FrelyNetworkClient.resolve(["vision"])`、只调用 Network execution endpoint 且返回 `resolutionSource: "static_allowlist"` 和 `identityVerified: false` 的两个 MCP tools。

- [ ] **Step 1: 写配置与 client RED 测试。**

有效配置对象固定使用：

```ts
const base = {
  schemaVersion: 2,
  network: {
    mode: "static-local",
    baseUrl: "http://127.0.0.1:13600",
    apiKeyRef: "env:FRELY_NETWORK_API_KEY",
  },
  approvedProvider: {
    id: "frely-vision-basic",
    endpoint: "https://api.frely.cloud/v1/responses",
  },
  approvedExecution: {
    endpoint: "http://127.0.0.1:13600/v1/responses",
  },
  walletDir,
  paymentConfigPath,
  paymentRegistryPath,
};
```

`config.test.ts` 对 `localhost`、`127.0.0.1:13601`、`https` Network、额外字段、
旧 chain/registry/relay 字段、嵌入式 secret、错误 env ref、相对路径、Provider drift
和 execution drift 逐个断言 `CONFIG_INVALID`。

`network-client.test.ts` 断言发送 v2 请求、`redirect: "error"`、Network 专用
Bearer，以及对 Provider ID、上游 endpoint、本地 execution endpoint、protocol、
capabilities、payment network、payment resource、`resolution.source` 和
`identityVerified` 任一漂移的拒绝。

- [ ] **Step 2: 运行配置/client RED。**

Run: `FRELY_NETWORK_API_KEY=network-test-only bun test apps/frely-mcp/config.test.ts apps/frely-mcp/network-client.test.ts`

Expected: FAIL，因为当前代码仍要求公网 HTTPS Network、chain ID、registry 和 v1 响应。

- [ ] **Step 3: 实现精确配置和 v2 client。**

配置类型固定为：

```ts
export type FrelyMcpConfig = {
  schemaVersion: 2;
  network: {
    mode: "static-local";
    baseUrl: "http://127.0.0.1:13600";
    apiKeyRef: "env:FRELY_NETWORK_API_KEY";
  };
  approvedProvider: {
    id: "frely-vision-basic";
    endpoint: "https://api.frely.cloud/v1/responses";
  };
  approvedExecution: {
    endpoint: "http://127.0.0.1:13600/v1/responses";
  };
  walletDir: string;
  paymentConfigPath: string;
  paymentRegistryPath: string;
};
```

同时把 Broker 执行配置收窄为 Network client 语义：

```ts
export type ExecutionConfig = {
  mode: "static-local";
  networkKey: string;
  origin: "http://127.0.0.1:13600";
};
```

`prepareFrelyRequest` 只接受 Provider 内部执行 endpoint 精确为
`http://127.0.0.1:13600/v1/responses`，用 `networkKey` 生成 Network Bearer。它不再
要求 HTTPS，不接受其他 HTTP 地址，也不存在 Relay caller key。`createStartExecutor`
从 `config.network.apiKeyRef` 读取该 key；删除对 `config.relay.apiKeyRef` 的读取。

`FrelyNetworkClient` 构造器同时接收 `network`、`approvedProvider` 和
`approvedExecution`。它只向
`/v1/capabilities/resolve` 发 10 秒、无重定向、1 MiB 上限的 v2 请求。解析后调用
一个 `assertStaticAuthorization`，逐字段比较 v2 结果与本地配置。任何 HTTP、JSON、
超限、重定向或非已知服务错误都映射为 `NETWORK_UNAVAILABLE`；不记录请求头或响应
正文。

- [ ] **Step 4: 写 runtime/MCP RED 测试。**

把现有 identity 断言替换为：

```ts
expect(result).toMatchObject({
  provider: { id: "frely-vision-basic" },
  resolutionSource: "static_allowlist",
  identityVerified: false,
  paymentOutcome: { paymentStatus: "settled" },
});
```

新增测试证明：Provider ID、上游 endpoint 或本地 execution endpoint 漂移时
executor 构造次数、sign 次数和 Network execution 次数均为零；`find_capability`
不构造 executor；相同 requestId 但图片、任务、预算或 Provider 任一变化时返回
冲突且无第二次付款。

图片 URL 只接受无凭据的公网 HTTPS hostname；拒绝 `http:`、localhost、`.local`
和 IP 字面量。验收图片仍由 Task 7 以最终 HTTPS URL 和内容 hash 固定。

- [ ] **Step 5: 实现 runtime、tools 与 check。**

`authorizeProvider` 必须同时比较 v2 static 字段、本地 `approvedProvider` 和付款
policy：

```ts
if (
  resolved.provider.id !== config.approvedProvider.id
  || resolved.provider.endpoint !== config.approvedProvider.endpoint
  || resolved.execution.endpoint !== config.approvedExecution.endpoint
  || resolved.execution.endpoint !== policy.resourceUrl
  || resolved.payment.resource !== policy.resourceUrl
  || resolved.provider.protocol !== "responses"
  || resolved.execution.managedBy !== "network"
  || resolved.resolution.source !== "static_allowlist"
  || resolved.resolution.identityVerified !== false
  || resolved.payment.network !== "hedera:testnet"
  || policy.network !== "hedera:testnet"
) throw new Error("PROVIDER_NOT_AUTHORIZED");
```

传入现有 Broker 的对象固定为：

```ts
{
  id: resolved.provider.id,
  endpoint: resolved.execution.endpoint,
  protocol: "responses",
  verified: false,
  authorizationSource: "static_allowlist",
}
```

MCP 返回值不得保留 `identityVerificationSource` 或 `ensName`；改为
`resolutionSource` 和 `identityVerified: false`。两个工具继续用现代
`registerTool`、Zod 输入、JSON text 和 `structuredContent`。补齐 title、精确
description、现有 annotations；`find_capability` 的描述必须出现“static allowlist”
而不能出现“verified provider”。`use_capability` 保持 `destructiveHint: true` 和
仅对完全相同调用成立的 `idempotentHint: true`。

`checkFrelyMcp` 读取 Network secret reference、Ready wallet、付款 policy 并调用
本地 resolve；它不打开 journal、不调用 execution endpoint 或 Relay、不签名。
错误响应只返回稳定 code。

- [ ] **Step 6: 运行 MCP GREEN。**

Run: `bun test apps/frely-mcp packages/broker/execution packages/protocol/capability-resolution && bun run typecheck`

Expected: 配置、client、runtime、stdio 工具、只读 check 和 Broker 授权测试 PASS；输出中没有 ENS/registry/verified 身份声明。

- [ ] **Step 7: 提交静态 MCP。**

```bash
git add apps/frely-mcp packages/broker/execution packages/protocol/shared-types
git commit -m "feat(mcp): authorize the static Frely provider"
```

## Task 4 — FXPLAN-005：路径 A 固定付款金额、余额保留额和 synthetic 全链

Status: Draft
Review level: L3
Source: FXE2E-007、FXE2E-010、FXE2E-012 G4、G7-G9、G11

**Files:**

- Modify: `packages/payment/hedera-x402/types.ts`
- Modify: `packages/payment/hedera-x402/config.ts`
- Modify: `packages/payment/hedera-x402/config.test.ts`
- Modify: `packages/payment/hedera-x402/preflight.ts`
- Modify: `packages/payment/hedera-x402/preflight.test.ts`
- Modify: `packages/payment/hedera-x402/network.ts`
- Modify: `packages/payment/hedera-x402/network.test.ts`
- Modify: `packages/payment/hedera-x402/live.ts`
- Modify: `packages/payment/hedera-x402/session.ts`
- Modify: `packages/payment/hedera-x402/session.test.ts`
- Modify: `packages/wallet/agent-wallet/types.ts`
- Modify: `packages/wallet/agent-wallet/read-ready.ts`
- Modify: `packages/wallet/agent-wallet/read-ready.test.ts`
- Modify: `apps/frely-mcp/index.ts`
- Modify: `apps/frely-mcp/check.test.ts`
- Modify: `apps/frely-mcp/cli.test.ts`
- Modify: `apps/frely-mcp/runtime.test.ts`
- Modify: `apps/frely-mcp/start-gate.test.ts`
- Modify: `apps/frely-mcp/full-chain.test.ts`
- Modify: `apps/frely-mcp/fixtures/payment-server.ts`
- Modify: `apps/frely-mcp/fixtures/full-chain-preload.ts`
- Modify: `packages/payment/hedera-x402/test-support.ts`
- Modify: `packages/payment/hedera-x402/file-signer.test.ts`
- Modify: `packages/payment/hedera-x402/verifier.test.ts`
- Modify: `packages/broker/payment/index.test.ts`
- Modify: `scripts/payment-spike/fixtures/spec-derived/policy.json`
- Modify: `scripts/payment-spike/fixtures/synthetic/policy.json`

**Interfaces:**

- Consumes: Task 3 的静态 Provider 和既有 payer session/journal。
- Produces: `Policy.amountAtomic`、Ready wallet 的 `reserveTinybar`、带 body hash 的付款 payload，以及 `100000000` tinybar synthetic 全链证据。

- [ ] **Step 1: 写精确金额与 reserve RED 测试。**

`Policy` fixture 增加 `amountAtomic: "100000000"`。新增断言：

```ts
test("requires the quote to equal the policy amount", () => {
  const lower = validInput();
  lower.http.paymentRequired.accepts[0].amount = "99999999";
  expect(preflight(lower)).toMatchObject({
    decision: "blocked",
    reason: "NO_ACCEPTABLE_QUOTE",
  });
});

test("requires payer balance to cover amount plus wallet reserve", async () => {
  const check = createNetworkCheck(policy, fixture.fetch, {
    payerReserveAtomic: "10000000",
  });
  fixture.setPayerBalance("109999999");
  await expect(check(selection)).rejects.toThrow("NETWORK_CHECK_FAILED");
  fixture.setPayerBalance("110000000");
  await expect(check(selection)).resolves.toBeUndefined();
});

test("allows only the exact loopback Network payment resource", () => {
  expect(validPolicy({
    ...raw,
    resourceUrl: "http://127.0.0.1:13600/v1/responses",
  })).toBe(true);
  for (const resourceUrl of [
    "http://localhost:13600/v1/responses",
    "http://127.0.0.1:13601/v1/responses",
    "https://api.frely.cloud/v1/responses",
  ]) expect(validPolicy({ ...raw, resourceUrl })).toBe(false);
});
```

- [ ] **Step 2: 运行付款 RED。**

Run: `bun test packages/payment/hedera-x402/preflight.test.ts packages/payment/hedera-x402/network.test.ts packages/wallet/agent-wallet/read-ready.test.ts`

Expected: FAIL，因为 Policy 没有精确金额字段，Ready identity 也没有 reserve。

- [ ] **Step 3: 实现金额、reserve 和 body hash 约束。**

给 `Policy` 增加 `amountAtomic: string`，配置白名单和 `validPolicy` 要求它是大于零
的规范整数字符串。把通用公网 `secureUrl` 与 Network resource 校验分开：
facilitator 和 Mirror 继续只接受 HTTPS；`resourceUrl` 只接受字面值
`http://127.0.0.1:13600/v1/responses`。`quoteReason` 在预算比较前要求：

```ts
if (quote.amount !== policy.amountAtomic) return "POLICY_MISMATCH";
```

`Identity` 增加 `reserveTinybar: string`；`readReadyWalletIdentity` 从已验证 snapshot 的
`state.limits.reserveTinybar` 返回它，不读取 secret。`createNetworkCheck` 接受可选
第三参数 `{ payerReserveAtomic: string }`，HBAR payer 最低余额使用：

```ts
const requiredPayerBalance = integer(q.amount)
  + integer(options.payerReserveAtomic);
if (id === policy.payerAccountId && balance < requiredPayerBalance) {
  throw new Error("NETWORK_CHECK_FAILED");
}
```

`wrapPaymentPorts` 在 402 和预算通过后读取 Ready identity，核对 payer/signer，再把
wallet reserve 传给 `live.checkNetwork`。签名仍发生在网络检查之后。

在 `session.ts` 编码付款头前，把业务 body 的 SHA-256 加入 payment payload
extensions：

```ts
const boundPayload = {
  ...signed.payload,
  extensions: {
    ...(signed.payload.extensions ?? {}),
    bodySha256: createHash("sha256").update(request.body).digest("hex"),
  },
};
paidHeaders.set("PAYMENT-SIGNATURE", encodePaymentSignatureHeader(boundPayload));
```

- [ ] **Step 4: 更新 packaged synthetic 全链。**

把 fixture 的 Network 响应改为 v2，包含远端 Provider 元数据和本地 execution
endpoint；金额和工具预算改为 `100000000`，synthetic 输出改为
`FRELY X402 OK`。fixture 的 402 必须由 Network execution endpoint 返回，Relay
fixture 只在模拟 settlement 成功后被 Network 调用。断言首次调用：

```ts
expect(first.structuredContent).toMatchObject({
  resolutionSource: "static_allowlist",
  identityVerified: false,
  paymentOutcome: { paymentStatus: "settled", serviceStatus: "succeeded" },
  output: { output_text: "FRELY X402 OK" },
});
expect(await h.counts()).toMatchObject({
  networkQuote: 1,
  sign: 1,
  networkSettle: 1,
  relayDispatch: 1,
});
```

完全相同回放必须等于首次 structuredContent，且 sign、Network settle 和 Relay
dispatch 不增加；相同 requestId 修改任务、图片或预算必须冲突且计数不增加；
pending 回放只增加 Mirror 查询，不增加 sign、Network settle 或 Relay dispatch。

- [ ] **Step 5: 运行路径 A 完整验证和包检查。**

Run: `bun run check`

Expected: TypeScript 检查 PASS；全仓 Bun 测试零失败。

Run: `bun apps/frely-mcp/build-package.ts && cd apps/frely-mcp && npm pack --dry-run`

Expected: 构建 PASS；tarball 清单不含钱包、journal、`.env`、私钥、真实 key 或本地验收目录，且无 `workspace:*` 运行依赖。

- [ ] **Step 6: 提交精确付款与 synthetic 验收。**

```bash
git add packages/payment packages/wallet/agent-wallet apps/frely-mcp scripts/payment-spike/fixtures
git commit -m "test(mcp): lock the one-HBAR static provider flow"
```

## Task 5 — FXPLAN-006：路径 B 在 Network 建立 x402 Resource Server

Status: Draft
Review level: L3
Source: FXE2E-008、FXE2E-010、FXE2E-012 G3、G5-G9

本任务只在 `frely-network` 的 Network 服务端实现付款。Relay 的
`feat/x402-resource-mvp@52e286d` 不合并、不部署，也不作为运行依赖。

**Files:**

- Modify: `packages/gateway/x402/package.json`
- Modify: `packages/gateway/x402/index.ts`
- Create: `packages/gateway/x402/index.test.ts`
- Create: `apps/capability-service/upstream.ts`
- Create: `apps/capability-service/upstream.test.ts`
- Modify: `apps/capability-service/package.json`
- Modify: `apps/capability-service/service.ts`
- Modify: `apps/capability-service/service.test.ts`
- Modify: `apps/capability-service/runtime.ts`
- Modify: `apps/capability-service/runtime.test.ts`

**Interfaces:**

- Consumes: Task 2 的 loopback Network、规格冻结的 `extensions.bodySha256` 契约、官方 `x402ResourceServer`、`x402HTTPResourceServer`、`ExactHederaScheme` 和 Blocky `HTTPFacilitatorClient`。
- Produces: `createNetworkX402Gate(config)`、`readNetworkX402Config(env)`、`createRelayUpstream(config)`，以及只有 settled 后才调用 Relay 的 `/v1/responses`。

- [ ] **Step 1: 写 Network 付款边界 RED 测试。**

在 `packages/gateway/x402/index.test.ts` 增加：

```ts
test("returns 402 from Network without calling the upstream", async () => {
  const h = await createNetworkX402Harness();
  const admission = await h.gate.admit(h.unsignedRequest, h.body);
  expect(admission.kind).toBe("response");
  if (admission.kind === "response") expect(admission.response.status).toBe(402);
  expect(h.events()).toEqual([]);
});

test("rejects an unbound payment before Blocky or Relay", async () => {
  const h = await createNetworkX402Harness({ omitBodySha256: true });
  const admission = await h.gate.admit(h.signedRequest, h.body);
  expect(admission.kind).toBe("response");
  expect(h.events()).toEqual([]);
});

test("grants Relay dispatch only after Blocky settlement", async () => {
  const h = await createNetworkX402Harness();
  const admission = await h.gate.admit(h.signedRequest, h.body);
  expect(admission.kind).toBe("settled");
  expect(h.events()).toEqual(["verify", "settle"]);
});
```

配置测试必须只接受 `http://127.0.0.1:13600/v1/responses` 作为 resource，只接受
`https://api.testnet.blocky402.com` 作为 Facilitator，并拒绝 localhost、其他端口、
凭据、search/hash、非法账户 ID 和非 `100000000` 金额。

- [ ] **Step 2: 写 Relay 上游隔离 RED 测试。**

```ts
test("forwards no x402 or local authorization headers to Relay", async () => {
  const capture = createRelayCapture(Response.json({ output_text: "FRELY X402 OK" }));
  await createRelayUpstream(config, capture.fetch).invoke(body, "request-1");
  expect(capture.request.headers.get("authorization")).toBe("Bearer upstream-test-key");
  for (const name of [
    "PAYMENT-SIGNATURE",
    "PAYMENT-REQUIRED",
    "PAYMENT-RESPONSE",
  ]) expect(capture.request.headers.has(name)).toBe(false);
});

test("does not relay a second payment requirement", async () => {
  const upstream = createRelayUpstream(config, async () => new Response(null, { status: 402 }));
  await expect(upstream.invoke(body, "request-1"))
    .rejects.toThrow("UPSTREAM_PAYMENT_UNEXPECTED");
});
```

- [ ] **Step 3: 运行 Network Resource Server RED。**

Run: `bun test packages/gateway/x402/index.test.ts apps/capability-service/upstream.test.ts`

Expected: FAIL，因为 Network x402 gate 和 Relay upstream 尚不存在。

- [ ] **Step 4: 实现官方 Network Resource Server。**

`packages/gateway/x402/package.json` 增加精确依赖 `@x402/core: 2.25.0` 和
`@x402/hedera: 2.25.0`。`index.ts` 注册：

```ts
const resourceServer = new x402ResourceServer(facilitator)
  .register("hedera:testnet", new ExactHederaScheme());
const httpServer = new x402HTTPResourceServer(resourceServer, {
  "POST /v1/responses": {
    accepts: {
      scheme: "exact",
      network: "hedera:testnet",
      payTo: "0.0.10403579",
      price: { asset: "0.0.0", amount: "100000000" },
      maxTimeoutSeconds: 120,
      extra: { feePayer: "0.0.7162784", paymentFlow: "upfront" },
    },
    resource: "http://127.0.0.1:13600/v1/responses",
    description: "Frely Network vision-basic",
    mimeType: "application/json",
  },
});
```

从 Relay 分支的已审查实现只迁移通用算法，不复制 Relay 耦合：64 KiB 付款头上限、
requestId + method + resource + body 指纹、必需的小写 64 位 `bodySha256`、verify →
settle 顺序、settle 后进程内单调状态以及 unknown 占位。导出的类型命名为
`NetworkX402Admission` 和 `NetworkX402Gate`。

- [ ] **Step 5: 实现结算后的 Relay upstream。**

`createRelayUpstream` 固定 URL 为 `https://api.frely.cloud/v1/responses`，只在内部读取
`FRELY_RELAY_API_KEY`，使用 30 秒超时、2 MiB 响应上限和 `redirect: "error"`。请求
只包含 `authorization`、`content-type`、`accept` 和 `x-frely-request-id`；body 固定
`model: "vision-basic"`、`stream: false`。Relay 返回 402 时抛
`UPSTREAM_PAYMENT_UNEXPECTED`，其他非 2xx 映射为 `UPSTREAM_FAILED`，不返回上游
header 或正文。

`service.ts` 对 `/v1/responses` 复用现有等长 Network Bearer 校验和 64 KiB body
上限，拒绝非 `vision-basic`、truthy stream 和缺失 requestId。无付款头时直接返回
Network gate 生成的标准 402；只有 `admission.kind === "settled"` 才调用 upstream，
再用 `admission.finish(response)` 加入 `PAYMENT-RESPONSE`。任何未结算分支的 upstream
调用次数必须为零。

- [ ] **Step 6: 运行 Network 服务端 GREEN。**

Run: `bun test packages/gateway/x402 apps/capability-service`

Run: `bun run typecheck`

Expected: Network 402、请求绑定、verify → settle → Relay、上游隔离、resolve、health
和 runtime 测试全部 PASS；没有访问真实 Facilitator、Hedera 或 Relay。

- [ ] **Step 7: 提交 Network x402 服务端。**

```bash
git add packages/gateway/x402 apps/capability-service
git commit -m "feat(network): settle x402 before Relay dispatch"
```

## Task 6 — FXPLAN-007：配置无 x402 的 Relay/Swarm 业务 canary

Status: Draft
Review level: L3
Source: FXE2E-004、FXE2E-008、FXE2E-011、FXE2E-012 G0、G3、G10-G11

该任务会改变远程服务状态，但不会执行 HBAR 付款。执行前必须确认操作者已经获得
`api.frely.cloud` 当前部署机制、管理权限和回滚权限；只找到源代码或本地 Docker
脚本不算生产部署能力。

**Files:**

- Create: `docs/runbooks/static-provider-x402-deploy.md` in the `frely-network` worktree
- No source change: `/Users/bit/projects/FrelyHQ/swarm`
- External state: `vision-basic` AccessPoint、Swarm Provider、restricted keys、deployment secrets

**Interfaces:**

- Consumes: Task 5 冻结的 Network → Relay upstream 契约、Swarm `main@3fb9371`、现有 `gpt-5.6-luna` Provider 路由。
- Produces: 不含 x402 的可回滚 `vision-basic` 业务 canary、私有 Swarm route 和脱敏部署基线。

- [ ] **Step 1: 记录生产基线和真实部署入口。**

只读取得 `/health`、`/v1/models`、当前 release、source SHA、六模型普通调用结果、
部署目标、发布命令来源和回滚命令来源。若无法定位实际机制，记录
`DEPLOYMENT_MECHANISM_UNKNOWN` 并停止 Task 6；不把 `scripts/local-dev.mjs` 当生产
命令。

runbook 必须记录命令来源文件或平台名称，但不记录 token、cookie、key 或私有
拓扑。回滚目标使用执行当天重新读取的 release/source SHA，不直接沿用设计快照。

- [ ] **Step 2: 撤销泄露 key 并建立四个独立凭据域。**

通过现有 Frely 管理入口撤销聊天中出现的 caller key，创建仅能访问
`vision-basic` AccessPoint 的 Network 专用 upstream key。确认并分别保存：

```text
FRELY_NETWORK_API_KEY      本地 Network Bearer
FRELY_RELAY_API_KEY        只由本地 Network 服务端读取，仅 vision-basic
SWARM_ACCESS_TOKEN         Relay 到 Swarm
SWARM_FRELY_API_KEY        Swarm 到 Relay，仅 gpt-5.6-luna
```

Provider credential 继续由 Relay secret store 持有。逐对做负例：Network upstream key 不能
访问基础模型；Swarm key 不能访问 `vision-basic`；Swarm token 不能访问 Relay；
Network upstream key 不能直接访问 Swarm。任何串用都阻止部署继续。MCP 配置和进程
环境中不得出现 `FRELY_RELAY_API_KEY`。

- [ ] **Step 3: 配置 Swarm 与 Relay AccessPoint。**

Swarm 固定：`SWARM_PUBLIC_MODEL=vision-basic`、`MODEL_NAME=gpt-5.6-luna`、
非公网监听、独立 `SWARM_ACCESS_TOKEN`、Relay base URL 和
`SWARM_FRELY_API_KEY`。Relay 将唯一 `vision-basic` Provider 指向 Swarm 的
`/v1/responses`，并创建或更新同名 AccessPoint；不改六个现有模型。

先用 Swarm service token 做私有健康与模型检查，再用 Swarm Agent key 对 Relay
执行一次普通 `gpt-5.6-luna` 调用。两项都成功仍只表示内部路由就绪，不表示 x402
或外部业务闭环。

- [ ] **Step 4: 应用并验证普通业务 route。**

只发布 `vision-basic` AccessPoint、Network upstream key 权限和 Swarm route 配置；
Relay 环境不得新增 `FRELY_X402_*`、Blocky、payTo、fee payer 或 amount 配置，也不
部署 Task 5 的本地 Network commit。发布后再次读取 health、release 和 source SHA，
确认 `/v1/models` 只新增预期的 `vision-basic`。

使用 Network upstream key 直接发一次最小 `vision-basic`、`store:false`、
`stream:false` 请求。它必须返回普通 200 业务响应并经过 Swarm；若返回 402，立即
标记 `RELAY_PAYMENT_BOUNDARY_VIOLATION` 并回滚。该调用可能产生正常 Provider usage，
但不会签名或产生 HBAR 付款。

- [ ] **Step 5: 执行本地 Network 无付款 canary。**

启动 Task 5 的本地 Network，使用本地 Network key 对
`http://127.0.0.1:13600/v1/responses` 发 `store:false`、`stream:false`、固定
requestId 且不带付款头的请求。必须由 Network 收到标准 402，并解码核对 resource、
network、scheme、asset、amount、payTo、fee payer 和 timeout。Relay 与 Swarm
请求日志的增量必须为零。

随后用受限普通模型 key 调用至少一个现有模型，必须仍返回 200。若 402 字段漂移、
Network 在结算前调用 Relay，或普通模型回归，立即按 Step 1 记录的机制回滚。

- [ ] **Step 6: 验证 Swarm 源码回归。**

在 `/Users/bit/projects/FrelyHQ/swarm` 运行：

Run: `bun test && bun run typecheck`

Expected: Swarm 测试和类型检查 PASS；工作树仍干净。本任务不提交 Swarm 代码。

- [ ] **Step 7: 提交脱敏 runbook。**

runbook 记录字段、顺序、失败规则和回滚来源，不写真实 secret。提交：

```bash
git add docs/runbooks/static-provider-x402-deploy.md
git commit -m "docs(runbook): add static provider x402 canary steps"
```

## Task 7 — FXPLAN-008：联合无 HBAR 付款验收和证据门

Status: Draft
Review level: L3
Source: FXE2E-012 G0-G4、G8-G12；FXE2E-013

**Files:**

- Create: `scripts/static-provider-e2e/package.json`
- Create: `scripts/static-provider-e2e/preflight.ts`
- Create: `scripts/static-provider-e2e/preflight.test.ts`
- Create: `scripts/static-provider-e2e/live.ts`
- Create: `scripts/static-provider-e2e/live.test.ts`
- Create: `docs/verification/2026-09-12-static-provider-x402-e2e.md`
- Modify: root `package.json`

**Interfaces:**

- Consumes: 路径 A 的 packaged MCP、路径 B 的本地 Network Resource Server、无 x402 的远程 Relay/Swarm canary、Blocky `/supported`、Hedera Mirror Node。
- Produces: `bun run acceptance:static-preflight`，只执行 G0-G4、G8-G12 的无 HBAR 付款部分并写脱敏 JSON 到 `.local/acceptance/static-provider/preflight.json`。

- [ ] **Step 1: 写付款禁用和脱敏 RED 测试。**

```ts
test("preflight never sends PAYMENT-SIGNATURE", async () => {
  const seen: Request[] = [];
  await runPreflight(testPorts(seen));
  expect(seen.some(request => request.headers.has("PAYMENT-SIGNATURE"))).toBe(false);
});

test("evidence redacts secrets, signatures and local secret paths", () => {
  const publicEvidence = redactEvidence(secretBearingFixture());
  const text = JSON.stringify(publicEvidence);
  for (const forbidden of [
    "Bearer relay-secret",
    "PAYMENT-SIGNATURE",
    "agent.key",
    "signerRef",
    "journalPath",
  ]) expect(text).not.toContain(forbidden);
});
```

- [ ] **Step 2: 运行 preflight RED。**

Run: `bun test scripts/static-provider-e2e/preflight.test.ts`

Run: `bun test scripts/static-provider-e2e/live.test.ts`

Expected: 两个测试都 FAIL，因为 runner 尚不存在。

- [ ] **Step 3: 实现只读 runner。**

`preflight.ts` 只允许以下动作：读取本地 Network v2、读取 Relay health/models、向
本地 Network 发一次无付款头的 `vision-basic` 请求并验证 402、读取 Blocky
`/supported`、读取 payer/payTo Mirror 账户、读取本地 Ready wallet 公开身份、比较
付款 policy 和 Task 6 的远程业务 canary 证据。它不得调用 signer、settle、带付款
头的请求或 `use_capability`。

硬门函数固定为：

```ts
export function assertExactPaymentIntent(input: {
  resource: string;
  network: string;
  asset: string;
  amountAtomic: string;
  payer: string;
  payTo: string;
  feePayer: string;
}): void {
  const expected = {
    resource: "http://127.0.0.1:13600/v1/responses",
    network: "hedera:testnet",
    asset: "0.0.0",
    amountAtomic: "100000000",
    payer: "0.0.10386782",
    payTo: "0.0.10403579",
    feePayer: "0.0.7162784",
  };
  if (JSON.stringify(input) !== JSON.stringify(expected)) {
    throw new Error("PAYMENT_INTENT_MISMATCH");
  }
}
```

payer 余额必须大于等于金额加 wallet reserve。所有 fetch 都使用超时、响应上限和
`redirect: "error"`。runner 输出每个 gate 的 pass/fail、公开账户 ID、quote、
release 和 hash，不输出 key、header、签名、cookie、内部 URL 或本地秘密路径。

根 `package.json` 只增加以下两个脚本，不替换现有脚本：

```json
{
  "acceptance:static-preflight": "bun scripts/static-provider-e2e/preflight.ts",
  "acceptance:static-live": "bun scripts/static-provider-e2e/live.ts"
}
```

`scripts/static-provider-e2e/package.json` 固定 `name` 为
`@frely-network/static-provider-e2e`，设置 `private: true` 和 `type: "module"`，不增加
生产依赖。`live.ts` 在构造 MCP transport 前执行第二道防误触门：

```ts
export function assertLiveAuthorization(value: string | undefined): void {
  if (value !== "I AUTHORIZE ONE 1 HBAR TESTNET PAYMENT") {
    throw new Error("LIVE_PAYMENT_NOT_AUTHORIZED");
  }
}
```

`live.ts` 使用 MCP `Client` 与 `StdioClientTransport`，以 `FRELY_MCP_BIN` 为 command、
`["start", "--config", FRELY_MCP_CONFIG_PATH]` 为 args 启动 packaged MCP，以同一
requestId 调用两次 `use_capability`，并在启动子进程前读取及验证全绿 preflight
证据。它先把 UUID requestId 持久化，再发出首个请求；最后只把脱敏结果写入
`.local/acceptance/static-provider/live.json`。`live.test.ts` 必须证明确认值缺失或
错误时，连 transport 都不会构造。

- [ ] **Step 4: 固定 OCR 图片。**

将最终公开 HTTPS 图片地址写入 `FRELY_ACCEPTANCE_IMAGE_URL`。runner 先 GET 图片，
拒绝重定向，限制 2 MiB，只接受 PNG 或 JPEG，计算 SHA-256，并要求操作者目视确认
图片只包含高对比度文本 `FRELY X402 OK`。URL、content type、字节数和 hash 可进入
脱敏证据；图片获取失败则 G4 不通过。

- [ ] **Step 5: 启动本地 Network 并运行无 HBAR 付款验收。**

启动 Network 时只设置：

```text
FRELY_NETWORK_MODE=static-local
FRELY_STATIC_PROVIDER_ID=frely-vision-basic
FRELY_STATIC_PROVIDER_ENDPOINT=https://api.frely.cloud/v1/responses
FRELY_NETWORK_EXECUTION_URL=http://127.0.0.1:13600/v1/responses
FRELY_SERVICE_API_KEY 取自本地 secret store
FRELY_RELAY_API_KEY 取自 Network 服务端 secret store
FRELY_X402_RESOURCE_URL=http://127.0.0.1:13600/v1/responses
FRELY_X402_AMOUNT_ATOMIC=100000000
FRELY_X402_PAY_TO=0.0.10403579
FRELY_X402_FEE_PAYER=0.0.7162784
FRELY_X402_FACILITATOR_URL=https://api.testnet.blocky402.com
FRELY_UPSTREAM_RELAY_URL=https://api.frely.cloud/v1/responses
HOST=127.0.0.1
PORT=13600
```

Run: `bun run acceptance:static-preflight`

Expected: G0-G4、G8 的测试双、G9 的模拟、G10、G11、G12 全部 PASS；输出明确
`paymentAuthorized=false`、`paymentSent=false`。任一 gate 失败都不进入 Task 8。

- [ ] **Step 6: 运行全仓回归并建立验证记录。**

Run: `bun run check`

Expected: 类型检查与全部 Bun 测试零失败。

验证文档使用 governed profile，逐项记录 G0-G12 的实际状态。本阶段 G5-G7 必须
写 `Not run — awaiting explicit 1 HBAR authorization`，不得写 pass。记录本地证据
文件的 SHA-256，不提交含秘密的原始 JSON。

- [ ] **Step 7: 提交无 HBAR 付款 runner 和验证状态。**

```bash
git add package.json scripts/static-provider-e2e docs/verification/2026-09-12-static-provider-x402-e2e.md
git commit -m "test(e2e): add static provider no-HBAR acceptance gate"
```

## Task 8 — FXPLAN-009：单次真实 1 HBAR、业务结果和零增量回放

Status: Draft
Review level: L3
Source: FXE2E-009、FXE2E-010、FXE2E-012 G5-G7、FXE2E-015

该任务是唯一允许真实付款的任务。Task 7 全部通过并不自动授权本任务。

**Files:**

- Modify: `docs/verification/2026-09-12-static-provider-x402-e2e.md`
- Local evidence only: `.local/acceptance/static-provider/live.json`
- No planned source change: 真实执行暴露缺陷时停止验收，回到 Task 1-7 的对应文件先补 RED 测试，再单独修复

**Interfaces:**

- Consumes: Task 7 的全绿 preflight、用户单次授权、packaged `frely-mcp`、本地 Network Resource Server 和无 x402 的 Relay/Swarm canary。
- Produces: 一个 Mirror 已确认的 1 HBAR transaction、包含 `FRELY X402 OK` 的业务输出、相同 requestId 零额外付款和零额外调度证据。

- [ ] **Step 1: 再次刷新全部时变事实。**

重新读取 Relay health/release/source SHA、`/v1/models`、Blocky `/supported`、payer 与
payTo 账户、payer signer 公钥绑定、余额、Network v2 和 Network 402 quote。核对
Network 在真实付款与回放期间不会重启。任何字段变化都使 Task 7 证据失效，必须重新运行
preflight。

- [ ] **Step 2: 向用户显示最终授权摘要并等待。**

授权摘要必须逐字包含：

```text
Network: hedera:testnet
Asset: HBAR 0.0.0
Amount: 100000000 tinybar (1 HBAR)
Payer: 0.0.10386782
PayTo: 0.0.10403579
Fee payer: 0.0.7162784
Resource: http://127.0.0.1:13600/v1/responses
Upstream: https://api.frely.cloud/v1/responses
Model: vision-basic
```

只有用户在看到这份最新摘要后明确允许本次交易，才能继续 Step 3。沉默、旧授权、
计划批准、部署批准或“继续测试”均不算付款授权。

- [ ] **Step 3: 通过 packaged MCP 发一次真实调用。**

获得 Step 2 的本次授权后，在仓库根目录构建并安装待验收包：

```bash
MCP_ACCEPTANCE_DIR="$(mktemp -d)"
bun apps/frely-mcp/build-package.ts
npm pack --workspace apps/frely-mcp --pack-destination "$MCP_ACCEPTANCE_DIR"
mkdir "$MCP_ACCEPTANCE_DIR/install"
npm install --prefix "$MCP_ACCEPTANCE_DIR/install" --ignore-scripts "$MCP_ACCEPTANCE_DIR/frely-mcp-0.1.0.tgz"
export FRELY_MCP_BIN="$MCP_ACCEPTANCE_DIR/install/node_modules/.bin/frely-mcp"
test -n "$FRELY_MCP_CONFIG_PATH"
test -n "$FRELY_ACCEPTANCE_IMAGE_URL"
export FRELY_LIVE_PAYMENT_CONFIRMATION="I AUTHORIZE ONE 1 HBAR TESTNET PAYMENT"
bun run acceptance:static-live
```

`FRELY_MCP_CONFIG_PATH` 与 `FRELY_ACCEPTANCE_IMAGE_URL` 必须由 Task 7 留在当前受控
shell 中，并与 preflight 证据一致；否则 runner 必须在启动 MCP 或签名前失败。临时
目录只用于安装和运行，不进入 Git；验收结束后保留其路径到证据确认完成，再删除。

用唯一 requestId、Task 7 固定的图片 URL/hash、任务文本
`Read the image and return the exact visible text.`、预算 `100000000` 和
`stream:false` 调用 `use_capability`。不得绕过 MCP 直接构造付款头。

如果返回 `PAYMENT_UNKNOWN`、连接中断或 settle 结果不明，立即停止：只查询原
transactionId，不创建新 requestId、不重新签名、不重发。只有结果明确
`paymentStatus=settled` 且 `serviceStatus=succeeded` 才进入业务断言。

- [ ] **Step 4: 核对结算与业务顺序。**

Mirror 必须确认原 transaction 在 `hedera:testnet` 成功、共识时间存在、payer 向
payTo 转移精确 `100000000` tinybar，并且 transactionId 与 MCP evidence、Blocky
摘要和 `PAYMENT-RESPONSE` 一致。

Network/Relay/Swarm 脱敏 trace 必须证明顺序为 Network settle success → Network
调用 Relay → Relay 调度 Swarm `vision-basic` → Swarm 经 Relay 调用
`gpt-5.6-luna` → Provider response。Relay 不得出现 402、付款头或 Blocky 调用。
最终输出必须包含精确文本 `FRELY X402 OK`。结算成功但业务失败时保留 settled
事实，并把 G6 标为 fail。

- [ ] **Step 5: 执行完全相同回放与冲突负例。**

第一次调用达到 `delivered` 后，以完全相同 requestId、body、图片、预算和 Provider
再次调用 `use_capability`。返回值必须与保存输出相同；本地 sign、Network/Blocky
settle、Mirror 转账、Network 上游请求、Relay 请求日志和 Swarm dispatch 的增量
全部为零。

冲突负例只在测试双执行，不在真实链上使用同 requestId 改 body。真实链不为冲突
测试承担第二笔付款风险。

- [ ] **Step 6: 完成回归、秘密扫描和声明检查。**

再次检查 health、models 和至少一个现有模型调用。扫描 live evidence、日志摘录、
配置和 package 清单，确认没有 API key、私钥、原始签名、可广播交易、本地秘密
路径或内部完整 header。

验收结论只能写“静态 Provider 的真实付款全链路”；必须明确 The Graph、ENS 和
ERC-8004 未参与。任一 G0-G12 未通过，父任务继续保持进行中。

- [ ] **Step 7: 写回真实验证结果并提交公开摘要。**

更新验证文档的 G5-G12 状态、公开 transactionId、Mirror 链接、共识时间、输出
摘要、回放零增量证据和最终 claim boundary。原始脱敏 JSON 留在 `.local`，只提交
不含秘密的摘要：

```bash
git add docs/verification/2026-09-12-static-provider-x402-e2e.md
git commit -m "docs(verification): record static provider x402 acceptance"
```

通过 CLI 更新滴答父任务：写入真实结算、业务、回放和回归的证据摘要。只有 G0-G12
全部通过才把任务标记完成；不归档、不触发与本任务无关的发布、push 或 merge。

## FXPLAN-010 — 完成检查与停止条件

Status: Draft
Review level: L3
Source: FXE2E-010、FXE2E-012、FXE2E-014、FXE2E-015

执行者在结束前逐项核对：

- Task 1 至 Task 5 每个提交都有新鲜测试证据，且两个 `frely-network` 开发工作树只包含授权范围；
- Task 6 有实际部署和回滚机制证据，而不是本地脚本推断；
- Task 7 明确没有签名或付款，并且 G5-G7 保持未执行；
- Task 8 获得最新、单次、精确 1 HBAR 授权；
- settlement、业务结果、完全相同回放和普通模型回归分别有证据；
- `unknown` 没有被猜成失败或成功，也没有产生第二笔潜在交易；
- 验证记录、TickTick 和最终回复都没有把静态 allowlist 写成 Graph/ENS/ERC-8004；
- 未经另行授权，没有 npm publish、push、main merge 或 Mainnet 操作。

## Execution Handoff

计划执行有两种方式：

1. **Subagent-Driven（推荐）**：当前会话为每个代码任务调度独立实现者，并在每个提交后做规格与质量双审查；共享 Task 1 后，路径 A 的 Task 3-4 与路径 B 的 Task 2、5 可并行。
2. **Inline Execution**：在单一执行会话中使用 `superpowers:executing-plans`，按 Task 1-4、Task 5-6、Task 7、Task 8 四个检查点分批执行。

无论选择哪一种，Task 8 都必须停在单次付款授权门前等待用户；不能由执行模式替代授权。
