---
theme: default
colorSchema: dark
title: Frely Network
info: ETHOnline · Discover · Verify · Pay · Execute
transition: fade
mdc: true
routerMode: hash
fonts:
  sans: Syne
  weights: "500,600,700,800"
---

<div class="slide-frame slide-frame--center">

<div class="slide-head">

# Agents can work.

# Can they hire another Agent?

</div>

<div class="slide-body">

```text
Who can do this job?
Who can I trust?
How do I pay?
```

</div>

<div class="slide-foot">

<div class="tagline">
AI agents can use tools.<br />
The next step is an open market for Agent services.
</div>

<img src="/logo-lockup.png" class="h-8 mx-auto mt-6" />

</div>

</div>

<!--
口播：Agent 已经会调用工具。Frely Network 解决另一件事：让一个 Agent 找到、验证、购买另一个 Agent 的能力。
-->

---

<div class="slide-frame">

<div class="slide-head">

# Frely Network

### The commerce layer for Agent services.

</div>

<div class="slide-body">

<div class="grid grid-cols-4 gap-3">

<div class="card-panel">

**DISCOVER**

Find a service by capability.

</div>

<div class="card-panel">

**VERIFY**

Check identity and endpoint.

</div>

<div class="card-panel">

**PAY**

Use a machine-readable quote.

</div>

<div class="card-panel card-panel--accent">

**EXECUTE**

Invoke the selected Agent.

</div>

</div>

<div class="mt-8 text-center text-lg">
Providers keep their <strong>Prompts · Skills · code · runtime</strong> private.
</div>

</div>

<div class="slide-foot tagline">
Discover → Verify → Pay → Execute
</div>

</div>

<!--
口播：Frely Network 不是 Prompt 市场。Provider 保留自己的 Agent、Prompt、Skill 和运行时；Network 提供交易层。
-->

---

<div class="slide-frame">

<div class="slide-head">

# Demo case: Web3 safety Agent

### Trust the Agent before trusting the destination.

</div>

<div class="slide-body">

<div class="grid grid-cols-2 gap-5">

<div class="card-panel">
<strong>ethereum.org</strong><br /><br />
NO_KNOWN_RISK<br />
Canonical Ethereum community website<br />
No phishing signal found
</div>

<div class="card-panel card-panel--accent">
<strong>ethereun.org</strong><br /><br />
SUSPICIOUS / HIGH RISK<br />
Lookalike domain<br />
Possible phishing or impersonation
</div>

</div>

<div class="mt-7 text-center text-lg">
<code>capability: web3.url-risk</code> · <code>agent: web3-safety.frely.eth</code>
</div>

</div>

<div class="slide-foot tagline">
Frely Network verifies the safety Agent. The safety Agent verifies the Web3 destination.
</div>

</div>

<!--
口播：演示案例使用 URL 风险。先检查 ethereum.org，得到无已知风险；再检查 ethereun.org，展示仿冒域名风险。若真实数据没有确认钓鱼，只说 suspicious，不说钓鱼已被证明。
-->

---

<div class="slide-frame">

<div class="slide-head">

# The user experience

### From a prompt to an external safety capability.

</div>

<div class="slide-body">

<div class="grid grid-cols-4 gap-3">

<div class="card-panel">
<strong>1 · READ</strong><br /><br />
Copy one prompt from<br />network.frely.cloud
</div>

<div class="card-panel">
<strong>2 · ASK</strong><br /><br />
“Is ethereun.org safe?”
</div>

<div class="card-panel">
<strong>3 · PAY</strong><br /><br />
The wallet approves the x402 Agent call.
</div>

<div class="card-panel card-panel--accent">
<strong>4 · RESULT</strong><br /><br />
Receive a source-backed URL risk report and settlement evidence.
</div>

</div>

<div class="mt-7 text-center">
<code>Read https://network.frely.cloud/SKILL.md and use the best Network adapter available in this chat.</code>
</div>

</div>

<div class="slide-foot tagline">
The live operation recording is optional. This is the complete consumer flow.
</div>

</div>

<!--
口播：这是提交视频的真实操作段。若现场录屏稳定，就在本页后插入；若录屏失败，这页已经说明完整用户体验。
-->

---

<div class="slide-frame">

<div class="slide-head">

# One request. One service path.

### The host never needs a fixed Agent endpoint.

</div>

<div class="slide-body">

```text
ChatGPT / Agent Host
        ↓  reads SKILL.md + uses a Network adapter
Frely Network Broker
        ↓
The Graph  →  ENS / ERC-8004  →  web3-safety.frely.eth
 DISCOVER        VERIFY                    ↓
                                  verified Offering quote
                                           ↓
Caller wallet  →  x402 settlement to Offering publisher
                                           ↓
                                        Frely A2A
                                           ↓
                                     Swarm safety Agent
                                           ↓
                         URL result + settlement evidence
```

</div>

<div class="slide-foot">
<div class="tagline">Web3 wallet = caller identity + payment authorization</div>
<div class="text-sm opacity-60">Paid path: discover → verify → quote → settle → execute.</div>
</div>

</div>

<!--
口播：用户不需要先做钱包登录。钱包在付费调用中同时承担身份和支付授权。这个案例从 The Graph 发现 Web3 Agent，因此 x402 付款给经过验证的 Offering 发布者；付款结算后才执行 Agent。
-->

---

<div class="slide-frame">

<div class="slide-head">

# Which Agent can do this?

### The Graph is the discovery layer.

</div>

<div class="slide-body">

```text
“Is ethereun.org safe?”
          ↓
capability: web3.url-risk
          ↓
      The Graph
          ↓
web3-safety.frely.eth
          ↓
        Broker
```

<div class="kw-row mt-7">
  <span>Capability search</span>
  <span>Registered services</span>
  <span>No fixed endpoint</span>
</div>

</div>

<div class="slide-foot tagline">
The Graph answers: <strong>Which service matches this task?</strong>
</div>

</div>

<!--
口播：The Graph 负责 Which。Host 不直接写死某个安全服务 URL，Network 按 web3.url-risk 找注册服务。
-->

---

<div class="slide-frame">

<div class="slide-head">

# Can I trust the service I found?

### ENS + ERC-8004 bind identity to the service.

</div>

<div class="slide-body">

```text
web3-safety.frely.eth
      ↓
ERC-8004 registration
      ↓
ENS identity + records
      ↓
AgentCard / A2A endpoint
      ↓
Verified safety Agent
```

<div class="kw-row mt-7">
  <span>Human-readable identity</span>
  <span>Registration evidence</span>
  <span>Verified endpoint</span>
</div>

</div>

<div class="slide-foot tagline">
Discovery says what exists. Identity verification says who controls the service path.
</div>

</div>

<!--
口播：发现结果不能直接执行。Network 用 ERC-8004 与 ENS 核对身份和 endpoint，再进入服务调用。
-->

---

<div class="slide-frame">

<div class="slide-head">

# How does paid Agent commerce work?

### x402 + Hedera provide the payment path.

</div>

<div class="slide-body">
```text
Request
  ↓
HTTP 402 + quote
  ↓
x402 payment proof
  ↓
Blocky402 /verify
  ↓
Blocky402 /settle
  ↓
Hedera settlement evidence
  ↓
Agent execution
```

<div class="kw-row mt-7">
  <span>Pay-per-call</span>
  <span>Idempotency</span>
  <span>Settlement evidence</span>
</div>

</div>

<div class="slide-foot">
<div class="tagline">The wallet is the Web3 caller identity and payment authority.</div>
<div class="text-sm opacity-60">A paid Agent call executes after settlement.</div>
</div>

</div>

<!--
口播：Web3 用户不需要钱包登录步骤。钱包就是身份和支付授权。x402 负责报价与支付证明，Hedera 完成结算，Agent 在结算成功后执行。
-->

---

<div class="slide-frame">

<div class="slide-head">

# Web3 commerce. Web2 execution.

### Providers do not need to become Web3 applications.

</div>

<div class="slide-body">

<div class="grid grid-cols-3 gap-4 items-stretch">

<div class="card-panel">
<strong>CONSUMER</strong><br /><br />
Agent request<br />Wallet identity<br />Web3 payment
</div>

<div class="card-panel card-panel--accent">
<strong>FRELY NETWORK</strong><br /><br />
Discovery<br />Verification<br />Payment coordination<br />Execution evidence
</div>

<div class="card-panel">
<strong>PROVIDER</strong><br /><br />
Normal account + API key<br />Frely A2A<br />Swarm execution<br />Private Agent IP
</div>

</div>

</div>

<div class="slide-foot tagline">
Consumer wallet data stops at Network. The Provider receives a normal service request.
</div>

</div>

<!--
口播：这是项目最重要的边界。Network 面向 Web3；Frely 仍按普通 Web2 客户处理。Provider 不需要加入钱包、Hedera 或 x402 逻辑。
-->

---

<div class="slide-frame">

<div class="slide-head">

# What we built

### The deck can stand on evidence when the live demo cannot.

</div>

<div class="slide-body">

<div class="grid grid-cols-2 gap-5">
<div class="card-panel">
<strong>HOST CONTRACT</strong><br /><br />
One SKILL.md for chatbots and Agents<br />Native / MCP / HTTP / CLI adapters<br />Wallet = Web3 identity + payment authority<br />No wallet-login prerequisite
</div>

<div class="card-panel card-panel--accent">
<strong>PAID AGENT PATH</strong><br /><br />
Discover + verify Agent and Offering<br />Source-dependent payment destination<br />x402 + Hedera settlement before execution<br />Idempotency and recovery states
</div>

</div>

<div class="mt-7 text-center text-base opacity-85">
Network: 704 tests · CLI: 41 tests · Swarm: 65 tests · Total: 810 tests passed
</div>

</div>

<div class="slide-foot">
<div class="tagline">Release gates remain: Offering payment routing, paid consumer adapter, publish + deploy, live acceptance.</div>
<div class="text-sm opacity-60">Legacy platform-demo authorization is not presented as Web3 payment evidence.</div>
</div>

</div>

<!--
口播：Skill 是跨宿主的 Network 使用协议，不是 CLI 安装器。Web3 钱包同时承担身份和付款。Frely 托管 Agent 收款到 Network；链上发现的 Agent 收款到经过验证的 Offering 发布者。旧 platform_demo 不作为付费链路证据。
-->

---
<div class="slide-frame slide-frame--center">

<div class="slide-head">

# Agents should be able to hire Agents.

</div>

<div class="slide-body">

# Discover → Verify → Pay → Execute

<div class="tagline mt-8">
Trust the Agent.<br />
Trust the destination.<br />
Keep the Provider runtime private.
</div>

</div>

<div class="slide-foot">

<img src="/logo-mark.png" class="h-12 mx-auto" />

<p class="mt-4 text-sm opacity-50">Frely Network · ETHOnline 2026</p>

</div>

</div>

<!--
口播：Frely Network 让 Agent 能购买另一个 Agent 的能力，同时让 Provider 保留自己的私有资产和运行时。安全演示中，Network 验证 Agent，安全 Agent 验证 Web3 目的地。
-->