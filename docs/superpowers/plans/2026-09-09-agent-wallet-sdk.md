---
title: Minimal SDK agent wallet implementation plan
mdq:
  profile: project-governance/governed-document-v1
---
# SDK Agent Wallet 最小实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 用户最新要求：最小实现、只做基础测试；本计划不授权现在开始编码或真实收费操作。

**Goal:** 实现独立的 agent wallet init：SDK 本地生成密钥，用户充值自动开户，SDK 激活核验，然后输出既有 x402 signer 可使用的身份片段。

**Architecture:** 一个钱包包负责本地文件、限定链上操作及恢复；一个薄 CLI 负责输入和充值提示。Broker 不运行初始化，只沿用现有付款配置及 file signer。

**Tech Stack:** Bun 1.4.0、TypeScript 6.0.3、Node >=22.13.0、@hiero-ledger/sdk 2.85.0、Bun SQLite（仅用于进程锁）；不引入 CLI 框架、Hiero CLI 运行依赖或新数据库服务。

**Spec:** [AWS-001–007](../specs/2026-09-09-agent-wallet-sdk-design.md)；运行规则的单一事实来源是 [WINIT-001–007](../../../workflows/agent-wallet-init.md)。执行者先读两份文档；本计划的代码片段定义实现接口，不是已存在的实现。

## PLAN-001 — Global Constraints 与执行前提

Status: Draft
Review level: L3
Source: AWS-001 至 AWS-007；WINIT-001 至 WINIT-007；2026-09-09 用户“最小实现，不要做过多的测试”

- “第一版仅支持 Hedera Testnet、ECDSA secp256k1、本地 POSIX 文件权限和 HBAR 初始化资金。”
- “不调用 AccountCreateTransaction，不要求已有 operator 私钥。”
- “钱包包不导入 Broker、MCP、业务 payment session 或付款 registry。”
- “沿用 0700/0600 明文文件规范，同一系统用户可读取”；路径、文件类型、所有者、格式检查不能为减少测试而删除。
- “init 不修改 registry、不设置 enabled=true、不启动或热更新 Broker。”
- “任何失败、超时、恢复或重新运行不得自动提高上限或产生第二笔新激活交易。”
- 复用已有 file signer，不回退 env，不更改业务签名算法、付款去重、unknown、恢复和结算核验。
- 只新增 **4 项基础测试**：本地钱包生成/复用；模拟初始化成功；未知交易恢复不重发；与现有 signer 的离线交接。没有覆盖率指标、完整异常排列、漫长实时时间测试或全仓回归要求。
- AccountUpdate 激活的真实兼容性仍未证明。允许完成下面的最小实现以产生可运行验收入口，但不能把计划、mock 或 CLI 密钥生成当作链上验收通过；最终交付须保留该门槛。

执行前准备（纳入 Task 1，不另造交付任务）：

- [ ] 在执行时用 using-git-worktrees 创建新的隔离工作区，从最新 B1wl7ch 的文档提交开始；核实本计划可读。不要修改当前有脏文档的主工作区。
- [ ] 在该新工作区集成 feat/hedera-local-key，确认 e7c0637、7659c31 已在祖先链。若分支已集成则跳过；不能重复重写 key-file/file-signer。只合并到实施分支，不在此步合并主分支或推送。
- [ ] 使用 Bun 1.4.0。已知本机可执行文件为 `/Users/bit/.bun/install/cache/@oven/bun-darwin-aarch64@1.4.0@@@1/bin/bun`；执行时验证版本，后文的 `bun` 均指这个版本。不得用已知旧的默认 Bun 改写 lockfile。
- [ ] 核对文件范围；记录实施起点。只提交该任务文件，不顺带提交旧 allowance 文档或其他本地计划。

## PLAN-002 — 文件与共用接口

Status: Draft
Review level: L3
Source: AWS-002 至 AWS-005

| 文件 | 职责 | 任务 |
| --- | --- | --- |
| packages/wallet/agent-wallet/package.json、index.ts、types.ts | 包入口及下面的稳定接口 | 1 |
| packages/wallet/agent-wallet/local-wallet.ts | 创建、回读、原子保存、SQLite 独占锁 | 1 |
| packages/wallet/agent-wallet/local-wallet.test.ts、test-support.ts | 一个文件测试及临时目录工具 | 1 |
| packages/wallet/agent-wallet/chain.ts | 固定 Testnet 查询、交易构建核对和一次提交 | 2 |
| packages/wallet/agent-wallet/init.ts、init.test.ts | 状态推进、恢复与两个基础用例 | 2 |
| apps/agent-cli/package.json、index.ts、README.md | 参数、交互提示、JSON 输出、使用方式 | 3 |
| 根 package.json、bun.lock | 钱包 workspace 和直接依赖；CLI 启动脚本 | 1、3 |
| packages/payment/hedera-x402/file-signer.test.ts、package.json | 一个交接测试；钱包包仅作为 devDependency | 3 |
| apps/broker-mcp/README.md、scripts/payment-spike/README.md | 配置片段交接说明 | 3 |

types.ts 的最小公共契约（Task 1 建立；Task 2/3 使用同一名字，不各自定义）：

```ts
export type Limits = { maxFeeTinybar: string; reserveTinybar: string };
export type Wallet = {
  schemaVersion: 1; network: 'hedera:testnet'; keyType: 'ecdsa';
  publicKey: string; evmAddress: string; signerRef: string;
  accountId: string | null; verifiedAt: string | null;
};
export type Intent = {
  transactionId: string; bodyDigest: string; submittedAt: string;
};
export type Evidence = {
  transactionId: string; consensusTimestamp: string;
  chargedFeeTinybar: string; verificationUrl: string;
};
export type State = {
  workflowId: 'agent-wallet-init'; runId: string; limits: Limits;
  phase: 'LocalReady' | 'AwaitFunding' | 'InspectAccount' | 'Activate' | 'Verify' | 'Ready' | 'Blocked';
  intent: Intent | null; evidence: Evidence | null; reason: string | null;
};
export type Snapshot = { wallet: Wallet; state: State };
export type Identity = {
  network: 'hedera:testnet'; payerAccountId: string;
  keyType: 'ecdsa'; signerRef: string;
};
export type Outcome = {
  status: 'ready' | 'waiting_funds' | 'activation_unknown' | 'paused' | 'blocked';
  exitCode: 0 | 2 | 3; reason: string | null;
  walletPath: string; verifiedAt: string | null;
  paymentIdentity: Identity | null;
};
export type Progress = {
  kind: 'funding' | 'phase'; walletPath: string; evmAddress: string;
  balanceTinybar: string; requiredTinybar: string; deficitTinybar: string;
  limits: Limits; phase: State['phase'];
};
export type Options = {
  network: 'hedera:testnet'; walletDir: string; limits?: Limits;
};
```

金额字符串仅保存十进制整数；校验正数、上限 9223372036854775807，maxFee+reserve 也不得超限。CLI 十进制 HBAR 转 tinybar 用字符串拆分和 BigInt，不能经过浮点数。新钱包必须有 limits；恢复省略时沿用，显式不同值返回 `INIT_CONFIG_CONFLICT`。

## PLAN-003 — Task 1：可复用的本地钱包

Status: Draft
Review level: L3
Source: AWS-003；WINIT-001、WINIT-002

**Interfaces:** `openLocalWallet(options: Options): Promise<WalletStore>`。WalletStore 暴露只读 dir、snapshot，`save(next: Snapshot): Promise<void>`、`readKey(): Promise<PrivateKey>`、`close(): void`。close 释放 SQLite 事务及连接；save 成功后更新内存 snapshot。readKey 为钱包内部签名使用，不从包 index.ts 导出它或 PrivateKey；公共 index 先导出 openLocalWallet 及公共类型，最终 CLI 不直接读取 key。

- [ ] **Step 1 — 写一个失败用例。** 新建 local-wallet.test.ts：临时目录创建→权限/格式检查→关闭→重开→公钥相同。一个用例覆盖正常持久化和重复执行，避免排列所有异常。

```ts
import {test, expect} from 'bun:test';
import {mkdtemp, realpath, readFile, stat, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openLocalWallet} from './local-wallet.ts';
test('persists a restricted key and reuses the wallet', async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'wallet-test-')));
  const walletDir = join(parent, 'wallet');
  const options = {network: 'hedera:testnet' as const, walletDir,
    limits: {maxFeeTinybar: '10000000', reserveTinybar: '10000000'}};
  let store: Awaited<ReturnType<typeof openLocalWallet>> | undefined;
  try {
    store = await openLocalWallet(options);
    const publicKey = store.snapshot.wallet.publicKey;
    expect((await stat(walletDir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(walletDir, 'agent.key'))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(walletDir, 'agent.key'), 'utf8')).toMatch(/^[0-9a-f]{64}\n?$/i);
    store.close();
    store = await openLocalWallet({network: options.network, walletDir});
    expect(store.snapshot.wallet.publicKey).toBe(publicKey);
    expect(store.snapshot.state.limits).toEqual(options.limits);
  } finally { store?.close(); await rm(parent, {recursive: true, force: true}); }
});
```

- [ ] **Step 2 — 运行 RED。** `bun test packages/wallet/agent-wallet/local-wallet.test.ts`；应因新模块不存在而失败，不接受语法/环境错误作 RED。
- [ ] **Step 3 — 建包并实现最小文件存储。** 新 package.json 使用 name=`@frely-network/agent-wallet`、private=true、type=module、exports/types=`./index.ts`、dependency=`@hiero-ledger/sdk:2.85.0`；根 workspace 添加 `packages/wallet/*`，运行一次 bun install 并审查 lock 差异。

核心生成动作如下；只在已验证目录、取得锁、确认三个钱包文件均不存在后执行：

```ts
const key = await PrivateKey.generateECDSAAsync();
const publicKey = key.publicKey.toStringRaw();
const evmAddress = '0x' + key.publicKey.toEvmAddress();
const file = await open(keyPath, constants.O_WRONLY | constants.O_CREAT |
  constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
try { await file.writeFile(key.toStringRaw() + '\n'); await file.sync(); }
finally { await file.close(); }
```

使用 node:fs/promises 的 open、realpath、lstat、rename 和 node:fs constants；keyPath=join(walletDir,'agent.key')。生成后按已有 key-file.ts 的权限、上限、格式及 SDK 校验规则回读，公钥一致才写 JSON。钱包包不反向 import 付款包；这里只共享文件契约。既有文件全存在则校验再加载；部分存在就 `WALLET_STATE_INVALID`，不补造密钥。

目录逐层 lstat，已有组件不得是符号链接；新目录0700，已有直接父目录和文件验证当前 UID、准确权限，不自动 chmod 用户已有文件。默认路径在 CLI 层用 realpath(homedir()) 计算。JSON 只接受声明字段和类型，读取限制 1 MiB；私钥限制 1 KiB。文件打开后 fstat 检查；写 JSON 使用同目录排他临时文件0600、sync、rename、目录 sync。写入失败立即停止后续链上动作。

锁文件先安全创建/验证为0600普通文件，再使用 `Database` from `bun:sqlite` 打开：`PRAGMA busy_timeout=0`，`BEGIN IMMEDIATE`。只持锁，不向数据库保存私钥或业务数据。失败统一 `INIT_IN_PROGRESS`；异常路径关闭连接。锁保护 wallet/state 成对更新，崩溃造成部分写入时停在 `WALLET_STATE_INVALID`，不尝试猜测修复。

- [ ] **Step 4 — GREEN 与一次类型检查。** 重跑这个测试及 `bun run typecheck`；通过即停止扩展测试。固定错误映射为 `SIGNER_UNAVAILABLE`、`WALLET_STATE_INVALID`、`INIT_CONFIG_CONFLICT`、`INIT_IN_PROGRESS`，不透传原始异常。
- [ ] **Step 5 — 提交本任务文件。** `git add packages/wallet/agent-wallet package.json bun.lock`；`git commit -m "feat(wallet): persist a standalone local agent wallet"`。

## PLAN-004 — Task 2：最小到账、激活与恢复

Status: Draft
Review level: L3
Source: AWS-003；WINIT-003 至 WINIT-006

**Interfaces:** 消费 Task 1 的 Options、WalletStore、Snapshot。新增 `initWallet(options: Options, ports?: Partial<InitPorts>): Promise<Outcome>`；默认创建实际网络端口，测试显式注入。公开 index 导出 initWallet。`InitPorts` 和 `ChainPort` 在 types.ts 追加：

```ts
export type Account = {
  accountId: string; evmAddress: string; publicKey: string | null;
  balanceTinybar: string; memo: string;
};
export type TransactionCheck =
  | {kind: 'success'; evidence: Evidence}
  | {kind: 'unknown'} | {kind: 'failed'; reason: string};
export type PreparedActivation = {intent: Intent; submit(): Promise<void>};
export type ChainPort = {
  account(wallet: Wallet, signal: AbortSignal): Promise<Account | null>;
  prepare(wallet: Wallet, limits: Limits): Promise<PreparedActivation>;
  transaction(intent: Intent, wallet: Wallet, limits: Limits,
    signal: AbortSignal): Promise<TransactionCheck>;
  close(): void;
};
export type InitPorts = {
  chain: ChainPort; now(): number; delay(ms: number): Promise<void>;
  progress(event: Progress): void;
};
```

实际 `createChain(store: WalletStore): ChainPort` 在 prepare 才调用 store.readKey。测试用假的 prepare，不产生外部交易。默认 now=Date.now、delay 使用有界 timer、progress 空函数；initWallet 取得 store 后构造缺省 chain，再用传入的 Partial<InitPorts> 覆盖。CLI 只传 progress，不自行打开另一份 store 或网络 client。

- [ ] **Step 1 — 写两个基础失败用例。** 在 test-support.ts 新增 `withWalletDir(run: (walletDir: string) => Promise<void>): Promise<void>`：用 mkdtemp/realpath 创建临时根目录，传入其未创建的 wallet 子路径，finally 删除该测试目录。init.test.ts 使用下面的最小模拟端口；计时为虚拟时间，不真实等待。

```ts
function fakePorts(unknown = false) {
  let now = 0, complete = false, submits = 0;
  const intent = {transactionId: '0.0.12345@1.000000001',
    bodyDigest: 'a'.repeat(64), submittedAt: '1970-01-01T00:00:00.000Z'};
  const ports: InitPorts = {
    now: () => now, delay: async ms => { now += ms; }, progress: () => {},
    chain: {
      account: async wallet => ({accountId: '0.0.12345', evmAddress: wallet.evmAddress,
        publicKey: complete ? wallet.publicKey : null,
        balanceTinybar: '100000000', memo: complete ? 'frely-agent-wallet' : ''}),
      prepare: async () => ({intent, submit: async () => {
        submits++; if (unknown) throw Error('SIMULATED_TIMEOUT'); complete = true;
      }}),
      transaction: async () => unknown ? {kind: 'unknown'} : {kind: 'success', evidence: {
        transactionId: intent.transactionId, consensusTimestamp: '2.000000001',
        chargedFeeTinybar: '1000', verificationUrl: 'https://testnet.mirrornode.hedera.com'}},
      close: () => {},
    },
  };
  return {ports, submits: () => submits};
}
test('funded wallet becomes ready with only public identity', async () => {
  await withWalletDir(async walletDir => {
    const f = fakePorts();
    const result = await initWallet({network: 'hedera:testnet', walletDir,
      limits: {maxFeeTinybar: '10000000', reserveTinybar: '10000000'}}, f.ports);
    expect(result.status).toBe('ready');
    expect(result.paymentIdentity?.payerAccountId).toBe('0.0.12345');
    expect(f.submits()).toBe(1);
    const secret = (await readFile(join(walletDir, 'agent.key'), 'utf8')).trim();
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});
test('unknown submission is queried instead of submitted again', async () => {
  await withWalletDir(async walletDir => {
    const f = fakePorts(true);
    const options = {network: 'hedera:testnet' as const, walletDir,
      limits: {maxFeeTinybar: '10000000', reserveTinybar: '10000000'}};
    expect((await initWallet(options, f.ports)).status).toBe('activation_unknown');
    expect((await initWallet(options, f.ports)).status).toBe('activation_unknown');
    expect(f.submits()).toBe(1);
  });
});
```

导入 test/expect（bun:test）、readFile（node:fs/promises）、join（node:path）、InitPorts（./types.ts）、initWallet（./init.ts）、withWalletDir（./test-support.ts）。

- [ ] **Step 2 — RED。** `bun test packages/wallet/agent-wallet/init.test.ts`；预期缺少 initWallet 失败。
- [ ] **Step 3 — 实现 chain.ts。** 固定官方 Mirror，fetch 使用 redirect:error、AbortSignal，响应体最大1MiB，整数只接收安全整数 number 或规范整数字符串。不接受不安全 number 后再 BigInt。account 只在404时返回 null；其余 HTTP、超时及结构错误统一 `NETWORK_CHECK_FAILED`。拒绝 deleted、非数字账户 ID、evm_address 不匹配及非单 ECDSA key；空账户仅 key=null。完整 key 必须为压缩公钥并与本地一致。

交易构建使用 SDK 2.85.0 已存在的方法，memo 同时写账户字段和交易字段，方便核验两个不同对象：

```ts
const client = Client.forTestnet();
const transactionId = TransactionId.generate(AccountId.fromString(wallet.accountId!));
const transaction = new AccountUpdateTransaction()
  .setAccountId(wallet.accountId!)
  .setAccountMemo('frely-agent-wallet')
  .setTransactionMemo('frely-agent-wallet')
  .setTransactionId(transactionId)
  .setTransactionValidDuration(120)
  .setMaxTransactionFee(Hbar.fromTinybars(limits.maxFeeTinybar))
  .setRegenerateTransactionId(false)
  .setMaxAttempts(1)
  .freezeWith(client);
const key = await store.readKey();
await transaction.sign(key);
```

上述变量属于 createChain(store) 内的 prepare(wallet,limits)。签名前再次校验账户 ID/地址及金额，签后用 Transaction.fromBytes 解码，核对 AccountUpdate 类型、accountId、accountMemo、transactionMemo、transactionId、120秒、maxFee、无新 key/质押/token关联字段，公钥 verifyTransaction 必须通过。bodyDigest 为完整签名 bytes 的 SHA-256；字节不落盘。PreparedActivation.submit 只调用一次 `transaction.execute(client, 30_000)`，SDK 异常不得触发第二次 execute；close 关闭 client。

交易查询复用现有 verifier.ts 的 ID 转换规则，但不导入业务 verifier。请求 `/api/v1/transactions/<account-seconds-nanos>`，从记录中选择唯一 nonce=0、scheduled=false、匹配 transaction_id 的主记录，不能把空账户补全产生的子记录算成重复主交易。核对 name=CRYPTOUPDATEACCOUNT、entity_id=账户、memo_base64 解码后的固定交易 memo、charged_tx_fee≤maxFee、合法 consensus_timestamp；payer 来自已绑定 transactionId。成功后还须账户公钥/地址/account memo 匹配；记录与账户字段缺失、冲突为 unknown 或固定错误，不猜测。

- [ ] **Step 4 — 实现 init.ts。** 严格按 WINIT-003/005 阶段表推进，不另建后台服务。先读取状态：有 intent 时直接 Verify，绝不 prepare/submit；Blocked 只返回已存失败；没有 intent 才检查余额与账户状态。已有完整匹配账户跳过激活，仅要求 reserve；空账户要求 maxFee+reserve。save intent 与 Activate 阶段必须成功后才调用 submit，失败时只查询原 ID。

用 WINIT 的总期限裁剪每个 fetch/timer 的剩余时间；连续网络错误计数只在成功响应后清零，404不是网络错误。首次、余额变化或阶段变化才调用 progress。成功交易 evidence 先持久化，后续 Mirror 延迟不抹除证据；只读失败返回 paused/unknown。临时余额不足回 AwaitFunding，不再花钱激活。最后保存 Ready 和 verifiedAt 后才输出 paymentIdentity；否则该字段始终 null。所有退出路径 finally close chain/store。

- [ ] **Step 5 — GREEN、类型检查、提交。** 只运行 init.test.ts 和 `bun run typecheck`；提交 types.ts、index.ts、chain.ts、init.ts、init.test.ts、test-support.ts，消息 `feat(wallet): activate funded accounts with resumable initialization`。

## PLAN-005 — Task 3：薄 CLI 与 signer 交接

Status: Draft
Review level: L3
Source: AWS-004、AWS-005；WINIT-006

**Interfaces:** CLI 消费 initWallet、Options、Outcome、Progress。`main(args: string[], io): Promise<number>` 中 io 提供 isTTY、ask(prompt):Promise<string>、stdout(text)、stderr(text)；实际 process 适配在 import.meta.main 分支。不创建新的业务配置加载器。

- [ ] **Step 1 — 写第4个基础测试。** 在现有 file-signer.test.ts 添加一个用例：用 openLocalWallet 创建真实临时文件，关闭锁；合入 synthetic policy 的 signerRef/keyType，沿用 fixture 的数字 payerAccountId；注入匹配公钥的 Mirror 响应，调用 createSdkSigner。复用该文件已有 preflight、fixture 和 Transaction 校验，不重新搭建支付 session。

```ts
const policy = loadPaymentConfig({...raw,
  signerRef: wallet.signerRef, keyType: wallet.keyType});
const checked = preflight({policy, payment: valid.request.payment, http: valid.capture});
if (checked.decision !== 'prepared') throw Error('TEST_PREFLIGHT_FAILED');
const resolve = createFileKeyResolver(policy, async () => Response.json({
  account: policy.payerAccountId, deleted: false,
  key: {_type: 'ECDSA_SECP256K1', key: wallet.publicKey},
}));
const result = await createSdkSigner(policy, resolve)(checked.selection);
expect(typeof result.payload.payload.transaction).toBe('string');
```

在完整用例中 wallet 来自 `store.snapshot.wallet`；用 PublicKey.fromStringECDSA(wallet.publicKey).verifyTransaction 校验返回 bytes，临时目录 finally 清理。该测试仅证明文件格式及真实离线签名兼容；模拟账户不标记为链上 Ready。付款包仅新增钱包 workspace devDependency，runtime dependencies 不变。

- [ ] **Step 2 — 添加最小 CLI。** apps/agent-cli/package.json 依赖 `@frely-network/agent-wallet:workspace:*`，bin=`agent:./index.ts`；index.ts 以 Bun shebang 启动。根脚本增加 `agent: bun apps/agent-cli/index.ts`。开发运行命令为 `bun run agent wallet init ...`，不自动全局安装。

只接受 `wallet init`，以及 --network、--wallet-dir、--max-fee-hbar、--reserve-hbar、--format human|json、--help。未知/重复参数、错误网络、非法金额退出2。parseArgs 使用 node:util；首次交互缺金额时 ask，一次收集两项；非交互缺金额直接退出。恢复允许省略金额，交给 store 读取已存授权；不暗中提高。

HBAR 解析核心（在 CLI 本地定义 hbarToTinybar）：

```ts
function hbarToTinybar(input: string): string {
  const m = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,8}))?$/.exec(input);
  if (!m) throw Error('INPUT_INVALID');
  const value = BigInt(m[1]!) * 100_000_000n + BigInt((m[2] ?? '').padEnd(8, '0'));
  if (value <= 0n || value > 9223372036854775807n) throw Error('INPUT_INVALID');
  return value.toString();
}
```

human 输出 WINIT-006 的充值 Brief；json 模式 stdout 使用逐行 JSON，进度为 `{type:'progress',...event}`，最终为 `{type:'result',...outcome}`，不用非结构化日志污染输出。错误仅输出已知固定码及恢复命令；不传递 SDK 原始异常或 key。CLI 不读写 Broker 配置、不启用付款。

- [ ] **Step 3 — 说明交接。** 新 apps/agent-cli/README.md 记录新建/恢复命令、存储路径、金额输入与退出码。现有 Broker/付款 README 引用此文档，说明只把 paymentIdentity 的4个字段合入已有 Policy，保留业务参数、首次 enabled=false、沿用 registry 和 journal。不提供带假 payTo/业务 URL 的“可运行”配置。
- [ ] **Step 4 — 基础验证。** 运行 `bun test packages/payment/hedera-x402/file-signer.test.ts`、一次最终 `bun run typecheck`；手动运行 `bun run agent --help` 和缺 network 的命令，确认不创建钱包、错误退出2。若前三项测试后没有相关变更，不重复跑它们，不跑全仓 suite。
- [ ] **Step 5 — 提交。** 只 add 本任务 CLI、README、测试及 workspace 元数据，消息 `feat(wallet): expose init command and payment identity handoff`。

## PLAN-006 — Task 4：旧钱包转入测试 HBAR，验收新钱包初始化

Status: Draft
Review level: L3
Source: AWS-006、AWS-007；WINIT-004 至 WINIT-007；2026-09-09 用户授权使用之前的私钥向本地新钱包转测试代币，并要求先写任务

**任务状态：已完成。真实充值、激活、Ready 和同目录不重发验收通过；证据见验收记录。**

**目标：** 使用用户此前配置的本地私钥控制的旧 Testnet 账户，向正式 CLI 新建的独立 Agent 钱包转入测试 HBAR，完成到账、自动激活、Ready 和同目录重复运行的最小真实验收。这里的“测试代币”按现有 HBAR 初始化范围解释，不添加 HTS token 关联或业务 x402 付款测试。

**范围与授权：** 用户已允许旧钱包向新钱包转入测试资金；实际执行安排在本任务之后。本次委托转账是 WINIT-006 充值 Checkpoint 的执行方式，初始化流程仍以 `workflows/agent-wallet-init.md` 为唯一事实来源。旧私钥只供独立的验收转账步骤使用，不传入 init、不交给 Broker、不替代新钱包生成的私钥。此前 Hiero 探测钱包不能仅因已生成密钥就被认定为有余额的资金来源。

**输入及执行前置条件：**

- 执行分支为 `feat/agent-wallet-sdk`，实现基线 `b71014c`；使用 Bun 1.4.0 和现有 SDK，不先合并或推送。
- 执行时先从此前已配置的本地凭据引用中定位旧钱包，只记录凭据路径/引用、公开账户 ID 和地址；在本地派生公钥并与 Testnet 账户核对，同时查询 HBAR 余额。凭据含糊、缺失、网络或账户不符时暂停，不能猜选另一个资金来源，也不能把私钥输出到终端日志或聊天。
- 必须明确四项金额：充值额、旧账户转账手续费上限、新账户激活 maxFee、新账户 reserve。复用同一验收已明确记录的授权值；缺少数值时先只读核对，再集中请求缺失数值，不擅自填写。首次充值额至少覆盖新账户 maxFee + reserve；旧账户余额须覆盖充值额与转账费用，别把新账户激活上限用于旧账户转账。
- 使用一个仓库和同步目录之外的专用验收目录。已有完整的钱包则复用；残缺或冲突时保留并停止，不能重建密钥。若此前已有 Ready 钱包，只能用于复跑检查，不能冒充本任务的首次激活证据。

**产物位置：** 新建 `docs/verification/2026-09-09-agent-wallet-testnet-acceptance.md`，沿用 governed-document-v1、结构化记录 ID 和实际生命周期字段。只保存公开身份、金额、交易 ID、Mirror 核对结果、运行退出码与证据链接。私钥和可广播的签名交易字节不得写入文档。执行记录已建立，见 [验收记录](../../verification/2026-09-09-agent-wallet-testnet-acceptance.md)。

- [x] **Step 1 — 核对输入并建立运行记录。** 记录源账户、目标钱包目录、网络、四项明确金额和实施 commit；确认只使用测试 HBAR。缺失输入标记为等待输入，不把任务标记通过。
- [x] **Step 2 — 正式 CLI 新建或恢复目标钱包。** 使用 `bun run agent wallet init --network hedera:testnet --wallet-dir <验收绝对目录> --max-fee-hbar <已授权激活上限> --reserve-hbar <已授权保留余额> --format json`。首次金额取 Step 1 已记录值；恢复省略两项金额以复用保存授权。回读公开 wallet.json 与充值进度，确认本地生成的公钥/地址和待充值状态，随后才允许向该地址转账。命令中的参数由执行记录提供，不是默认额度。
- [x] **Step 3 — 旧钱包只转入一次测试 HBAR。** 使用本地 SDK 构造原生 HBAR 转账：源账户扣除已授权充值额，接收方是目标公钥派生的 EVM 地址，不误用未创建的数字账户 ID。显式设置源账户 payer、固定交易 ID、授权的转账手续费上限，关闭新 ID 重试；提交前核对网络、双方、资产、金额、费用，并先保存转账意图与交易 ID，再使用旧私钥本地签名提交一次。通过 Mirror 核实原交易 SUCCESS、源账户实际扣款、目标账户入账、资产和金额，再将到账证据交给初始化验收。源账户费用单独记录，不混入到账金额。
- [x] **Step 4 — 验收自动激活及 Ready。** 保持或恢复同一个 init 运行，由新钱包自己的私钥签名、自己付费完成既定 AccountUpdate；记录激活交易 ID、SUCCESS、实际费用不超 maxFee，账户 ID、公钥、EVM 地址和 memo 匹配，余额至少 reserve，持久化 evidence、verifiedAt、Ready 及 exit 0。确认 paymentIdentity 只有公开交接字段，未修改 Broker 或启用业务支付。
- [x] **Step 5 — 同目录复跑一次。** 省略金额重新运行 init；核对地址、密钥公开指纹、账户 ID 和激活交易 ID 均未变化，exit 0、核验时间更新、没有新激活提交或第二笔激活交易。不为覆盖超时而额外制造真实失败交易；如果实测恰好中断，按下面的恢复边界处理。
- [x] **Step 6 — 回读证据并更新验证缺口。** 分别核对充值交易和激活交易，给出“通过 / 未通过 / 等待输入”的实际结论。只有真实步骤全部满足才在 WINIT-007 和 AWS 对应验证项引用验收记录，关闭 AccountUpdate 兼容性缺口；其他未满足的 Workflow DoD 不能因此自动完成。基础测试已通过的部分不重复跑，不新增测试矩阵。

**Success signal：** 同一验收记录能同时证明一次指定旧账户充值成功、一次新账户激活成功、最终 Ready，以及第二次 init 只读核验且未重发。余额截图、SDK execute 返回或 mock 通过均不足以独立完成本任务；成功也不代表真实 x402 服务付款已验收。

**失败、幂等与恢复：** 初始化继续遵守 WINIT-005 的现有时限。独立充值步骤最多提交一次；提交结果不明时只查询已保存的原交易 ID，最多 6 轮、间隔 5 秒、每请求最多 10 秒、总计最多 120 秒，超时保留 unknown 并暂停，不能凭 404、超时或过期重转。重启任务先读记录：已有充值意图先查原交易，已成功则跳过转账；已有激活意图只恢复 init。若保存意图后尚未发出也按未知处理，接受人工核对窗口。余额不足、凭据不匹配、明确交易失败或超费均停止；新转账或追加充值需另行明确金额。AccountUpdate 不兼容时记录原证据，保留 Draft，不静默改用 TopicCreate、第三方转账或显式开户。

## PLAN-007 — 自检与执行交接

Status: Draft
Review level: L3
Source: PLAN-001 至 PLAN-006

| 规格范围 | 计划落点 |
| --- | --- |
| AWS-001/003、WINIT-001/002：SDK、本地文件、独立模块 | Task 1 |
| WINIT-003/004/005：到账、激活、费用限制、去重与恢复 | Task 2 |
| AWS-004/005、WINIT-006：CLI Brief、公开身份、Broker 交接 | Task 3 |
| AWS-002：file signer 分支前提 | Task 1 执行准备 |
| AWS-006/007、WINIT-007：旧钱包充值与最小真实验收 | Task 4 / PLAN-006 |

接口、阶段名和属性以 PLAN-002/004 为准；实施细节发现与 Workflow 冲突时先修正规格，不静默改变交易权限。文档维护仅新增本计划；既有脏文档与旧计划不修改。按用户最新要求，4项基础用例足够，不因技能模板扩展测试量。

计划保存为本地开发文档，不自动推送。Task 1–3 已在 `feat/agent-wallet-sdk` 实施并复查，当前实现基线为 `b71014c`，四项新增基础测试及类型检查通过；Task 4 已完成真实充值、激活、Ready 与同目录不重发验收，见 [验收记录](../../verification/2026-09-09-agent-wallet-testnet-acceptance.md)。此前步骤清单保留原实施顺序，实际完成证据以提交和验收记录为准。
