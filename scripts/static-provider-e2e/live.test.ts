import { expect, test } from "bun:test";
import { runLiveGate } from "./live.ts";

test("live runner exits before initialization when approval is missing", async () => {
  let initializations = 0;
  const result = await runLiveGate({
    approvalPath: "/tmp/does-not-exist/.local/live-approval.json",
    targetSha: "a".repeat(40),
    amountAtomic: "10",
    requestId: "live-1",
    initialize: async () => { initializations += 1; },
  });
  expect(result).toEqual({ exitCode: 2, code: "LIVE_PAYMENT_NOT_AUTHORIZED" });
  expect(initializations).toBe(0);
});

test("live runner rejects paths outside a local approval boundary before initialization", async () => {
  let initializations = 0;
  const result = await runLiveGate({
    approvalPath: "/tmp/live-approval.json",
    targetSha: "a".repeat(40),
    amountAtomic: "10",
    requestId: "live-1",
    initialize: async () => { initializations += 1; },
  });
  expect(result).toEqual({ exitCode: 2, code: "LIVE_PAYMENT_NOT_AUTHORIZED" });
  expect(initializations).toBe(0);
});
