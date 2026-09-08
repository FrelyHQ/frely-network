import { encodeFunctionData, isAddressEqual, parseAbi, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { sepolia } from "viem/chains";
import { namehash } from "viem/ens";
import { ensip25AgentRegistrationKey } from "@frely-network/ens";
import type { IdentityBindingPlan } from "../identity-api.ts";

const textAbi = parseAbi(["function setText(bytes32 node, string key, string value)"]);
const registry = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
const storageKey = "frely.ens-binding.pending.v1";
type Pending = { registrationTx: string; key: string; hash?: Hex };
type Wallet = { account: Address; publicClient: PublicClient; walletClient: WalletClient };

export function setupIdentityBinding(options: {
  getWallet: () => Promise<Wallet>;
  run: (action: () => Promise<void>) => Promise<void>;
  log: (message: string, kind?: "info" | "success" | "error") => void;
}) {
  const element = (id: string) => document.getElementById(id)!;
  const preview = element("binding-preview");
  const status = element("binding-status");
  const message = element("binding-message");
  const write = element("binding-write") as HTMLButtonElement;
  const refresh = element("binding-refresh") as HTMLButtonElement;
  const verify = element("binding-verify") as HTMLButtonElement;
  let plan: IdentityBindingPlan | undefined;
  let busy = false;

  function setStatus(text: string, state = "neutral") {
    status.textContent = text;
    status.className = `status ${state}`;
  }
  function pending(): Pending | undefined {
    const value = localStorage.getItem(storageKey);
    return value ? JSON.parse(value) as Pending : undefined;
  }
  function controls() {
    write.disabled = busy || !plan?.transactions.length || !!pending();
    refresh.disabled = busy;
    verify.disabled = busy || !plan || plan.transactions.length > 0;
    write.textContent = plan?.transactions[0]?.key === "agent-endpoint[responses]"
      ? "写入 endpoint 记录" : "写入 ERC-8004 关联记录";
  }
  async function request<T>(path = ""): Promise<T> {
    const response = await fetch(`/api/identity-binding${path}`, {
      cache: "no-store", signal: AbortSignal.timeout(120_000),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "IDENTITY_BINDING_REQUEST_FAILED");
    return body as T;
  }
  function render(value: IdentityBindingPlan) {
    preview.replaceChildren();
    const details = document.createElement("dl");
    for (const [label, content] of [
      ["ENS 名称", value.ensName], ["ERC-8004 Agent ID", value.agentId],
      ["操作钱包", value.owner], ["Resolver（交易目标）", value.resolver],
      ["网络 / 转账金额", "Ethereum Sepolia (11155111) / 0 ETH，仅 gas"],
      ["读取区块", value.blockNumber],
    ]) {
      const term = document.createElement("dt"); term.textContent = label;
      const description = document.createElement("dd"); description.textContent = content;
      details.append(term, description);
    }
    preview.append(details);
    for (const record of value.records) {
      const card = document.createElement("div"); card.className = "binding-record";
      const label = document.createElement("strong");
      label.textContent = value.transactions.some((item) => item.key === record.key) ? "待写入" : "链上记录已满足要求";
      const key = document.createElement("code"); key.textContent = record.key;
      const content = document.createElement("code"); content.textContent = `目标值：${record.value}`;
      card.append(label, key, content); preview.append(card);
    }
    setStatus(value.transactions.length ? `待写入 ${value.transactions.length} 条记录` : "记录已就绪，待回验");
  }
  function validate(value: IdentityBindingPlan) {
    const expected = [
      { key: "agent-endpoint[responses]", value: value.endpoint },
      { key: ensip25AgentRegistrationKey(registry, value.agentId, sepolia.id), value: "1" },
    ];
    if (value.chainId !== sepolia.id || new URL(value.endpoint).protocol !== "https:" ||
        JSON.stringify(value.records) !== JSON.stringify(expected)) throw new Error("绑定计划不符合预期，已停止签名。");
    const seen = new Set<string>();
    for (const { key, transaction: tx } of value.transactions) {
      const record = expected.find((item) => item.key === key);
      if (!record || seen.has(key) || tx.chainId !== sepolia.id || tx.value !== "0" ||
          !isAddressEqual(tx.from, value.owner) || !isAddressEqual(tx.to, value.resolver) ||
          tx.data !== encodeFunctionData({ abi: textAbi, functionName: "setText", args: [namehash(value.ensName), key, record.value] })) {
        throw new Error("交易内容与预览不一致，已停止签名。");
      }
      seen.add(key);
    }
  }
  async function load() {
    const value = await request<IdentityBindingPlan>();
    validate(value);
    plan = value;
    render(value);
    const saved = pending();
    if (saved?.registrationTx === value.registrationTx && !value.transactions.some((item) => item.key === saved.key)) {
      localStorage.removeItem(storageKey);
    }
    const unresolved = pending();
    message.textContent = unresolved
      ? `上次交易尚未核实，暂停再次写入。${unresolved.hash ?? "钱包未返回哈希，请先检查钱包活动记录。"}`
      : "连接上方操作钱包后，逐条写入；两条完成后点击回验。";
    if (unresolved) setStatus("交易状态待核实", "error");
    controls();
  }
  async function refreshState() {
    const saved = pending();
    if (saved?.hash) {
      const wallet = await options.getWallet();
      try {
        const receipt = await wallet.publicClient.getTransactionReceipt({ hash: saved.hash });
        localStorage.removeItem(storageKey);
        options.log(`已查到交易 ${saved.hash}：${receipt.status === "success" ? "成功" : "执行回退"}`,
          receipt.status === "success" ? "success" : "error");
      } catch { /* Missing receipt is still unknown; never resend automatically. */ }
    }
    await load();
  }
  async function sendNext() {
    if (!plan || pending()) return;
    const shown = plan;
    const next = shown.transactions[0];
    if (!next) return;
    const latest = await request<IdentityBindingPlan>();
    validate(latest);
    const sameIdentity = ["ensName", "agentId", "endpoint", "owner", "resolver", "registrationTx"] as const;
    const current = latest.transactions.find((item) => item.key === next.key);
    if (sameIdentity.some((key) => shown[key] !== latest[key]) || JSON.stringify(current) !== JSON.stringify(next)) {
      plan = latest; render(latest);
      throw new Error("链上状态或交易预览已变化，请查看新预览后再操作。");
    }
    const wallet = await options.getWallet();
    if (!isAddressEqual(wallet.account, latest.owner)) throw new Error("请连接预览中显示的操作钱包。");
    const tx = next.transaction;
    await wallet.publicClient.call({ account: wallet.account, to: tx.to, data: tx.data, value: 0n });
    // Recheck account/network after the RPC simulation, immediately before signing.
    await options.getWallet();
    setStatus("请在钱包确认");
    const saved: Pending = { registrationTx: latest.registrationTx, key: next.key };
    // Persist before sending; a wallet disconnect can happen before a hash is returned.
    localStorage.setItem(storageKey, JSON.stringify(saved));
    let hash: Hex;
    try {
      hash = await wallet.walletClient.sendTransaction({ account: wallet.account, chain: sepolia,
        to: tx.to, data: tx.data, value: 0n });
    } catch (error) {
      let cause: unknown = error;
      for (let i = 0; i < 8 && cause && typeof cause === "object"; i++) {
        if ("code" in cause && cause.code === 4001) {
          localStorage.removeItem(storageKey);
          throw new Error("已取消钱包签名，没有提交交易。");
        }
        cause = "cause" in cause ? cause.cause : undefined;
      }
      throw new Error("钱包未返回确定结果。请先检查钱包活动记录，暂不重复提交。");
    }
    saved.hash = hash;
    options.log(`ENS 交易已提交：${hash}`);
    message.textContent = `交易哈希：${hash}`;
    localStorage.setItem(storageKey, JSON.stringify(saved));
    setStatus("等待链上确认");
    let receipt;
    try { receipt = await wallet.publicClient.waitForTransactionReceipt({ hash, timeout: 60_000, retryCount: 0 }); }
    catch { throw new Error(`交易状态未知，请保留哈希并点击刷新核实：${hash}`); }
    localStorage.removeItem(storageKey);
    if (receipt.status !== "success") throw new Error(`交易执行回退，未写入记录：${hash}`);
    options.log(`ENS 记录交易成功：${next.key}，${hash}`, "success");
    await load();
  }
  async function verifyBinding() {
    const result = await request<{ registrationAndEnsVerified: boolean; blockNumber: string }>("/verify");
    if (result.registrationAndEnsVerified !== true) throw new Error("ENS 绑定尚未通过回验。");
    await load();
    setStatus("身份绑定回验通过", "success");
    message.textContent = `区块 ${result.blockNumber}：ERC-8004 与 ENS 关联已核实。Provider 执行与支付仍需单独验证。`;
    options.log(message.textContent, "success");
  }
  async function run(action: () => Promise<void>) {
    if (busy) return;
    busy = true; controls();
    try { await options.run(action); }
    catch (error) {
      // Do not expose wallet RPC error payloads/URLs in the page.
      const text = error instanceof Error && !error.message.includes("https://")
        ? error.message : "读取或钱包检查失败，请确认 Sepolia 网络后刷新。";
      setStatus("操作未完成", "error"); message.textContent = text; options.log(text, "error");
    } finally { busy = false; controls(); }
  }
  refresh.addEventListener("click", () => void run(refreshState));
  write.addEventListener("click", () => void run(sendNext));
  verify.addEventListener("click", () => void run(verifyBinding));
  void run(load);
}
