import { expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { createHarness } from "./test-support.ts";
import { openJournal } from "./journal.ts";
test("journal survives reopen and does not store signer references, credentials, or payload", async () => {
  const h = createHarness();
  try {
    await h.session.execute(h.request);
    const r = h.journal.read(h.request.payment.requestId)!;
    expect(r.policy).not.toHaveProperty("signerRef");
    expect(r.policy).not.toHaveProperty("keyType");
    expect(JSON.stringify(r)).not.toContain("test-secret");
    expect(JSON.stringify(r)).not.toContain("testOnly");
    const second = openJournal(h.policy.journalPath);
    try {
      expect(second.read(r.requestId)).toEqual(r);
    } finally {
      second.close();
    }
    expect(statSync(dirname(h.policy.journalPath)).mode & 0o777).toBe(0o700);
    for (const file of [
      h.policy.journalPath,
      h.policy.journalPath + "-wal",
      h.policy.journalPath + "-shm",
    ])
      expect(statSync(file).mode & 0o777).toBe(0o600);
  } finally {
    h.close();
  }
});
test("settled and conflict knowledge are monotonic", async () => {
  const h = createHarness();
  try {
    const result = await h.session.execute(h.request);
    h.journal.update(h.request.payment.requestId, { responseConflict: true });
    h.journal.update(h.request.payment.requestId, {
      outcome: { ...result, paymentStatus: "unknown" },
      responseConflict: false,
    });
    const r = h.journal.read(h.request.payment.requestId)!;
    expect(r.outcome?.paymentStatus).toBe("settled");
    expect(r.responseConflict).toBe(true);
  } finally {
    h.close();
  }
});

test("separate journal connections cannot admit a second execution while an owner is active", () => {
  const h = createHarness();
  const second = openJournal(h.policy.journalPath);
  try {
    const token = h.journal.claimRun();
    expect(() => second.claimRun()).toThrow("REQUEST_IN_PROGRESS");
    expect(() => second.admit("intruder", "f", h.policy)).toThrow("REQUEST_IN_PROGRESS");
    h.journal.releaseRun(token);
    const next = second.claimRun();
    second.releaseRun(next);
  } finally { second.close(); h.close(); }
});
test("expired owner cannot dispatch or mutate after another connection takes ownership", () => {
  const h = createHarness();
  let time = Date.now();
  const first = openJournal(h.policy.journalPath, () => time);
  const second = openJournal(h.policy.journalPath, () => time);
  try {
    first.claimRun();
    first.admit("orphan", "f", h.policy);
    time += 60_001;
    const token = second.claimRun();
    expect(() => first.beforeDispatch("orphan")).toThrow("JOURNAL_UNAVAILABLE");
    expect(() => first.update("orphan", { phase: "signed" })).toThrow("JOURNAL_UNAVAILABLE");
    second.releaseRun(token);
    expect(() => first.update("orphan", { phase: "signed" })).toThrow("JOURNAL_UNAVAILABLE");
  } finally { first.close(); second.close(); h.close(); }
});

test("updates cannot erase settlement, dispatch, closure, or resurrect expired output", async () => {
  const h = createHarness();
  try {
    await h.session.execute(h.request);
    const id = h.request.payment.requestId;
    const before = h.journal.read(id)!;
    h.advance(24 * 60 * 60 * 1000 + 1);
    h.journal.read(id);
    h.journal.update(id, { outcome: null, evidence: null, dispatched: false, output: before.output });
    const after = h.journal.read(id)!;
    expect(after.outcome?.paymentStatus).toBe("settled");
    expect(after.evidence).toEqual(before.evidence);
    expect(after.dispatched).toBe(true);
    expect(after.output).toBeNull();
    h.journal.admit("closed", "f", h.policy);
    h.journal.update("closed", { phase: "closed-before-payment" });
    expect(() => h.journal.update("closed", { phase: "authorized" })).toThrow("REQUEST_CLOSED_BEFORE_PAYMENT");
  } finally { h.close(); }
});

test("an older run token on the same connection cannot mutate a successor run", () => {
  const h = createHarness();
  try {
    const old = h.journal.claimRun();
    h.journal.admit("owned", "f", h.policy);
    h.advance(60_001);
    const next = h.journal.claimRun();
    expect(() => h.journal.update("owned", { phase: "signed" }, old)).toThrow("JOURNAL_UNAVAILABLE");
    h.journal.releaseRun(next);
  } finally { h.close(); }
});
