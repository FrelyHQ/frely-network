---
title: Hedera automatic payment workflow
mdq:
  profile: project-governance/governed-document-v1
---
# Hedera 自动支付运行规格

## HPAY-001 — Loop、Trigger 与前置条件

Status: Draft
Review level: L3
Source: ../docs/architecture.md

Loop 是在授权预算内调用需要按次付费的能力。Trigger 是一个带稳定 requestId 的业务调用，不使用定时器。输入、配置和证据契约见 [x402 架构契约](../docs/architecture.md)。此文件为阶段、失败策略与恢复规则的唯一维护位置。

先按 mode 分流，再进入对应路径；不得先占用正式 requestId 再判断模式。offline/preflight 输入为 {configRef, request, capture}，live 为 {configRef, request}，recover 为 {requestId, journalPath}。capture 绑定 source、capturedAt、method、url、bodySha256、status 与 paymentRequiredHeader。

| 模式 | 前置条件与允许动作 | 正式 journal 边界 |
| --- | --- | --- |
| offline | synthetic fixture；仅解析报价与预算、策略；禁止真实外发、签名和阶段执行 | 不打开 journal，不接触正式请求记录 |
| preflight | 业务输入、可信公开配置及获准捕获样本完整；在内存中校验请求绑定、v2 结构及 X402-contract-1 策略，仅查询获准 supported/资产/账户只读入口；无密钥、无签名、无业务 HTTP 请求 | 不打开正式 journal，不占用 ID，不写正式缓存；报告只返回调用者，成功为 prepared/not_paid/not_started |
| live | 新请求要求 Provider 已验证、资源地址受信、支付明确启用、预算合法、配置完整且 journal 可写；进入 HPAY-002 | 只有该模式可创建正式记录；已有 ID 按持久指纹去重，不因当前配置缺失覆盖历史付款状态 |
| recover | 获准 journal 中存在该 ID，且没有活跃执行者；使用已保存的证据和 verifier 配置，按 HPAY-004 处理 | 不创建业务记录，不重新发现 Provider、不签名、不请求业务 URL；可保存核验或关闭结果 |

新请求缺前置条件立即 blocked/not_paid。已有请求及 recover 缺少读取证据所需条件时返回拒绝原因；付款状态保留可信历史值，无法读取时使用 unknown，不能凭当前配置缺失推断未付款。preflight 缺捕获样本直接拒绝，不自动采集；不提供在线业务报价探测模式。预检成功不授权 live，也不证明 signer 可用。

## HPAY-002 — 阶段交接

Status: Draft
Review level: L3
Source: X402-architecture-1；X402-contract-1；X402-storage-1

| 阶段 | 输入与动作 | 输出/交接条件 |
| --- | --- | --- |
| Admit | 验证请求、预算、策略；原子占用 requestId，保存指纹及 admitted 阶段 | 只有新请求继续；重复请求返回已有状态或缓存；失去执行者的未完成记录返回 paused/RECOVERY_REQUIRED；冲突拒绝 |
| Quote | 先持久化 quote-intent，再对绑定 URL 发送无支付载荷的原请求一次；禁止跟随重定向 | 完整 402 响应经 v2 校验并持久保存报价后为 quoted；非 402 转 Capture，随后直接 Deliver；发送失败或结果不完整先记录服务未知并暂停，不重发 |
| Authorize | 筛选报价、匹配可信配置、整数预算、检查 supported 和账户条件 | 按 X402-contract-1 仅允许一个合格报价；持久化 authorized 后继续；0 个或多个均拒绝，不能进入 Sign |
| Sign | signer 创建官方部分签名交易；解码核对实际交易和报价 | 得到内存 payload、交易 ID/摘要；不等于已付款 |
| Dispatch | 原子写 dispatch-intent 与交易证据后，携 PAYMENT-SIGNATURE 重发相同请求一次 | 发送或不能排除已发送即 unknown；禁止生成第二笔支付 |
| Capture | 完整响应到达即校验业务结果；按 X402-storage-1 原子保存服务状态、有效输出及可选结算线索；接收失败或超时保存服务未知 | 携款请求在服务观察结果提交后才进入 Verify，尚未结算时不得标记整个付费调用成功；Quote 的非 402 响应直接进入 Deliver |
| Verify | 以本地持久原交易为依据查询 SUCCESS 与资产转账；PAYMENT-RESPONSE 可缺失，存在时仅作受约束线索 | 核验通过即持久化 settled；证据不足或交易 ID 冲突为 unknown；更新不覆盖服务状态和缓存 |
| Deliver | 根据已保存的支付证据与服务观察结果合成输出并保存最终处理状态 | 返回支付状态、服务状态、证据与仍有效的输出；不会为交付结果重新签名或调用业务端 |

此阶段表用于 live；offline、preflight 与 recover 不进入该表。付款请求的 body、目标及业务指纹不得改变。服务端须保证 Quote 阶段不会执行付费工作，并在 Dispatch 请求核实结算后才执行。Quote 仍可能执行免费或豁免业务，因此必须记录 quote-intent，不能将所有 dispatch-intent 之前的中断都解释为业务未执行。客户端或本地 mock 的验证不证明实际服务端已履行该契约。

## HPAY-003 — Success signal 与失败策略

Status: Draft
Review level: L3
Source: loop-me；X402-contract-1；HPAY-004

自动付费调用成功的可观察条件：journal 已保存与请求绑定的已核实结算证据，服务结果通过校验，输出 paymentStatus=settled、serviceStatus=succeeded。免费响应可为 not_paid+succeeded，但不能计入支付验收。

初始业务请求与携款重发每次 30 秒超时，二者都不自动重试；避免业务端不具备幂等时重复执行。只读 supported/元数据/账户查询每次 10 秒，最多 2 次、间隔 1 秒，失败暂停。结算查询每次 10 秒，最多 3 次、间隔 2 秒；索引延迟、无法核实或冲突均 unknown/query_original，停止自动轮询。

签名前拒绝为 not_paid。签名后、dispatch-intent 写入前有确证未发送时为 not_paid；进程恢复到 dispatch-intent 或之后且尚无持久 settled 证据时保守 unknown。即使 facilitator 返回 transaction_failed，若不能排除此前提交成功，也不能判为未付款并补付。

已结算但服务失败保留 settled+failed；服务超时为 settled+unknown。不得通过换 requestId 自动“恢复”。本流程不自动退款，也不宣称服务失败可由支付层补偿。

Capture 写入失败时停止后续自动步骤，返回 paused/JOURNAL_UNAVAILABLE；携款请求保留已落盘的 dispatch-intent 及 paymentStatus=unknown，Quote 的非 402 响应则保留 quote-intent、paymentStatus=not_paid 及持久服务状态未知。不得输出整体成功。用户修复本地存储后按 HPAY-004 处理；只有已发送付款的分支可查原交易，未落盘输出可能无法恢复。结果已缓存而 Verify 达到查询上限时，保留缓存并返回 unknown/query_original，之后的 recover 可在缓存有效期内完成核验并交付。settled 证据一旦持久化不因临时网络故障降级，也无需每次读取缓存重新查询链；新的实质证据冲突需要人工处理。

## HPAY-004 — 幂等、恢复与 Checkpoint

Status: Draft
Review level: L3
Source: X402-storage-1；loop-me

同 ID 依赖持久指纹和唯一约束去重。普通重试只读取已有状态，不推进未完成阶段；recover 必须先原子取得记录所有权，活跃执行者持有时返回 paused/REQUEST_IN_PROGRESS、exit 3，不关闭或接管。无法取得所需读写权限时拒绝，不清除原阶段。以下为中断后唯一处置规则：

| 持久阶段/证据 | recover 动作与持久结果 | 返回与后续边界 |
| --- | --- | --- |
| 不存在 requestId | 不创建记录 | blocked/REQUEST_NOT_FOUND，exit 2 |
| admitted，尚无 quote-intent | 原子保存 closed-before-payment，保留原阶段 | blocked/not_paid/not_started，reason=REQUEST_CLOSED_BEFORE_PAYMENT，exit 2；不继续原业务 |
| quote-intent，尚无完整响应记录 | 原子保存 closed-before-payment，保留原阶段和业务结果未知事实 | blocked/not_paid/unknown，reason=REQUEST_CLOSED_BEFORE_PAYMENT，exit 2；不重发 Quote，不声称业务未执行 |
| quoted、authorized 或签名后但尚无 dispatch-intent | 丢弃任何内存签名载荷，原子保存 closed-before-payment 和原阶段 | blocked/not_paid/not_started，reason=REQUEST_CLOSED_BEFORE_PAYMENT，exit 2；有效 402 及已交接服务契约是服务未开始的依据；不恢复签名或继续付款 |
| 已保存非 402 服务结果，未进入 dispatch-intent | 读取并返回已知服务状态和未过期输出；过期只返回状态及 OUTPUT_UNAVAILABLE | completed/not_paid；验证命令 exit 2，不算付款验收，也不重复业务调用 |
| dispatch-intent 或之后，尚无已核实结算 | 用已持久原交易 ID/摘要及报价进行 HPAY-003 的有界只读核验，保存付款结论；保留先前 Capture 结果 | settled 且有效成功缓存为 exit 0；settled 但失败/无结果为 exit 4；未核实为 paused/unknown/query_original、exit 3；HTTP 响应缺失不阻止查询 |
| 已持久 settled | 读取证据与服务缓存，不重新签名或业务请求 | 有效成功缓存为 completed/settled/succeeded、exit 0；失败或缺失为 settled 加已知服务状态、exit 4；输出过期不否定已知服务成功 |
| closed-before-payment | 幂等返回原关闭结果，保留 tombstone 与指纹 | 同 ID 永不重新准入；重复 recover 不再进行查询、签名或业务请求 |

closed-before-payment 是请求执行终止标记；它只说明本客户端没有发送付款载荷，不能覆盖已知或未知的业务执行事实。原记录永久保留 ID 去重信息。发送前 journal 不可用则禁止发送；发送后写入失败从已落盘交易 ID 恢复，付款状态无法核实时保持 unknown。

每次已获准预算内的正常调用不设置人工 Checkpoint。配置/授权缺口、无法自动继续的中断请求、未知结果超过查询上限、已付费服务失败需要人工处理。Checkpoint Brief 包含 requestId、产物/结果位置、原因、已核验证据、剩余风险、待决事项及完整记录位置；禁止用原始日志或签名 payload 替代。

人工处理可以补充缺失配置、发起原交易只读核查或关闭失败调用；不能仅凭“继续”自动产生新付款。本版明确不提供发送前中断记录的继续入口。关闭后如仍需执行，必须是新的明确授权业务调用和新 ID；Brief 须说明旧调用已知的付款与服务状态，尤其 quote-intent 结果未知时可能已执行业务。不得自动生成新 ID。对已发送付款载荷的记录，关闭人工处理事项也不得改写付款证据或解除去重。

## HX402-contract-1 — 验证与边界

Status: Draft
Review level: L3
Source: X402-contract-1；HPAY-004

阶段测试使用注入的 HTTP/signer/journal/verifier；必须验证预算拒绝发生在签名前、意图落盘发生在外发前、服务结果落盘发生在结算查询前、未知恢复不签名。模式隔离必须证明 preflight 不发业务请求、不占正式 ID，recover 不新增签名或付款，多个合格报价拒绝。真实运行需要独立保存结算、重复请求和超时恢复证据。测试输出不可替代链上核验。

允许外部写入仅限明确获准的测试网付款请求；不将钱包密钥、可结算载荷或服务凭据写入报告。live CLI 还要求操作者为该次进程显式设置 `PAYMENT_LIVE_AUTHORIZED=1`，但该变量不能替代 endpoint、payer、预算、资产或服务契约授权。每次真实付款须处于操作者明确授权的资源、资产和预算范围内。服务端契约未交接时，运行规格保持 Draft，不能标记端到端完成。


## HPAY-006 — 本地 mock 的单次真实结算验证

Status: Draft
Review level: L3
Source: HPAY-003；HPAY-004；scripts/payment-spike/mock-run.ts

仅用于操作者明确触发的测试。前置条件为获准 registry/policy、单次 requestId 与预算、
已有 Testnet 付款和收款账户、真实 facilitator 的 v2 exact 支持，以及 loopback TLS
证书。settings JSON 绑定 policyFile、tlsCert、tlsKey、amountAtomic、完整 request。
业务 URL 固定 HTTPS 127.0.0.1:端口；证书仅用于该资源 fetch 的本地信任。

prepare 读取 supported、获取 mock 402 并保存 capture，不签名；操作者批准 capture
后沿用 payment:check preflight。run 需要独立 live 授权，真实 session 获取 402、
签名、持久化并重发；mock 依次调用真实 verify/settle，仅成功后返回固定服务文本。
gateway-events 持久化 settle intent 和回执，不保存签名载荷。

一次成功的证据是 Mirror 精确转账核验、journal settled、有效缓存输出和 exit 0。
同 ID 再执行走 session 缓存，禁止新增 business fetch/sign；不得替换 ID 补付。
facilitator 每次请求 12 秒且不自动重试。未知结果沿 HPAY-004 recover 原交易，
不重建网关继续结算；已存在 gateway attempt 且 journal 缺失时停下人工调查。
客户端 Mirror 有界查询及恢复规则沿 HPAY-003/004。runner recover 依赖当前获准
policy 文件；配置不可用时使用正式 CLI recover 的原 journal 入口。

返回测试款是独立、显式授权的原生 Testnet 转账，不属于自动补偿。mock 成功
仅证明本地业务替身与真实支付链路；W 的实际服务和故障交付验收仍待交接。
