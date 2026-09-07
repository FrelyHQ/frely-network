import { createHash } from 'node:crypto';
import { createClientHederaSigner, inspectHederaTransaction, PrivateKey, Transaction, TransferTransaction } from '@x402/hedera';
import { ExactHederaScheme } from '@x402/hedera/exact/client';
import type { Policy, Ports } from './types.ts';
import { atomic } from './preflight.ts';
export function createSdkSigner(policy: Policy, resolveKey: (ref: string) => string | Promise<string>): Ports['sign'] {
  return async selection => {
    const q = selection.requirements;
    const amount = atomic(q.amount, 'AMOUNT_INVALID');
    if (!policy.enabled || policy.network !== 'hedera:testnet' || q.network !== policy.network || q.scheme !== 'exact' || selection.required.x402Version !== 2 || selection.required.resource.url !== policy.resourceUrl || q.asset !== policy.asset || q.payTo !== policy.payTo || !policy.feePayers.includes(String(q.extra?.feePayer)) || amount <= 0n || amount > 9223372036854775807n || policy.payerAccountId === policy.payTo) throw Error('POLICY_MISMATCH');
    const secret = await resolveKey(policy.signerRef);
    let key: PrivateKey;
    try { key = policy.keyType === 'ecdsa' ? PrivateKey.fromStringECDSA(secret) : PrivateKey.fromStringED25519(secret); } catch { throw Error('SIGNER_UNAVAILABLE'); }
    const scheme = new ExactHederaScheme(createClientHederaSigner(policy.payerAccountId, key, {network: policy.network}));
    const signed = await scheme.createPaymentPayload(2, q);
    if (!signed.payload || typeof signed.payload.transaction !== 'string') throw Error('SIGNED_TRANSACTION_INVALID');
    const transaction = signed.payload.transaction;
    const bytes = Buffer.from(transaction, 'base64');
    const decoded = Transaction.fromBytes(bytes);
    const inspected = inspectHederaTransaction(transaction);
    const entries = q.asset === '0.0.0' ? inspected.hbarTransfers : inspected.tokenTransfers[q.asset];
    const net = new Map<string,bigint>();
    for (const entry of entries ?? []) net.set(entry.accountId, (net.get(entry.accountId) ?? 0n) + BigInt(entry.amount));
    const transfers = [...net].filter(([,a]) => a !== 0n);
    if (!(decoded instanceof TransferTransaction) || inspected.hasNonTransferOperations || inspected.transactionIdAccountId !== q.extra?.feePayer || !key.publicKey.verifyTransaction(decoded) || transfers.length !== 2 || net.get(policy.payerAccountId) !== -amount || net.get(policy.payTo) !== amount || (q.asset === '0.0.0' ? Object.keys(inspected.tokenTransfers).length !== 0 : inspected.hbarTransfers.length !== 0 || Object.keys(inspected.tokenTransfers).length !== 1)) throw Error('SIGNED_TRANSACTION_INVALID');
    return {payload: {x402Version: 2, resource: selection.required.resource, accepted: q, payload: signed.payload}, transactionId: inspected.transactionId, signedDigest: createHash('sha256').update(bytes).digest('hex')};
  };
}
