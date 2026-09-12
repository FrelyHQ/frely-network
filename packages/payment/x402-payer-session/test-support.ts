import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaymentRequirement } from "@frely-network/hedera-x402";
import type { PayerExecuteInput, PayerPolicy, PayerSessionPorts, SignedPayment } from "./types.ts";

export function encodeHeader(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function examplePolicy(overrides: Partial<PayerPolicy> = {}): PayerPolicy {
  return {
    network: "hedera:testnet",
    asset: "0.0.0",
    amountAtomic: "1",
    maxAmountAtomic: "1",
    payerAccountId: "0.0.2001",
    payTo: "0.0.1001",
    feePayer: "0.0.1002",
    facilitatorUrl: "https://facilitator.example.com",
    resourceUrl: "http://127.0.0.1:18765/v1/responses",
    walletDirectory: "/tmp/frely-payer-session-wallet",
    journalPath: "/tmp/frely-payer-session-journal.sqlite",
    maxTimeoutSeconds: 60,
    ...overrides,
  };
}

export function exampleRequirement(
  overrides: Partial<PaymentRequirement> & {
    feePayer?: string;
    resource?: string;
  } = {},
): PaymentRequirement {
  const defined = Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined),
  ) as Partial<PaymentRequirement> & { feePayer?: string; resource?: string };
  const { feePayer, resource, ...rest } = defined;
  return {
    scheme: "exact",
    network: "hedera:testnet",
    amount: "1",
    asset: "0.0.0",
    payTo: "0.0.1001",
    maxTimeoutSeconds: 60,
    extra: { feePayer: feePayer ?? "0.0.1002" },
    resource: resource ?? "http://127.0.0.1:18765/v1/responses",
    ...rest,
  };
}

export function paymentRequiredHeader(
  overrides: {
    amount?: string;
    payTo?: string;
    network?: string;
    asset?: string;
    feePayer?: string;
    resource?: string;
    maxTimeoutSeconds?: number;
    accepts?: Array<Partial<PaymentRequirement> & { amount?: string; payTo?: string }>;
  } = {},
): string {
  const accepts = overrides.accepts
    ? overrides.accepts.map((item) =>
        exampleRequirement({
          amount: item.amount,
          payTo: item.payTo,
          ...item,
        }),
      )
    : [
        exampleRequirement({
          amount: overrides.amount,
          payTo: overrides.payTo,
          network: overrides.network,
          asset: overrides.asset,
          feePayer: overrides.feePayer,
          resource: overrides.resource,
          maxTimeoutSeconds: overrides.maxTimeoutSeconds,
        }),
      ];
  return encodeHeader({
    x402Version: 2,
    accepts,
    resource: { url: "http://127.0.0.1:18765/v1/responses" },
  });
}

export function executeInput(overrides: Partial<PayerExecuteInput> = {}): PayerExecuteInput {
  return {
    requestId: "req-1",
    providerId: "example-vision",
    method: "POST",
    resourceUrl: "http://127.0.0.1:18765/v1/responses",
    body: new TextEncoder().encode('{"task":"describe"}'),
    maxAmountAtomic: "1",
    ...overrides,
  };
}

export async function withTempDir(
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "payer-session-")));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function recordingPorts(options: {
  amount?: string;
  paidStatus?: number;
  paidSettlement?: unknown;
  paidBody?: unknown;
  paidThrow?: boolean;
  verify?: "settled" | "pending" | "failed";
} = {}): PayerSessionPorts & {
  calls: { sign: number; paidFetch: number; fetch: number; verifyOriginal: number };
  relayHeaders: Headers[];
} {
  const calls = { sign: 0, paidFetch: 0, fetch: 0, verifyOriginal: 0 };
  const relayHeaders: Headers[] = [];
  const signed: SignedPayment = {
    paymentHeader: encodeHeader({
      x402Version: 2,
      accepted: exampleRequirement({ amount: options.amount ?? "1" }),
      payload: { transaction: "c2lnbmVk" },
    }),
    transactionId: "0.0.2001@1.000000001",
    payloadDigest: "a".repeat(64),
  };
  return {
    calls,
    relayHeaders,
    async fetch(request) {
      calls.fetch += 1;
      if (request.headers.get("PAYMENT-SIGNATURE")) {
        calls.paidFetch += 1;
        relayHeaders.push(new Headers(request.headers));
        if (options.paidThrow) throw new Error("NETWORK_TIMEOUT");
        const settlement = options.paidSettlement === undefined
          ? {
              success: true,
              network: "hedera:testnet",
              transaction: signed.transactionId,
            }
          : options.paidSettlement;
        const headers = new Headers({ "content-type": "application/json" });
        if (settlement !== null) {
          headers.set("PAYMENT-RESPONSE", encodeHeader(settlement));
        }
        return new Response(JSON.stringify(options.paidBody ?? { ok: true }), {
          status: options.paidStatus ?? 200,
          headers,
        });
      }
      return new Response(null, {
        status: 402,
        headers: {
          "PAYMENT-REQUIRED": paymentRequiredHeader({ amount: options.amount ?? "1" }),
        },
      });
    },
    async sign() {
      calls.sign += 1;
      return signed;
    },
    async verifyOriginal() {
      calls.verifyOriginal += 1;
      return options.verify ?? "settled";
    },
  };
}
