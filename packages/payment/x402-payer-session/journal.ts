import { Database } from "bun:sqlite";
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { PaymentRequirement } from "@frely-network/hedera-x402";
import type {
  JournalPhase,
  JournalRecord,
  PaymentStatus,
  PayerPolicy,
  ServiceStatus,
  SignedPayment,
} from "./types.ts";

const PHASE_RANK: Record<JournalPhase, number> = {
  new: 0,
  challenged: 1,
  signed: 2,
  paid_dispatch_started: 3,
  unknown: 4,
  settled: 5,
  service_succeeded: 6,
  service_failed: 6,
};

function failure(code: string): Error {
  return new Error(code);
}

function nowIso(now: () => number): string {
  return new Date(now()).toISOString();
}

function quoteSnapshot(requirement: PaymentRequirement): string {
  const extra = requirement.extra && typeof requirement.extra === "object" && !Array.isArray(requirement.extra)
    ? requirement.extra as Record<string, unknown>
    : undefined;
  return JSON.stringify({
    scheme: requirement.scheme,
    network: requirement.network,
    ...(requirement.amount === undefined ? {} : { amount: requirement.amount }),
    ...(requirement.maxAmountRequired === undefined ? {} : { maxAmountRequired: requirement.maxAmountRequired }),
    ...(requirement.asset === undefined ? {} : { asset: requirement.asset }),
    ...(requirement.payTo === undefined ? {} : { payTo: requirement.payTo }),
    ...(requirement.maxTimeoutSeconds === undefined ? {} : { maxTimeoutSeconds: requirement.maxTimeoutSeconds }),
    ...(typeof extra?.feePayer === "string" ? { extra: { feePayer: extra.feePayer } } : {}),
    ...(requirement.resource === undefined ? {} : { resource: requirement.resource }),
  });
}

function rowToRecord(row: {
  request_id: string;
  fingerprint: string;
  phase: string;
  policy_json: string;
  transaction_id: string | null;
  payload_digest: string | null;
  payment_status: string;
  service_status: string;
  response_digest: string | null;
  output_json: string | null;
  quote_json: string | null;
  created_at: string;
  updated_at: string;
}): JournalRecord {
  return {
    requestId: row.request_id,
    fingerprint: row.fingerprint,
    phase: row.phase as JournalPhase,
    policyJson: row.policy_json,
    transactionId: row.transaction_id,
    payloadDigest: row.payload_digest,
    paymentStatus: row.payment_status as PaymentStatus,
    serviceStatus: row.service_status as ServiceStatus,
    responseDigest: row.response_digest,
    outputJson: row.output_json,
    quoteJson: row.quote_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assertSafePath(path: string): void {
  if (!path || path.includes("\0")) throw failure("JOURNAL_UNAVAILABLE");
}

function currentUid(): number {
  if (typeof process.getuid !== "function") throw failure("JOURNAL_UNAVAILABLE");
  return process.getuid();
}

function prepareDirectory(path: string): void {
  if (path === ":memory:") return;
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    info.uid !== currentUid() ||
    (info.mode & 0o7777) !== 0o700
  ) throw failure("JOURNAL_UNAVAILABLE");
}

function applyFilePermissions(path: string): void {
  if (path === ":memory:") return;
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    if (!existsSync(file)) continue;
    const info = lstatSync(file);
    if (info.isSymbolicLink() || !info.isFile() || info.uid !== currentUid()) {
      throw failure("JOURNAL_UNAVAILABLE");
    }
    chmodSync(file, 0o600);
  }
}

export function policySnapshot(policy: PayerPolicy): string {
  return JSON.stringify({
    network: policy.network,
    asset: policy.asset,
    amountAtomic: policy.amountAtomic,
    maxAmountAtomic: policy.maxAmountAtomic,
    payerAccountId: policy.payerAccountId,
    payTo: policy.payTo,
    feePayer: policy.feePayer,
    facilitatorUrl: policy.facilitatorUrl,
    resourceUrl: policy.resourceUrl,
    maxTimeoutSeconds: policy.maxTimeoutSeconds,
  });
}

export class PayerJournal {
  private readonly db: Database;
  private closed = false;

  constructor(
    private readonly path: string,
    private readonly now: () => number = Date.now,
  ) {
    assertSafePath(path);
    try {
      prepareDirectory(path);
      this.db = new Database(path, { create: true });
      this.db.exec("PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS payment_requests (
          request_id TEXT PRIMARY KEY,
          fingerprint TEXT NOT NULL,
          phase TEXT NOT NULL,
          policy_json TEXT NOT NULL,
          transaction_id TEXT,
          payload_digest TEXT,
          payment_status TEXT NOT NULL,
          service_status TEXT NOT NULL,
          response_digest TEXT,
          output_json TEXT,
          quote_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      const columns = this.db.query("PRAGMA table_info(payment_requests)").all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "quote_json")) {
        this.db.exec("ALTER TABLE payment_requests ADD COLUMN quote_json TEXT;");
      }
      applyFilePermissions(path);
    } catch {
      throw failure("JOURNAL_UNAVAILABLE");
    }
  }

  admit(requestId: string, fingerprint: string, policy: PayerPolicy): {
    fresh: boolean;
    record: JournalRecord;
  } {
    this.assertOpen();
    if (!requestId || requestId.includes("\0")) throw failure("INVALID_REQUEST");
    const stamp = nowIso(this.now);
    const policyJson = policySnapshot(policy);
    try {
      return this.db.transaction(() => {
        const existing = this.get(requestId);
        if (existing) {
          if (existing.fingerprint !== fingerprint) throw failure("REQUEST_ID_CONFLICT");
          return { fresh: false, record: existing };
        }
        this.db
          .query(
            `INSERT INTO payment_requests (
              request_id, fingerprint, phase, policy_json, payment_status, service_status, created_at, updated_at
            ) VALUES (?, ?, 'new', ?, 'not_paid', 'not_started', ?, ?)`,
          )
          .run(requestId, fingerprint, policyJson, stamp, stamp);
        applyFilePermissions(this.path);
        return { fresh: true, record: this.get(requestId)! };
      }).immediate();
    } catch (error) {
      if (error instanceof Error && /REQUEST_ID_CONFLICT|REQUEST_IN_PROGRESS|INVALID_REQUEST|JOURNAL_UNAVAILABLE/.test(error.message)) {
        throw error;
      }
      throw failure("JOURNAL_UNAVAILABLE");
    }
  }

  beforePaidDispatch(
    requestId: string,
    fingerprint: string,
    requirement: PaymentRequirement,
    signed: SignedPayment,
  ): JournalRecord {
    this.assertOpen();
    if (!signed.transactionId || !/^[0-9a-f]{64}$/.test(signed.payloadDigest)) {
      throw failure("JOURNAL_UNAVAILABLE");
    }
    return this.update(requestId, fingerprint, {
      phase: "paid_dispatch_started",
      paymentStatus: "unknown",
      serviceStatus: "unknown",
      transactionId: signed.transactionId,
      payloadDigest: signed.payloadDigest,
      quoteJson: quoteSnapshot(requirement),
    });
  }

  update(
    requestId: string,
    fingerprint: string,
    patch: Partial<Pick<JournalRecord, "phase" | "paymentStatus" | "serviceStatus" | "transactionId" | "payloadDigest" | "responseDigest" | "outputJson" | "quoteJson">>,
  ): JournalRecord {
    this.assertOpen();
    try {
      return this.db.transaction(() => {
        const existing = this.get(requestId);
        if (!existing) throw failure("JOURNAL_UNAVAILABLE");
        if (existing.fingerprint !== fingerprint) throw failure("REQUEST_ID_CONFLICT");
        if (patch.phase && PHASE_RANK[patch.phase] < PHASE_RANK[existing.phase]) {
          throw failure("JOURNAL_UNAVAILABLE");
        }
        const next: JournalRecord = {
          ...existing,
          ...patch,
          transactionId: patch.transactionId ?? existing.transactionId,
          payloadDigest: patch.payloadDigest ?? existing.payloadDigest,
          responseDigest: patch.responseDigest ?? existing.responseDigest,
          outputJson: patch.outputJson === undefined ? existing.outputJson : patch.outputJson,
          quoteJson: patch.quoteJson === undefined ? existing.quoteJson : patch.quoteJson,
          updatedAt: nowIso(this.now),
        };
        if (existing.paymentStatus === "settled") next.paymentStatus = "settled";
        if (existing.transactionId) next.transactionId = existing.transactionId;
        if (existing.payloadDigest) next.payloadDigest = existing.payloadDigest;
        this.db
          .query(
            `UPDATE payment_requests SET
              phase = ?, payment_status = ?, service_status = ?, transaction_id = ?,
              payload_digest = ?, response_digest = ?, output_json = ?, quote_json = ?, updated_at = ?
             WHERE request_id = ?`,
          )
          .run(
            next.phase,
            next.paymentStatus,
            next.serviceStatus,
            next.transactionId,
            next.payloadDigest,
            next.responseDigest,
            next.outputJson,
            next.quoteJson,
            next.updatedAt,
            requestId,
          );
        applyFilePermissions(this.path);
        return this.get(requestId)!;
      }).immediate();
    } catch (error) {
      if (error instanceof Error && /REQUEST_ID_CONFLICT|JOURNAL_UNAVAILABLE/.test(error.message)) {
        throw error;
      }
      throw failure("JOURNAL_UNAVAILABLE");
    }
  }

  read(requestId: string): JournalRecord | null {
    this.assertOpen();
    try {
      return this.get(requestId);
    } catch {
      throw failure("JOURNAL_UNAVAILABLE");
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private get(requestId: string): JournalRecord | null {
    const row = this.db
      .query(
        `SELECT request_id, fingerprint, phase, policy_json, transaction_id, payload_digest,
                payment_status, service_status, response_digest, output_json, quote_json, created_at, updated_at
         FROM payment_requests WHERE request_id = ?`,
      )
      .get(requestId) as Parameters<typeof rowToRecord>[0] | null;
    return row ? rowToRecord(row) : null;
  }

  private assertOpen(): void {
    if (this.closed) throw failure("JOURNAL_UNAVAILABLE");
  }
}
