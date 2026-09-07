import { expect, test } from 'bun:test';
import { PrivateKey, inspectHederaTransaction, Transaction } from '@x402/hedera';
import { createSdkSigner } from './signer.ts';
import { preflight } from './preflight.ts';
import valid from '../../../scripts/payment-spike/fixtures/synthetic/valid.json';
import raw from '../../../scripts/payment-spike/fixtures/synthetic/policy.json';
import type { Policy } from './types.ts';
for (const keyType of ['ecdsa', 'ed25519'] as const) for (const asset of ['0.0.0', '0.0.9876']) test(`offline real SDK roundtrip ${keyType} ${asset}`, async () => {
  const policy = { ...raw, keyType, asset } as Policy;
  const local = preflight({policy: raw, payment: valid.request.payment, http: valid.capture});
  if (local.decision !== 'prepared') throw Error('fixture');
  local.selection.requirements.asset = asset;
  const key = keyType === 'ecdsa' ? PrivateKey.generateECDSA() : PrivateKey.generateED25519();
  let reads = 0;
  const sign = createSdkSigner(policy, () => { reads++; return key.toStringRaw(); });
  expect(reads).toBe(0);
  const old = globalThis.fetch;
  globalThis.fetch = (() => { throw Error('NETWORK_FORBIDDEN'); }) as unknown as typeof fetch;
  try {
    const result = await sign(local.selection);
    const transaction = result.payload.payload.transaction as string;
    expect(key.publicKey.verifyTransaction(Transaction.fromBytes(Buffer.from(transaction, 'base64')))).toBe(true);
    expect(inspectHederaTransaction(transaction).transactionId).toBe(result.transactionId);
    expect(result.signedDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(reads).toBe(1);
  } finally { globalThis.fetch = old; }
});
test('rejects mismatching quote before key resolution', async () => {
  const local = preflight({policy: raw, payment: valid.request.payment, http: valid.capture});
  if(local.decision !== 'prepared') throw Error('fixture');
  local.selection.requirements.payTo = '0.0.99';
  let reads = 0;
  await expect(createSdkSigner(raw as Policy, () => { reads++; throw Error('forbidden'); })(local.selection)).rejects.toThrow('POLICY_MISMATCH');
  expect(reads).toBe(0);
});
