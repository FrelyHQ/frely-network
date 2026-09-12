# Frely Network 本地远程联调

本地启动 `frely-network`，并通过 Cloudflare Tunnel 暴露为：

```text
https://network-dev.frely.cloud
```

## 准备工作

- macOS/Linux
- Docker Desktop 或 Docker Engine
- Bun
- `cloudflared`
- 具备 `frely.cloud` DNS 权限的 Cloudflare 账号
- `frely-network` 源码和本地开发环境变量

安装工具（macOS）：

```bash
brew install cloudflared
```

## 启动本地 Network

在项目根目录执行：

```bash
bun install
cp .env.example .env
```

按团队约定填写 `.env`。本地服务默认监听：

```text
127.0.0.1:13600
```

启动服务：

```bash
docker compose -f compose.production.yaml up -d
```

先验证本地健康状态：

```bash
curl http://127.0.0.1:13600/healthz
curl http://127.0.0.1:13600/readyz
```

`/readyz` 返回 200 后，才进行完整业务联调。

## 创建 Cloudflare Tunnel

首次使用时登录 Cloudflare：

```bash
cloudflared tunnel login
```

浏览器中选择拥有 `frely.cloud` 的账号和 Zone。

创建 Tunnel 并绑定开发域名：

```bash
cloudflared tunnel create network-dev
cloudflared tunnel route dns network-dev network-dev.frely.cloud
```

记录命令输出的 Tunnel UUID。

## 配置 Tunnel

创建配置目录并复制模板：

```bash
mkdir -p ~/.cloudflared
cp ops/cloudflared/network-dev.yml ~/.cloudflared/config.yml
```

编辑 `~/.cloudflared/config.yml`，替换 `<TUNNEL_UUID>` 和 `<USER>`：

```yaml
tunnel: <TUNNEL_UUID>
credentials-file: /Users/<USER>/.cloudflared/<TUNNEL_UUID>.json

ingress:
  - hostname: network-dev.frely.cloud
    service: http://127.0.0.1:13600
  - service: http_status:404
```

启动 Tunnel：

```bash
cloudflared tunnel run network-dev
```

保持该终端运行。

## 远程验证

另开终端执行：

```bash
curl https://network-dev.frely.cloud/healthz
curl https://network-dev.frely.cloud/readyz
```

如果需要查看 Tunnel 状态：

```bash
cloudflared tunnel list
cloudflared tunnel info network-dev
```

## 联调约定

- `network-dev.frely.cloud` 只用于本地开发，不覆盖 `network.frely.cloud`。
- 不要提交或共享 `~/.cloudflared/*.json`、Cloudflare API Token、API key、私钥或 `.env` 中的敏感值。
- Tunnel 只负责网络转发，Network 自身的认证、签名和 API key 仍然必须启用。
- 联调结束后停止本地服务和 Tunnel：

```bash
cloudflared tunnel cleanup network-dev
# 或在运行 tunnel 的终端按 Ctrl-C

docker compose -f compose.production.yaml down
```
