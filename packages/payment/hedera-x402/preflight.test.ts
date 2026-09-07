import { describe, expect, test } from "bun:test";
import {
  decodePaymentRequiredHeader,
  encodePaymentRequiredHeader,
} from "@x402/core/http";
import valid from "../../../scripts/payment-spike/fixtures/synthetic/valid.json";
import policy from "../../../scripts/payment-spike/fixtures/synthetic/policy.json";
import archive from "../../../scripts/payment-spike/fixtures/spec-derived/archive-mainnet-180.json";
import archivePolicy from "../../../scripts/payment-spike/fixtures/spec-derived/policy.json";
import { preflight } from "./preflight.ts";

function fixture(): InternalFixture {
  return {
    http: {
      status: valid.capture.status,
      paymentRequiredHeader: valid.capture.paymentRequiredHeader,
    },
    policy: structuredClone(policy),
    payment: structuredClone(valid.request.payment),
  };
}

type InternalFixture = {
  http: { status: number; paymentRequiredHeader: string };
  policy: typeof policy;
  payment: typeof valid.request.payment & {
    budget?: { network: string; asset: string; maxAmountAtomic: string };
    acceptIndex?: number;
  };
};
type Fixture = InternalFixture;

function mutateQuote(
  change: (required: ReturnType<typeof decodePaymentRequiredHeader>) => void,
): Fixture {
  const input = fixture() as Fixture;
  const required = decodePaymentRequiredHeader(input.http.paymentRequiredHeader);
  change(required);
  input.http.paymentRequiredHeader = encodePaymentRequiredHeader(required);
  return input;
}

describe("Hedera x402 offline preflight", () => {
  test("denies amount 1000 against budget 999", () => {
    const input = fixture();
    input.payment.budget.maxAmountAtomic = "999";
    expect(preflight(input).reason).toBe("NO_ACCEPTABLE_QUOTE");
  });

  test("does not treat a missing budget as unlimited", () => {
    const input = fixture();
    Reflect.deleteProperty(input.payment, "budget");
    expect(preflight(input)).toMatchObject({
      decision: "blocked",
      paymentStatus: "not_paid",
      reason: "BUDGET_INVALID",
    });
  });

  test("prepares the one valid quote without paying", () => {
    expect(preflight(fixture())).toMatchObject({
      decision: "prepared",
      paymentStatus: "not_paid",
      reason: "DRY_RUN_ONLY",
      selection: { acceptIndex: 0 },
    });
  });

  test("rejects malformed encoding and a schema-valid v1 envelope", () => {
    const malformed = fixture() as Fixture;
    malformed.http.paymentRequiredHeader = "not base64";
    expect(preflight(malformed).reason).toBe("CAPTURE_INVALID");

    const v1 = fixture() as Fixture;
    v1.http.paymentRequiredHeader = Buffer.from(JSON.stringify({
      x402Version: 1,
      accepts: [
        {
          scheme: "exact",
          network: "hedera:testnet",
          maxAmountRequired: "1000",
          resource: "https://fixture.invalid/v1/responses",
          description: "legacy fixture",
          payTo: "0.0.1234",
          maxTimeoutSeconds: 120,
          asset: "0.0.0",
          extra: { feePayer: "0.0.1235" },
        },
      ],
    })).toString("base64");
    expect(preflight(v1).reason).toBe("CAPTURE_INVALID");
  });

  test("requires canonical string budgets, including zero as a valid cap", () => {
    for (const value of [1000, -1, "-1", "1.0", "1e3", "01", ""]) {
      const input = fixture() as Fixture;
      input.payment.budget.maxAmountAtomic = value as string;
      expect(preflight(input).reason).toBe("BUDGET_INVALID");
    }
    const zero = fixture() as Fixture;
    zero.payment.budget.maxAmountAtomic = "0";
    expect(preflight(zero).reason).toBe("NO_ACCEPTABLE_QUOTE");
  });

  test("enforces canonical positive signed-64-bit quote amounts", () => {
    for (const value of ["0", "01", "1.0", "1e3", "9223372036854775808"]) {
      expect(preflight(mutateQuote((r) => (r.accepts[0]!.amount = value))).reason).toBe(
        "NO_ACCEPTABLE_QUOTE",
      );
    }
    const upper = mutateQuote(
      (r) => (r.accepts[0]!.amount = "9223372036854775807"),
    );
    upper.payment.budget.maxAmountAtomic = "9223372036854775807";
    expect(preflight(upper).decision).toBe("prepared");
  });

  test("binds budget scope before comparing the amount", () => {
    for (const field of ["network", "asset"] as const) {
      const input = fixture() as Fixture;
      input.payment.budget[field] = "other";
      expect(preflight(input).reason).toBe("BUDGET_SCOPE_MISMATCH");
    }
  });

  test("binds quote receiver, fee payer, resource, and timeout to policy", () => {
    const changes = [
      (r: ReturnType<typeof decodePaymentRequiredHeader>) =>
        (r.accepts[0]!.payTo = "0.0.9999"),
      (r: ReturnType<typeof decodePaymentRequiredHeader>) =>
        (r.accepts[0]!.extra = { feePayer: "0.0.9999" }),
      (r: ReturnType<typeof decodePaymentRequiredHeader>) =>
        (r.resource.url = "https://other.invalid/v1/responses"),
      (r: ReturnType<typeof decodePaymentRequiredHeader>) =>
        (r.accepts[0]!.maxTimeoutSeconds = 121),
    ];
    for (const change of changes) {
      expect(preflight(mutateQuote(change)).reason).toBe("NO_ACCEPTABLE_QUOTE");
    }
    expect(preflight(mutateQuote((r) => (r.accepts[0]!.maxTimeoutSeconds = 120))).decision).toBe(
      "prepared",
    );
  });

  test("rejects quote profile and asset mismatches", () => {
    expect(
      preflight({
        http: {
          status: archive.capture.status,
          paymentRequiredHeader: archive.capture.paymentRequiredHeader,
        },
        policy: archivePolicy,
        payment: archive.request.payment,
      }),
    ).toMatchObject({ reason: "NO_ACCEPTABLE_QUOTE" });
    expect(preflight(mutateQuote((r) => (r.accepts[0]!.scheme = "other"))).reason).toBe(
      "NO_ACCEPTABLE_QUOTE",
    );
    expect(preflight(mutateQuote((r) => (r.accepts[0]!.asset = "0.0.999"))).reason).toBe(
      "NO_ACCEPTABLE_QUOTE",
    );
  });

  test("requires trusted configuration without reading signer material", () => {
    const cases: Array<[keyof Fixture["policy"], unknown]> = [
      ["enabled", false],
      ["network", "hedera:mainnet"],
      ["assetDecimals", 6],
      ["payerAccountId", "payer"],
      ["facilitatorUrl", "http://facilitator.invalid"],
      ["mirrorNodeUrl", "https://user@mirror.invalid"],
      ["signerRef", "literal-private-key"],
      ["keyType", "unknown"],
    ];
    for (const [key, value] of cases) {
      const input = fixture() as Fixture;
      (input.policy as Record<string, unknown>)[key] = value;
      expect(preflight(input).reason).toBe("CONFIG_INCOMPLETE");
    }
  });

  test("requires a canonical persistent request ID", () => {
    for (const requestId of [123, "", "contains spaces", "a".repeat(129)]) {
      const input = fixture() as Fixture;
      input.payment.requestId = requestId as string;
      expect(preflight(input).reason).toBe("INPUT_INVALID");
    }
  });

  test("selects one valid quote while ignoring an unsupported offer", () => {
    const input = mutateQuote((required) => {
      required.accepts.unshift({
        ...required.accepts[0]!,
        network: "eip155:1",
      });
    });
    expect(preflight(input)).toMatchObject({
      decision: "prepared",
      selection: { acceptIndex: 1 },
    });
  });

  test("blocks ambiguous valid quotes and the unsupported selector", () => {
    const ambiguous = mutateQuote((required) => {
      required.accepts.push(structuredClone(required.accepts[0]!));
    });
    expect(preflight(ambiguous).reason).toBe("QUOTE_AMBIGUOUS");

    const selected = fixture() as Fixture & { payment: { acceptIndex?: number } };
    selected.payment.acceptIndex = 0;
    expect(preflight(selected).reason).toBe("INPUT_UNSUPPORTED");
  });
});
