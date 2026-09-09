import { expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { initWallet } from './init.ts';
import { withWalletDir } from './test-support.ts';
import type { InitPorts } from './types.ts';

function fakePorts(unknown = false) {
  let now = 0;
  let complete = false;
  let submits = 0;
  let accountVisible = false;
  let successReported = false;
  const intent = {
    transactionId: '0.0.12345@1.000000001',
    bodyDigest: 'a'.repeat(64),
    submittedAt: '1970-01-01T00:00:00.000Z',
  };
  const ports: InitPorts = {
    now: () => now,
    delay: async (ms) => { now += ms; },
    progress: () => {},
    chain: {
      account: async (wallet) => ({
        accountId: '0.0.12345',
        evmAddress: wallet.evmAddress,
        publicKey: complete && accountVisible ? wallet.publicKey : null,
        balanceTinybar: '100000000',
        memo: complete && accountVisible ? 'frely-agent-wallet' : '',
      }),
      prepare: async () => ({
        intent,
        submit: async () => {
          submits++;
          if (unknown) throw Error('SIMULATED_TIMEOUT');
          complete = true;
        },
      }),
      transaction: async () => {
        if (unknown || successReported) return { kind: 'unknown' };
        successReported = true;
        return {
          kind: 'success',
          evidence: {
            transactionId: intent.transactionId,
            consensusTimestamp: '2.000000001',
            chargedFeeTinybar: '1000',
            verificationUrl: 'https://testnet.mirrornode.hedera.com',
          },
        };
      },
      close: () => {},
    },
  };
  return { ports, submits: () => submits, showAccount: () => { accountVisible = true; } };
}

test('funded wallet becomes ready with only public identity', async () => {
  await withWalletDir(async (walletDir) => {
    const fake = fakePorts();
    const account = fake.ports.chain.account;
    let initialReads = 0;
    let emptyFundingPrompts = 0;
    fake.ports.chain.account = async (wallet, signal) => {
      if (initialReads++ < 2) return null;
      return account(wallet, signal);
    };
    fake.ports.progress = (event) => {
      if (event.kind === 'funding' && event.balanceTinybar === '0') emptyFundingPrompts++;
    };
    const options = {
      network: 'hedera:testnet',
      walletDir,
      limits: { maxFeeTinybar: '10000000', reserveTinybar: '10000000' },
    } as const;
    expect((await initWallet(options, fake.ports)).status).toBe('paused');
    expect(emptyFundingPrompts).toBe(1);
    const paused = JSON.parse(await readFile(join(walletDir, 'init-state.json'), 'utf8'));
    expect(paused.evidence.transactionId).toBe('0.0.12345@1.000000001');
    paused.intent.transactionId = '0.0.99999@1.000000001';
    paused.evidence.transactionId = '0.0.99999@1.000000001';
    await writeFile(join(walletDir, 'init-state.json'), `${JSON.stringify(paused, null, 2)}\n`);
    expect((await initWallet(options, fake.ports)).reason).toBe('ACTIVATION_INVALID');
    paused.phase = 'Verify';
    paused.reason = null;
    paused.intent.transactionId = '0.0.12345@1.000000001';
    paused.evidence.transactionId = '0.0.12345@1.000000001';
    await writeFile(join(walletDir, 'init-state.json'), `${JSON.stringify(paused, null, 2)}\n`);
    fake.showAccount();
    const result = await initWallet(options, fake.ports);
    expect(result.status).toBe('ready');
    expect(result.paymentIdentity?.payerAccountId).toBe('0.0.12345');
    expect(fake.submits()).toBe(1);
    const secret = (await readFile(join(walletDir, 'agent.key'), 'utf8')).trim();
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});

test('unknown submission is queried instead of submitted again', async () => {
  await withWalletDir(async (walletDir) => {
    const fake = fakePorts(true);
    const options = {
      network: 'hedera:testnet' as const,
      walletDir,
      limits: { maxFeeTinybar: '10000000', reserveTinybar: '10000000' },
    };
    expect((await initWallet(options, fake.ports)).status).toBe('activation_unknown');
    expect((await initWallet(options, fake.ports)).status).toBe('activation_unknown');
    expect(fake.submits()).toBe(1);
  });
});
