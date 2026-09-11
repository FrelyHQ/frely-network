# Frely MCP

本地 stdio MCP：Host Agent 通过 Frely Network 取得已验证 Relay，再用本机 Agent Wallet 在唯一授权 profile 下完成 x402 付款调用。

## CLI

```text
frely-mcp wallet init --network hedera:testnet [wallet options]
frely-mcp check --config /absolute/config.json
frely-mcp start --config /absolute/config.json
```

- `wallet init` 交给现有 `apps/agent-cli` 的 `main()`，不复制第二套钱包流程。
- `check` 只读：读取外层配置、确认两个 env 引用、Ready 钱包、付款 profile，比较 payer/signer/provider/resource，并调用一次 Network resolve。不打开 journal、不调用 Relay、不签名。disabled profile 保持 disabled。
- `start` 用官方 `StdioServerTransport` 提供 `find_capability` 与 `use_capability`。stdout 只允许 MCP 协议帧；启动本身不触发 resolve 或付款。

外层配置只保存 `env:` 引用，不保存 Network / Relay 密钥。付款 profile 与 Agent Wallet 独立；签名发生在 402 与预算通过之后。

## Verify

从仓库根目录使用 Bun 1.4.0：

```sh
npm exec --yes --package=bun@1.4.0 -- bun install --frozen-lockfile
npm exec --yes --package=bun@1.4.0 -- bun test apps/frely-mcp/cli.test.ts apps/frely-mcp/check.test.ts packages/wallet/agent-wallet/read-ready.test.ts packages/payment/hedera-x402/config.test.ts
npm exec --yes --package=bun@1.4.0 -- bun run typecheck
```

测试只用 synthetic Resource Server 与 fake Network；不会发起真实 HBAR，也不会发布 npm。
