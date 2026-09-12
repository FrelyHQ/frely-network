import { expect, test } from "bun:test";
import { join } from "node:path";
import { PayerJournal } from "./journal.ts";
import { recoverPayerRequest } from "./recovery.ts";
import { PayerSession } from "./session.ts";
import { examplePolicy, executeInput, recordingPorts, withTempDir } from "./test-support.ts";

test("recovery does not sign or fetch after an unknown dispatch", async () => {
  await withTempDir(async (directory) => {
    const ports = recordingPorts({ paidThrow: true });
    const policy = examplePolicy({ journalPath: join(directory, "journal.sqlite") });
    const session = new PayerSession(policy, ports);
    const unknown = await session.execute(executeInput());
    expect(unknown.paymentStatus).toBe("unknown");

    let fetched = 0;
    const recovered = await recoverPayerRequest({
      requestId: "req-1",
      journalPath: policy.journalPath,
      policy: { ...policy, amountAtomic: "2", maxAmountAtomic: "2" },
      verifyOriginal: async ({ transactionId, payloadDigest, requirement }) => {
        expect(unknown.transactionId).toBeDefined();
        expect(transactionId).toBe(unknown.transactionId!);
        expect(payloadDigest).toMatch(/^[a-f0-9]{64}$/);
        expect(requirement.amount).toBe("1");
        fetched += 1;
        return "settled";
      },
    });
    expect(recovered.paymentStatus).toBe("settled");
    expect(fetched).toBe(1);
    expect(ports.calls.sign).toBe(1);
    expect(ports.calls.paidFetch).toBe(1);
    expect(ports.calls.verifyOriginal).toBe(0);
  });
});

test("pre-dispatch recovery closes as not_paid without verifyOriginal", async () => {
  await withTempDir(async (directory) => {
    const policy = examplePolicy({ journalPath: join(directory, "journal.sqlite") });
    const journal = new PayerJournal(policy.journalPath);
    journal.admit("req-9", "a".repeat(64), policy);
    journal.close();
    let verified = 0;
    const recovered = await recoverPayerRequest({
      requestId: "req-9",
      journalPath: policy.journalPath,
      policy,
      verifyOriginal: async () => {
        verified += 1;
        return "settled";
      },
    });
    expect(recovered.paymentStatus).toBe("not_paid");
    expect(verified).toBe(0);
  });
});
