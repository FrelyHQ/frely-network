---
title: Frely 服务端路径 MVP 实施计划
mdq:
  profile: project-governance/governed-document-v1
---
# Frely 服务端路径 MVP 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Frely Network 返回一个经过 Graph、ENS 与 ERC-8004 验证的 Relay 入口，并让 Relay 通过 Blocky 完成官方 Hedera x402 `verify → settle` 后再调度业务。

**Architecture:** `frely-network` 新增普通 HTTPS capability resolve 服务；它不托管 MCP，也不持有付款私钥。`FrelyHQ/relay` 在既有 `/v1/responses` Gateway 前增加一个固定 Vision 能力的 x402 Resource Server；`FrelyHQ/swarm` 保持既有执行接口，不在本轮改造。

**Tech Stack:** Bun 1.4、TypeScript、现有 The Graph/ENS/ERC-8004 包、`@x402/core@2.25.0`、`@x402/hedera@2.25.0`、Blocky Facilitator、Relay 既有 Gateway、Swarm Responses API。

**Spec:** [Frely 自托管 MCP MVP 设计](../specs/2026-09-11-self-hosted-frely-mcp-design.md)

## Global Constraints

- 实施基线是本地 `B1wl7ch@5ec26e3` 加已确认的设计与计划提交，不用远端 `main` 覆盖本地工作。
- 先完成 Task 1 的共享契约提交；本计划余下任务与本地 MCP 计划才可从该提交分叉并行。
- Network 只接收 capability 查询；禁止接收 `task`、`input`、钱包引用和付款签名。
- Network 不加载 `X402_PRIVATE_KEY`，不代理 Relay 请求，不公开远程 `/mcp`。
- Relay 是 x402 Resource Server；Blocky 仍是 Facilitator；只有 settled 后才能调用既有 Gateway 执行业务。
- MVP 只支持 `vision`、`responses`、`hedera:testnet`、HBAR `0.0.0` 和一个 Relay Resource URL。
- 不新增服务端数据库、分布式协调、多 Provider 授权、流式付费响应或主网支持。
- 本计划只验证 synthetic 付款。新的真实 `0.01 HBAR` 必须在无成本验收通过后再次获得用户明确授权。
- 每个任务使用独立提交；不得在本计划中执行 npm 发布、合并主分支或真实付款。

---

## FSRV-001 — 文件与交付顺序

Status: Draft
Review level: L3
Source: FMCP-003、FMCP-005、FMCP-009

| 仓库 | 文件 | 职责 | 任务 |
| --- | --- | --- | --- |
| frely-network | `packages/protocol/capability-resolution/*` | resolve v1 类型、校验器、错误码、fixture | 1 |
| frely-network | `apps/capability-service/service.ts` | HTTP 路由、Bearer 鉴权、无缓存错误 | 2 |
| frely-network | `apps/capability-service/resolver.ts` | Graph 筛选、ENS/ERC-8004 验证、确定性选择 | 2 |
| frely-network | `apps/capability-service/runtime.ts`、`index.ts` | 从环境组合真实端口并启动服务 | 2 |
| FrelyHQ/relay | `apps/gateway/src/x402-resource.ts` | 官方 x402 HTTP Resource Server 与 Blocky | 3 |
| FrelyHQ/relay | `apps/gateway/src/server.ts` | settled 后才调用既有 executor | 3 |
| FrelyHQ/swarm | 无代码变更 | 参与最终 Responses 业务验收 | 4 |
| frely-network | `docs/verification/2026-09-11-service-mvp-acceptance.md` | 记录三仓无成本验收边界 | 4 |

执行顺序：Task 1 是契约门；完成后 Task 2、Task 3 与本地 MCP 计划可以并行；Task 4 等待服务端两部分完成。

## FSRV-002 — Task 1：冻结 resolve v1 共享契约

Status: Draft
Review level: L3
Source: FMCP-005

**Files:**

- Create: `packages/protocol/capability-resolution/package.json`
- Create: `packages/protocol/capability-resolution/index.ts`
- Create: `packages/protocol/capability-resolution/index.test.ts`
- Create: `packages/protocol/capability-resolution/fixtures/success.json`
- Create: `packages/protocol/capability-resolution/fixtures/no-provider.json`
- Modify: `bun.lock`

**Interfaces:**

- Consumes: 无业务实现，只消费 JSON 值。
- Produces: `parseResolveCapabilitiesRequest(value): ResolveCapabilitiesRequest`、`parseResolvedCapability(value): ResolvedCapability`、`CapabilityResolutionErrorCode`。

稳定类型只有以下字段：

```ts
export type ResolveCapabilitiesRequest = {
  schemaVersion: 1;
  capabilities: string[];
  paymentNetwork: "hedera:testnet";
};

export type ResolvedCapability = {
  schemaVersion: 1;
  requestedCapabilities: string[];
  provider: {
    id: string;
    ensName: string;
    endpoint: string;
    protocol: "responses";
  };
  identity: {
    verified: true;
    chainId: 11155111;
    registry: `0x${string}`;
  };
  payment: {
    supportsX402: true;
    network: "hedera:testnet";
  };
};

export type CapabilityResolutionErrorCode =
  | "INVALID_REQUEST"
  | "UNAUTHORIZED"
  | "NO_PROVIDER"
  | "NETWORK_DISCOVERY_FAILED"
  | "IDENTITY_VERIFICATION_FAILED"
  | "CAPABILITY_NOT_SUPPORTED";
```

- [ ] **Step 1: 写契约 RED 测试。**

```ts
import { expect, test } from "bun:test";
import success from "./fixtures/success.json";
import {
  parseResolveCapabilitiesRequest,
  parseResolvedCapability,
} from "./index.ts";

test("accepts the frozen resolve v1 pair", () => {
  expect(parseResolveCapabilitiesRequest({
    schemaVersion: 1,
    capabilities: ["vision"],
    paymentNetwork: "hedera:testnet",
  }).capabilities).toEqual(["vision"]);
  expect(parseResolvedCapability(success).provider.protocol).toBe("responses");
});

test("rejects executable but unverified or unsafe responses", () => {
  for (const change of [
    { identity: { ...success.identity, verified: false } },
    { provider: { ...success.provider, endpoint: "http://127.0.0.1/v1/responses" } },
    { provider: { ...success.provider, protocol: "mcp" } },
    { payment: { ...success.payment, network: "hedera:mainnet" } },
  ]) expect(() => parseResolvedCapability({ ...success, ...change })).toThrow("INVALID_RESPONSE");
});
```

- [ ] **Step 2: 运行 RED。**

Run: `bun test packages/protocol/capability-resolution/index.test.ts`

Expected: FAIL，因为 `index.ts` 和 fixture 尚不存在；语法或 Bun 版本错误不算有效 RED。

- [ ] **Step 3: 实现严格校验器和 fixture。**

`parseResolveCapabilitiesRequest` 必须拒绝额外字段、空数组、空白 capability、重复 capability 和非 Testnet。`parseResolvedCapability` 必须拒绝额外字段、无效或零地址 registry、未验证身份、非 `responses`、非 x402、非 Testnet 和不安全 endpoint。请求与响应 capability 是否相等由 Network client 在拿到两者后检查。

endpoint 判定固定为：`https:`、无 username/password/search/hash，hostname 不是 `localhost` 或 `.local`，也不是 IPv4/IPv6 loopback、link-local 或 RFC1918 字面地址。MVP 不增加 DNS pinning；本地 MCP 后续还会要求 endpoint 与唯一授权 profile 完全相等。

```ts
import { isIP } from "node:net";
import { z } from "zod";

const capabilities = z.array(z.string().trim().min(1)).min(1)
  .refine(values => new Set(values).size === values.length);
const safeEndpoint = (value: string): boolean => {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:"
      && !url.username && !url.password && !url.search && !url.hash
      && host !== "localhost" && !host.endsWith(".local") && isIP(host) === 0;
  } catch {
    return false;
  }
};
const registry = z.string().regex(/^0x[0-9a-f]{40}$/i)
  .refine(value => !/^0x0{40}$/i.test(value));
const requestSchema = z.object({
  schemaVersion: z.literal(1),
  capabilities,
  paymentNetwork: z.literal("hedera:testnet"),
}).strict();
const responseSchema = z.object({
  schemaVersion: z.literal(1),
  requestedCapabilities: capabilities,
  provider: z.object({
    id: z.string().trim().min(1),
    ensName: z.string().trim().min(1),
    endpoint: z.string().refine(safeEndpoint),
    protocol: z.literal("responses"),
  }).strict(),
  identity: z.object({
    verified: z.literal(true),
    chainId: z.literal(11155111),
    registry,
  }).strict(),
  payment: z.object({
    supportsX402: z.literal(true),
    network: z.literal("hedera:testnet"),
  }).strict(),
}).strict();

export function parseResolveCapabilitiesRequest(value: unknown): ResolveCapabilitiesRequest {
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success) throw new Error("INVALID_REQUEST");
  return parsed.data;
}

export function parseResolvedCapability(value: unknown): ResolvedCapability {
  const parsed = responseSchema.safeParse(value);
  if (!parsed.success) throw new Error("INVALID_RESPONSE");
  return parsed.data as ResolvedCapability;
}
```

`success.json` 使用规格 FMCP-005 的成功响应；`no-provider.json` 固定为：

```json
{"code":"NO_PROVIDER"}
```

`package.json` 使用 `name=@frely-network/capability-resolution`、`private=true`、`type=module`、`exports=./index.ts`、`types=./index.ts`，运行依赖只增加仓库已使用的 `zod: 4.5.4`。

- [ ] **Step 4: 运行 GREEN 和类型检查。**

Run: `bun test packages/protocol/capability-resolution/index.test.ts && bun run typecheck`

Expected: 契约测试 PASS；全仓类型检查 PASS。

- [ ] **Step 5: 提交契约门。**

```bash
git add packages/protocol/capability-resolution bun.lock
git commit -m "feat(protocol): freeze capability resolution v1"
```

该提交哈希是两条路径的共同起点。用 `superpowers:using-git-worktrees` 从它创建 `feat/frely-service-mvp` 与 `feat/frely-local-mcp-mvp`；不要从 `origin/main` 重新起分支。

## FSRV-003 — Task 2：实现 Frely Network capability 服务

Status: Draft
Review level: L3
Source: FMCP-003、FMCP-005、FMCP-010

**Files:**

- Create: `apps/capability-service/package.json`
- Create: `apps/capability-service/service.ts`
- Create: `apps/capability-service/service.test.ts`
- Create: `apps/capability-service/resolver.ts`
- Create: `apps/capability-service/resolver.test.ts`
- Create: `apps/capability-service/runtime.ts`
- Create: `apps/capability-service/index.ts`
- Modify: `bun.lock`

**Interfaces:**

- Consumes: Task 1 的 `ResolveCapabilitiesRequest` 与 `ResolvedCapability`。
- Produces: `createCapabilityServiceFetch(options)` 和 `createCapabilityResolver(deps)`。

```ts
export type CapabilityResolver = {
  resolve(request: ResolveCapabilitiesRequest): Promise<ResolvedCapability>;
};

export function createCapabilityServiceFetch(options: {
  apiKey: string;
  resolver: CapabilityResolver;
}): (request: Request) => Promise<Response>;
```

- [ ] **Step 1: 写 HTTP 边界 RED 测试。**

```ts
import { expect, test } from "bun:test";
import success from "../../packages/protocol/capability-resolution/fixtures/success.json";
import { parseResolvedCapability } from "@frely-network/capability-resolution";
import { createCapabilityServiceFetch } from "./service.ts";

test("exposes resolve only after bearer authentication", async () => {
  const fetcher = createCapabilityServiceFetch({
    apiKey: "network-secret",
    resolver: { resolve: async () => parseResolvedCapability(success) },
  });
  const denied = await fetcher(new Request("https://network.example/v1/capabilities/resolve", { method: "POST" }));
  expect(denied.status).toBe(401);
  const response = await fetcher(new Request("https://network.example/v1/capabilities/resolve", {
    method: "POST",
    headers: { authorization: "Bearer network-secret", "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, capabilities: ["vision"], paymentNetwork: "hedera:testnet" }),
  }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(success);
  expect((await fetcher(new Request("https://network.example/mcp", { method: "POST" }))).status).toBe(404);
});
```

- [ ] **Step 2: 运行 HTTP RED。**

Run: `bun test apps/capability-service/service.test.ts`

Expected: FAIL，因为 service 尚不存在。

- [ ] **Step 3: 实现最小 HTTP 服务。**

路由只允许 `GET /healthz`、`GET /readyz` 和 `POST /v1/capabilities/resolve`。请求体上限 64 KiB；`Content-Type` 必须是 JSON；响应统一 `cache-control: no-store`。Bearer 值使用等长字节和 `timingSafeEqual` 比较。错误映射固定如下：

| 情况 | HTTP | body.code |
| --- | ---: | --- |
| 鉴权失败 | 401 | `UNAUTHORIZED` |
| JSON/契约失败 | 400 | `INVALID_REQUEST` |
| 无候选 | 404 | `NO_PROVIDER` |
| Graph 失败 | 502 | `NETWORK_DISCOVERY_FAILED` |
| 身份全部失败 | 502 | `IDENTITY_VERIFICATION_FAILED` |
| 能力不匹配 | 422 | `CAPABILITY_NOT_SUPPORTED` |
| 未识别异常 | 500 | `INTERNAL_ERROR` |

错误响应不得包含异常 message、URL、API Key、RPC、候选详情或堆栈。

- [ ] **Step 4: 写 resolver RED 测试。**

```ts
import { expect, test } from "bun:test";
import { createCapabilityResolver } from "./resolver.ts";

test("sorts candidates and returns the first identity-verified x402 Relay", async () => {
  const seen: string[] = [];
  const resolver = createCapabilityResolver({
    findProviders: async () => [
      { id: "2", ensName: "z.example.eth", capabilities: ["vision"], supportsX402: true },
      { id: "1", ensName: "a.example.eth", capabilities: ["vision"], supportsX402: true },
    ],
    resolveProvider: async candidate => {
      seen.push(candidate.id);
      if (candidate.id === "1") throw new Error("IDENTITY_VERIFICATION_FAILED");
      return { id: "2", ensName: "z.example.eth", endpoint: "https://relay.example/v1/responses", protocol: "responses", verified: true };
    },
    chainId: 11155111,
    registry: "0x1111111111111111111111111111111111111111",
    allowedRelayOrigin: "https://relay.example",
  });
  const result = await resolver.resolve({ schemaVersion: 1, capabilities: ["vision"], paymentNetwork: "hedera:testnet" });
  expect(seen).toEqual(["1", "2"]);
  expect(result.provider.id).toBe("2");
});
```

- [ ] **Step 5: 运行 resolver RED。**

Run: `bun test apps/capability-service/resolver.test.ts`

Expected: FAIL，因为 resolver 尚不存在。

- [ ] **Step 6: 实现确定性选择与真实 runtime。**

resolver 先保留包含全部 requested capabilities 且 `supportsX402=true` 的候选，再按 `ensName.toLowerCase() + "\\0" + id` 排序。按顺序调用现有 `ProviderIdentityResolver.resolveProvider`；身份失败只尝试下一个候选，其他 Graph 失败不降级为假候选。已验证 endpoint 的 origin 必须等于 `allowedRelayOrigin`，保证执行入口是比赛配置的 Relay，而不是 Swarm 或最终模型 Provider。返回前用 Task 1 的 `parseResolvedCapability` 自校验。

```ts
for (const candidate of matching.sort(compareCandidate)) {
  try {
    const provider = await deps.resolveProvider(candidate);
    if (new URL(provider.endpoint).origin !== deps.allowedRelayOrigin) {
      throw new Error("IDENTITY_VERIFICATION_FAILED");
    }
    return parseResolvedCapability({
      schemaVersion: 1,
      requestedCapabilities: [...request.capabilities],
      provider: {
        id: provider.id,
        ensName: provider.ensName,
        endpoint: provider.endpoint,
        protocol: provider.protocol,
      },
      identity: { verified: true, chainId: deps.chainId, registry: deps.registry },
      payment: { supportsX402: true, network: "hedera:testnet" },
    });
  } catch (error) {
    if (!(error instanceof Error) || !["IDENTITY_VERIFICATION_FAILED", "ENDPOINT_NOT_HTTPS", "PROTOCOL_NOT_SUPPORTED"].includes(error.message)) throw error;
  }
}
throw new Error("IDENTITY_VERIFICATION_FAILED");
```

`runtime.ts` 只读取 `GRAPH_ENDPOINT`、`ENS_SEPOLIA_RPC_URL`、`ERC8004_IDENTITY_REGISTRY`、`FRELY_SERVICE_API_KEY`、`FRELY_ALLOWED_RELAY_ORIGIN`、`HOST` 和 `PORT`。Relay origin 必须是无凭据、无 path/search/hash 的公网 HTTPS origin。runtime 组合现有 `createGraphDiscovery`、`createEnsReader`、`ViemErc8004Reader` 与 `ProviderIdentityResolver`；不得读取任何 `X402_*` 私钥变量。

`apps/capability-service/package.json` 使用 `name=@frely-network/capability-service`、`private=true`、`type=module`，只依赖 `@frely-network/capability-resolution`、`@frely-network/the-graph`、`@frely-network/ens` 和 `@frely-network/erc8004` 的 `workspace:*`。`index.ts` 只做端口校验、runtime 组合与 `Bun.serve`，默认绑定 `127.0.0.1:4100`。

- [ ] **Step 7: 运行服务测试。**

Run: `bun test apps/capability-service packages/protocol/capability-resolution && bun run typecheck`

Expected: HTTP 与 resolver 测试 PASS；类型检查 PASS。

- [ ] **Step 8: 提交 Network 服务。**

```bash
git add apps/capability-service bun.lock
git commit -m "feat(network): add verified capability resolve service"
```

## FSRV-004 — Task 3：在 Relay 增加官方 x402 Resource Server

Status: Draft
Review level: L3
Source: FMCP-003、FMCP-004、FMCP-009

本任务在 `FrelyHQ/relay` 的独立 worktree/branch `feat/x402-resource-mvp` 执行。先记录实际 `main` commit；若远端已变化，重新核对 `apps/gateway/src/server.ts` 的入口，再按本任务接口落位。参考已审查实现：frely-network 的 `feat/hedera-auto-payment@4ff5a5e:scripts/payment-spike/mock-gateway.ts`；不要复制其中固定测试输出。

**Files:**

- Create: `apps/gateway/src/x402-resource.ts`
- Create: `apps/gateway/src/x402-resource.test.ts`
- Modify: `apps/gateway/src/server.ts`
- Modify: `apps/gateway/package.json`
- Modify: root lockfile

**Interfaces:**

```ts
export type X402Admission =
  | { kind: "response"; response: Response }
  | { kind: "settled"; finish(response: Response): Promise<Response> };

export type RelayX402Gate = {
  admit(request: Request, body: string): Promise<X402Admission>;
};

export async function createRelayX402Gate(config: {
  resourceUrl: string;
  amountAtomic: string;
  payTo: string;
  feePayer: string;
  facilitatorUrl: string;
  facilitator?: FacilitatorClient;
}): Promise<RelayX402Gate>;
```

- [ ] **Step 1: 加入锁定版本依赖。**

在 `apps/gateway/package.json` 增加 `@x402/core: 2.25.0` 与 `@x402/hedera: 2.25.0`，运行 Relay 仓库规定的 Bun 1.4 安装命令并只审查 lockfile 的对应变化。

- [ ] **Step 2: 写 Resource Server RED 测试。**

测试用注入的 Facilitator 记录事件，必须固定下面四个断言：

```ts
const h = await createX402TestHarness();
expect((await h.gate.admit(h.unsignedRequest, h.body)).kind).toBe("response");
expect(h.events()).toEqual(["quote"]);
expect(h.dispatches()).toBe(0);

const admitted = await h.gate.admit(h.signedRequest, h.body);
expect(admitted.kind).toBe("settled");
expect(h.events()).toEqual(["quote", "verify", "settle", "settled"]);
expect(h.dispatches()).toBe(0);

if (admitted.kind === "settled") {
  h.recordDispatch();
  const response = await admitted.finish(Response.json({ output_text: "synthetic" }));
  expect(response.headers.get("PAYMENT-RESPONSE")).toBeTruthy();
}
expect(h.dispatches()).toBe(1);
```

`createX402TestHarness()` 在测试文件中返回 `{gate, body, unsignedRequest, signedRequest, events, dispatches, recordDispatch}`；signedRequest 使用官方 header encoder 和固定 synthetic transaction 构造，Facilitator 的 `verify`、`settle` 每次调用都先把同名事件加入数组。

同文件再验证：verify 拒绝时 settle=0、dispatch=0；`settlement_pending` 时 settle=1、dispatch=0；相同 `x-frely-request-id` 的第二个已付款请求返回 409 且 dispatch 仍为 1；签名中的 resource/amount/payTo/feePayer 任一变化都不能调用 Blocky。

- [ ] **Step 3: 运行 Resource Server RED。**

Run: `bun test apps/gateway/src/x402-resource.test.ts`

Expected: FAIL，因为 `createRelayX402Gate` 尚不存在。

- [ ] **Step 4: 用官方服务端组件实现 gate。**

实现必须实例化以下官方对象：

```ts
const facilitator = config.facilitator
  ?? new HTTPFacilitatorClient({ url: config.facilitatorUrl, timeoutMs: 12_000 });
const resourceServer = new x402ResourceServer(facilitator).register(
  "hedera:testnet",
  new ExactHederaScheme(),
);
const httpServer = new x402HTTPResourceServer(resourceServer, {
  ["POST " + new URL(config.resourceUrl).pathname]: {
    accepts: {
      scheme: "exact",
      network: "hedera:testnet",
      payTo: config.payTo,
      price: { asset: "0.0.0", amount: config.amountAtomic },
      maxTimeoutSeconds: 120,
      extra: { feePayer: config.feePayer, paymentFlow: "upfront" },
    },
    resource: config.resourceUrl,
    description: "Frely vision-basic",
    mimeType: "application/json",
  },
});
await httpServer.initialize();
```

请求必须绑定 `POST`、完整 resource URL、body SHA-256、`x-frely-request-id` 和 64 KiB payment header 上限。只接受 v2 exact Hedera 报价的完整字段匹配。`processHTTPRequest` 返回 `payment-verified` 且 `beforeHandlerSettlement.result.success=true` 后，才返回 `kind: "settled"`。

MVP 用进程内 `Map<requestId, { fingerprint: string; state: "paying" | "settled" | "delivered" }>` 阻止同进程重复结算和重复业务调度；状态变化只前进。进程重启后的幂等不在 MVP 内，不新增数据库或分布式锁，并在验收记录中写明该限制。

- [ ] **Step 5: 把 gate 接到既有 Gateway。**

`server.ts` 保留 Host 校验、API Key 鉴权、body 上限、租户、定价和既有 executor。只有满足以下条件才进入 x402 gate：

```ts
const paidVision = url.pathname === "/v1/responses"
  && String(body.model ?? body.model_name ?? "") === "vision-basic";
if (paidVision && body.stream === true) {
  throw new RelayError("x402_stream_unsupported", "Paid MVP requests must use stream=false", 400);
}
const admission = paidVision ? await x402Gate.admit(request, JSON.stringify(body)) : null;
if (admission?.kind === "response") return admission.response;
```

随后只调用一次现有 `executor.invoke`。得到非流式 Response 后调用 `admission.finish(response)` 添加标准 `PAYMENT-RESPONSE`。未付款、verify 失败、settle 失败或 pending 都必须在 `executor.invoke` 之前返回。

- [ ] **Step 6: 运行 Relay 验证。**

Run: `bun test apps/gateway/src/x402-resource.test.ts && bun run --filter @frely/gateway typecheck && bun run --filter @frely/gateway build`

Expected: x402 测试 PASS；Gateway 类型检查和构建 PASS。

- [ ] **Step 7: 提交 Relay 改造。**

```bash
git add apps/gateway/src/x402-resource.ts apps/gateway/src/x402-resource.test.ts apps/gateway/src/server.ts apps/gateway/package.json bun.lock
git commit -m "feat(gateway): gate vision responses with Hedera x402"
```

## FSRV-005 — Task 4：服务端三仓无成本验收

Status: Draft
Review level: L3
Source: FMCP-004、FMCP-010

**Files:**

- Create: `docs/verification/2026-09-11-service-mvp-acceptance.md`

**Interfaces:**

- Consumes: Network resolve 服务、Relay x402 gate、既有 Swarm `/v1/responses`。
- Produces: 可复核的服务端验收记录；不产生真实支付证明。

- [ ] **Step 1: 运行 Network 验证。**

Run: `bun test packages/protocol/capability-resolution apps/capability-service && bun run typecheck`

Expected: resolve 成功、身份拒绝、鉴权失败和 `/mcp` 404 测试全部 PASS。

- [ ] **Step 2: 运行 Relay 验证。**

Run in Relay: `bun test apps/gateway/src/x402-resource.test.ts && bun run --filter @frely/gateway typecheck && bun run --filter @frely/gateway build`

Expected: 402、字段绑定、verify→settle→dispatch、pending 不重试和重复请求不重复调度全部 PASS。

- [ ] **Step 3: 回归既有 Swarm。**

Run in Swarm: `bun test && bun run typecheck`

Expected: 既有 `/v1/responses` 认证与 Vision workflow 测试 PASS；本任务不得为了通过而修改 Swarm。

- [ ] **Step 4: 写验收记录。**

记录三个仓库的 commit、命令、退出码、通过用例和以下边界：

```text
Graph/identity: synthetic or configured test endpoint
x402: synthetic Facilitator; no HBAR transferred
Relay dispatch: observed only after synthetic settled
Swarm: existing authenticated workflow regression
Server restart idempotency: outside MVP
Real 0.01 HBAR: not authorized and not executed
```

- [ ] **Step 5: 提交验收记录。**

```bash
git add docs/verification/2026-09-11-service-mvp-acceptance.md
git commit -m "docs(verification): record service MVP acceptance"
```
