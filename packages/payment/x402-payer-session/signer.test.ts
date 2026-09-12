import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { PrivateKey, Transaction } from "@x402/hedera";
import { signPayerQuote } from "./signer.ts";
import { examplePolicy, exampleRequirement } from "./test-support.ts";

const bodySha256 = createHash("sha256").update('{"task":"describe"}').digest("hex");

test("signs a matching v2 quote locally and binds the body hash", async () => {
  const key = PrivateKey.generateECDSA();
  const policy = examplePolicy({ payerAccountId: "0.0.2001" });
  const fetchWas = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("NETWORK_FORBIDDEN");
  }) as unknown as typeof fetch;
  try {
    const signed = await signPayerQuote({
      policy,
      requirement: exampleRequirement(),
      resourceUrl: policy.resourceUrl,
      bodySha256,
      privateKey: key.toStringRaw(),
    });
    expect(signed.transactionId.length).toBeGreaterThan(0);
    expect(signed.payloadDigest).toMatch(/^[a-f0-9]{64}$/);
    const payload = JSON.parse(Buffer.from(signed.paymentHeader, "base64").toString("utf8"));
    expect(payload.payload.extensions.bodySha256).toBe(bodySha256);
    expect(
      key.publicKey.verifyTransaction(
        Transaction.fromBytes(Buffer.from(payload.payload.transaction, "base64")),
      ),
    ).toBe(true);
    expect(JSON.stringify({ transactionId: signed.transactionId, payloadDigest: signed.payloadDigest })).not.toContain(
      key.toStringRaw(),
    );
  } finally {
    globalThis.fetch = fetchWas;
  }
});

test("rejects a tampered body hash, payer=payTo, and a bad key before emitting a header", async () => {
  const key = PrivateKey.generateECDSA();
  await expect(
    signPayerQuote({
      policy: examplePolicy(),
      requirement: exampleRequirement(),
      resourceUrl: examplePolicy().resourceUrl,
      bodySha256: "ABCDEF",
      privateKey: key.toStringRaw(),
    }),
  ).rejects.toThrow("INVALID_REQUEST");

  await expect(
    signPayerQuote({
      policy: examplePolicy({ payerAccountId: "0.0.1001", payTo: "0.0.1001" }),
      requirement: exampleRequirement({ payTo: "0.0.1001" }),
      resourceUrl: examplePolicy().resourceUrl,
      bodySha256,
      privateKey: key.toStringRaw(),
    }),
  ).rejects.toThrow("PAYMENT_REJECTED");

  await expect(
    signPayerQuote({
      policy: examplePolicy(),
      requirement: exampleRequirement(),
      resourceUrl: examplePolicy().resourceUrl,
      bodySha256,
      privateKey: "not-a-key",
    }),
  ).rejects.toThrow("SIGNER_UNAVAILABLE");
});
