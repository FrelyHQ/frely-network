---
title: Main-based frely-mcp acceptance slice verification
mdq:
  profile: project-governance/governed-document-v1
---

# 基于 main 的 frely-mcp 验收切片验证记录

## FVFY-001 — 结论与证据边界

Status: Verified
Review level: L3
Verified at: 2026-09-12 23:40 Asia/Shanghai

目标实现 SHA 为 `cb87175a74737e7e88bf51db3c28c216564849f2`。G0–G5 已通过；用户随后授权新分支的一次、最多 1 HBAR Testnet 逻辑请求，G6 也已在该 SHA 上完成。

因此当前可下结论为：**基于最新 main 的功能移植、无费用验收和一次真实 Hedera x402 付款验收已完成。** 本结论只绑定本记录中的 target SHA、amount 和 request ID；不表示已部署、已推送、已合并或获得第二次付款授权。

本记录验证的是重建后的目标 SHA，不继承来源分支上的付款、测试或完成状态。

## FVFY-002 — 目标、来源与 Grok 交接

Status: Verified
Review level: L3
Source: local Git objects and Grok session inspection

| 项目 | 证据 |
| --- | --- |
| 目标基线 | `origin/main@259c79f1e854382d43e64e4e0e3d963d4d955de7` |
| 目标实现 | `cb87175a74737e7e88bf51db3c28c216564849f2` |
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
- `git merge-base --is-ancestor origin/main cb87175` 退出 0。
- `origin/main..cb87175` 共 16 个提交；merge commit 为 0；commit message 中 cherry-pick footer 为 0。
- 实现 SHA 相对 main 有 76 个变更路径，全部属于 FPLAN-002 白名单。
- `git diff --check origin/main...cb87175` 退出 0。
- 没有 merge、cherry-pick B1 或 `integration/frely-mcp-mvp-acceptance`，也没有从来源 tip 整目录恢复。

## FVFY-004 — G1 单元、契约与回归

Status: Verified
Review level: L3

在 `cb87175` 的实现树上执行 `bun run check`：

- TypeScript typecheck：PASS。
- Bun tests：664 pass，0 fail，2194 assertions，46 files。
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

Status: Verified
Review level: L3

2026-09-12 对 `https://api.frely.cloud` 做了不带 payment header 的真实 canary：

- `GET /health`：HTTP 200；service `gateway-srv`，version `0.64.1`，release `v0.65.40-72ae712b0406`，source SHA `72ae712b0406993aa4dc4a34e1b4975a00825291`。
- 未认证 `GET /v1/models` 返回 HTTP 401，符合受保护边界。
- 使用本地受限 Relay credential 的认证 `GET /v1/models` 返回 HTTP 200，`gpt-5.6-luna` 可用。
- 认证 `POST /v1/responses` 返回 HTTP 200、状态 `completed`；request ID `req_083ee16e60203bd8aa8d9e1e`，输出包含 `FRELY X402 OK`。
- 请求与响应都没有 `PAYMENT-*`/`X-PAYMENT*` header；该 canary 没有支付 HBAR。

这证明 Relay 的认证业务路径可用，但不证明链上结算；G6 证据单列在 FVFY-009。

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
- payment 默认关闭；live runner 只接受 `.local/` 的短期 SHA/amount/request ID 绑定，未加入 root scripts、check、CI 或 postinstall。
- 44 个变更后的非测试 production 文件接受了硬编码检查；来源 `FROZEN` 付款参数、具体 `amountAtomic/payTo/feePayer`、私钥材料和 Bearer literal 命中数为 0。
- 宽泛敏感赋值扫描的命中经人工审阅，均为动态 header 组装、类型字段或测试计数，不是明文 secret。测试/fixture 中的 `0.0.222`、`0.0.333` 和 amount `1` 是显式 synthetic 保留值。
- 本地钱包、payer journal 与 upfront attempt store 校验 owner、文件类型和权限；wallet 读写使用 `O_NOFOLLOW`，journal/attempt store 拒绝不安全目录。
- live runtime、approval、journal 和 evidence 只位于被忽略的 `.local/`，目录权限 0700、文件权限 0600；跟踪文件不包含 credential、私钥或 payment proof。

扫描只能证明当前规则没有命中可疑字面量，不替代正式 secret scanner 或生产安全审计。

## FVFY-009 — G6 真实付款

Status: Verified
Review level: L3

Live payment: **settled / service succeeded / replay succeeded**。

| 证据 | 结果 |
| --- | --- |
| target SHA | `cb87175a74737e7e88bf51db3c28c216564849f2` |
| amount / request | `100000000` tinybar；`main-port-03127143-4062-426f-9d43-b2cf0be1dfaa` |
| 交易 | `0.0.7162784@1789227538.623873938`；Mirror consensus `1789227547.478842104`；`SUCCESS` |
| 账务 | payer `0.0.10386782`：`-100000000`；payTo `0.0.10403579`：`+100000000`；fee payer `0.0.7162784`：`-268648` tinybar手续费 |
| Relay | provider/model `gpt-5.6-luna`；response ID `resp_0450341706b6595c016aa5721ef3f887d2aa4d3ca50e889b85`；输出包含 `FRELY X402 OK` |
| 重放 | structured result 完全相等；同一 transaction ID；payer journal 1 条；Network attempt store 1 条 |

Mirror 交易端点：`https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7162784-1789227538-623873938`。在付款时间窗按 payer 查询只得到 1 笔同时包含 payer `-100000000` 与 payTo `+100000000` 的交易。付款前后余额分别为 payer `572777702 → 472777702`、payTo `101000000 → 201000000` tinybar，与交易 transfers 一致；fee payer 单独承担手续费。

runner 在首次成功后只用相同 request ID 和完全相同参数调用第二次。payer journal 已处于 `service_succeeded`，因此第二次从本地缓存返回，没有重新签名、访问 Network 或调用 Relay。旧来源分支的交易没有用于补齐本记录。本次授权已经消耗；没有部署、push 或 merge。

## FVFY-010 — 剩余动作

Status: Verified
Review level: L3

G0–G6 没有剩余验收动作。若用户希望交付该分支，下一步是单独审阅 diff 后决定 push/PR/merge；这些动作不在本次授权内。任何新的真实付款都需要新的明确授权。
