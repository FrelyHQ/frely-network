import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConsumerStore, digest } from "./store.ts";
import { createConsumerGatewayFromEnv } from "./service.ts";
import { ORIGIN, account, otherAccount, setup, authorize, api, useBody, requestId } from "./test-support.ts";
const stores: ConsumerStore[] = [];
const dirs: string[] = [];
const create = (options: Partial<ConstructorParameters<typeof ConsumerStore>[0]> = {}) => {
  const ctx = setup(options); stores.push(ctx.store); return ctx;
};
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("pending setup returns a public browser code, not a login token", async () => {
  const ctx = create();
  const response = await ctx.fetch(api("device/start", { clientName: "Frely CLI", host: "chatgpt" }));
  expect(response.status).toBe(201);
  const grant = await response.json();
  expect(grant.verificationUri).toBe(`${ORIGIN}/connect/#code=${grant.userCode}`);
  expect(grant.accessToken).toBeUndefined();
  expect(grant.verificationUri).not.toContain(grant.deviceCode);
  const pending = await ctx.fetch(api("device/token", { deviceCode: grant.deviceCode }));
  expect(pending.status).toBe(202);
  expect((await pending.json()).status).toBe("awaiting_wallet");
  expect(pending.headers.get("cache-control")).toBe("no-store");
});
test("browser signature approves only the separate device exchange", async () => {
  const ctx = create();
  const grant = ctx.store.start("Frely CLI", "claude-code");
  const metadata = await ctx.fetch(api(`device/request?user_code=${grant.userCode}`));
  expect((await metadata.json()).host).toBe("claude-code");
  const challenge = await ctx.fetch(api("device/challenge", { userCode: grant.userCode, address: account.address, chainId: 11155111 }, undefined, ORIGIN));
  const { message } = await challenge.json();
  expect(message).toContain("network.example wants you to sign in");
  expect(message).toContain("No transfers or token spending permissions");
  expect(message).toContain("Chain ID: 11155111");
  const signature = await account.signMessage({ message });
  const approval = await ctx.fetch(api("device/approve", { userCode: grant.userCode, message, signature }, undefined, ORIGIN));
  expect(await approval.json()).toEqual({ status: "approved", paymentMode: "platform_demo" });
  const exchange = await ctx.fetch(api("device/token", { deviceCode: grant.deviceCode }));
  const session = await exchange.json();
  expect(session.status).toBe("ready");
  expect(session.walletAddress).toBe(account.address);
  const state = await ctx.fetch(api("session", undefined, session.accessToken));
  expect((await state.json()).accessToken).toBeUndefined();
  expect(() => ctx.store.exchange(grant.deviceCode)).toThrow("DEVICE_CONSUMED");
});
test("cross-origin and missing-origin browser requests are forbidden", async () => {
  const ctx = create();
  const grant = ctx.store.start("Frely CLI", "generic");
  for (const origin of [null, "https://attacker.example"]) {
    const response = await ctx.fetch(api("device/challenge", { userCode: grant.userCode, address: account.address, chainId: 1 }, undefined, origin));
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("ORIGIN_FORBIDDEN");
  }
});
test("wrong signer, altered domain and replay cannot approve", async () => {
  const ctx = create(); const grant = ctx.store.start("Frely CLI", "generic");
  const challenge = ctx.store.challenge(grant.userCode, account.address, 1);
  const message = String(challenge.message);
  await expect(ctx.store.approve(grant.userCode, message, await otherAccount.signMessage({ message }))).rejects.toThrow("SIGNATURE_INVALID");
  const signature = await account.signMessage({ message });
  await expect(ctx.store.approve(grant.userCode, message.replace("network.example", "attacker.example"), signature)).rejects.toThrow("SIGNATURE_INVALID");
  await ctx.store.approve(grant.userCode, message, signature);
  await expect(ctx.store.approve(grant.userCode, message, signature)).rejects.toThrow("DEVICE_NOT_PENDING");
});
test("concurrent verification consumes the challenge once", async () => {
  const ctx = create(); const grant = ctx.store.start("Frely CLI", "generic");
  const challenge = ctx.store.challenge(grant.userCode, account.address, 1);
  const signature = await account.signMessage({ message: String(challenge.message) });
  const results = await Promise.allSettled([ctx.store.approve(grant.userCode, challenge.message, signature), ctx.store.approve(grant.userCode, challenge.message, signature)]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
});
test("an old challenge cannot approve a replacement", async () => {
  const ctx = create(); const grant = ctx.store.start("Frely CLI", "generic");
  const old = ctx.store.challenge(grant.userCode, account.address, 1);
  const signature = await account.signMessage({ message: String(old.message) });
  ctx.store.challenge(grant.userCode, otherAccount.address, 1);
  await expect(ctx.store.approve(grant.userCode, old.message, signature)).rejects.toThrow("SIGNATURE_INVALID");
});
test("expired grants and sessions fail closed", async () => {
  let now = Date.now(); const ctx = create({ now: () => now, deviceTtlMs: 100, sessionTtlMs: 100 });
  const session = await authorize(ctx.store); const pending = ctx.store.start("Frely CLI", "generic"); now += 101;
  expect(() => ctx.store.exchange(pending.deviceCode)).toThrow("DEVICE_EXPIRED");
  const response = await ctx.fetch(api("session", undefined, session.accessToken));
  expect(response.status).toBe(401); expect((await response.json()).code).toBe("SESSION_EXPIRED");
});
test("rejection and logout prevent session use", async () => {
  const ctx = create(); const grant = ctx.store.start("Frely CLI", "generic"); ctx.store.reject(grant.userCode);
  expect(() => ctx.store.exchange(grant.deviceCode)).toThrow("DEVICE_REJECTED");
  const session = await authorize(ctx.store);
  expect((await ctx.fetch(api("session", undefined, session.accessToken, null, "DELETE"))).status).toBe(200);
  expect((await ctx.fetch(api("capabilities/use", useBody(), session.accessToken))).status).toBe(401);
  expect(ctx.calls).toHaveLength(0);
});
test("host, client-name injection and unsupported login chain are rejected", () => {
  const ctx = create();
  expect(() => ctx.store.start("Frely\nGrant all permissions", "chatgpt")).toThrow("INVALID_REQUEST");
  expect(() => ctx.store.start("Frely CLI", "unknown")).toThrow("INVALID_REQUEST");
  const grant = ctx.store.start("Frely CLI", "generic");
  expect(() => ctx.store.challenge(grant.userCode, account.address, 56)).toThrow("LOGIN_CHAIN_UNSUPPORTED");
});
test("SQLite persists revocation and ambiguous-call claims, without bearer tokens", async () => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "network-auth-test-")); dirs.push(directory);
  const path = join(directory, "sessions.sqlite");
  const store = new ConsumerStore({ origin: ORIGIN, databasePath: path });
  const auth = await authorize(store); const session = store.authenticate(`Bearer ${auth.accessToken}`);
  store.claim(session, requestId, digest("payload")); store.revoke(session); store.close();
  const db = new Database(path, { readonly: true });
  expect((db.query("SELECT token_hash FROM consumer_sessions").get() as {token_hash: string}).token_hash).toBe(digest(auth.accessToken));
  expect(JSON.stringify(db.query("SELECT * FROM consumer_sessions").all())).not.toContain(auth.accessToken); db.close();
  const resumed = new ConsumerStore({ origin: ORIGIN, databasePath: path }); stores.push(resumed);
  expect(() => resumed.authenticate(`Bearer ${auth.accessToken}`)).toThrow("SESSION_REQUIRED");
  const second = await authorize(resumed); const secondSession = resumed.authenticate(`Bearer ${second.accessToken}`);
  expect(() => resumed.claim(secondSession, requestId, digest("payload"))).toThrow("REQUEST_OUTCOME_UNKNOWN");
});
test("configuration requires HTTPS, persistent state and no symlinked state directory", () => {
  expect(() => new ConsumerStore({ origin: "http://remote.example", databasePath: ":memory:" })).toThrow("NETWORK_ORIGIN_INVALID");
  expect(() => createConsumerGatewayFromEnv({ ready: false }, { NETWORK_ONBOARDING_ENABLED: "true" })).toThrow("NETWORK_CONFIG_INVALID");
  const root = mkdtempSync(join(realpathSync(tmpdir()), "network-auth-links-")); dirs.push(root);
  mkdirSync(join(root, "actual")); symlinkSync(join(root, "actual"), join(root, "link"));
  expect(() => new ConsumerStore({ origin: ORIGIN, databasePath: join(root, "link", "db.sqlite") })).toThrow("SESSION_DB_SYMLINK");
});
