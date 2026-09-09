import { join } from 'node:path';
import { createChain } from './chain.ts';
import { openLocalWallet, type WalletStore } from './local-wallet.ts';
import type { Account, InitPorts, Options, Outcome, Progress, Snapshot } from './types.ts';

const FUNDING_WINDOW = 10 * 60_000;
const VERIFY_WINDOW = 120_000;
const REQUEST_TIMEOUT = 10_000;
const INTERVAL = 5_000;

function outcome(store: WalletStore, status: Outcome['status'], reason: string | null): Outcome {
  const { wallet } = store.snapshot;
  const ready = status === 'ready' && wallet.accountId !== null && wallet.verifiedAt !== null;
  return {
    status,
    exitCode: status === 'ready' ? 0 : status === 'blocked' ? 2 : 3,
    reason,
    walletPath: join(store.dir, 'wallet.json'),
    verifiedAt: ready ? wallet.verifiedAt : null,
    paymentIdentity: ready ? {
      network: 'hedera:testnet', payerAccountId: wallet.accountId!, keyType: 'ecdsa', signerRef: wallet.signerRef,
    } : null,
  };
}

async function save(store: WalletStore, mutate: (next: Snapshot) => void): Promise<void> {
  const next = store.snapshot;
  mutate(next);
  await store.save(next);
}

function abortAfter(ms: number): { signal: AbortSignal; clear(): void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, ms));
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

async function account(ports: InitPorts, store: WalletStore, remaining: number): Promise<Account | null> {
  const timeout = abortAfter(Math.min(REQUEST_TIMEOUT, remaining));
  try { return await ports.chain.account(store.snapshot.wallet, timeout.signal); }
  finally { timeout.clear(); }
}

function progress(store: WalletStore, ports: InitPorts, accountValue: Account | null, required: bigint): void {
  const snapshot = store.snapshot;
  const balance = BigInt(accountValue?.balanceTinybar ?? '0');
  const event: Progress = {
    kind: snapshot.state.phase === 'AwaitFunding' ? 'funding' : 'phase',
    walletPath: join(store.dir, 'wallet.json'),
    evmAddress: snapshot.wallet.evmAddress,
    balanceTinybar: balance.toString(),
    requiredTinybar: required.toString(),
    deficitTinybar: (required > balance ? required - balance : 0n).toString(),
    limits: snapshot.state.limits,
    phase: snapshot.state.phase,
  };
  ports.progress(event);
}

export async function initWallet(options: Options, overrides: Partial<InitPorts> = {}): Promise<Outcome> {
  let store: WalletStore | undefined;
  let chain: InitPorts['chain'] | undefined;
  try {
    store = await openLocalWallet(options);
    chain = overrides.chain ?? createChain(store);
    const ports: InitPorts = {
      chain,
      now: overrides.now ?? Date.now,
      delay: overrides.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      progress: overrides.progress ?? (() => {}),
    };
    const snapshot = store.snapshot;
    if (snapshot.state.phase === 'Blocked') return outcome(store, 'blocked', snapshot.state.reason);

    if (snapshot.state.intent) {
      return await verifyIntent(store, ports);
    }

    const started = ports.now();
    let networkErrors = 0;
    let lastBalance: string | null = null;
    let first = true;
    while (true) {
      const remaining = FUNDING_WINDOW - (ports.now() - started);
      if (remaining <= 0) return outcome(store, 'waiting_funds', 'INSUFFICIENT_FUNDS');
      let current: Account | null;
      try {
        current = await account(ports, store, remaining);
        networkErrors = 0;
      } catch {
        networkErrors++;
        if (networkErrors >= 3) return outcome(store, 'paused', 'NETWORK_CHECK_FAILED');
        const delayBudget = FUNDING_WINDOW - (ports.now() - started);
        if (delayBudget <= 0) return outcome(store, 'paused', 'NETWORK_CHECK_FAILED');
        await ports.delay(Math.min(INTERVAL, delayBudget));
        continue;
      }
      const limits = store.snapshot.state.limits;
      const matching = current?.publicKey?.toLowerCase() === store.snapshot.wallet.publicKey.toLowerCase();
      const required = matching ? BigInt(limits.reserveTinybar) : BigInt(limits.maxFeeTinybar) + BigInt(limits.reserveTinybar);
      const balance = current?.balanceTinybar ?? '0';
      if (first || balance !== lastBalance) {
        if (store.snapshot.state.phase !== 'AwaitFunding') await save(store, (next) => { next.state.phase = 'AwaitFunding'; next.state.reason = null; });
        progress(store, ports, current, required);
        first = false;
        lastBalance = balance;
      }
      if (!current || BigInt(current.balanceTinybar) < required) {
        const delayBudget = FUNDING_WINDOW - (ports.now() - started);
        if (delayBudget <= 0) return outcome(store, 'waiting_funds', 'INSUFFICIENT_FUNDS');
        await ports.delay(Math.min(INTERVAL, delayBudget));
        continue;
      }
      await save(store, (next) => {
        next.wallet.accountId = current!.accountId;
        next.state.phase = 'InspectAccount';
      });
      progress(store, ports, current, required);
      if (matching) return await markReady(store, ports, current);
      if (current.publicKey !== null) {
        await save(store, (next) => { next.state.phase = 'Blocked'; next.state.reason = 'ACCOUNT_KEY_MISMATCH'; });
        return outcome(store, 'blocked', 'ACCOUNT_KEY_MISMATCH');
      }
      const prepared = await ports.chain.prepare(store.snapshot.wallet, limits);
      await save(store, (next) => { next.state.phase = 'Activate'; next.state.intent = prepared.intent; });
      progress(store, ports, current, required);
      try { await prepared.submit(); } catch { /* The persisted transaction ID is the only recovery path. */ }
      return await verifyIntent(store, ports);
    }
  } catch (error) {
    if (!store) throw error;
    const reason = error instanceof Error ? error.message : 'INIT_FAILED';
    if (['NETWORK_CHECK_FAILED'].includes(reason)) return outcome(store, 'paused', reason);
    try { await save(store, (next) => { next.state.phase = 'Blocked'; next.state.reason = reason; }); } catch {}
    return outcome(store, 'blocked', reason);
  } finally {
    chain?.close();
    store?.close();
  }
}

async function verifyIntent(store: WalletStore, ports: InitPorts): Promise<Outcome> {
  await save(store, (next) => { next.state.phase = 'Verify'; });
  progress(store, ports, null, BigInt(store.snapshot.state.limits.reserveTinybar));
  const started = ports.now();
  const persisted = store.snapshot;
  if (persisted.state.evidence !== null && !validPersistedEvidence(persisted)) {
    await save(store, (next) => { next.state.phase = 'Blocked'; next.state.reason = 'ACTIVATION_INVALID'; });
    return outcome(store, 'blocked', 'ACTIVATION_INVALID');
  }
  let successKnown = persisted.state.evidence !== null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const remaining = VERIFY_WINDOW - (ports.now() - started);
    if (remaining <= 0) break;
    if (!successKnown) {
      const snapshot = store.snapshot;
      const timeout = abortAfter(Math.min(REQUEST_TIMEOUT, remaining));
      let check;
      try { check = await ports.chain.transaction(snapshot.state.intent!, snapshot.wallet, snapshot.state.limits, timeout.signal); }
      catch { check = { kind: 'unknown' as const }; }
      finally { timeout.clear(); }
      if (check.kind === 'failed') {
        await save(store, (next) => { next.state.phase = 'Blocked'; next.state.reason = check.reason; });
        return outcome(store, 'blocked', check.reason);
      }
      if (check.kind === 'success') {
        await save(store, (next) => { next.state.evidence = check.evidence; next.state.reason = null; });
        successKnown = true;
      }
    }
    if (successKnown) {
      let current: Account | null;
      const accountBudget = VERIFY_WINDOW - (ports.now() - started);
      if (accountBudget <= 0) return outcome(store, 'paused', 'NETWORK_CHECK_FAILED');
      try { current = await account(ports, store, accountBudget); }
      catch { return outcome(store, 'paused', 'NETWORK_CHECK_FAILED'); }
      if (current && finalAccountMatches(store.snapshot, current)) {
        if (BigInt(current.balanceTinybar) >= BigInt(store.snapshot.state.limits.reserveTinybar)) {
          return await markReady(store, ports, current);
        }
        await save(store, (next) => { next.state.phase = 'AwaitFunding'; next.state.reason = 'INSUFFICIENT_RESERVE'; });
        progress(store, ports, current, BigInt(store.snapshot.state.limits.reserveTinybar));
        return outcome(store, 'waiting_funds', 'INSUFFICIENT_RESERVE');
      }
    }
    if (attempt < 5) {
      const delayBudget = VERIFY_WINDOW - (ports.now() - started);
      if (delayBudget <= 0) break;
      await ports.delay(Math.min(INTERVAL, delayBudget));
    }
  }
  if (successKnown) return outcome(store, 'paused', 'NETWORK_CHECK_FAILED');
  return outcome(store, 'activation_unknown', 'ACTIVATION_UNKNOWN');
}

function validPersistedEvidence(snapshot: Snapshot): boolean {
  const intentId = snapshot.state.intent?.transactionId;
  const evidenceId = snapshot.state.evidence?.transactionId;
  const match = typeof intentId === 'string'
    ? /^(0\.0\.[1-9][0-9]*)@(0|[1-9][0-9]*)\.([0-9]{9})$/.exec(intentId)
    : null;
  return match !== null && evidenceId === intentId && match[1] === snapshot.wallet.accountId;
}

function finalAccountMatches(snapshot: Snapshot, current: Account): boolean {
  return current.accountId === snapshot.wallet.accountId &&
    current.evmAddress.toLowerCase() === snapshot.wallet.evmAddress.toLowerCase() &&
    current.publicKey?.toLowerCase() === snapshot.wallet.publicKey.toLowerCase() &&
    current.memo === 'frely-agent-wallet';
}

async function markReady(store: WalletStore, ports: InitPorts, current: Account): Promise<Outcome> {
  const snapshot = store.snapshot;
  const identityMatches = current.accountId === snapshot.wallet.accountId &&
    current.evmAddress.toLowerCase() === snapshot.wallet.evmAddress.toLowerCase() &&
    current.publicKey?.toLowerCase() === snapshot.wallet.publicKey.toLowerCase();
  const activationMatches = snapshot.state.intent === null ||
    (snapshot.state.evidence?.transactionId === snapshot.state.intent.transactionId && current.memo === 'frely-agent-wallet');
  if (!identityMatches || !activationMatches || BigInt(current.balanceTinybar) < BigInt(snapshot.state.limits.reserveTinybar)) {
    return outcome(store, 'paused', 'NETWORK_CHECK_FAILED');
  }
  const verifiedAt = new Date(ports.now()).toISOString();
  await save(store, (next) => {
    next.wallet.accountId = current.accountId;
    next.wallet.verifiedAt = verifiedAt;
    next.state.phase = 'Ready';
    next.state.reason = null;
  });
  progress(store, ports, current, BigInt(store.snapshot.state.limits.reserveTinybar));
  return outcome(store, 'ready', null);
}
