import {
  AccountId,
  AccountUpdateTransaction,
  Client,
  Hbar,
  PublicKey,
  Transaction,
  TransactionId,
} from '@hiero-ledger/sdk';
import { createHash } from 'node:crypto';
import type { WalletStore } from './local-wallet.ts';
import type {
  Account,
  ChainPort,
  Evidence,
  Limits,
  TransactionCheck,
  Wallet,
} from './types.ts';

const MIRROR = 'https://testnet.mirrornode.hedera.com';
const MEMO = 'frely-agent-wallet';
const MAX_BODY = 1024 * 1024;
const MAX_TINYBAR = 9_223_372_036_854_775_807n;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function integer(value: unknown): bigint {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw Error('NETWORK_CHECK_FAILED');
    return BigInt(value);
  }
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw Error('NETWORK_CHECK_FAILED');
  }
  return BigInt(value);
}

function validLimits(limits: Limits): boolean {
  try {
    const maxFee = integer(limits.maxFeeTinybar);
    const reserve = integer(limits.reserveTinybar);
    return maxFee > 0n && reserve > 0n && maxFee + reserve <= MAX_TINYBAR;
  } catch {
    return false;
  }
}

function validWallet(wallet: Wallet): boolean {
  return wallet.network === 'hedera:testnet' && wallet.keyType === 'ecdsa' &&
    wallet.accountId !== null && /^0\.0\.[1-9][0-9]*$/.test(wallet.accountId) &&
    /^0x[0-9a-fA-F]{40}$/.test(wallet.evmAddress) && /^[0-9a-fA-F]{66}$/.test(wallet.publicKey);
}

async function json(url: string, signal: AbortSignal): Promise<{ status: number; value: unknown }> {
  let response: Response;
  try {
    response = await fetch(url, { redirect: 'error', signal });
  } catch {
    throw Error('NETWORK_CHECK_FAILED');
  }
  if (response.status === 404) return { status: 404, value: null };
  if (!response.ok) throw Error('NETWORK_CHECK_FAILED');
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY)) {
    throw Error('NETWORK_CHECK_FAILED');
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_BODY) throw Error('NETWORK_CHECK_FAILED');
  try {
    return { status: response.status, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) };
  } catch {
    throw Error('NETWORK_CHECK_FAILED');
  }
}

function parseKey(value: unknown): string | null {
  if (value === null) return null;
  if (!object(value) || value._type !== 'ECDSA_SECP256K1' ||
    typeof value.key !== 'string' || !/^[0-9a-fA-F]{66}$/.test(value.key)) {
    throw Error('NETWORK_CHECK_FAILED');
  }
  try {
    return PublicKey.fromStringECDSA(value.key).toStringRaw();
  } catch {
    throw Error('NETWORK_CHECK_FAILED');
  }
}

function parseAccount(value: unknown, wallet: Wallet): Account {
  if (!object(value) || value.deleted !== false || typeof value.account !== 'string' ||
    !/^0\.0\.[1-9][0-9]*$/.test(value.account) || typeof value.evm_address !== 'string' ||
    value.evm_address.toLowerCase() !== wallet.evmAddress.toLowerCase() ||
    typeof value.memo !== 'string' || !object(value.balance) ||
    (wallet.accountId !== null && value.account !== wallet.accountId)) throw Error('NETWORK_CHECK_FAILED');
  const balance = integer(value.balance.balance);
  if (balance < 0n || balance > MAX_TINYBAR) throw Error('NETWORK_CHECK_FAILED');
  return {
    accountId: value.account,
    evmAddress: value.evm_address,
    publicKey: parseKey(value.key),
    balanceTinybar: balance.toString(),
    memo: value.memo,
  };
}

function mirrorId(transactionId: string): string | null {
  const match = /^((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))@((?:0|[1-9][0-9]*))\.([0-9]{1,9})$/.exec(transactionId);
  return match ? `${match[1]}-${match[2]}-${match[3]!.padStart(9, '0')}` : null;
}

function decodeMemo(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try { return Buffer.from(value, 'base64').toString('utf8'); } catch { return null; }
}

export function createChain(store: WalletStore): ChainPort {
  const client = Client.forTestnet();
  return {
    async account(wallet, signal) {
      const identifier = wallet.accountId ?? wallet.evmAddress;
      const result = await json(`${MIRROR}/api/v1/accounts/${encodeURIComponent(identifier)}`, signal);
      return result.status === 404 ? null : parseAccount(result.value, wallet);
    },
    async prepare(wallet, limits) {
      if (!validWallet(wallet) || !validLimits(limits)) throw Error('ACTIVATION_INVALID');
      const accountId = wallet.accountId!;
      const transactionId = TransactionId.generate(AccountId.fromString(accountId));
      const transaction = new AccountUpdateTransaction()
        .setAccountId(accountId)
        .setAccountMemo(MEMO)
        .setTransactionMemo(MEMO)
        .setTransactionId(transactionId)
        .setTransactionValidDuration(120)
        .setMaxTransactionFee(Hbar.fromTinybars(limits.maxFeeTinybar))
        .setRegenerateTransactionId(false)
        .setMaxAttempts(1)
        .freezeWith(client);
      const key = await store.readKey();
      await transaction.sign(key);
      const bytes = await transaction.toBytesAsync();
      const decoded = Transaction.fromBytes(bytes);
      if (!(decoded instanceof AccountUpdateTransaction) || decoded.accountId?.toString() !== accountId ||
        decoded.accountMemo !== MEMO || decoded.transactionMemo !== MEMO ||
        decoded.transactionId?.toString() !== transactionId.toString() || decoded.transactionValidDuration !== 120 ||
        decoded.maxTransactionFee?.toTinybars().toString() !== limits.maxFeeTinybar || decoded.key !== null ||
        decoded.receiverSignatureRequired !== null || decoded.proxyAccountId !== null ||
        decoded.autoRenewPeriod !== null || decoded.expirationTime !== null ||
        decoded.maxAutomaticTokenAssociations !== null || decoded.aliasKey !== null || decoded.stakedAccountId !== null ||
        decoded.stakedNodeId !== null || decoded.declineStakingRewards !== null ||
        decoded.hooksToCreate.length !== 0 || decoded.hooksToDelete.length !== 0 ||
        !PublicKey.fromStringECDSA(wallet.publicKey).verifyTransaction(decoded)) {
        throw Error('ACTIVATION_INVALID');
      }
      let submitted = false;
      return {
        intent: {
          transactionId: transactionId.toString(),
          bodyDigest: createHash('sha256').update(bytes).digest('hex'),
          submittedAt: new Date().toISOString(),
        },
        async submit() {
          if (submitted) throw Error('ACTIVATION_ALREADY_SUBMITTED');
          submitted = true;
          await transaction.execute(client, 30_000);
        },
      };
    },
    async transaction(intent, wallet, limits, signal): Promise<TransactionCheck> {
      if (!validWallet(wallet) || !validLimits(limits) || intent.transactionId.split('@')[0] !== wallet.accountId) {
        return { kind: 'failed', reason: 'ACTIVATION_INVALID' };
      }
      const id = mirrorId(intent.transactionId);
      if (!id) return { kind: 'failed', reason: 'ACTIVATION_INVALID' };
      let result: { status: number; value: unknown };
      try { result = await json(`${MIRROR}/api/v1/transactions/${id}`, signal); }
      catch { return { kind: 'unknown' }; }
      if (result.status === 404) return { kind: 'unknown' };
      if (!object(result.value) || !Array.isArray(result.value.transactions)) return { kind: 'unknown' };
      const rows = result.value.transactions.filter((row) => object(row) && row.nonce === 0 && row.scheduled === false && row.transaction_id === id);
      if (rows.length === 0) return { kind: 'unknown' };
      if (rows.length !== 1) return { kind: 'failed', reason: 'ACTIVATION_CONFLICT' };
      const row = rows[0]!;
      let fee: bigint;
      try { fee = integer(row.charged_tx_fee); } catch { return { kind: 'unknown' }; }
      if (row.result !== 'SUCCESS' || row.name !== 'CRYPTOUPDATEACCOUNT' ||
        row.entity_id !== wallet.accountId || decodeMemo(row.memo_base64) !== MEMO ||
        fee > BigInt(limits.maxFeeTinybar)) return { kind: 'failed', reason: 'ACTIVATION_REJECTED' };
      if (typeof row.consensus_timestamp !== 'string' || !/^\d+\.[0-9]{9}$/.test(row.consensus_timestamp)) {
        return { kind: 'unknown' };
      }
      const evidence: Evidence = {
        transactionId: intent.transactionId,
        consensusTimestamp: row.consensus_timestamp,
        chargedFeeTinybar: fee.toString(),
        verificationUrl: `${MIRROR}/api/v1/transactions/${id}`,
      };
      return { kind: 'success', evidence };
    },
    close() { client.close(); },
  };
}
