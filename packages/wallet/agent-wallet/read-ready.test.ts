import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLocalWallet } from './local-wallet.ts';
import { readReadyWalletIdentity } from './read-ready.ts';

async function createReadyWalletFixture() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'wallet-test-')));
  const walletDir = join(parent, 'wallet');
  const store = await openLocalWallet({
    network: 'hedera:testnet',
    walletDir,
    limits: { maxFeeTinybar: '10000000', reserveTinybar: '10000000' },
  });
  try {
    const next = structuredClone(store.snapshot);
    next.wallet.accountId = '0.0.12345';
    next.wallet.verifiedAt = '1970-01-01T00:00:00.000Z';
    next.state.phase = 'Ready';
    await store.save(next);
  } finally {
    store.close();
  }
  return {
    walletDir,
    cleanup: () => rm(parent, { recursive: true, force: true }),
  };
}

async function fileSnapshot(walletDir: string) {
  return Promise.all(["wallet.json", "init-state.json", "agent.key"].map(async name => {
    const path = join(walletDir, name);
    const [info, bytes] = await Promise.all([stat(path), readFile(path)]);
    return { name, mode: info.mode & 0o777, size: info.size, digest: createHash("sha256").update(bytes).digest("hex") };
  }));
}

test("reads a Ready identity without creating or changing wallet files", async () => {
  const h = await createReadyWalletFixture();
  try {
    const before = await fileSnapshot(h.walletDir);
    const names = await readdir(h.walletDir);
    const identity = await readReadyWalletIdentity(h.walletDir);
    const after = await fileSnapshot(h.walletDir);
    expect(identity).toEqual({
      network: "hedera:testnet",
      payerAccountId: "0.0.12345",
      keyType: "ecdsa",
      signerRef: "file:" + join(h.walletDir, "agent.key"),
    });
    expect(after).toEqual(before);
    expect((await readdir(h.walletDir)).sort()).toEqual([...names].sort());
  } finally {
    await h.cleanup();
  }
});

test("rejects a wallet that is not Ready without adding files", async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'wallet-test-')));
  const walletDir = join(parent, 'wallet');
  try {
    const store = await openLocalWallet({
      network: 'hedera:testnet',
      walletDir,
      limits: { maxFeeTinybar: '10000000', reserveTinybar: '10000000' },
    });
    store.close();
    const before = await readdir(walletDir);
    await expect(readReadyWalletIdentity(walletDir)).rejects.toThrow('WALLET_NOT_READY');
    expect((await readdir(walletDir)).sort()).toEqual([...before].sort());
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
