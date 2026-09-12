import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function withTemporaryWallet(
  run: (paths: { parent: string; walletDir: string }) => Promise<void>,
): Promise<void> {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "wallet-test-")));
  try {
    await run({ parent, walletDir: join(parent, "wallet") });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

export async function withWalletDir(
  run: (walletDir: string) => Promise<void>,
): Promise<void> {
  await withTemporaryWallet(({ walletDir }) => run(walletDir));
}
