import { createHash } from "node:crypto";
import {
  createClientHederaSigner,
  inspectHederaTransaction,
  PrivateKey,
  Transaction,
  TransferTransaction,
} from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import type { PaymentRequirement } from "@frely-network/hedera-x402";
import { parsePositiveAtomicAmount } from "./policy.ts";
import type { PayerPolicy, SignedPayment } from "./types.ts";

const MAX_HEADER_BYTES = 128 * 1024;
const BODY_SHA = /^[0-9a-f]{64}$/;

function encodeBase64Json(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (bytes.byteLength > MAX_HEADER_BYTES) throw new Error("PAYMENT_REJECTED");
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export async function signPayerQuote(input: {
  policy: PayerPolicy;
  requirement: PaymentRequirement;
  resourceUrl: string;
  bodySha256: string;
  privateKey: string;
}): Promise<SignedPayment> {
  const { policy, requirement } = input;
  if (!BODY_SHA.test(input.bodySha256)) throw new Error("INVALID_REQUEST");
  if (policy.payerAccountId === policy.payTo) throw new Error("PAYMENT_REJECTED");
  const amount = parsePositiveAtomicAmount(
    String(requirement.amount ?? requirement.maxAmountRequired ?? ""),
    "PAYMENT_REJECTED",
  );
  const extra = asObject(requirement.extra);
  if (
    policy.network !== "hedera:testnet" ||
    requirement.network !== policy.network ||
    requirement.scheme !== "exact" ||
    requirement.asset !== policy.asset ||
    requirement.payTo !== policy.payTo ||
    extra?.feePayer !== policy.feePayer ||
    input.resourceUrl !== policy.resourceUrl
  ) {
    throw new Error("PAYMENT_REJECTED");
  }

  let key: PrivateKey;
  try {
    key = PrivateKey.fromStringECDSA(input.privateKey);
  } catch {
    throw new Error("SIGNER_UNAVAILABLE");
  }

  const scheme = new ExactHederaScheme(
    createClientHederaSigner(policy.payerAccountId, key, { network: policy.network }),
  );
  const signed = await scheme.createPaymentPayload(
    2,
    requirement as Parameters<ExactHederaScheme["createPaymentPayload"]>[1],
  );
  const transaction = asObject(signed.payload)?.transaction;
  if (typeof transaction !== "string") throw new Error("PAYMENT_REJECTED");

  const bytes = Buffer.from(transaction, "base64");
  const decoded = Transaction.fromBytes(bytes);
  const inspected = inspectHederaTransaction(transaction);
  const entries = requirement.asset === "0.0.0" ? inspected.hbarTransfers : inspected.tokenTransfers[requirement.asset];
  const net = new Map<string, bigint>();
  for (const entry of entries ?? []) {
    net.set(entry.accountId, (net.get(entry.accountId) ?? 0n) + BigInt(entry.amount));
  }
  const transfers = [...net].filter(([, value]) => value !== 0n);
  if (
    !(decoded instanceof TransferTransaction) ||
    inspected.hasNonTransferOperations ||
    inspected.transactionIdAccountId !== String(extra?.feePayer) ||
    !key.publicKey.verifyTransaction(decoded) ||
    transfers.length !== 2 ||
    net.get(policy.payerAccountId) !== -amount ||
    net.get(policy.payTo) !== amount ||
    (requirement.asset === "0.0.0"
      ? Object.keys(inspected.tokenTransfers).length !== 0
      : inspected.hbarTransfers.length !== 0 || Object.keys(inspected.tokenTransfers).length !== 1)
  ) {
    throw new Error("PAYMENT_REJECTED");
  }

  const payload = {
    x402Version: 2 as const,
    resource: { url: input.resourceUrl },
    accepted: requirement,
    payload: {
      ...signed.payload,
      extensions: { bodySha256: input.bodySha256 },
    },
  };
  return {
    paymentHeader: encodeBase64Json(payload),
    transactionId: inspected.transactionId,
    payloadDigest: createHash("sha256").update(bytes).digest("hex"),
  };
}
