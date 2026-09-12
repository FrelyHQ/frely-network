import { expect, test } from "bun:test";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { initAgentWallet } from "./init.ts";
import { withWalletDir } from "./test-support.ts";

test("first init creates a restricted wallet and repeat init returns the same descriptor", async () => {
  await withWalletDir(async (walletDir) => {
    const first = await initAgentWallet({
      directory: walletDir,
      network: "hedera:testnet",
    });
    const second = await initAgentWallet({
      directory: walletDir,
      network: "hedera:testnet",
    });

    expect(first).toEqual(second);
    expect(first.version).toBe(1);
    expect(first.network).toBe("hedera:testnet");
    expect(first.keyType).toBe("ecdsa");
    expect(first.publicKey).toMatch(/^[0-9a-fA-F]{66}$/);
    expect(first.accountId.length).toBeGreaterThan(0);
    expect(first.privateKeyRef).toBe(`file:${join(walletDir, "agent.key")}`);
    const secret = (await readFile(join(walletDir, "agent.key"), "utf8")).trim();
    expect(JSON.stringify(first)).not.toContain(secret);
    expect(first).not.toHaveProperty("funded");
    expect(first).not.toHaveProperty("activated");
    expect(first).not.toHaveProperty("balance");
  });
});

test("rejects conflicting existing files instead of repairing them", async () => {
  await withWalletDir(async (walletDir) => {
    await mkdir(walletDir, { mode: 0o700 });
    await writeFile(join(walletDir, "agent.key"), "aa".repeat(32) + "\n", {
      mode: 0o600,
    });
    await expect(
      initAgentWallet({ directory: walletDir, network: "hedera:testnet" }),
    ).rejects.toThrow("WALLET_STATE_INVALID");
  });
});

test("rejects a directory that is not 0700", async () => {
  await withWalletDir(async (walletDir) => {
    await mkdir(walletDir, { mode: 0o755 });
    await chmod(walletDir, 0o755);
    await expect(
      initAgentWallet({ directory: walletDir, network: "hedera:testnet" }),
    ).rejects.toThrow("WALLET_STATE_INVALID");
  });
});

test("rejects a wallet directory that is a symlink", async () => {
  await withWalletDir(async (walletDir) => {
    const realDir = `${walletDir}-real`;
    await mkdir(realDir, { mode: 0o700 });
    await symlink(realDir, walletDir);
    await expect(
      initAgentWallet({ directory: walletDir, network: "hedera:testnet" }),
    ).rejects.toThrow("WALLET_STATE_INVALID");
  });
});

test("rejects an unsupported network without writing a wallet", async () => {
  await withWalletDir(async (walletDir) => {
    await expect(
      initAgentWallet({
        directory: walletDir,
        network: "hedera:mainnet" as "hedera:testnet",
      }),
    ).rejects.toThrow("INIT_CONFIG_CONFLICT");
  });
});
