import { Database } from 'bun:sqlite';
import { PrivateKey } from '@hiero-ledger/sdk';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  rename,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { isAbsolute, join, normalize, posix } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Limits, Options, Snapshot, State, Wallet } from './types.ts';

const JSON_LIMIT = 1024 * 1024;
const KEY_LIMIT = 1024;
const MAX_TINYBAR = 9_223_372_036_854_775_807n;
const PHASES = new Set<State['phase']>([
  'LocalReady', 'AwaitFunding', 'InspectAccount', 'Activate', 'Verify', 'Ready', 'Blocked',
]);

export type WalletStore = {
  readonly dir: string;
  readonly snapshot: Snapshot;
  save(next: Snapshot): Promise<void>;
  readKey(): Promise<PrivateKey>;
  close(): void;
};

type ErrorCode =
  | 'SIGNER_UNAVAILABLE'
  | 'WALLET_STATE_INVALID'
  | 'INIT_CONFIG_CONFLICT'
  | 'INIT_IN_PROGRESS';

function failure(code: ErrorCode): Error {
  return new Error(code);
}

function currentUid(): number {
  if (typeof process.getuid !== 'function') throw failure('WALLET_STATE_INVALID');
  return process.getuid();
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validOptionalString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function parseLimits(value: unknown): Limits {
  if (!object(value) || !exactKeys(value, ['maxFeeTinybar', 'reserveTinybar'])) {
    throw failure('WALLET_STATE_INVALID');
  }
  const amounts = [value.maxFeeTinybar, value.reserveTinybar];
  if (!amounts.every((amount) => typeof amount === 'string' && /^[1-9][0-9]*$/.test(amount))) {
    throw failure('WALLET_STATE_INVALID');
  }
  const maxFee = BigInt(value.maxFeeTinybar as string);
  const reserve = BigInt(value.reserveTinybar as string);
  if (maxFee > MAX_TINYBAR || reserve > MAX_TINYBAR || maxFee + reserve > MAX_TINYBAR) {
    throw failure('WALLET_STATE_INVALID');
  }
  return { maxFeeTinybar: value.maxFeeTinybar as string, reserveTinybar: value.reserveTinybar as string };
}

function parseWallet(value: unknown): Wallet {
  const keys = ['schemaVersion', 'network', 'keyType', 'publicKey', 'evmAddress', 'signerRef', 'accountId', 'verifiedAt'];
  if (!object(value) || !exactKeys(value, keys)) throw failure('WALLET_STATE_INVALID');
  if (
    value.schemaVersion !== 1 || value.network !== 'hedera:testnet' || value.keyType !== 'ecdsa' ||
    typeof value.publicKey !== 'string' || typeof value.evmAddress !== 'string' ||
    typeof value.signerRef !== 'string' || !validOptionalString(value.accountId) ||
    !validOptionalString(value.verifiedAt)
  ) throw failure('WALLET_STATE_INVALID');
  return value as Wallet;
}

function parseIntent(value: unknown): State['intent'] {
  if (value === null) return null;
  if (!object(value) || !exactKeys(value, ['transactionId', 'bodyDigest', 'submittedAt']) ||
    typeof value.transactionId !== 'string' || typeof value.bodyDigest !== 'string' ||
    typeof value.submittedAt !== 'string') throw failure('WALLET_STATE_INVALID');
  return value as State['intent'];
}

function parseEvidence(value: unknown, maxFeeTinybar: string): State['evidence'] {
  if (value === null) return null;
  if (!object(value) || !exactKeys(value, ['transactionId', 'consensusTimestamp', 'chargedFeeTinybar', 'verificationUrl']) ||
    typeof value.transactionId !== 'string' || typeof value.consensusTimestamp !== 'string' ||
    typeof value.chargedFeeTinybar !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value.chargedFeeTinybar) ||
    BigInt(value.chargedFeeTinybar) > BigInt(maxFeeTinybar) || typeof value.verificationUrl !== 'string') {
    throw failure('WALLET_STATE_INVALID');
  }
  return value as State['evidence'];
}

function parseState(value: unknown): State {
  const keys = ['workflowId', 'runId', 'limits', 'phase', 'intent', 'evidence', 'reason'];
  if (!object(value) || !exactKeys(value, keys) || value.workflowId !== 'agent-wallet-init' ||
    typeof value.runId !== 'string' || typeof value.phase !== 'string' ||
    !PHASES.has(value.phase as State['phase']) || !validOptionalString(value.reason)) {
    throw failure('WALLET_STATE_INVALID');
  }
  const limits = parseLimits(value.limits);
  return {
    workflowId: 'agent-wallet-init',
    runId: value.runId,
    limits,
    phase: value.phase as State['phase'],
    intent: parseIntent(value.intent),
    evidence: parseEvidence(value.evidence, limits.maxFeeTinybar),
    reason: value.reason,
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function ensureWalletDirectory(walletDir: string): Promise<void> {
  if (process.platform === 'win32' || typeof process.getuid !== 'function' ||
    typeof constants.O_NOFOLLOW !== 'number' || !isAbsolute(walletDir) ||
    normalize(walletDir) !== walletDir || walletDir === posix.parse(walletDir).root || /[\0\r\n]/.test(walletDir)) {
    throw failure('WALLET_STATE_INVALID');
  }

  const root = posix.parse(walletDir).root;
  let current = root;
  for (const part of walletDir.slice(root.length).split('/').filter(Boolean)) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw failure('WALLET_STATE_INVALID');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(current, { mode: 0o700 });
    }
  }

  const info = await lstat(walletDir);
  if (!info.isDirectory() || info.uid !== currentUid() || (info.mode & 0o7777) !== 0o700) {
    throw failure('WALLET_STATE_INVALID');
  }
}

async function validateRegularFile(path: string, mode: number, limit?: number): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== currentUid() ||
    (info.mode & 0o7777) !== mode || (limit !== undefined && info.size > limit)) {
    throw failure('WALLET_STATE_INVALID');
  }
}

async function safeRead(path: string, limit: number): Promise<string> {
  let handle: FileHandle | undefined;
  const buffer = Buffer.alloc(limit + 1);
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== currentUid() || (info.mode & 0o7777) !== 0o600 || info.size > limit) {
      throw failure('WALLET_STATE_INVALID');
    }
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > limit) throw failure('WALLET_STATE_INVALID');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size));
  } finally {
    buffer.fill(0);
    await handle?.close().catch(() => {});
  }
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await safeRead(path, JSON_LIMIT));
  } catch (error) {
    if (error instanceof Error && error.message === 'WALLET_STATE_INVALID') throw error;
    throw failure('WALLET_STATE_INVALID');
  }
}

async function readKeyFile(path: string): Promise<PrivateKey> {
  let text = '';
  try {
    text = await safeRead(path, KEY_LIMIT);
    const encoded = text.endsWith('\n') ? text.slice(0, -1) : text;
    if (encoded.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(encoded)) throw failure('SIGNER_UNAVAILABLE');
    const key = PrivateKey.fromStringECDSA(encoded);
    key.publicKey.toStringRaw();
    return key;
  } catch {
    throw failure('SIGNER_UNAVAILABLE');
  } finally {
    text = '';
  }
}

async function writeExclusive(path: string, content: string): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== currentUid() || (info.mode & 0o7777) !== 0o600) {
      throw failure('WALLET_STATE_INVALID');
    }
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(dir: string): Promise<void> {
  const handle = await open(dir, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    await writeExclusive(temporary, `${JSON.stringify(value, null, 2)}\n`);
    await rename(temporary, path);
    await syncDirectory(posix.dirname(path));
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function persistSnapshot(dir: string, snapshot: Snapshot): Promise<void> {
  const marker = join(dir, '.save-intent');
  await writeExclusive(marker, '\n');
  try {
    await atomicWrite(join(dir, 'wallet.json'), snapshot.wallet);
    await atomicWrite(join(dir, 'init-state.json'), snapshot.state);
    await unlink(marker);
    await syncDirectory(dir);
  } catch (error) {
    throw error;
  }
}

function validateSnapshot(value: Snapshot, key: PrivateKey, keyPath: string): Snapshot {
  const wallet = parseWallet(value.wallet);
  const state = parseState(value.state);
  const publicKey = key.publicKey.toStringRaw();
  const evmAddress = `0x${key.publicKey.toEvmAddress()}`;
  if (wallet.publicKey !== publicKey || wallet.evmAddress.toLowerCase() !== evmAddress.toLowerCase() ||
    wallet.signerRef !== `file:${keyPath}`) throw failure('WALLET_STATE_INVALID');
  return { wallet, state };
}

function detachSnapshot(snapshot: Snapshot): Snapshot {
  return structuredClone(snapshot);
}

async function acquireLock(path: string): Promise<Database> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== currentUid() || (info.mode & 0o7777) !== 0o600) throw failure('INIT_IN_PROGRESS');
    await handle.close();
    handle = undefined;
    const database = new Database(path, { create: true });
    try {
      database.exec('PRAGMA busy_timeout=0');
      database.exec('BEGIN IMMEDIATE');
      return database;
    } catch {
      database.close(false);
      throw failure('INIT_IN_PROGRESS');
    }
  } catch {
    await handle?.close().catch(() => {});
    throw failure('INIT_IN_PROGRESS');
  }
}

export async function openLocalWallet(options: Options): Promise<WalletStore> {
  if (options.network !== 'hedera:testnet') throw failure('INIT_CONFIG_CONFLICT');
  let requestedLimits: Limits | undefined;
  if (options.limits !== undefined) {
    try { requestedLimits = parseLimits(options.limits); }
    catch { throw failure('INIT_CONFIG_CONFLICT'); }
  }

  try { await ensureWalletDirectory(options.walletDir); }
  catch { throw failure('WALLET_STATE_INVALID'); }

  const dir = options.walletDir;
  const keyPath = join(dir, 'agent.key');
  const walletPath = join(dir, 'wallet.json');
  const statePath = join(dir, 'init-state.json');
  const markerPath = join(dir, '.save-intent');
  const lock = await acquireLock(join(dir, 'init-lock.sqlite'));
  let closed = false;

  try {
    if (await pathExists(markerPath)) throw failure('WALLET_STATE_INVALID');
    const existing = await Promise.all([keyPath, walletPath, statePath].map(pathExists));
    let snapshot: Snapshot;

    if (existing.every(Boolean)) {
      await Promise.all([
        validateRegularFile(keyPath, 0o600, KEY_LIMIT),
        validateRegularFile(walletPath, 0o600, JSON_LIMIT),
        validateRegularFile(statePath, 0o600, JSON_LIMIT),
      ]);
      const key = await readKeyFile(keyPath);
      snapshot = validateSnapshot({
        wallet: parseWallet(await readJson(walletPath)),
        state: parseState(await readJson(statePath)),
      }, key, keyPath);
      if (requestedLimits && (requestedLimits.maxFeeTinybar !== snapshot.state.limits.maxFeeTinybar ||
        requestedLimits.reserveTinybar !== snapshot.state.limits.reserveTinybar)) {
        throw failure('INIT_CONFIG_CONFLICT');
      }
    } else if (existing.some(Boolean)) {
      throw failure('WALLET_STATE_INVALID');
    } else {
      if (!requestedLimits) throw failure('INIT_CONFIG_CONFLICT');
      const generated = await PrivateKey.generateECDSAAsync();
      await writeExclusive(keyPath, `${generated.toStringRaw()}\n`);
      const key = await readKeyFile(keyPath);
      const wallet: Wallet = {
        schemaVersion: 1,
        network: 'hedera:testnet',
        keyType: 'ecdsa',
        publicKey: key.publicKey.toStringRaw(),
        evmAddress: `0x${key.publicKey.toEvmAddress()}`,
        signerRef: `file:${keyPath}`,
        accountId: null,
        verifiedAt: null,
      };
      snapshot = {
        wallet,
        state: {
          workflowId: 'agent-wallet-init',
          runId: randomUUID(),
          limits: requestedLimits,
          phase: 'LocalReady',
          intent: null,
          evidence: null,
          reason: null,
        },
      };
      await persistSnapshot(dir, snapshot);
    }

    let currentSnapshot = detachSnapshot(snapshot);
    const store: WalletStore = {
      dir,
      get snapshot() { return detachSnapshot(currentSnapshot); },
      async save(next) {
        if (closed) throw failure('WALLET_STATE_INVALID');
        try {
          const key = await readKeyFile(keyPath);
          const validated = detachSnapshot(validateSnapshot(next, key, keyPath));
          if (validated.state.limits.maxFeeTinybar !== currentSnapshot.state.limits.maxFeeTinybar ||
            validated.state.limits.reserveTinybar !== currentSnapshot.state.limits.reserveTinybar) {
            throw failure('INIT_CONFIG_CONFLICT');
          }
          await persistSnapshot(dir, validated);
          currentSnapshot = detachSnapshot(validated);
        } catch (error) {
          if (error instanceof Error && ['SIGNER_UNAVAILABLE', 'WALLET_STATE_INVALID', 'INIT_CONFIG_CONFLICT'].includes(error.message)) throw error;
          throw failure('WALLET_STATE_INVALID');
        }
      },
      readKey() {
        if (closed) return Promise.reject(failure('SIGNER_UNAVAILABLE'));
        return readKeyFile(keyPath);
      },
      close() {
        if (closed) return;
        closed = true;
        try { lock.exec('ROLLBACK'); } catch {}
        lock.close(false);
      },
    };
    return store;
  } catch (error) {
    try { lock.exec('ROLLBACK'); } catch {}
    lock.close(false);
    if (error instanceof Error && ['SIGNER_UNAVAILABLE', 'WALLET_STATE_INVALID', 'INIT_CONFIG_CONFLICT', 'INIT_IN_PROGRESS'].includes(error.message)) {
      throw error;
    }
    throw failure('WALLET_STATE_INVALID');
  }
}
