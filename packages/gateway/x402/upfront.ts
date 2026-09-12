import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  decodePaymentHeader,
  type PaymentPayload,
  type PaymentRequirement,
  type PaymentRequired,
} from "@frely-network/hedera-x402";
import type { GatewaySettlement, X402GatewaySettler, X402GatewayVerifier } from "./index.ts";

const MAX_PROOF_BYTES = 128 * 1024;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,191}$/;
const BODY_SHA = /^[a-f0-9]{64}$/;
const TRANSACTION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/;

export type UpfrontAdmission =
  | { kind: "response"; response: Response }
  | {
      kind: "settled";
      settlement: GatewaySettlement;
      finish(response: Response): Promise<Response>;
    };

export interface X402AttemptStore {
  claim(input: {
    requestId: string;
    fingerprint: string;
    proofDigest: string;
    expiresAt: string;
  }): Promise<"claimed" | "duplicate" | "conflict">;
  markSettled(requestId: string, settlement: GatewaySettlement): Promise<void>;
  markDelivered(requestId: string, responseDigest: string): Promise<void>;
}

export interface UpfrontX402GatewayConfig {
  verifier: X402GatewayVerifier;
  settler: X402GatewaySettler;
  network: string;
  attemptStore: X402AttemptStore;
  now?: () => number;
}

function encode(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function challenge(requirements: PaymentRequired, error?: string, status = 402): Response {
  const body = { ...requirements, ...(error ? { error } : {}) };
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "PAYMENT-REQUIRED": encode(body),
    },
  });
}

function paymentPayload(value: unknown): PaymentPayload | undefined {
  const record = asObject(value);
  if (!record || record.x402Version !== 2 || !asObject(record.payload)) return undefined;
  return record as unknown as PaymentPayload;
}

function feePayerOf(requirement: PaymentRequirement): string | undefined {
  const extra = asObject(requirement.extra);
  return typeof extra?.feePayer === "string" ? extra.feePayer : undefined;
}

function acceptedRequirement(payload: PaymentPayload, requirements: PaymentRequired): PaymentRequirement | undefined {
  const accepted = asObject(payload.accepted);
  if (!accepted || typeof accepted.scheme !== "string" || typeof accepted.network !== "string") return undefined;
  return requirements.accepts.find((candidate) => {
    if (candidate.scheme !== accepted.scheme || candidate.network !== accepted.network) return false;
    const expectedAmount = candidate.amount ?? candidate.maxAmountRequired;
    const actualAmount = accepted.amount ?? accepted.maxAmountRequired;
    if (expectedAmount !== actualAmount) return false;
    if (candidate.asset !== undefined && candidate.asset !== accepted.asset) return false;
    if (candidate.payTo !== undefined && candidate.payTo !== accepted.payTo) return false;
    if (feePayerOf(candidate) !== undefined && feePayerOf(candidate) !== feePayerOf(accepted as PaymentRequirement)) {
      return false;
    }
    if (
      candidate.maxTimeoutSeconds !== undefined &&
      candidate.maxTimeoutSeconds !== accepted.maxTimeoutSeconds
    ) {
      return false;
    }
    return true;
  });
}

function normalizedResource(value: string): string | undefined {
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.hash) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function bodyHashFromPayload(payload: PaymentPayload): string | undefined {
  const inner = asObject(payload.payload);
  const extensions = asObject(inner?.extensions);
  return typeof extensions?.bodySha256 === "string" ? extensions.bodySha256 : undefined;
}

export class FileX402AttemptStore implements X402AttemptStore {
  private readonly db: Database;

  constructor(directory: string) {
    if (!directory || directory.includes("\0")) throw new Error("ATTEMPT_STORE_UNAVAILABLE");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const path = join(directory, "attempts.sqlite");
    this.db = new Database(path, { create: true });
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS attempts (
        request_id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        proof_digest TEXT NOT NULL,
        phase TEXT NOT NULL,
        settlement_json TEXT,
        response_digest TEXT,
        expires_at TEXT NOT NULL
      );
    `);
    if (existsSync(path)) chmodSync(path, 0o600);
  }

  async claim(input: {
    requestId: string;
    fingerprint: string;
    proofDigest: string;
    expiresAt: string;
  }): Promise<"claimed" | "duplicate" | "conflict"> {
    return this.db.transaction(() => {
      const existing = this.db
        .query("SELECT fingerprint, proof_digest FROM attempts WHERE request_id = ?")
        .get(input.requestId) as { fingerprint: string; proof_digest: string } | null;
      if (!existing) {
        this.db
          .query(
            "INSERT INTO attempts (request_id, fingerprint, proof_digest, phase, expires_at) VALUES (?, ?, ?, 'claimed', ?)",
          )
          .run(input.requestId, input.fingerprint, input.proofDigest, input.expiresAt);
        return "claimed";
      }
      if (existing.fingerprint === input.fingerprint && existing.proof_digest === input.proofDigest) {
        return "duplicate";
      }
      return "conflict";
    }).immediate();
  }

  async markSettled(requestId: string, settlement: GatewaySettlement): Promise<void> {
    const result = this.db
      .query("UPDATE attempts SET phase = 'settled', settlement_json = ? WHERE request_id = ? AND phase = 'claimed'")
      .run(JSON.stringify(settlement), requestId);
    if (result.changes !== 1) throw new Error("ATTEMPT_STATE_INVALID");
  }

  async markDelivered(requestId: string, responseDigest: string): Promise<void> {
    if (!BODY_SHA.test(responseDigest)) throw new Error("ATTEMPT_STATE_INVALID");
    const result = this.db
      .query("UPDATE attempts SET phase = 'delivered', response_digest = ? WHERE request_id = ? AND phase = 'settled'")
      .run(responseDigest, requestId);
    if (result.changes !== 1) throw new Error("ATTEMPT_STATE_INVALID");
  }

  close(): void {
    this.db.close();
  }
}

export class UpfrontX402Gateway {
  constructor(private readonly config: UpfrontX402GatewayConfig) {}

  async admit(
    request: Request,
    body: Uint8Array,
    requirements: PaymentRequired,
  ): Promise<UpfrontAdmission> {
    if (requirements.x402Version !== 2) {
      return { kind: "response", response: challenge(requirements, "PAYMENT_REJECTED") };
    }
    const encoded = request.headers.get("PAYMENT-SIGNATURE") ?? request.headers.get("X-PAYMENT");
    if (!encoded) return { kind: "response", response: challenge(requirements) };
    if (new TextEncoder().encode(encoded).byteLength > MAX_PROOF_BYTES) {
      return { kind: "response", response: challenge(requirements, "PAYMENT_REJECTED") };
    }

    const requestId = request.headers.get("x-frely-request-id");
    if (!requestId || !REQUEST_ID.test(requestId)) {
      return { kind: "response", response: challenge(requirements, "INVALID_REQUEST") };
    }

    let payload: PaymentPayload;
    try {
      const decoded = paymentPayload(decodePaymentHeader(encoded));
      if (!decoded) return { kind: "response", response: challenge(requirements, "PAYMENT_REJECTED") };
      payload = decoded;
    } catch {
      return { kind: "response", response: challenge(requirements, "PAYMENT_REJECTED") };
    }

    const expected = requirements.resource?.url;
    const requestUrl = normalizedResource(request.url);
    if (!expected || !requestUrl || normalizedResource(expected) !== requestUrl) {
      return { kind: "response", response: challenge(requirements, "PAYMENT_REJECTED") };
    }
    if (payload.resource?.url && normalizedResource(payload.resource.url) !== requestUrl) {
      return { kind: "response", response: challenge(requirements, "PAYMENT_REJECTED") };
    }

    const bodySha256 = createHash("sha256").update(body).digest("hex");
    const declared = bodyHashFromPayload(payload);
    if (!declared || !BODY_SHA.test(declared) || declared !== bodySha256) {
      return { kind: "response", response: challenge(requirements, "PAYMENT_REJECTED") };
    }

    const requirement = acceptedRequirement(payload, requirements);
    if (
      !requirement ||
      requirement.scheme !== "exact" ||
      requirement.network !== this.config.network
    ) {
      return { kind: "response", response: challenge(requirements, "PAYMENT_REJECTED") };
    }

    const proofDigest = createHash("sha256").update(encoded, "utf8").digest("hex");
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          method: request.method,
          url: requestUrl,
          requestId,
          bodySha256,
          scheme: requirement.scheme,
          network: requirement.network,
          asset: requirement.asset,
          amount: requirement.amount ?? requirement.maxAmountRequired,
          payTo: requirement.payTo,
          feePayer: feePayerOf(requirement),
          timeout: requirement.maxTimeoutSeconds,
        }),
      )
      .digest("hex");
    const ttl = typeof requirement.maxTimeoutSeconds === "number" ? requirement.maxTimeoutSeconds : 300;
    const expiresAt = new Date((this.config.now?.() ?? Date.now()) + ttl * 1000).toISOString();

    let claimed: "claimed" | "duplicate" | "conflict";
    try {
      claimed = await this.config.attemptStore.claim({
        requestId,
        fingerprint,
        proofDigest,
        expiresAt,
      });
    } catch {
      return { kind: "response", response: Response.json({ code: "PAYMENT_REPLAY_UNAVAILABLE" }, { status: 503 }) };
    }
    if (claimed === "duplicate") {
      return { kind: "response", response: challenge(requirements, "PAYMENT_REPLAYED") };
    }
    if (claimed === "conflict") {
      return { kind: "response", response: Response.json({ code: "REQUEST_ID_CONFLICT" }, { status: 409 }) };
    }

    let verification;
    try {
      verification = await this.config.verifier.verify(payload, requirement);
    } catch {
      return { kind: "response", response: challenge(requirements, "PAYMENT_REJECTED") };
    }
    if (!verification.isValid) {
      return { kind: "response", response: challenge(requirements, "PAYMENT_REJECTED") };
    }

    let settlement: GatewaySettlement;
    try {
      settlement = await this.config.settler.settle(payload, requirement);
    } catch {
      return { kind: "response", response: Response.json({ code: "PAYMENT_SETTLEMENT_FAILED" }, { status: 502 }) };
    }
    if (
      !settlement.success ||
      settlement.network !== this.config.network ||
      typeof settlement.transaction !== "string" ||
      !TRANSACTION_ID.test(settlement.transaction)
    ) {
      return { kind: "response", response: Response.json({ code: "PAYMENT_SETTLEMENT_FAILED" }, { status: 502 }) };
    }
    const settled: GatewaySettlement = {
      ...settlement,
      ...(settlement.payer ?? verification.payer ? { payer: settlement.payer ?? verification.payer } : {}),
    };
    await this.config.attemptStore.markSettled(requestId, settled);

    return {
      kind: "settled",
      settlement: settled,
      finish: async (response) => {
        const headers = new Headers(response.headers);
        headers.set("PAYMENT-RESPONSE", encode({
          success: settled.success,
          network: settled.network,
          ...(settled.transaction ? { transaction: settled.transaction } : {}),
          ...(settled.payer ? { payer: settled.payer } : {}),
        }));
        if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
        const bytes = new Uint8Array(await response.clone().arrayBuffer());
        await this.config.attemptStore.markDelivered(
          requestId,
          createHash("sha256").update(bytes).digest("hex"),
        );
        return new Response(bytes, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      },
    };
  }
}
