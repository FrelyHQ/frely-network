import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PrivateKey } from '@x402/hedera';

export async function withTestKey(
  run: (file: { dir: string; path: string; ref: string; key: PrivateKey }) => Promise<void>,
): Promise<void> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'frely-key-')));
  await chmod(dir, 0o700);
  const path = join(dir, 'agent.key');
  const key = PrivateKey.generateECDSA();

  try {
    await writeFile(path, `${key.toStringRaw()}\n`, { mode: 0o600 });
    await chmod(path, 0o600);
    await run({ dir, path, ref: `file:${path}`, key });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
