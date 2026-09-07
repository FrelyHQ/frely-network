import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Journal, JournalRecord, RecoveryPolicy } from "./types.ts";

export function recoveryPolicy(policy: RecoveryPolicy): RecoveryPolicy {
  const {
    network,
    asset,
    assetDecimals,
    payerAccountId,
    payTo,
    feePayers,
    facilitatorUrl,
    resourceUrl,
    mirrorNodeUrl,
    credentialRef,
  } = policy;
  return {
    network,
    asset,
    assetDecimals,
    payerAccountId,
    payTo,
    feePayers: [...feePayers],
    facilitatorUrl,
    resourceUrl,
    mirrorNodeUrl,
    credentialRef,
  };
}
export function openJournal(
  path: string,
  now: () => number = Date.now,
): Journal {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(path), 0o700);
  }
  const db = new Database(path, { create: true });
  const permissions = () => {
    if (path !== ":memory:")
      for (const file of [path, path + "-wal", path + "-shm"])
        if (existsSync(file)) chmodSync(file, 0o600);
  };
  permissions();
  db.exec(
    "PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS payment_requests (request_id TEXT PRIMARY KEY, record_json TEXT NOT NULL)",
  );
  db.exec("CREATE TABLE IF NOT EXISTS payment_run_lock (slot INTEGER PRIMARY KEY CHECK(slot=1), owner TEXT, expires_at INTEGER); INSERT OR IGNORE INTO payment_run_lock VALUES (1, NULL, 0)");
  let owner: string | null = null;
  const lock = () => db.query("SELECT owner, expires_at FROM payment_run_lock WHERE slot=1").get() as { owner: string | null; expires_at: number };
  const assertOwner = (required = false) => {
    const current = lock();
    if (owner !== null) {
      if (current.owner !== owner || current.expires_at <= now()) throw new Error("JOURNAL_UNAVAILABLE");
    } else if (required) throw new Error("JOURNAL_UNAVAILABLE");
    else if (current.owner !== null && current.expires_at > now()) throw new Error("REQUEST_IN_PROGRESS");
  };
  permissions();
  const get = (id: string): JournalRecord | null => {
    const row = db
      .query("SELECT record_json FROM payment_requests WHERE request_id = ?")
      .get(id) as { record_json: string } | null;
    return row ? (JSON.parse(row.record_json) as JournalRecord) : null;
  };
  const put = (r: JournalRecord) => {
    db.query(
      "UPDATE payment_requests SET record_json = ? WHERE request_id = ?",
    ).run(JSON.stringify(r), r.requestId);
    permissions();
  };
  const read = (id: string) =>
    db
      .transaction(() => {
        const r = get(id);
        if (
          r &&
          r.outputExpiresAt !== null &&
          now() >= r.outputExpiresAt &&
          r.output !== null
        ) {
          r.output = null;
          if (r.outcome) {
            r.outcome.output = null;
            r.outcome.reason = "OUTPUT_UNAVAILABLE";
          }
          // Readers never mutate a record currently owned by another runner.
          const current = lock();
          if (current.owner === null || current.expires_at <= now() || current.owner === owner) put(r);
        }
        return r;
      })
      .immediate();
  return {
    read,
    isRunActive() { const current = lock(); return current.owner !== null && current.expires_at > now(); },
    claimRun() {
      const token = crypto.randomUUID();
      db.transaction(() => {
        const changed = db.query("UPDATE payment_run_lock SET owner=?, expires_at=? WHERE slot=1 AND (owner IS NULL OR expires_at<=?)").run(token, now() + 60_000, now());
        if (changed.changes !== 1) throw new Error("REQUEST_IN_PROGRESS");
      }).immediate();
      owner = token;
      permissions();
      return token;
    },
    heartbeat(token) {
      if (token !== owner) throw new Error("JOURNAL_UNAVAILABLE");
      const changed = db.query("UPDATE payment_run_lock SET expires_at=? WHERE slot=1 AND owner=? AND expires_at>?").run(now() + 60_000, token, now());
      if (changed.changes !== 1) throw new Error("JOURNAL_UNAVAILABLE");
    },
    releaseRun(token) {
      if (token !== owner) throw new Error("JOURNAL_UNAVAILABLE");
      const changed = db.query("UPDATE payment_run_lock SET owner=NULL, expires_at=0 WHERE slot=1 AND owner=?").run(token);
      if (changed.changes !== 1) throw new Error("JOURNAL_UNAVAILABLE");
      owner = null;
    },
    beforeDispatch(id, token) {
      return this.update(id, { phase: "dispatch-intent", dispatched: true, serviceStatus: "unknown" }, token);
    },
    admit(id, fingerprint, policy) {
      return db
        .transaction(() => {
          assertOwner();
          const old = get(id);
          if (old) {
            if (old.fingerprint !== fingerprint)
              throw new Error("REQUEST_ID_CONFLICT");
            return { fresh: false, record: old };
          }
          const rows = db.query("SELECT record_json FROM payment_requests").all() as { record_json: string }[];
          if (rows.some(row => {
            const record = JSON.parse(row.record_json) as JournalRecord;
            return record.dispatched ? record.outcome?.paymentStatus !== "settled" : !["finished", "closed-before-payment"].includes(record.phase);
          })) throw new Error("RECOVERY_REQUIRED");
          const record: JournalRecord = {
            requestId: id,
            fingerprint,
            policy: recoveryPolicy(policy),
            phase: "admitted",
            phaseBeforeFinish: null,
            dispatched: false,
            required: null,
            quote: null,
            evidence: null,
            outcome: null,
            serviceStatus: "not_started",
            output: null,
            outputDigest: null,
            outputExpiresAt: null,
            responseTransaction: null,
            responseConflict: false,
          };
          db.query("INSERT INTO payment_requests VALUES (?, ?)").run(
            id,
            JSON.stringify(record),
          );
          permissions();
          return { fresh: true, record };
        })
        .immediate();
    },
    update(id, change, token) {
      return db
        .transaction(() => {
          if (token !== undefined && token !== owner) throw new Error("JOURNAL_UNAVAILABLE");
          assertOwner();
          const old = get(id);
          if (!old) throw new Error("REQUEST_NOT_FOUND");
          if (old.phase === "closed-before-payment" && change.phase && change.phase !== old.phase) throw new Error("REQUEST_CLOSED_BEFORE_PAYMENT");
          if (change.phase === "dispatch-intent") {
            assertOwner(true);
            if (old.phase !== "signed" || old.dispatched || !old.evidence?.transactionId || !old.evidence.signedDigest) throw new Error("JOURNAL_UNAVAILABLE");
          }
          const next = { ...old, ...change };
          if (change.phase === "finished" || change.phase === "closed-before-payment") {
            next.phaseBeforeFinish = old.phaseBeforeFinish ?? old.phase;
          }
          if (old.dispatched) next.dispatched = true;
          if (old.outcome?.paymentStatus === "settled") {
            next.outcome = {
              ...(next.outcome ?? old.outcome),
              paymentStatus: "settled",
              evidence: old.outcome.evidence,
            };
            next.evidence = old.evidence;
          }
          if (old.responseConflict) next.responseConflict = true;
          if (old.outputExpiresAt !== null)
            next.outputExpiresAt = old.outputExpiresAt;
          if (next.outputExpiresAt !== null && now() >= next.outputExpiresAt) {
            next.output = null;
            if (next.outcome) next.outcome = { ...next.outcome, output: null, reason: "OUTPUT_UNAVAILABLE" };
          }
          put(next);
          return next;
        })
        .immediate();
    },
    close() {
      db.close();
    },
  };
}
