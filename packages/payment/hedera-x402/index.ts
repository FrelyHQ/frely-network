import { createHash } from "node:crypto";
import type {
  A2APaymentAdmission,
  A2APaymentChallenge,
  A2APaymentRequirementsRequest,
  A2APaymentVerifyRequest,
} from "@frely-network/shared-types";
import {
  A2A_PAYMENT_CONTRACT_VERSION,
  A2A_PAYMENT_NETWORK,
  A2A_PAYMENT_SCHEME,
} from "@frely-network/shared-types";

const MAX_PROOF_BYTES = 128 * 1024;
const MAX_REQUIREMENT_BYTES = 64 * 1024;
const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,191}$/u;
const SAFE_HASH = /^[a-f0-9]{64}$/u;
const SECRET_REFERENCE_PATTERNS = [
  /^(?:bearer|basic)[_.:/-]/iu,
  /^sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{8,}$/u,
  /^(?:sk|rk)_(?:live|test)_[A-Za-z0-9_.:/-]{8,}$/u,
  /^(?:api[_-]?key|token|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret|credential|authorization)[:=_-][A-Za-z0-9_.:/-]{8,}$/iu,
] as const;

export interface HederaX402PaymentVerificationContext extends Omit<A2APaymentVerifyRequest, "proof"> {
  readonly proof: string;
  readonly challenge: A2APaymentChallenge;
}

export type HederaX402VerifiedPayment = Omit<A2APaymentAdmission, "contractVersion" | "scheme" | "network">;

export interface HederaX402AdmissionVerifier {
  requirements(input: A2APaymentRequirementsRequest): Promise<A2APaymentChallenge>;
  verify(input: A2APaymentVerifyRequest): Promise<A2APaymentAdmission>;
}

export interface HederaX402AdmissionVerifierOptions {
  requirements(input: A2APaymentRequirementsRequest): Promise<A2APaymentChallenge>;
  verifyProof(input: HederaX402PaymentVerificationContext): Promise<HederaX402VerifiedPayment>;
  now?: () => string;
}

/**
 * Adapts a concrete x402 verifier to the small Network -> Relay contract.
 * Hedera testnet and exact payment are deliberate contract values here; the
 * actual requirement encoding and proof verification remain injected at this
 * boundary until the live x402 integration is frozen.
 */
export function createHederaX402AdmissionVerifier(options: HederaX402AdmissionVerifierOptions): HederaX402AdmissionVerifier {
  const now = options.now ?? (() => new Date().toISOString());

  return {
    requirements: async (input) => {
      validateRequirementsRequest(input);
      const challenge = await options.requirements(input);
      return validateChallenge(challenge, input.resource, now());
    },
    verify: async (input) => {
      validateVerifyRequest(input);
      const challenge = await options.requirements(input);
      const validatedChallenge = validateChallenge(challenge, input.resource, now());
      if (typeof input.proof !== "string" || input.proof.length === 0 || new TextEncoder().encode(input.proof).byteLength > MAX_PROOF_BYTES) {
        throw new HederaX402PaymentRejectedError("payment_invalid", validatedChallenge);
      }
      let verified: HederaX402VerifiedPayment;
      try {
        verified = await options.verifyProof({ ...input, challenge: validatedChallenge });
      } catch (error) {
        if (error instanceof HederaX402PaymentRejectedError) throw error;
        throw error;
      }
      const admission = validateVerifiedPayment(verified, validatedChallenge, now());
      return {
        contractVersion: A2A_PAYMENT_CONTRACT_VERSION,
        paymentReference: admission.paymentReference,
        requirementRevision: admission.requirementRevision,
        scheme: A2A_PAYMENT_SCHEME,
        payerReference: admission.payerReference,
        network: A2A_PAYMENT_NETWORK,
        asset: admission.asset,
        authorizedAmount: admission.authorizedAmount,
        verifiedAt: admission.verifiedAt,
        expiresAt: admission.expiresAt,
        replayStatus: admission.replayStatus,
      };
    },
  };
}

export type HederaX402PaymentRejectionCode = "payment_invalid" | "payment_replayed" | "payment_expired";

/** A safe, response-ready rejection. It deliberately does not retain proof data. */
export class HederaX402PaymentRejectedError extends Error {
  readonly status = 402 as const;
  readonly code: HederaX402PaymentRejectionCode;
  readonly challenge: A2APaymentChallenge;

  constructor(code: HederaX402PaymentRejectionCode, challenge: A2APaymentChallenge) {
    super(code === "payment_replayed" ? "Payment proof has already been used" : code === "payment_expired" ? "Payment proof has expired" : "Payment proof is invalid");
    this.name = "HederaX402PaymentRejectedError";
    this.code = code;
    this.challenge = challenge;
  }
}

export interface FixtureHederaX402Options {
  readonly expectedProof?: string;
  readonly requirementRevision?: string;
  readonly paymentRequired?: string;
  readonly payerReference?: string;
  readonly asset?: string;
  readonly authorizedAmount?: string;
  readonly expiresInSeconds?: number;
  readonly now?: () => string;
}

/**
 * Deterministic test-only verifier. It models exact-payment replay handling
 * without pretending to be a live Hedera/x402 integration.
 */
export function createFixtureHederaX402AdmissionVerifier(options: FixtureHederaX402Options = {}): HederaX402AdmissionVerifier {
  const now = options.now ?? (() => new Date().toISOString());
  const expectedProof = options.expectedProof ?? "fixture-x402-proof";
  if (!expectedProof || new TextEncoder().encode(expectedProof).byteLength > MAX_PROOF_BYTES) throw new Error("FIXTURE_PROOF_INVALID");
  const expiresInSeconds = options.expiresInSeconds ?? 300;
  if (!Number.isSafeInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 86_400) throw new Error("FIXTURE_EXPIRY_INVALID");
  const requirementRevision = options.requirementRevision ?? "fixture-v1";
  const paymentRequired = options.paymentRequired ?? "fixture:x402:hedera-testnet:exact:v1";
  const payerReference = options.payerReference ?? "fixture:payer";
  const asset = options.asset ?? "HBAR";
  const authorizedAmount = options.authorizedAmount ?? "1";
  const acceptedProofs = new Map<string, { requestHash: string; idempotencyKeyHash: string; admission: HederaX402VerifiedPayment }>();

  const verifier = createHederaX402AdmissionVerifier({
    now,
    requirements: async (input) => ({
      contractVersion: A2A_PAYMENT_CONTRACT_VERSION,
      scheme: A2A_PAYMENT_SCHEME,
      network: A2A_PAYMENT_NETWORK,
      requirementRevision,
      resource: normalizeResource(input.resource),
      paymentRequired,
      expiresAt: futureIso(now(), expiresInSeconds),
    }),
    verifyProof: async (input) => {
      const proofHash = sha256(input.proof);
      const previous = acceptedProofs.get(proofHash);
      if (previous) {
        if (previous.requestHash !== input.requestHash || previous.idempotencyKeyHash !== input.idempotencyKeyHash) {
          throw new HederaX402PaymentRejectedError("payment_replayed", input.challenge);
        }
        return { ...previous.admission, replayStatus: "replayed" };
      }
      if (input.proof !== expectedProof) throw new HederaX402PaymentRejectedError("payment_invalid", input.challenge);
      const admission: HederaX402VerifiedPayment = {
        paymentReference: `fixture:payment:${proofHash.slice(0, 24)}`,
        requirementRevision: input.challenge.requirementRevision,
        payerReference,
        asset,
        authorizedAmount,
        verifiedAt: now(),
        expiresAt: input.challenge.expiresAt,
        replayStatus: "fresh",
      };
      acceptedProofs.set(proofHash, { requestHash: input.requestHash, idempotencyKeyHash: input.idempotencyKeyHash, admission });
      return admission;
    },
  });
  return verifier;
}

function validateRequirementsRequest(input: A2APaymentRequirementsRequest): void {
  validateRequestShape(input.resource, input.method, input.requestHash);
}

function validateVerifyRequest(input: A2APaymentVerifyRequest): void {
  validateRequestShape(input.resource, input.method, input.requestHash);
  if (!SAFE_REFERENCE.test(input.requestId) || !SAFE_HASH.test(input.idempotencyKeyHash)) throw new Error("A2A_PAYMENT_CORRELATION_INVALID");
  if (typeof input.proof !== "string" || input.proof.length === 0 || new TextEncoder().encode(input.proof).byteLength > MAX_PROOF_BYTES) throw new Error("A2A_PAYMENT_PROOF_INVALID");
}

function validateRequestShape(resource: string, method: string, requestHash: string): void {
  if (method !== "POST" || !SAFE_HASH.test(requestHash)) throw new Error("A2A_PAYMENT_REQUEST_INVALID");
  normalizeResource(resource);
}

function validateChallenge(value: A2APaymentChallenge, resource: string, currentTime: string): A2APaymentChallenge {
  if (value.contractVersion !== A2A_PAYMENT_CONTRACT_VERSION || value.scheme !== A2A_PAYMENT_SCHEME || value.network !== A2A_PAYMENT_NETWORK) throw new Error("A2A_PAYMENT_CONTRACT_UNSUPPORTED");
  if (!safeReference(value.requirementRevision) || value.paymentRequired.length === 0 || new TextEncoder().encode(value.paymentRequired).byteLength > MAX_REQUIREMENT_BYTES || /[\r\n]/u.test(value.paymentRequired)) throw new Error("A2A_PAYMENT_REQUIREMENT_INVALID");
  const normalizedResource = normalizeResource(resource);
  if (normalizeResource(value.resource) !== normalizedResource) throw new Error("A2A_PAYMENT_RESOURCE_MISMATCH");
  const expiresAt = parseIso(value.expiresAt);
  const normalizedChallenge = { ...value, resource: normalizedResource, expiresAt: new Date(expiresAt).toISOString() };
  if (expiresAt <= Date.parse(currentTime)) throw new HederaX402PaymentRejectedError("payment_expired", normalizedChallenge);
  return normalizedChallenge;
}

function validateVerifiedPayment(value: HederaX402VerifiedPayment, challenge: A2APaymentChallenge, currentTime: string): HederaX402VerifiedPayment {
  if (!safeReference(value.paymentReference) || !safeReference(value.payerReference) || !safeReference(value.asset)) throw new Error("A2A_PAYMENT_ADMISSION_REFERENCE_INVALID");
  if (value.requirementRevision !== challenge.requirementRevision || !/^[1-9][0-9]*$/u.test(value.authorizedAmount) || value.authorizedAmount.length > 128 || BigInt(value.authorizedAmount) <= 0n) throw new Error("A2A_PAYMENT_ADMISSION_INVALID");
  if (value.replayStatus !== "fresh" && value.replayStatus !== "replayed") throw new Error("A2A_PAYMENT_REPLAY_STATUS_INVALID");
  const verifiedAt = parseIso(value.verifiedAt);
  const expiresAt = parseIso(value.expiresAt);
  if (expiresAt > parseIso(challenge.expiresAt) || expiresAt <= verifiedAt || expiresAt <= Date.parse(currentTime)) {
    throw new HederaX402PaymentRejectedError("payment_expired", challenge);
  }
  return { ...value, verifiedAt: new Date(verifiedAt).toISOString(), expiresAt: new Date(expiresAt).toISOString() };
}

function safeReference(value: string): boolean {
  return SAFE_REFERENCE.test(value) && !SECRET_REFERENCE_PATTERNS.some((pattern) => pattern.test(value));
}

function normalizeResource(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) throw new Error("A2A_PAYMENT_RESOURCE_INVALID");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("A2A_PAYMENT_RESOURCE_INVALID"); }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.hash) throw new Error("A2A_PAYMENT_RESOURCE_INVALID");
  return url.toString();
}

function parseIso(value: string): number {
  if (typeof value !== "string" || value.length > 64) throw new Error("A2A_PAYMENT_TIME_INVALID");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("A2A_PAYMENT_TIME_INVALID");
  return parsed;
}

function futureIso(value: string, seconds: number): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error("FIXTURE_CLOCK_INVALID");
  return new Date(timestamp + seconds * 1_000).toISOString();
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
