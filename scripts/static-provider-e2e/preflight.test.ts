import { expect, test } from "bun:test";
import { runSyntheticPreflight } from "./preflight.ts";

test("real-process synthetic preflight proves ordering, isolation and idempotency without external payment", async () => {
  const result = await runSyntheticPreflight();
  expect(result.mode).toBe("synthetic");
  expect(result.targetSha).toMatch(/^[0-9a-f]{40}$/);
  expect(result.order).toEqual(["challenge", "sign", "settle", "relay"]);
  expect(result.identity).toEqual({ source: "static_allowlist", verified: false });
  expect(result.first).toMatchObject({ payment: "settled", service: "succeeded", output: "synthetic vision result" });
  expect(result.repeat).toEqual({ cached: true, signDelta: 0, settleDelta: 0, relayDelta: 0 });
  expect(result.conflict).toEqual({ code: "REQUEST_ID_CONFLICT", signDelta: 0, settleDelta: 0, relayDelta: 0 });
  expect(result.relayFailure).toEqual({ payment: "settled", service: "failed", retryAction: "none" });
  expect(result.unknown).toEqual({ payment: "unknown", service: "unknown", retryAction: "query_original" });
  expect(result.unknownRepeat).toEqual({ signDelta: 0, settleDelta: 0, relayDelta: 0 });
  expect(result.recovery).toEqual({ verifyOriginal: 1, signDelta: 0, relayDelta: 0 });
  expect(result.relayPaymentHeaders).toEqual([]);
  expect(result.counters).toMatchObject({ challenges: 3, proofs: 3, verifies: 3, settlements: 3, relay: 3, externalPayment: 0 });
});
