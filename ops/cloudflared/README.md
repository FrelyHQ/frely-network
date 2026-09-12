# network-dev.frely.cloud

```bash
cloudflared tunnel login
cloudflared tunnel create network-dev
cloudflared tunnel route dns network-dev network-dev.frely.cloud
```

Copy `network-dev.yml` to `~/.cloudflared/config.yml`, replace the UUID and user path, then run:

```bash
cloudflared tunnel run network-dev
```

Start Network first with `docker compose -f compose.production.yaml up -d` and verify:

```bash
curl http://127.0.0.1:13600/healthz
curl https://network-dev.frely.cloud/healthz
```
