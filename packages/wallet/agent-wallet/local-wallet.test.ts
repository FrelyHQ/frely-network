import { expect, test } from 'bun:test';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { openLocalWallet } from './local-wallet.ts';
import { withTemporaryWallet } from './test-support.ts';

test('persists a restricted key and reuses the wallet', async () => {
  await withTemporaryWallet(async ({ walletDir }) => {
    const limits = { maxFeeTinybar: '10000000', reserveTinybar: '10000000' };
    let store = await openLocalWallet({ network: 'hedera:testnet', walletDir, limits });

    try {
      const publicKey = store.snapshot.wallet.publicKey;
      expect((await stat(walletDir)).mode & 0o777).toBe(0o700);
      expect((await stat(join(walletDir, 'agent.key'))).mode & 0o777).toBe(0o600);
      expect(await readFile(join(walletDir, 'agent.key'), 'utf8')).toMatch(/^[0-9a-f]{64}\n?$/i);

      store.close();
      store = await openLocalWallet({ network: 'hedera:testnet', walletDir });
      expect(store.snapshot.wallet.publicKey).toBe(publicKey);
      expect(store.snapshot.state.limits).toEqual(limits);

      const conflicting = structuredClone(store.snapshot);
      conflicting.state.limits.maxFeeTinybar = '20000000';
      await expect(store.save(conflicting)).rejects.toThrow('INIT_CONFIG_CONFLICT');

      const exposed = store.snapshot;
      exposed.state.phase = 'Ready';
      expect(store.snapshot.state.phase).toBe('LocalReady');

      const next = structuredClone(store.snapshot);
      next.state.phase = 'AwaitFunding';
      await store.save(next);
      next.state.phase = 'Blocked';
      expect(store.snapshot.state.phase).toBe('AwaitFunding');
    } finally {
      store.close();
    }
  });
});
