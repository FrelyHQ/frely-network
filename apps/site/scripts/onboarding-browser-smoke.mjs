import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const requireBroker = createRequire(join(root, "apps/broker-mcp/package.json"));
const { privateKeyToAccount } = requireBroker("viem/accounts");
const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
const screenshots = join(root, ".local/qa");
await mkdir(screenshots, { recursive: true });
const child = spawn("bun", [join(root, "scripts/consumer-browser-fixture.ts")], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
let browser;
try {
  const metadata = await new Promise((resolveMetadata, reject) => {
    const timer = setTimeout(() => reject(new Error("Fixture startup timed out")), 10_000);
    let text = "";
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Fixture exited: ${code}`)); });
    child.stdout.on("data", (chunk) => {
      text += chunk.toString();
      if (!text.includes("\n")) return;
      try { const value = JSON.parse(text.split("\n")[0]); clearTimeout(timer); resolveMetadata(value); }
      catch (error) { clearTimeout(timer); reject(error); }
    });
  });
  // A fresh headless profile is used; this never attaches to a user's Chrome profile or wallet.
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.exposeFunction("__frelyTestSign", (hex) => account.signMessage({ message: { raw: hex } }));
  await context.addInitScript(({ address }) => {
    window.__frelyWalletMethods = [];
    window.__frelyCopiedPrompt = "";
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async (text) => { window.__frelyCopiedPrompt = text; },
    } });
    Object.defineProperty(window, "ethereum", { configurable: true, value: {
      async request({ method, params }) {
        window.__frelyWalletMethods.push(method);
        if (["eth_requestAccounts", "eth_accounts"].includes(method)) return [address];
        if (method === "eth_chainId") return "0x1";
        if (method === "personal_sign") return window.__frelyTestSign(params[0]);
        throw new Error(`Wallet method not allowed in fixture: ${method}`);
      },
    } });
  }, { address: account.address });
  const page = await context.newPage();
  const errors = [];
  const external = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => { if (new URL(request.url()).origin !== metadata.origin) external.push(request.url()); });
  await page.goto(`${metadata.origin}/onboarding/`, { waitUntil: "networkidle" });
  const prompt = "Read https://network.frely.cloud/SKILL.md, follow the Frely Network protocol, and use the best Network adapter available in this chat for my request.";
  assert.equal((await page.locator("#network-install-prompt").inputValue()).trim(), prompt);
  await page.getByTestId("copy-network-prompt").click();
  assert.equal(await page.evaluate(() => window.__frelyCopiedPrompt), prompt);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(screenshots, "onboarding-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(screenshots, "onboarding-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1120, height: 1000 });
  const walletPage = await page.goto(metadata.verificationUri, { waitUntil: "networkidle" });
  assert.match(walletPage.headers()["content-security-policy"], /frame-ancestors 'none'/);
  await page.locator("#request-details").waitFor({ state: "visible" });
  assert.equal(await page.locator("#connect-wallet").isDisabled(), true);
  assert.equal(await page.locator("#user-code").textContent(), metadata.userCode);
  await page.locator("#confirm-code").check();
  await page.locator("#connect-wallet").click();
  await page.locator("#signature-preview").waitFor({ state: "visible" });
  assert.match(await page.locator("#siwe-message").textContent(), /No transfers or token spending permissions/);
  assert.equal(await page.evaluate(() => window.__frelyWalletMethods.includes("personal_sign")), false);
  await page.screenshot({ path: join(screenshots, "wallet-signature-preview.png"), fullPage: true });
  await page.locator("#authorize-device").click();
  await page.locator("#connection-complete").waitFor({ state: "visible" });
  assert.match(await page.locator("#connection-status").textContent(), /approved/);
  const methods = await page.evaluate(() => window.__frelyWalletMethods);
  assert.equal(methods.filter((method) => method === "personal_sign").length, 1);
  assert(methods.every((method) => ["eth_requestAccounts", "eth_accounts", "eth_chainId", "personal_sign"].includes(method)));
  await page.screenshot({ path: join(screenshots, "wallet-connected.png"), fullPage: true });
  await page.reload({ waitUntil: "networkidle" });
  await page.locator("#connection-complete").waitFor({ state: "visible" });
  await page.goto(`${metadata.origin}/connect/`, { waitUntil: "networkidle" });
  assert.match(await page.locator("#connection-status").textContent(), /not found/);
  assert.equal(await page.locator("#connection-complete").isVisible(), false);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log(JSON.stringify({ status: "passed", mode: "browser_fixture", liveWallet: false,
    checks: ["exact-prompt", "copy-without-system-clipboard", "desktop-layout", "mobile-layout", "same-origin-assets", "request-code-confirmation",
      "signature-preview-before-signing", "real-test-signature-verification", "no-transfer-methods", "reload-approved-state", "missing-code-error"],
    screenshots }, null, 2));
} finally {
  await browser?.close();
  if (child.exitCode === null) child.kill("SIGTERM");
}
