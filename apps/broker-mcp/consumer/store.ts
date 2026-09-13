import { Database } from "bun:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getAddress, verifyMessage, type Address, type Hex } from "viem";
import { createSiweMessage } from "viem/siwe";

export const HOSTS = ["chatgpt", "claude-code", "opencode", "generic"] as const;
export type ConsumerHost = typeof HOSTS[number];
export class ConsumerError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); this.name = "ConsumerError"; }
}
export interface ConsumerStoreOptions {
  origin: string;
  databasePath: string;
  allowLoopback?: boolean;
  now?: () => number;
  deviceTtlMs?: number;
  sessionTtlMs?: number;
  walletCallLimit?: number;
  globalCallLimit?: number;
  allowedLoginChains?: readonly number[];
}
export interface ConsumerSession {
  id: string;
  wallet_address: string;
  chain_id: number;
  expires_at: number;
  revoked: number;
}
interface DeviceRow {
  id: string; device_hash: string; user_hash: string; host: ConsumerHost; client_name: string;
  state: "awaiting_wallet" | "approved" | "consumed" | "rejected";
  created_at: number; expires_at: number; wallet_address: string | null; chain_id: number | null;
  message: string | null; challenge_count: number; verify_count: number;
}
interface InvocationRow {
  fingerprint: string; state: string; result_json: string | null; error_code: string | null;
}
export type InvocationClaim = { kind: "new" } | { kind: "cached"; result: unknown };
export const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const secret = (): string => randomBytes(32).toString("base64url");
const iso = (value: number): string => new Date(value).toISOString();

export function normalizeConsumerOrigin(value: string, allowLoopback = false): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new ConsumerError("NETWORK_ORIGIN_INVALID"); }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(allowLoopback && loopback && url.protocol === "http:")) ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new ConsumerError("NETWORK_ORIGIN_INVALID");
  }
  return url.origin;
}

/** Single-host SQLite state. Wallet keys, signatures and bearer tokens are never persisted. */
export class ConsumerStore {
  readonly origin: string;
  readonly allowedLoginChains: readonly number[];
  readonly walletCallLimit: number;
  readonly globalCallLimit: number;
  private readonly db: Database;
  private readonly now: () => number;
  private readonly deviceTtlMs: number;
  private readonly sessionTtlMs: number;

  constructor(options: ConsumerStoreOptions) {
    this.origin = normalizeConsumerOrigin(options.origin, options.allowLoopback);
    this.now = options.now ?? Date.now;
    this.deviceTtlMs = options.deviceTtlMs ?? 10 * 60_000;
    this.sessionTtlMs = options.sessionTtlMs ?? 60 * 60_000;
    this.walletCallLimit = options.walletCallLimit ?? 10;
    this.globalCallLimit = options.globalCallLimit ?? 100;
    this.allowedLoginChains = options.allowedLoginChains ?? [1, 11155111];
    for (const value of [this.deviceTtlMs, this.sessionTtlMs, this.walletCallLimit, this.globalCallLimit]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new ConsumerError("NETWORK_CONFIG_INVALID");
    }
    if (!this.allowedLoginChains.length || this.allowedLoginChains.some((v) => !Number.isSafeInteger(v) || v < 1)) {
      throw new ConsumerError("NETWORK_CONFIG_INVALID");
    }
    if (options.databasePath !== ":memory:") {
      const path = resolve(options.databasePath);
      let current = dirname(path);
      while (true) {
        if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new ConsumerError("SESSION_DB_SYMLINK");
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
      }
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const fileStat = lstatSync(path, { throwIfNoEntry: false });
      if (fileStat && (fileStat.isSymbolicLink() || !fileStat.isFile())) {
        throw new ConsumerError("SESSION_DB_INVALID");
      }
      // Refuse a shared directory instead of changing permissions on an operator-owned mount.
      if ((lstatSync(dirname(path)).mode & 0o077) !== 0) throw new ConsumerError("SESSION_DB_DIRECTORY_NOT_PRIVATE");
    }
    this.db = new Database(options.databasePath, { create: true, strict: true });
    if (options.databasePath !== ":memory:") chmodSync(options.databasePath, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS consumer_devices (
        id TEXT PRIMARY KEY, device_hash TEXT UNIQUE NOT NULL, user_hash TEXT UNIQUE NOT NULL,
        host TEXT NOT NULL, client_name TEXT NOT NULL, state TEXT NOT NULL,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        wallet_address TEXT, chain_id INTEGER, message TEXT,
        challenge_count INTEGER NOT NULL DEFAULT 0, verify_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS consumer_devices_expiry ON consumer_devices(expires_at);
      CREATE TABLE IF NOT EXISTS consumer_sessions (
        id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, wallet_address TEXT NOT NULL,
        chain_id INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS consumer_invocations (
        wallet TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
        state TEXT NOT NULL, created_at INTEGER NOT NULL, result_json TEXT, error_code TEXT,
        PRIMARY KEY(wallet, request_id)
      );
      CREATE INDEX IF NOT EXISTS consumer_invocations_created ON consumer_invocations(created_at);
      CREATE TABLE IF NOT EXISTS consumer_rate_windows (
        key TEXT PRIMARY KEY, window_at INTEGER NOT NULL, count INTEGER NOT NULL
      );
    `);
  }

  close(): void { this.db.close(); }
  timestamp(): string { return iso(this.now()); }

  rateLimit(key: string, maximum: number, windowMs = 60_000): void {
    this.db.transaction(() => {
      const now = this.now();
      const row = this.db.query<{ window_at: number; count: number }, [string]>(
        "SELECT window_at, count FROM consumer_rate_windows WHERE key = ?",
      ).get(key);
      if (row && now - row.window_at < windowMs && row.count >= maximum) throw new ConsumerError("RATE_LIMITED", 429);
      if (!row || now - row.window_at >= windowMs) {
        this.db.query("INSERT OR REPLACE INTO consumer_rate_windows(key, window_at, count) VALUES(?, ?, 1)").run(key, now);
      } else this.db.query("UPDATE consumer_rate_windows SET count = count + 1 WHERE key = ?").run(key);
    }).immediate();
  }

  start(clientName: unknown, host: unknown): Record<string, unknown> {
    if (typeof clientName !== "string" || !/^[A-Za-z0-9 ._()-]{1,64}$/u.test(clientName) ||
        typeof host !== "string" || !(HOSTS as readonly string[]).includes(host)) throw new ConsumerError("INVALID_REQUEST");
    this.rateLimit("device-start", 100, 10 * 60_000);
    const now = this.now();
    this.db.query("DELETE FROM consumer_devices WHERE expires_at < ?").run(now - 86_400_000);
    this.db.query("DELETE FROM consumer_sessions WHERE expires_at < ?").run(now - 86_400_000);
    this.db.query("DELETE FROM consumer_rate_windows WHERE window_at < ?").run(now - 86_400_000);
    // Idempotency tombstones outlive retained service output: old IDs never invoke again.
    this.db.query("UPDATE consumer_invocations SET result_json = NULL, state = 'expired', error_code = 'REQUEST_RESULT_EXPIRED' WHERE created_at < ? AND state = 'succeeded'").run(now - 7 * 86_400_000);
    const deviceCode = secret();
    const userCode = randomBytes(12).toString("hex").toUpperCase().match(/.{4}/gu)!.join("-");
    const expiresAt = now + this.deviceTtlMs;
    this.db.query(`INSERT INTO consumer_devices(id, device_hash, user_hash, host, client_name, state, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, 'awaiting_wallet', ?, ?)`)
      .run(randomUUID(), digest(deviceCode), digest(userCode), host, clientName, now, expiresAt);
    return { deviceCode, userCode, verificationUri: `${this.origin}/connect/#code=${userCode}`,
      expiresAt: iso(expiresAt), intervalSeconds: 5, paymentMode: "platform_demo" };
  }

  private deviceByUser(userCode: unknown): DeviceRow {
    if (typeof userCode !== "string" || !/^[A-F0-9]{4}(?:-[A-F0-9]{4}){5}$/u.test(userCode)) throw new ConsumerError("DEVICE_NOT_FOUND", 404);
    const row = this.db.query<DeviceRow, [string]>("SELECT * FROM consumer_devices WHERE user_hash = ?").get(digest(userCode));
    if (!row) throw new ConsumerError("DEVICE_NOT_FOUND", 404);
    if (row.expires_at <= this.now()) throw new ConsumerError("DEVICE_EXPIRED");
    return row;
  }

  inspect(userCode: unknown): Record<string, unknown> {
    const row = this.deviceByUser(userCode);
    return { requestId: row.id, clientName: row.client_name, host: row.host, status: row.state,
      expiresAt: iso(row.expires_at), allowedLoginChains: this.allowedLoginChains,
      paymentMode: "platform_demo", walletCallLimit: this.walletCallLimit,
      permissions: ["Discover services", "Use platform demo calls"], walletType: "eoa" };
  }

  challenge(userCode: unknown, inputAddress: unknown, chainId: unknown): Record<string, unknown> {
    const row = this.deviceByUser(userCode);
    if (row.state !== "awaiting_wallet") throw new ConsumerError("DEVICE_NOT_PENDING", 409);
    if (row.challenge_count >= 10) throw new ConsumerError("RATE_LIMITED", 429);
    if (typeof inputAddress !== "string" || !/^0x[0-9a-fA-F]{40}$/u.test(inputAddress)) throw new ConsumerError("INVALID_ADDRESS");
    if (typeof chainId !== "number" || !this.allowedLoginChains.includes(chainId)) throw new ConsumerError("LOGIN_CHAIN_UNSUPPORTED");
    let address: Address;
    try { address = getAddress(inputAddress); } catch { throw new ConsumerError("INVALID_ADDRESS"); }
    const message = createSiweMessage({
      address, chainId, domain: new URL(this.origin).host, uri: `${this.origin}/connect/`, version: "1",
      nonce: randomBytes(16).toString("hex"), issuedAt: new Date(this.now()),
      expirationTime: new Date(row.expires_at), requestId: row.id,
      statement: `Authorize ${row.client_name} (${row.host}) to discover services and use Frely Network platform demo calls. Code ${userCode}. No transfers or token spending permissions.`,
    });
    this.db.query(`UPDATE consumer_devices SET message = ?, wallet_address = ?, chain_id = ?, challenge_count = challenge_count + 1
      WHERE id = ? AND state = 'awaiting_wallet'`).run(message, address, chainId, row.id);
    return { message, expiresAt: iso(row.expires_at), requestId: row.id };
  }

  async approve(userCode: unknown, message: unknown, signature: unknown): Promise<Record<string, unknown>> {
    const row = this.deviceByUser(userCode);
    if (row.state !== "awaiting_wallet") throw new ConsumerError("DEVICE_NOT_PENDING", 409);
    if (row.verify_count >= 10) throw new ConsumerError("RATE_LIMITED", 429);
    this.db.query("UPDATE consumer_devices SET verify_count = verify_count + 1 WHERE id = ?").run(row.id);
    if (!row.message || message !== row.message || !row.wallet_address ||
        typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/u.test(signature)) throw new ConsumerError("SIGNATURE_INVALID", 403);
    // Exact equality binds domain, URI, address, chain, nonce, request, expiry and signed permissions.
    let valid = false;
    try { valid = await verifyMessage({ address: row.wallet_address as Address, message: row.message, signature: signature as Hex }); }
    catch { /* A malformed EOA signature is not an authorization. */ }
    if (!valid) throw new ConsumerError("SIGNATURE_INVALID", 403);
    this.db.transaction(() => {
      const updated = this.db.query(`UPDATE consumer_devices SET state = 'approved', message = NULL
        WHERE id = ? AND state = 'awaiting_wallet' AND message = ? AND expires_at > ?`)
        .run(row.id, row.message, this.now());
      if (updated.changes !== 1) throw new ConsumerError("DEVICE_NOT_PENDING", 409);
    }).immediate();
    return { status: "approved", paymentMode: "platform_demo" };
  }

  reject(userCode: unknown): Record<string, unknown> {
    const row = this.deviceByUser(userCode);
    const updated = this.db.query("UPDATE consumer_devices SET state = 'rejected', message = NULL WHERE id = ? AND state = 'awaiting_wallet'").run(row.id);
    if (updated.changes !== 1) throw new ConsumerError("DEVICE_NOT_PENDING", 409);
    return { status: "rejected" };
  }

  exchange(deviceCode: unknown): Record<string, unknown> {
    if (typeof deviceCode !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(deviceCode)) throw new ConsumerError("DEVICE_EXPIRED");
    return this.db.transaction(() => {
      const row = this.db.query<DeviceRow, [string]>("SELECT * FROM consumer_devices WHERE device_hash = ?").get(digest(deviceCode));
      if (!row || row.expires_at <= this.now()) throw new ConsumerError("DEVICE_EXPIRED");
      if (row.state === "awaiting_wallet") return { status: "awaiting_wallet", intervalSeconds: 5 };
      if (row.state === "rejected") throw new ConsumerError("DEVICE_REJECTED", 403);
      if (row.state === "consumed") throw new ConsumerError("DEVICE_CONSUMED");
      if (!row.wallet_address || !row.chain_id) throw new ConsumerError("DEVICE_INVALID");
      const token = `fn_${secret()}`;
      const session: ConsumerSession = { id: randomUUID(), wallet_address: row.wallet_address,
        chain_id: row.chain_id, expires_at: this.now() + this.sessionTtlMs, revoked: 0 };
      this.db.query("INSERT INTO consumer_sessions(id, token_hash, wallet_address, chain_id, expires_at) VALUES(?, ?, ?, ?, ?)")
        .run(session.id, digest(token), session.wallet_address, session.chain_id, session.expires_at);
      this.db.query("UPDATE consumer_devices SET state = 'consumed' WHERE id = ?").run(row.id);
      return { ...this.sessionView(session), accessToken: token };
    }).immediate();
  }

  authenticate(authorization: string | null): ConsumerSession {
    if (!authorization || !/^Bearer fn_[A-Za-z0-9_-]{43}$/u.test(authorization)) throw new ConsumerError("SESSION_REQUIRED", 401);
    const session = this.db.query<ConsumerSession, [string]>(
      "SELECT id, wallet_address, chain_id, expires_at, revoked FROM consumer_sessions WHERE token_hash = ?",
    ).get(digest(authorization.slice(7)));
    if (!session || session.revoked) throw new ConsumerError("SESSION_REQUIRED", 401);
    if (session.expires_at <= this.now()) throw new ConsumerError("SESSION_EXPIRED", 401);
    return session;
  }

  sessionView(session: ConsumerSession): Record<string, unknown> {
    return { status: "ready", sessionId: session.id, walletAddress: session.wallet_address,
      chainId: session.chain_id, expiresAt: iso(session.expires_at), paymentMode: "platform_demo",
      remainingCalls: this.remainingCalls(session.wallet_address) };
  }

  revoke(session: ConsumerSession): void {
    this.db.query("UPDATE consumer_sessions SET revoked = 1 WHERE id = ?").run(session.id);
  }

  private dayStart(): number { return Math.floor(this.now() / 86_400_000) * 86_400_000; }
  remainingCalls(address: string): number {
    const day = this.dayStart();
    const count = this.db.query<{ n: number }, [string, number]>(
      "SELECT COUNT(*) AS n FROM consumer_invocations WHERE wallet = ? AND created_at >= ?",
    ).get(address.toLowerCase(), day)!.n;
    const total = this.db.query<{ n: number }, [number]>(
      "SELECT COUNT(*) AS n FROM consumer_invocations WHERE created_at >= ?",
    ).get(day)!.n;
    return Math.max(0, Math.min(this.walletCallLimit - count, this.globalCallLimit - total));
  }

  claim(session: ConsumerSession, requestId: string, fingerprint: string): InvocationClaim {
    return this.db.transaction(() => {
      const wallet = session.wallet_address.toLowerCase();
      const prior = this.db.query<InvocationRow, [string, string]>(
        "SELECT fingerprint, state, result_json, error_code FROM consumer_invocations WHERE wallet = ? AND request_id = ?",
      ).get(wallet, requestId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new ConsumerError("IDEMPOTENCY_CONFLICT", 409);
        if (prior.state === "succeeded" && prior.result_json) return { kind: "cached" as const, result: JSON.parse(prior.result_json) as unknown };
        if (prior.state === "started") throw new ConsumerError("REQUEST_OUTCOME_UNKNOWN", 409);
        throw new ConsumerError(prior.error_code ?? "REQUEST_OUTCOME_UNKNOWN", 409);
      }
      if (this.remainingCalls(session.wallet_address) <= 0) throw new ConsumerError("DEMO_LIMIT_EXCEEDED", 429);
      this.db.query(`INSERT INTO consumer_invocations(wallet, request_id, fingerprint, state, created_at)
        VALUES(?, ?, ?, 'started', ?)`).run(wallet, requestId, fingerprint, this.now());
      return { kind: "new" as const };
    }).immediate();
  }

  succeed(session: ConsumerSession, requestId: string, value: unknown): void {
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > 256 * 1024) throw new ConsumerError("PROVIDER_RESPONSE_INVALID", 502);
    this.db.query("UPDATE consumer_invocations SET state = 'succeeded', result_json = ? WHERE wallet = ? AND request_id = ? AND state = 'started'")
      .run(text, session.wallet_address.toLowerCase(), requestId);
  }

  fail(session: ConsumerSession, requestId: string, code: string): void {
    this.db.query("UPDATE consumer_invocations SET state = 'failed', error_code = ? WHERE wallet = ? AND request_id = ? AND state = 'started'")
      .run(code, session.wallet_address.toLowerCase(), requestId);
  }
}
