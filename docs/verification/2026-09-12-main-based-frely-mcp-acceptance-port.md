---
title: Main-based frely-mcp acceptance slice verification
mdq:
  profile: project-governance/governed-document-v1
---

# 基于 main 的 frely-mcp 验收切片验证记录

## FVFY-001 — 结论与证据边界

Status: Partially Verified
Review level: L3
Verified at: 2026-09-12 23:15 Asia/Shanghai

目标实现 SHA 为 `7c332ca6a95d747ede0ee7471a25832c2293b2ed`。G0、G1、G2、G4、G5 已通过；G3 只完成公开 health 探针，认证 models/minimal request 因当前环境没有 `FRELY_API_KEY` 而未执行；G6 真实付款未获授权、未执行。

因此当前可下结论为：**基于最新 main 的功能移植和无费用验收已完成，但计划定义的整体门槛尚未全部关闭。** 不能据此声称远端 Relay 的认证业务请求已通过，也不能声称该 SHA 已发生真实 Hedera x402 结算。

本记录验证的是重建后的目标 SHA，不继承来源分支上的付款、测试或完成状态。

## FVFY-002 — 目标、来源与 Grok 交接

Status: Verified
Review level: L3
Source: local Git objects and Grok session inspection

| 项目 | 证据 |
| --- | --- |
| 目标基线 | `origin/main@259c79f1e854382d43e64e4e0e3d963d4d955de7` |
| 目标实现 | `7c332ca6a95d747ede0ee7471a25832c2293b2ed` |
| 来源审计 tip | `a854f545afabaa5ea56c5b3925ca231d8d7c5018` |
| 下午来源范围 | 19 commits；72 files；+5758/-507 |
| B1 关系 | `B1wl7ch` 是来源 tip 的祖先，只作风险审计，不作移植来源 |
| Grok 已完成 | `e22e044` protocol、`b29b9f5` wallet、`c93b1eb` payer、`f1f1f07` upfront gateway |
| Grok 停止原因 | 恢复会话返回 Grok Build 额度耗尽；没有后续新提交 |
| 接手后的实现 | static Network、frely MCP、合成 E2E、journal/recovery/attempt-store 安全加固和证据输出 |

## FVFY-003 — G0 来源与历史护栏

Status: Verified
Review level: L3

- `git fetch origin main` 后，`origin/main` 仍为 `259c79f`。
- `git merge-base --is-ancestor origin/main 7c332ca` 退出 0。
- `origin/main..7c332ca` 共 13 个提交；merge commit 为 0；commit message 中 cherry-pick footer 为 0。
- 实现 SHA 相对 main 有 73 个变更路径，全部属于 FPLAN-002 白名单。
- `git diff --check origin/main...7c332ca` 退出 0。
- 没有 merge、cherry-pick B1 或 `integration/frely-mcp-mvp-acceptance`，也没有从来源 tip 整目录恢复。

## FVFY-004 — G1 单元、契约与回归

Status: Verified
Review level: L3

在 `7c332ca` 的实现树上执行 `bun run check`：

- TypeScript typecheck：PASS。
- Bun tests：662 pass，0 fail，2185 assertions，46 files。
- production Broker bundle：PASS，生成 4.49 MB bundle。

覆盖范围包括 capability resolution v2、本地 wallet、payer policy/signer/journal/session/recovery、既有与 upfront gateway、static Network、frely MCP、打包黑盒、合成 E2E，以及当前 main 的既有 Broker、Graph/ENS/ERC-8004、payment 和 release 回归。

新增的持久化边界测试还确认：已有宽权限目录不会被静默改权限，符号链接目录会 fail closed，状态不会倒退，没有可信交易标识时不能把付款标为 settled。

## FVFY-005 — G2 无费用真实进程 E2E

Status: Verified
Review level: L3

执行 `bun scripts/static-provider-e2e/preflight.ts`，进程链路为打包后的 stdio MCP → loopback static Network → synthetic verifier/settler → fake Relay。记录的组件版本是 Bun `1.4.0`、frely-mcp `0.1.0`、static-network `0.0.0`。

观察结果：

- 顺序：`challenge → sign → settle → relay`。
- 身份来源：`static_allowlist`；`identityVerified:false`。
- 首次请求：payment `settled`，service `succeeded`，得到 synthetic output。
- 同 request ID 重复：命中缓存；sign、settle、Relay 增量均为 0。
- 同 request ID 改正文：`REQUEST_ID_CONFLICT`；sign、settle、Relay 增量均为 0。
- 已结算后 Relay 失败：payment 保持 `settled`，service 为 `failed`，不补付。
- 结果未知：payment/service 为 `unknown`，`retryAction:query_original`；重复不会重签、重结算或重调 Relay。
- recovery：只调用 `verifyOriginal` 1 次；sign 和 Relay 增量为 0。
- Relay 收到的 payment header 列表为空。
- 最终计数：3 challenges、3 proofs、3 verifies、3 settlements、3 Relay calls、0 external payments。

这里的 `settled` 是 fixture 内的合成状态，只证明状态机与调用顺序，不证明链上结算。

## FVFY-006 — G3 Relay canary

Status: Partial
Review level: L3

2026-09-12 23:14 Asia/Shanghai 对 `https://api.frely.cloud` 做了不带 payment header 的只读探针：

- `GET /health`：HTTP 200；service `gateway-srv`，version `0.64.1`，release `v0.65.40-72ae712b0406`，source SHA `72ae712b0406993aa4dc4a34e1b4975a00825291`。
- 当前进程环境：`FRELY_API_KEY_UNSET`。
- `GET /v1/models`：HTTP 401，`invalid_api_key`，符合受保护边界。
- 认证 models 和 minimal request：Not run。

这证明远端服务公开 health 可达和模型接口要求认证，不证明认证业务 canary 成功。为避免越过凭证边界，本轮没有查找或使用生产 secret。

## FVFY-007 — G4 包验收

Status: Verified
Review level: L3

`apps/frely-mcp/package.test.ts` 在临时目录完成 build、pack、解包、repo 外安装和 stdio 启动：

- tarball 只含 `README.md`、`dist/frely-mcp.js`、`package.json`。
- bundle 不含用户绝对路径、workspace 引用或 fixtures。
- repo 外 consumer 完成 MCP initialize/listTools/callTool。
- 只暴露 `find_capability` 与 `use_capability`；`find_capability` 返回绑定的 static Provider；stderr 无额外日志。

## FVFY-008 — G5 安全和配置审阅

Status: Verified
Review level: L3

- Network 与 MCP 配置只接受精确 loopback execution；Relay 只接受公网 HTTPS `/v1/responses`。
- Relay upstream 重新构造普通 Bearer JSON 请求，不转发 payment、Network auth 或 wallet header。
- payment 默认关闭；live runner 未加入 root scripts、check、CI 或 postinstall。
- 44 个变更后的非测试 production 文件接受了硬编码检查；来源 `FROZEN` 付款参数、具体 `amountAtomic/payTo/feePayer`、私钥材料和 Bearer literal 命中数为 0。
- 宽泛敏感赋值扫描的命中经人工审阅，均为动态 header 组装、类型字段或测试计数，不是明文 secret。测试/fixture 中的 `0.0.222`、`0.0.333` 和 amount `1` 是显式 synthetic 保留值。
- 本地钱包、payer journal 与 upfront attempt store 校验 owner、文件类型和权限；wallet 读写使用 `O_NOFOLLOW`，journal/attempt store 拒绝不安全目录。
- `.local` 下未发现 live approval 文件。

扫描只能证明当前规则没有命中可疑字面量，不替代正式 secret scanner 或生产安全审计。

## FVFY-009 — G6 真实付款

Status: Not Run
Review level: L3

Live payment: **Not run / Not authorized**。

没有创建 approval 文件，没有运行 live 初始化，没有查询或使用真实 wallet secret，没有调用真实 facilitator 付款，没有部署或推送。若以后执行，必须由用户针对届时目标 SHA、amountAtomic 和一个 request ID 重新明确授权，并分别记录链上 settlement、Relay 业务结果、同 ID 重复与 unknown recovery 证据。

## FVFY-010 — 剩余动作

Status: Planned
Review level: L3

1. 为 G3 提供获准的 Relay canary 凭证后，只运行 authenticated models 和最小业务请求，并确认不含 payment headers。
2. G3 通过后，可把 FPLAN-010 的“无费用移植实现”结论提升为完成。
3. G6 继续保持独立；除非用户对新 SHA、金额和 request ID 给出明确授权，否则不得执行。
