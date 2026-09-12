import { expect, test } from "bun:test";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { PayerJournal } from "./journal.ts";
import { examplePolicy, exampleRequirement, withTempDir } from "./test-support.ts";

test("admits a request once and rejects a fingerprint conflict", async () => {
  await withTempDir(async (directory) => {
    const journal = new PayerJournal(join(directory, "journal.sqlite"));
    try {
      const first = journal.admit("req-1", "a".repeat(64), examplePolicy());
      expect(first.fresh).toBe(true);
      expect(first.record.phase).toBe("new");
      const again = journal.admit("req-1", "a".repeat(64), examplePolicy());
      expect(again.fresh).toBe(false);
      expect(() => journal.admit("req-1", "b".repeat(64), examplePolicy())).toThrow(
        "REQUEST_ID_CONFLICT",
      );
    } finally {
      journal.close();
    }
  });
});

test("survives reopen and keeps paid dispatch evidence", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "journal.sqlite");
    const policy = examplePolicy();
    const journal = new PayerJournal(path);
    journal.admit("req-2", "c".repeat(64), policy);
    journal.beforePaidDispatch("req-2", "c".repeat(64), exampleRequirement(), {
      paymentHeader: "header",
      transactionId: "0.0.1@1.1",
      payloadDigest: "d".repeat(64),
    });
    journal.close();

    const reopened = new PayerJournal(path);
    try {
      const record = reopened.read("req-2");
      expect(record?.phase).toBe("paid_dispatch_started");
      expect(record?.transactionId).toBe("0.0.1@1.1");
      expect(record?.payloadDigest).toBe("d".repeat(64));
      expect(JSON.parse(record?.quoteJson ?? "null")).toEqual(exampleRequirement());
      expect(JSON.stringify(record)).not.toContain("header");
    } finally {
      reopened.close();
    }
  });
});

test("refuses to move a phase backwards", async () => {
  await withTempDir(async (directory) => {
    const journal = new PayerJournal(join(directory, "journal.sqlite"));
    try {
      journal.admit("req-3", "e".repeat(64), examplePolicy());
      journal.update("req-3", "e".repeat(64), { phase: "challenged" });
      expect(() =>
        journal.update("req-3", "e".repeat(64), { phase: "new" }),
      ).toThrow("JOURNAL_UNAVAILABLE");
    } finally {
      journal.close();
    }
  });
});

test("creates a 0700 directory and 0600 journal files", async () => {
  await withTempDir(async (directory) => {
    const dir = join(directory, "j");
    const path = join(dir, "journal.sqlite");
    const journal = new PayerJournal(path);
    journal.admit("req-4", "f".repeat(64), examplePolicy());
    journal.close();
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});

test("does not persist private keys, payment headers, or API keys", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "journal.sqlite");
    const journal = new PayerJournal(path);
    journal.admit("req-5", "a".repeat(64), examplePolicy());
    journal.beforePaidDispatch("req-5", "a".repeat(64), exampleRequirement(), {
      paymentHeader: "PAYMENT-SECRET-HEADER",
      transactionId: "0.0.1@1.1",
      payloadDigest: "ab".repeat(32),
    });
    journal.close();
    const bytes = await Bun.file(path).text();
    expect(bytes).not.toContain("PAYMENT-SECRET-HEADER");
    expect(bytes).not.toContain("private");
    expect(bytes).not.toContain("Bearer");
  });
});

test("fails closed when the journal path is invalid", () => {
  expect(() => new PayerJournal("bad\0path")).toThrow("JOURNAL_UNAVAILABLE");
});

test("refuses an existing broad parent directory without changing its permissions", async () => {
  await withTempDir(async (directory) => {
    const shared = join(directory, "shared");
    await mkdir(shared, { mode: 0o755 });
    expect(() => new PayerJournal(join(shared, "journal.sqlite"))).toThrow("JOURNAL_UNAVAILABLE");
    expect((await stat(shared)).mode & 0o777).toBe(0o755);
  });
});
