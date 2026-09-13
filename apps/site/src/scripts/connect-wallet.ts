export {};
interface WalletProvider { request(input: { method: string; params?: unknown[] }): Promise<unknown>; }
const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const status = element<HTMLElement>("connection-status");
const details = element<HTMLElement>("request-details");
const connectButton = element<HTMLButtonElement>("connect-wallet");
const authorizeButton = element<HTMLButtonElement>("authorize-device");
const rejectButton = element<HTMLButtonElement>("reject-device");
const compareCode = element<HTMLInputElement>("confirm-code");
const userCode = new URLSearchParams(location.hash.slice(1)).get("code");
let wallet: WalletProvider | undefined;
let address = "";
let chainId = 0;
let message = "";
let allowedChains: number[] = [];
let busy = false;

async function request(path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(`/api/network/${path}`, {
    method: body ? "POST" : "GET", credentials: "omit", redirect: "error",
    headers: body ? { "content-type": "application/json" } : {},
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000),
  });
  const value = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof value.code === "string" ? value.code : "NETWORK_REQUEST_FAILED");
  return value;
}
function renderError(error: unknown): void {
  const code = error instanceof Error ? error.message : "NETWORK_REQUEST_FAILED";
  const descriptions: Record<string, string> = {
    DEVICE_EXPIRED: "This request has expired. Return to your agent and start setup again.",
    DEVICE_NOT_FOUND: "This device request was not found. Open the link supplied by your agent.",
    DEVICE_NOT_PENDING: "This request has been completed or rejected. Return to your agent to check its status.",
    NETWORK_ONBOARDING_NOT_CONFIGURED: "Wallet onboarding is not enabled on this server.",
    WALLET_NOT_FOUND: "No browser wallet was found. Open this link in a browser with an EVM wallet extension.",
    WALLET_CHANGED: "The wallet account or network changed. Connect the wallet again before signing.",
    LOGIN_CHAIN_UNSUPPORTED: "Switch your wallet to Ethereum mainnet or Sepolia, then connect again. This is the login chain, not the chain being checked.",
    SIGNATURE_INVALID: "The sign-in signature could not be verified. An externally owned account is required.",
    RATE_LIMITED: "The request limit was reached. Return to your agent to check setup status.",
  };
  status.textContent = descriptions[code] ?? "The operation was not completed. A rejected signature does not authorize this device. You can retry or reject the request.";
}
async function action(callback: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  connectButton.disabled = true; authorizeButton.disabled = true; rejectButton.disabled = true;
  try { await callback(); } catch (error) { renderError(error); }
  finally {
    busy = false;
    connectButton.disabled = !compareCode.checked;
    authorizeButton.disabled = !message || !compareCode.checked;
    rejectButton.disabled = false;
  }
}
function complete(): void {
  details.hidden = true;
  element<HTMLElement>("connection-complete").hidden = false;
  status.textContent = "Wallet sign-in approved. No transfer or token approval was requested.";
  message = "";
}
compareCode.addEventListener("change", () => {
  connectButton.disabled = busy || !compareCode.checked;
  authorizeButton.disabled = busy || !compareCode.checked || !message;
});
connectButton.addEventListener("click", () => void action(async () => {
  message = "";
  element<HTMLElement>("signature-preview").hidden = true;
  wallet = (window as unknown as { ethereum?: WalletProvider }).ethereum;
  if (!wallet) throw new Error("WALLET_NOT_FOUND");
  const accounts = await wallet.request({ method: "eth_requestAccounts" });
  if (!Array.isArray(accounts) || typeof accounts[0] !== "string" || !/^0x[0-9a-fA-F]{40}$/u.test(accounts[0])) throw new Error("WALLET_NOT_FOUND");
  address = accounts[0];
  chainId = Number.parseInt(String(await wallet.request({ method: "eth_chainId" })), 16);
  if (!allowedChains.includes(chainId)) throw new Error("LOGIN_CHAIN_UNSUPPORTED");
  const result = await request("device/challenge", { userCode, address, chainId });
  if (typeof result.message !== "string") throw new Error("NETWORK_REQUEST_FAILED");
  message = result.message;
  element<HTMLElement>("wallet-address").textContent = `Wallet: ${address} · Login chain: ${chainId}`;
  element<HTMLElement>("siwe-message").textContent = message;
  element<HTMLElement>("signature-preview").hidden = false;
  status.textContent = "Wallet connected. Review the message, then authorize this device.";
}));
authorizeButton.addEventListener("click", () => void action(async () => {
  if (!wallet || !message || !compareCode.checked) return;
  const accounts = await wallet.request({ method: "eth_accounts" });
  const currentChain = Number.parseInt(String(await wallet.request({ method: "eth_chainId" })), 16);
  if (!Array.isArray(accounts) || String(accounts[0]).toLowerCase() !== address.toLowerCase() || currentChain !== chainId) {
    message = ""; throw new Error("WALLET_CHANGED");
  }
  status.textContent = "Confirm the sign-in message in your wallet.";
  const hex = `0x${Array.from(new TextEncoder().encode(message), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  const signature = await wallet.request({ method: "personal_sign", params: [hex, address] });
  if (typeof signature !== "string") throw new Error("SIGNATURE_INVALID");
  await request("device/approve", { userCode, message, signature });
  complete();
}));
rejectButton.addEventListener("click", () => void action(async () => {
  await request("device/reject", { userCode });
  message = ""; details.hidden = true;
  status.textContent = "Device request rejected. No session was issued.";
}));
async function initialize(): Promise<void> {
  if (!userCode || !/^[A-F0-9]{4}(?:-[A-F0-9]{4}){5}$/u.test(userCode)) throw new Error("DEVICE_NOT_FOUND");
  const result = await request(`device/request?user_code=${encodeURIComponent(userCode)}`);
  if (result.status === "approved" || result.status === "consumed") { complete(); return; }
  if (result.status === "rejected") { status.textContent = "Device request rejected. Return to your agent to start another request."; return; }
  allowedChains = Array.isArray(result.allowedLoginChains) ? result.allowedLoginChains.filter((v): v is number => typeof v === "number") : [];
  element<HTMLElement>("client-name").textContent = `${result.clientName} · ${result.host}`;
  element<HTMLElement>("user-code").textContent = userCode;
  element<HTMLElement>("request-expiry").textContent = new Date(String(result.expiresAt)).toLocaleString();
  details.hidden = false;
  status.textContent = "Compare this request code with the code shown by your agent. Approve only a request you started.";
}
void initialize().catch(renderError);
