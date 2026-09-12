# network模块本地联调

# B 模式：本地 Network 调用线上 Frely
> 实现本地network访问线上frely

## 必须准备

1. 克隆 `frely-network` 并安装依赖：`bun install`
2. 创建本地 `.env`：`cp .env.example .env`
3. 填写真实的 `GRAPH_ENDPOINT`、`ENS_RPC_URL`、`ERC8004_REGISTRY_ADDRESS`、`FRELY_API_KEY`；密钥只保存在本机，不提交 Git。
4. 如使用 A2A，填写 `FRELY_NETWORK_A2A_AGENT_ID` 和 `FRELY_A2A_DEFAULT_MODEL`。
5. 启动：`docker compose -f compose.production.yaml up -d`
6. 检查本地 `/healthz` 和 `/readyz`。
7. 用有效 API key 发起 Frely 请求，确认 discovery、认证和支付链路。

## 已确认的线上入口

- `https://api.frely.cloud/health` 返回 200，当前版本 `0.64.1`，实例 `frely-eu`。
- B 模式不需要 Cloudflare Tunnel，也不修改线上 Frely/Swarm。
- 目标由 ENS/ERC-8004/The Graph discovery 解析，不通过 BASE_URL 环境变量切换。

## 当前阻塞

Network 当前 `/readyz` 可能返回 `BROKER_EXECUTION_NOT_IMPLEMENTED`。这表示服务进程可启动，但 Broker execution 尚未就绪；必须先实现或启用该能力，才能完成业务联调。

---

# A 模式：线上 Frely/Swarm 调用本地 Network
> 实现线上frely访问本地network

目标：线上服务通过 `network-dev.frely.cloud` 调用队友本机 Network。

## 队友本机

```bash
# Network 默认监听 127.0.0.1:13600
docker compose -f compose.production.yaml up -d
curl http://127.0.0.1:13600/healthz
curl http://127.0.0.1:13600/readyz
```

`/readyz` 必须为 200。

## Cloudflare Tunnel

```bash
brew install cloudflared
cloudflared tunnel login
cloudflared tunnel create network-dev
cloudflared tunnel route dns network-dev network-dev.frely.cloud
```

配置 `~/.cloudflared/config.yml`：

```yaml
tunnel: <TUNNEL_UUID>
credentials-file: /Users/<USER>/.cloudflared/<TUNNEL_UUID>.json
ingress:
  - hostname: network-dev.frely.cloud
    service: http://127.0.0.1:13600
  - service: http_status:404
```

启动并验证：

```bash
cloudflared tunnel run network-dev
curl https://network-dev.frely.cloud/healthz
```

## 线上侧（由 Frely/Swarm 管理者完成）

1. 确认 Frely/Swarm 的实际 Network endpoint 配置字段（当前仓库没有统一字段，不能臆造 `NETWORK_BASE_URL`）。
2. 将该字段设置为 `https://network-dev.frely.cloud`。
3. 配置 Network 接受的服务 credential；不要把 credential 放进 Tunnel 配置。
4. 通过现有 release/deployment 流程更新并重启目标服务。
5. 先发起低成本健康/探针请求，再进行业务请求。
6. 联调结束恢复原线上 Network endpoint 并重启。

## 安全边界

- 不共享 `~/.cloudflared/*.json`、Cloudflare API Token、API key、私钥或 `.env`。
- `network-dev.frely.cloud` 只用于本次调试，不覆盖 `network.frely.cloud`。
- Cloudflare Access 应限制为 Frely/Swarm 的受控身份或出口。
