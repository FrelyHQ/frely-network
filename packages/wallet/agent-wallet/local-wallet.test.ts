import { expect, test } from "bun:test";
import { chmod, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { initAgentWallet } from "./init.ts";
import { createHederaSigner } from "./local-wallet.ts";
import { withTemporaryWallet } from "./test-support.ts";

test("persists a 0700 directory and 0600 key, then reuses them", async () => {
  await withTemporaryWallet(async ({ walletDir }) => {
    const first = await initAgentWallet({
      directory: walletDir,
      network: "hedera:testnet",
    });
    expect((await stat(walletDir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(walletDir, "agent.key"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(walletDir, "wallet.json"))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(walletDir, "agent.key"), "utf8")).toMatch(
      /^[0-9a-fA-F]{64}\n$/,
    );

    const second = await initAgentWallet({
      directory: walletDir,
      network: "hedera:testnet",
    });
    expect(second.publicKey).toBe(first.publicKey);
    expect(await readFile(join(walletDir, "agent.key"), "utf8")).toMatch(
      /^[0-9a-fA-F]{64}\n$/,
    );
  });
});

test("createHederaSigner reads the key without claiming the account is funded", async () => {
  await withTemporaryWallet(async ({ walletDir }) => {
    const created = await initAgentWallet({
      directory: walletDir,
      network: "hedera:testnet",
    });
    const signer = await createHederaSigner({
      directory: walletDir,
      accountId: "0.0.12345",
    });
    expect(signer.accountId).toBe("0.0.12345");
    expect(signer.publicKey).toBe(created.publicKey);
    expect(signer).not.toHaveProperty("funded");
    expect(signer).not.toHaveProperty("activated");
    expect(signer).not.toHaveProperty("balance");
    const secret = await signer.loadPrivateKey();
    expect(secret).toMatch(/^[0-9a-fA-F]{64}$/);
    expect(JSON.stringify(signer)).not.toContain(secret);
  });
});

test("createHederaSigner rejects a world-readable key", async () => {
  await withTemporaryWallet(async ({ walletDir }) => {
    await initAgentWallet({ directory: walletDir, network: "hedera:testnet" });
    await chmod(join(walletDir, "agent.key"), 0o644);
    await expect(
      createHederaSigner({ directory: walletDir, accountId: "0.0.12345" }),
    ).rejects.toThrow("SIGNER_UNAVAILABLE");
  });
});
