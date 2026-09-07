import { expect, test } from "bun:test";
import { createHarness } from "./test-support.ts";
import { openJournal } from "./journal.ts";
import { recoverPayment } from "./recovery.ts";
import type { JournalPhase } from "./types.ts";

for (const phase of ["admitted", "quote-intent", "quoted", "authorized", "signed"] as JournalPhase[]) {
  test(`recover closes orphan ${phase} without any network or signer`, async () => {
    const h = createHarness();
    try {
      h.journal.admit("orphan", "fingerprint", h.policy);
      h.journal.update("orphan", { phase, serviceStatus: phase === "quote-intent" ? "unknown" : "not_started" });
      const result = await recoverPayment({ requestId: "orphan", journal: h.journal, verify: h.ports.verify });
      expect(result.reason).toBe("REQUEST_CLOSED_BEFORE_PAYMENT");
      expect(result.paymentStatus).toBe("not_paid");
      expect(result.serviceStatus).toBe(phase === "quote-intent" ? "unknown" : "not_started");
      expect(h.journal.read("orphan")?.phaseBeforeFinish).toBe(phase);
      expect(await recoverPayment({ requestId: "orphan", journal: h.journal, verify: h.ports.verify })).toEqual(result);
      expect(h.counts).toEqual({ http: 0, sign: 0, verify: 0 });
      expect(h.journal.admit("orphan", "fingerprint", h.policy).fresh).toBe(false);
    } finally { h.close(); }
  });
}
test("active owner prevents recovery closing an orphan", async () => {
  const h = createHarness(); const second = openJournal(h.policy.journalPath);
  const token = h.journal.claimRun();
  try {
    h.journal.admit("active", "f", h.policy);
    const result = await recoverPayment({ requestId: "active", journal: second, verify: h.ports.verify });
    expect(result.reason).toBe("REQUEST_IN_PROGRESS");
    expect(second.read("active")?.phase).toBe("admitted");
    expect(h.counts.verify).toBe(0);
  } finally { h.journal.releaseRun(token); second.close(); h.close(); }
});
test("missing ID remains absent", async () => {
  const h = createHarness();
  try {
    expect((await recoverPayment({ requestId: "missing", journal: h.journal, verify: h.ports.verify })).reason).toBe("REQUEST_NOT_FOUND");
    expect(h.journal.read("missing")).toBeNull();
  } finally { h.close(); }
});
test("reopen recovers original transaction with cached output and stored public policy", async () => {
  const h = createHarness({ fault: "verify_failure" });
  try {
    await h.session.execute(h.request);
    const journal = openJournal(h.policy.journalPath);
    try {
      const result = await recoverPayment({ requestId: h.request.payment.requestId, journal, verify: async (evidence, hint, context) => {
        expect(context.policy).not.toHaveProperty("signerRef");
        expect(context.policy.network).toBe("hedera:testnet");
        expect(context.quote?.amount).toBe(evidence.amountAtomic);
        expect(hint).toBe(evidence.transactionId);
        return { verified: true, evidence };
      } });
      expect(result.paymentStatus).toBe("settled"); expect(result.output).not.toBeNull();
      expect(h.counts.http).toBe(2); expect(h.counts.sign).toBe(1);
    } finally { journal.close(); }
  } finally { h.close(); }
});
test("conflict survives recovery and bounded query exhaustion", async () => {
  const h = createHarness({ fault: "wrong_receipt" });
  try {
    await h.session.execute(h.request);
    const result = await recoverPayment({ requestId: h.request.payment.requestId, journal: h.journal, verify: h.ports.verify, wait: async () => {} });
    expect(result.paymentStatus).toBe("unknown");
    expect(h.journal.read(h.request.payment.requestId)?.responseConflict).toBe(true);
    expect(h.counts.verify).toBeLessThanOrEqual(4);
  } finally { h.close(); }
});
test("settled cache expires without another verification or TTL renewal", async () => {
  const h = createHarness();
  try {
    await h.session.execute(h.request);
    const expiry = h.journal.read(h.request.payment.requestId)!.outputExpiresAt;
    h.advance(24 * 60 * 60 * 1000 + 1);
    const result = await recoverPayment({ requestId: h.request.payment.requestId, journal: h.journal, verify: h.ports.verify });
    expect(result.paymentStatus).toBe("settled"); expect(result.serviceStatus).toBe("succeeded");
    expect(result.reason).toBe("OUTPUT_UNAVAILABLE"); expect(result.output).toBeNull();
    expect(h.counts.verify).toBe(1);
    expect(h.journal.read(h.request.payment.requestId)!.outputExpiresAt).toBe(expiry);
  } finally { h.close(); }
});

for (const stage of ["dispatch", "capture"]) {
  test(`child process crashes after ${stage}; new process connection queries only original transaction`, async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "frely-crash-"));
    const path = join(dir, "journal.sqlite");
    try {
      const worker = Bun.spawn([process.execPath, new URL("./fixtures/journal-worker.ts", import.meta.url).pathname, path, stage + "-crash", "crashed", "unused"], { stdout: "pipe", stderr: "pipe" });
      expect(await worker.exited).toBe(0);
      const journal = openJournal(path, () => Date.now() + 61_000);
      try {
        expect(journal.read("crashed")?.phase).toBe(stage === "dispatch" ? "dispatch-intent" : "captured");
        let calls = 0;
        const result = await recoverPayment({ requestId: "crashed", journal, verify: async evidence => { calls++; expect(evidence.transactionId).toBe("synthetic-tx"); return { verified: true, evidence }; } });
        expect(calls).toBe(1); expect(result.paymentStatus).toBe("settled");
        expect(result.serviceStatus).toBe(stage === "dispatch" ? "unknown" : "succeeded");
        expect(result.output === null).toBe(stage === "dispatch");
      } finally { journal.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
for (const sameId of [true, false]) {
  test(`two child workers competing ${sameId ? "same" : "different"} IDs dispatch at most once`, async () => {
    const { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "frely-race-")); const path = join(dir, "journal.sqlite"); const gate = join(dir, "gate");
    const init = openJournal(path); init.close();
    const children = ["one", sameId ? "one" : "two"].map(id => Bun.spawn([process.execPath, new URL("./fixtures/journal-worker.ts", import.meta.url).pathname, path, "compete", id, gate], { stdout: "pipe", stderr: "pipe" }));
    try {
      const deadline = Date.now() + 3_000;
      while (readdirSync(dir).filter(name => name.endsWith(".ready")).length !== 2 && Date.now() < deadline) await Bun.sleep(10);
      for (const child of children) if (child.exitCode !== null && child.exitCode !== 0) throw new Error(await new Response(child.stderr).text());
      expect(readdirSync(dir).filter(name => name.endsWith(".ready"))).toHaveLength(2);
      writeFileSync(gate, "start");
      expect(await Promise.all(children.map(child => child.exited))).toEqual([0, 0]);
      const results = await Promise.all(children.map(async child => JSON.parse(await new Response(child.stdout).text())));
      expect(results.filter(r => r.paymentStatus === "settled")).toHaveLength(1);
      expect(results.filter(r => r.reason === "REQUEST_IN_PROGRESS")).toHaveLength(1);
      expect(readFileSync(gate + ".paid", "utf8").trim().split("\n")).toHaveLength(1);
    } finally { children.forEach(child => child.kill()); rmSync(dir, { recursive: true, force: true }); }
  });
}
test("unknown dispatch blocks new ID until recovered and unavailable verification stops at three attempts", async () => {
  const h = createHarness({ fault: "verify_failure" });
  try {
    await h.session.execute(h.request);
    const next = structuredClone(h.request); next.payment.requestId += "-new";
    expect((await h.session.execute(next)).reason).toBe("RECOVERY_REQUIRED");
    expect(h.counts.http).toBe(2);
    let attempts = 0; const waits: number[] = [];
    const result = await recoverPayment({ requestId: h.request.payment.requestId, journal: h.journal, verify: async () => { attempts++; return { verified: false, reason: "not_found" }; }, wait: async ms => { waits.push(ms); } });
    expect(result.paymentStatus).toBe("unknown"); expect(attempts).toBe(3); expect(waits).toEqual([2000, 2000]);
    expect(h.counts.sign).toBe(1);
  } finally { h.close(); }
});

test("lost storage while persisting recovery retains original dispatched evidence", async () => {
  const h = createHarness({ fault: "verify_failure" });
  try {
    await h.session.execute(h.request);
    const id = h.request.payment.requestId;
    h.journal.update = () => { throw new Error("disk full"); };
    const result = await recoverPayment({ requestId: id, journal: h.journal, verify: async evidence => ({ verified: true, evidence }) });
    expect(result.reason).toBe("JOURNAL_UNAVAILABLE");
    expect(result.paymentStatus).toBe("unknown");
    expect(result.evidence?.transactionId).toBe("synthetic-tx");
    expect(result.output).not.toBeNull();
  } finally { h.close(); }
});
test("free Capture remains deliverable on recovery without settlement query", async () => {
  const h = createHarness();
  h.ports.fetcher = async () => new Response(JSON.stringify({ output_text: "free" }));
  try {
    await h.session.execute(h.request);
    const result = await recoverPayment({ requestId: h.request.payment.requestId, journal: h.journal, verify: h.ports.verify });
    expect(result.decision).toBe("completed"); expect(result.paymentStatus).toBe("not_paid");
    expect(result.output).toEqual({ output_text: "free" }); expect(h.counts.verify).toBe(0);
  } finally { h.close(); }
});

test("a new persisted conflict after settlement preserves payment evidence but escalates", async () => {
  const h = createHarness();
  try {
    await h.session.execute(h.request);
    h.journal.update(h.request.payment.requestId, { responseConflict: true });
    const result = await recoverPayment({ requestId: h.request.payment.requestId, journal: h.journal, verify: h.ports.verify });
    expect(result.paymentStatus).toBe("settled");
    expect(result.decision).toBe("paused"); expect(result.reason).toBe("SETTLEMENT_CONFLICT");
    expect(h.counts.verify).toBe(1);
  } finally { h.close(); }
});
