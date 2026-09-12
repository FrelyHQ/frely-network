import { expect, test } from "bun:test";
import { chmod, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { initAgentWallet } from "./init.ts";
import { readReadyAgentWallet } from "./read-ready.ts";
import { withWalletDir } from "./test-support.ts";

test("reads the same descriptor without exposing the private key", async () => {
  await withWalletDir(async (walletDir) => {
    const created = await initAgentWallet({
      directory: walletDir,
      network: "hedera:testnet",
    });
    const ready = await readReadyAgentWallet(walletDir);
    const secret = (await readFile(join(walletDir, "agent.key"), "utf8")).trim();

    expect(ready).toEqual(created);
    expect(JSON.stringify(ready)).not.toContain(secret);
    expect(ready).not.toHaveProperty("funded");
    expect(ready).not.toHaveProperty("activated");
  });
});

test("rejects a key file that is not 0600", async () => {
  await withWalletDir(async (walletDir) => {
    await initAgentWallet({ directory: walletDir, network: "hedera:testnet" });
    await chmod(join(walletDir, "agent.key"), 0o644);
    await expect(readReadyAgentWallet(walletDir)).rejects.toThrow(
      "WALLET_STATE_INVALID",
    );
  });
});

test("rejects a key file that is a symlink", async () => {
  await withWalletDir(async (walletDir) => {
    await initAgentWallet({ directory: walletDir, network: "hedera:testnet" });
    const keyPath = join(walletDir, "agent.key");
    const realKey = join(walletDir, "agent.key.real");
    const { rename } = await import("node:fs/promises");
    await rename(keyPath, realKey);
    await symlink(realKey, keyPath);
    await expect(readReadyAgentWallet(walletDir)).rejects.toThrow(
      "WALLET_STATE_INVALID",
    );
  });
});

test("rejects truncated, extra-field, and wrong-type wallet metadata", async () => {
  await withWalletDir(async (walletDir) => {
    const created = await initAgentWallet({
      directory: walletDir,
      network: "hedera:testnet",
    });
    const walletPath = join(walletDir, "wallet.json");

    await writeFile(walletPath, "{", { mode: 0o600 });
    await expect(readReadyAgentWallet(walletDir)).rejects.toThrow(
      "WALLET_STATE_INVALID",
    );

    await writeFile(
      walletPath,
      `${JSON.stringify({ ...created, extra: true }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await expect(readReadyAgentWallet(walletDir)).rejects.toThrow(
      "WALLET_STATE_INVALID",
    );

    await writeFile(
      walletPath,
      `${JSON.stringify({ ...created, network: "hedera:mainnet" }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await expect(readReadyAgentWallet(walletDir)).rejects.toThrow(
      "WALLET_STATE_INVALID",
    );

    await writeFile(
      walletPath,
      `${JSON.stringify({ ...created, keyType: "ed25519" }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await expect(readReadyAgentWallet(walletDir)).rejects.toThrow(
      "WALLET_STATE_INVALID",
    );
  });
});

test("errors do not echo the private key", async () => {
  await withWalletDir(async (walletDir) => {
    await initAgentWallet({ directory: walletDir, network: "hedera:testnet" });
    const keyPath = join(walletDir, "agent.key");
    const secret = (await readFile(keyPath, "utf8")).trim();
    await writeFile(keyPath, "not-a-key\n", { mode: 0o600 });
    try {
      await readReadyAgentWallet(walletDir);
      throw new Error("expected failure");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(secret);
      expect(message).toBe("WALLET_STATE_INVALID");
    }
  });
});
