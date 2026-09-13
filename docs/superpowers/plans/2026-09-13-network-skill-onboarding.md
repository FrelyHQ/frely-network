---
title: Frely Network SKILL.md onboarding plan
mdq:
  profile: project-governance/governed-document-v1
---

# Frely Network `SKILL.md` Onboarding Plan

Status: Planned
Review level: L3
Source: 用户确认的 Network onboarding 方案（2026-09-13）

## Goal

为 Frely Network 提供稳定的 `/SKILL.md` onboarding 入口，使 AI Agent 可以通过
`https://network.frely.cloud/SKILL.md` 获取后续安装说明。当前实现只建立静态文件
占位和参数契约记录，不填入安装指令，不接入运行时能力。

## URL contract

| Field | Current contract | Later decision |
| --- | --- | --- |
| Path | `/SKILL.md` | 保持根路径，作为公开静态资源提供 |
| `source` | 可选 onboarding 来源标识；当前示例为 `onboarding_sim` | 是否启用白名单、是否用于统计 |
| `install_id` | 可选 UUID 关联标识；不得作为凭证或鉴权材料 | 生成方、生命周期、关联记录和脱敏规则 |
| Unknown query fields | 当前不改变静态文件内容 | 是否拒绝、忽略或纳入版本化参数契约 |
| Query handling | 静态站点直接返回同一份 `SKILL.md` | 是否增加服务端读取、审计或安装状态回传 |

参数不能包含 API key、钱包私钥、服务 token、Authorization header 或其他身份凭证。

## Implementation scope

- 在 `apps/site/public/SKILL.md` 创建空白占位文件；Astro 构建后发布为根路径静态资源。
- 后续填写内容时，使用纯 Markdown 描述能力、环境检查、安装步骤、配置入口和失败关闭规则。
- 安装说明不得默认执行未获授权的命令，不得要求 AI Agent 回传凭证或原始 prompt/body。
- 不在本计划内新增动态 Route Handler、MCP tool、Broker orchestration、Provider、钱包、支付或生产部署逻辑。

## Verification gates

- `bun run build` 成功生成 `apps/site` 静态产物。
- 本地预览请求 `/SKILL.md` 与带 `source`、`install_id` 的 URL 均返回 `200`。
- 两种 URL 的响应正文一致，响应为 Markdown 文本，且不包含敏感配置。
- 后续填写安装内容前，先补充本计划中的参数决定和安全边界。

## Open decisions

- `source` 是否只允许 `onboarding_sim`，还是接受版本化来源集合。
- `install_id` 是否仅用于客户端关联，还是需要受控服务端记录。
- 安装是纯说明流程，还是需要后续提供可验证的 setup/status endpoint。
- 是否需要为不同 AI Agent 或客户端提供版本化 `SKILL.md` 内容。
