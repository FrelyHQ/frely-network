# Frely MCP MVP synthetic 联合验收

Status: Draft
Review level: L3
Source: FMCP-004、FMCP-009、FMCP-010；plan Task 5 FMCPPLAN-006

核验时间：2026-09-11。Bun 1.4.0（`/Users/bit/.bun/install/cache/@oven/bun-darwin-aarch64@1.4.0@@@1/bin/bun`）。

集成分支 `integration/frely-mcp-mvp-acceptance` 从共享契约 `5f7dd89` 建立，只合并 `feat/frely-service-mvp` 与 `feat/frely-local-mcp-mvp`，不合并 `main`，不推送。Relay 仍在独立仓库分支，没有把 Relay commit 合并进 frely-network。

## 实施分支

| 仓库 | 分支 | HEAD |
| --- | --- | --- |
| frely-network | integration/frely-mcp-mvp-acceptance | 本提交 |
| frely-network | feat/frely-service-mvp | a3861f6 |
| frely-network | feat/frely-local-mcp-mvp | 14a4ce6 |
| FrelyHQ/relay | feat/x402-resource-mvp | 52e286d |
| FrelyHQ/swarm | main | 3fb9371 |

## Tarball

`npm pack` 文件清单：

```text
README.md
dist/frely-mcp.js
package.json
```

临时安装后：

```text
bun --bun <install>/node_modules/.bin/frely-mcp --help
exit 0
stdio handshake tools: find_capability, use_capability
stderr 为空
```

未执行 `npm publish`。

## 全链 synthetic

```text
bun test apps/frely-mcp/full-chain.test.ts
2 pass, 0 fail, 12 expect()
exit 0
```

Happy path 计数：`resolve=3`、`sign=1`、`settle=1`、`dispatch=1`。同 requestId 第二次 `use_capability` 返回相同业务结果，不重新签名、结算或调度。

pending 场景：`paymentStatus=unknown`、`retryAction=query_original`；第二次调用只恢复查询，sign/settle 仍为 1，dispatch=0。

测试通过 `--preload` 把 `https://network.example` 接到真实 `createCapabilityServiceFetch`，把 `https://relay.example/v1/responses` 接到 synthetic Resource fixture（官方 x402 HTTP 编解码 + Hedera inspect；verify/settle 顺序的进程内 Resource Server 仍以 Relay 仓 `52e286d` 的单测为准）。配置仍是公网 HTTPS origin。Network 只看到 capability 请求；私钥、wallet path 和另一端 API Key 不得出现在对端请求中。pending 第二次 `use_capability` 会查询原 Mirror 交易，不重新签名或 settle。

## 全仓

```text
bun run check
typecheck exit 0
195 pass, 0 fail, 835 expect()
exit 0
```

## 边界

```text
MCP install/handshake: verified
Network resolve contract: verified against fixture and service tests
Wallet/profile gate: verified without exposing secrets
x402 verify/settle ordering: synthetic verified
Business result: synthetic verified
npm registry publication: not executed
real 0.01 HBAR settlement: not authorized and not executed
Relay remains an independent repository branch
```
