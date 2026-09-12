import { expect, test } from "bun:test";
import { join } from "node:path";
import { PayerSession } from "./session.ts";
import {
  examplePolicy,
  executeInput,
  recordingPorts,
  withTempDir,
} from "./test-support.ts";

test("never signs when the quote exceeds the request budget", async () => {
  await withTempDir(async (directory) => {
    const ports = recordingPorts({ amount: "2" });
    const session = new PayerSession(
      examplePolicy({
        amountAtomic: "2",
        maxAmountAtomic: "2",
        journalPath: join(directory, "journal.sqlite"),
      }),
      ports,
    );
    await expect(session.execute(executeInput({ maxAmountAtomic: "1" }))).rejects.toThrow(
      "PAYMENT_LIMIT_EXCEEDED",
    );
    expect(ports.calls.sign).toBe(0);
    expect(ports.calls.paidFetch).toBe(0);
  });
});

test("returns the cached success without signing or paying again", async () => {
  await withTempDir(async (directory) => {
    const ports = recordingPorts();
    const session = new PayerSession(
      examplePolicy({ journalPath: join(directory, "journal.sqlite") }),
      ports,
    );
    const first = await session.execute(executeInput());
    expect(first.paymentStatus).toBe("settled");
    expect(first.serviceStatus).toBe("succeeded");
    expect(first.output).toEqual({ ok: true });
    const second = await session.execute(executeInput());
    expect(second).toEqual(first);
    expect(ports.calls.sign).toBe(1);
    expect(ports.calls.paidFetch).toBe(1);
  });
});

test("rejects a reused request id with a different body", async () => {
  await withTempDir(async (directory) => {
    const ports = recordingPorts();
    const session = new PayerSession(
      examplePolicy({ journalPath: join(directory, "journal.sqlite") }),
      ports,
    );
    await session.execute(executeInput());
    await expect(
      session.execute(executeInput({ body: new TextEncoder().encode('{"task":"other"}') })),
    ).rejects.toThrow("REQUEST_ID_CONFLICT");
    expect(ports.calls.sign).toBe(1);
    expect(ports.calls.paidFetch).toBe(1);
  });
});

test("paid fetch timeout becomes unknown and does not settle", async () => {
  await withTempDir(async (directory) => {
    const ports = recordingPorts({ paidThrow: true });
    const session = new PayerSession(
      examplePolicy({ journalPath: join(directory, "journal.sqlite") }),
      ports,
    );
    const result = await session.execute(executeInput());
    expect(result.paymentStatus).toBe("unknown");
    expect(result.retryAction).toBe("query_original");
    expect(result.transactionId).toBeTruthy();
  });
});

test("keeps settlement when Relay returns 5xx", async () => {
  await withTempDir(async (directory) => {
    const ports = recordingPorts({ paidStatus: 502, paidBody: { error: "upstream" } });
    const session = new PayerSession(
      examplePolicy({ journalPath: join(directory, "journal.sqlite") }),
      ports,
    );
    const result = await session.execute(executeInput());
    expect(result.paymentStatus).toBe("settled");
    expect(result.serviceStatus).toBe("failed");
    expect(result.retryAction).toBe("none");
  });
});

test("success without a trusted settlement stays unknown", async () => {
  await withTempDir(async (directory) => {
    const ports = recordingPorts({ paidSettlement: null });
    const session = new PayerSession(
      examplePolicy({ journalPath: join(directory, "journal.sqlite") }),
      ports,
    );
    const result = await session.execute(executeInput());
    expect(result.paymentStatus).toBe("unknown");
    expect(result.serviceStatus).toBe("unknown");
    expect(result.retryAction).toBe("query_original");
  });
});
