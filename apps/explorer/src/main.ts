import {
  createPublicClient,
  createWalletClient,
  custom,
  encodeFunctionData,
  getAddress,
  http,
  isAddressEqual,
  keccak256,
  stringToHex,
  type Address,
  type EIP1193Provider,
  type PublicClient,
  type WalletClient,
} from "viem";
import { sepolia } from "viem/chains";
import {
  EnsSubnameManager,
  registryAbi,
  type PreparedSubnameAction,
} from "@frely-network/ens/subnames";
import "./styles.css";
import { setupIdentityBinding } from "./identity-binding.ts";

const PARENT = "frely.eth";
const OPERATOR = "0x252Cb90Cf2c190219c1cD09E550efe35B14Ec454" as Address;
const REGISTRY = "0x3F74E8F31106D4F2E4CD43671B23D0124A1abc91" as Address;
const RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com";
const labels = ["vision-basic", "vision-ocr"] as const;

type EthereumProvider = EIP1193Provider;

declare global {
  interface Window { ethereum?: EthereumProvider; }
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const connectButton = $("connect") as HTMLButtonElement;
const labelInput = $("label") as HTMLSelectElement;
const prepareButton = $("prepare") as HTMLButtonElement;
const registerButton = $("register") as HTMLButtonElement;
const releaseButton = $("release") as HTMLButtonElement;
const walletStatus = $("wallet-status");
const chainStatus = $("chain-status");
const preview = $("preview");
const log = $("log");

let provider: EthereumProvider | undefined;
let account: Address | undefined;
let publicClient: PublicClient | undefined;
let walletClient: WalletClient | undefined;
let prepared: PreparedSubnameAction | undefined;
let actionInProgress = false;

function logEvent(message: string, kind: "info" | "success" | "error" = "info") {
  log.querySelector(".log-empty")?.remove();
  const item = document.createElement("div");
  item.className = `log-item ${kind}`;
  const mark = document.createElement("span"); mark.className = "log-mark";
  const text = document.createElement("span"); text.textContent = message;
  item.append(mark, text);
  log.prepend(item);
}

function setStatus(element: HTMLElement, text: string, state: "neutral" | "success" | "error" = "neutral") {
  element.textContent = text;
  element.className = `status ${state}`;
}

function short(address: string) { return `${address.slice(0, 6)}...${address.slice(-4)}`; }

function renderPreview(action: PreparedSubnameAction) {
  const child = action.inspection.children[0];
  const isRegistered = child.state?.status === 2;
  preview.className = "preview";
  preview.innerHTML = `
    <div class="preview-name"><span class="status-dot ${isRegistered ? "live" : "ready"}"></span><strong>${child.name}</strong><span class="state-label">${isRegistered ? "REGISTERED" : "AVAILABLE"}</span></div>
    <div class="preview-grid"><div><span>Owner</span><code>${isRegistered ? short(child.state!.latestOwner) : short(account!)}</code></div><div><span>Resolver</span><code>${short(action.inspection.parent.resolver)}</code></div><div><span>Expiry</span><code>${new Date(Number(action.inspection.parent.state.expiry) * 1000).toISOString().slice(0, 10)}</code></div><div><span>Network</span><code>Sepolia / 11155111</code></div></div>
    <p class="preview-note">${isRegistered ? "This subname already exists. Release it only when you want to reuse the test identity." : "The platform will ask your wallet to sign one register transaction. No private key is handled here."}</p>`;
  registerButton.toggleAttribute("disabled", isRegistered || !account);
  releaseButton.toggleAttribute("disabled", !isRegistered || !account);
}

async function connectWallet() {
  if (!window.ethereum) throw new Error("No browser wallet detected");
  provider = window.ethereum;
  const chainId = await provider.request({ method: "eth_chainId" }) as string;
  if (Number.parseInt(chainId, 16) !== sepolia.id) {
    try { await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0xaa36a7" }] }); }
    catch { throw new Error("Switch your wallet to Ethereum Sepolia (11155111)"); }
  }
  const addresses = await provider.request({ method: "eth_requestAccounts" }) as string[];
  const connected = getAddress(addresses[0]);
  if (!isAddressEqual(connected, OPERATOR)) throw new Error(`Connected wallet ${short(connected)} does not own frely.eth`);
  account = connected;
  const transport = custom(provider);
  publicClient = createPublicClient({ chain: sepolia, transport });
  walletClient = createWalletClient({ account, chain: sepolia, transport });
  connectButton.textContent = short(account);
  setStatus(walletStatus, "Owner connected", "success");
  setStatus(chainStatus, "Sepolia ready", "success");
  labelInput.disabled = false;
  prepareButton.disabled = false;
  logEvent(`Connected owner wallet ${short(account)}`, "success");
  await inspect();
}

async function inspect() {
  if (!publicClient || !account) return;
  setStatus(chainStatus, "Reading ENS state", "neutral");
  const manager = new EnsSubnameManager(RPC_URL, publicClient);
  const action = await manager.prepareSubname({ parent: PARENT, operator: account, labels: [labelInput.value] }, labelInput.value);
  prepared = action;
  renderPreview(action);
  setStatus(chainStatus, action.action === "no_change" ? "Already registered" : "Available to register", action.action === "no_change" ? "neutral" : "success");
  logEvent(`${labelInput.value}.frely.eth is ${action.action === "no_change" ? "already registered" : "available"}`);
}

async function register() {
  if (!walletClient || !account || !prepared?.transaction) return;
  setStatus(chainStatus, "Confirm in wallet", "neutral");
  const hash = await walletClient.sendTransaction({ account, chain: sepolia, to: prepared.transaction.to, data: prepared.transaction.data, value: 0n });
  logEvent(`Submitted register transaction ${short(hash)}`);
  setStatus(chainStatus, "Waiting for receipt", "neutral");
  await publicClient!.waitForTransactionReceipt({ hash });
  const manager = new EnsSubnameManager(RPC_URL, publicClient);
  await manager.verify({ parent: PARENT, operator: account, labels: [labelInput.value] });
  logEvent(`Registered ${prepared.name}`, "success");
  await inspect();
}

async function release() {
  if (!walletClient || !account || !prepared?.inspection) return;
  const label = labelInput.value;
  const anyId = BigInt(keccak256(stringToHex(label)));
  const data = encodeFunctionData({ abi: registryAbi, functionName: "unregister", args: [anyId] });
  setStatus(chainStatus, "Confirm release in wallet", "neutral");
  const hash = await walletClient.sendTransaction({ account, chain: sepolia, to: REGISTRY, data, value: 0n });
  logEvent(`Submitted release transaction ${short(hash)}`);
  await publicClient!.waitForTransactionReceipt({ hash });
  logEvent(`Released ${label}.frely.eth for reuse`, "success");
  await inspect();
}

function handleError(error: unknown) {
  const message = error instanceof Error ? error.message : "Wallet action failed";
  setStatus(chainStatus, "Action failed", "error");
  logEvent(message, "error");
}

async function runAction(action: () => Promise<void>) {
  if (actionInProgress) throw new Error("请等待当前操作完成。");
  actionInProgress = true;
  for (const control of [connectButton, labelInput, prepareButton, registerButton, releaseButton]) control.disabled = true;
  try { await action(); }
  finally {
    actionInProgress = false;
    connectButton.disabled = false;
    labelInput.disabled = prepareButton.disabled = !account;
    const registered = prepared?.inspection.children[0]?.state?.status === 2;
    registerButton.disabled = !account || !prepared?.transaction || registered;
    releaseButton.disabled = !account || !registered;
  }
}

setupIdentityBinding({
  log: logEvent, run: runAction,
  async getWallet() {
    if (!provider || !account || !publicClient || !walletClient) throw new Error("请先点击上方 Connect wallet 连接操作钱包。");
    const currentAccounts = await provider.request({ method: "eth_accounts" }) as string[];
    const chain = await provider.request({ method: "eth_chainId" }) as string;
    if (Number(chain) !== sepolia.id || !currentAccounts[0] || !isAddressEqual(currentAccounts[0] as Address, account)) {
      throw new Error("钱包账户或网络已变化，请刷新页面并连接 Sepolia 操作钱包。");
    }
    return { account, publicClient, walletClient };
  },
});

connectButton.addEventListener("click", () => runAction(connectWallet).catch(handleError));
prepareButton.addEventListener("click", () => runAction(inspect).catch(handleError));
registerButton.addEventListener("click", () => runAction(register).catch(handleError));
releaseButton.addEventListener("click", () => runAction(release).catch(handleError));
labelInput.addEventListener("change", () => runAction(inspect).catch(handleError));
$("clear-log").addEventListener("click", () => { log.innerHTML = '<p class="log-empty">No wallet actions yet.</p>'; });

if (window.ethereum?.on) window.ethereum.on("accountsChanged", () => window.location.reload());
if (window.ethereum?.on) window.ethereum.on("chainChanged", () => window.location.reload());
