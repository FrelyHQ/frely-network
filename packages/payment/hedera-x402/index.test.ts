import { describe, expect, test } from "bun:test";

import {
  createFixtureHederaX402AdmissionVerifier,
  HederaX402PaymentRejectedError,
} from "./index.ts";

const NOW = "2026-09-09T03:00:00.000Z";
const REQUEST = {
  resource: "https://api.frely.cloud/a2a/tasks",
  method: "POST" as const,
  requestHash: "a".repeat(64),
};

describe("Hedera x402 admission boundary", () => {
  test("returns an opaque challenge and allowlisted scalar admission facts", async () => {
    const verifier = createFixtureHederaX402AdmissionVerifier({ now: () => NOW, expectedProof: "proof-a" });
    const challenge = await verifier.requirements(REQUEST);
    const admission = await verifier.verify({
      ...REQUEST,
      requestId: "req_a2a_1",
      idempotencyKeyHash: "b".repeat(64),
      proof: "proof-a",
    });

    expect(challenge).toMatchObject({ scheme: "exact", network: "hedera:testnet", paymentRequired: "fixture:x402:hedera-testnet:exact:v1" });
    expect(admission).toMatchObject({ payerReference: "fixture:payer", asset: "HBAR", authorizedAmount: "1", replayStatus: "fresh" });
    expect(admission.paymentReference).toMatch(/^fixture:payment:[a-f0-9]{24}$/u);
    expect(admission).not.toHaveProperty("proof");
  });

  test("marks same-correlation proof retries as replayed and rejects cross-task reuse", async () => {
    const verifier = createFixtureHederaX402AdmissionVerifier({ now: () => NOW, expectedProof: "proof-a" });
    const input = { ...REQUEST, requestId: "req_a2a_1", idempotencyKeyHash: "b".repeat(64), proof: "proof-a" };
    await expect(verifier.verify(input)).resolves.toMatchObject({ replayStatus: "fresh" });
    await expect(verifier.verify(input)).resolves.toMatchObject({ replayStatus: "replayed" });
    await expect(verifier.verify({ ...input, requestId: "req_a2a_2", idempotencyKeyHash: "c".repeat(64) })).rejects.toMatchObject({
      name: "HederaX402PaymentRejectedError",
      code: "payment_replayed",
      status: 402,
    });
  });

  test("fails invalid proof without retaining it in the rejection", async () => {
    const verifier = createFixtureHederaX402AdmissionVerifier({ now: () => NOW, expectedProof: "proof-a" });
    const error = await verifier.verify({ ...REQUEST, requestId: "req_a2a_1", idempotencyKeyHash: "b".repeat(64), proof: "wallet-signature-secret" }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(HederaX402PaymentRejectedError);
    expect(error).toMatchObject({ code: "payment_invalid", status: 402 });
    expect(String(error)).not.toContain("wallet-signature-secret");
  });

  test("rejects secret-shaped references from the verifier", async () => {
    const verifier = createFixtureHederaX402AdmissionVerifier({
      now: () => NOW,
      expectedProof: "proof-a",
      payerReference: "sk_live_not-a-payment-reference",
    });
    await expect(verifier.verify({ ...REQUEST, requestId: "req_a2a_1", idempotencyKeyHash: "b".repeat(64), proof: "proof-a" })).rejects.toThrow("A2A_PAYMENT_ADMISSION_REFERENCE_INVALID");
  });
});
