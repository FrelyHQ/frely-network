# 服务端三仓无成本验收

Status: Draft
Review level: L3
Source: FMCP-004、FMCP-010；plan Task 4 FSRV-005

核验时间：2026-09-11。Bun 1.4.0（`/Users/bit/.bun/install/cache/@oven/bun-darwin-aarch64@1.4.0@@@1/bin/bun`）。未发起真实付款，未推送，未合并 main。

Relay 在独立仓库分支 `feat/x402-resource-mvp`，没有把 Relay commit 合并进 frely-network。

## Network — feat/frely-service-mvp @10d8c94e7088dd8dbbc29ca33f2ea8b49507ed4c

工作树：`frely-network/.local/worktrees/frely-mvp-contract`

```text
bun test packages/protocol/capability-resolution apps/capability-service
20 pass, 0 fail, 106 expect()
exit 0

bun run typecheck
exit 0
```

覆盖：冻结 resolve v1 成功/拒绝、身份候选重试、鉴权失败、`/mcp` 非公开入口、Relay origin 约束。

## Relay — feat/x402-resource-mvp @52e286dc36506efd0d7f08902f84d438d9d62c6d

工作树：`relay/.local/worktrees/x402-resource-mvp`

独立复审 3a91ed9..9131c7d 发现 Important：`settlement_pending` 会清掉 in-process 占位，同 `x-frely-request-id` 会再次 settle。已在 `52e286d` 修复：verify 拒绝仍可重试；一旦调用 Blocky settle，pending 重试返回 409 且 settle 仍为 1。

```text
bun test apps/gateway/src/x402-resource.test.ts
12 pass, 0 fail, 60 expect()
exit 0

bun run --filter @frely/gateway typecheck
exit 0

bun run --filter @frely/gateway build
exit 0
```

覆盖：未签名 402、字段绑定、verify→settle→dispatch、pending 不调度、pending 同 requestId 不重试 settle、重复 requestId 不重复调度、body hash 冲突、失败 requestId 可重试、initialize 失败不 sticky、truthy stream 拒付费流式。 Relay commit 未合并进 frely-network。

## Swarm — main @3fb937159973faa80bcc973ba3fb41672c1a6f54

仓库：`/Users/bit/projects/FrelyHQ/swarm`。本轮只回归，未修改源码。为运行测试执行了 `bun install --frozen-lockfile`（`node_modules` 未跟踪）。

```text
bun test
12 pass, 0 fail, 38 expect()
exit 0

bun run typecheck
exit 0
```

覆盖：既有 `/v1/responses` 认证、Vision 请求校验、虚拟模型边界。

## 边界

```text
Graph/identity: synthetic or configured test endpoint
x402: synthetic Facilitator; no HBAR transferred
Relay dispatch: observed only after synthetic settled
Swarm: existing authenticated workflow regression
Server restart idempotency: outside MVP
Real 0.01 HBAR: not authorized and not executed
```
