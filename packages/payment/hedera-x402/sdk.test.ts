import { expect, test } from "bun:test";
import {
  decodePaymentRequiredHeader,
  encodePaymentRequiredHeader,
} from "@x402/core/http";
import { PaymentRequiredSchema } from "@x402/core/schemas";
import { ExactHederaScheme } from "@x402/hedera/exact/client";

test("pinned SDK loads and roundtrips a v2 envelope", () => {
  const required = {
    x402Version: 2 as const,
    resource: { url: "https://fixture.invalid/v1/responses" },
    accepts: [
      {
        scheme: "exact",
        network: "hedera:testnet" as const,
        asset: "0.0.0",
        amount: "1000",
        payTo: "0.0.1234",
        maxTimeoutSeconds: 120,
        extra: { feePayer: "0.0.1235" },
      },
    ],
  };

  expect(typeof ExactHederaScheme).toBe("function");
  const decoded = decodePaymentRequiredHeader(encodePaymentRequiredHeader(required));
  expect(decoded).toEqual(required);
  expect(PaymentRequiredSchema.parse(decoded)).toEqual(required);
});
