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

import { isSafePublicHttpUrl, type PaymentEvidence } from "@frely-network/shared-types";
import { createClientHederaSigner, PrivateKey } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";

export const HEDERA_TESTNET_NETWORK = "hedera:testnet" as const;
export const HEDERA_V1_TESTNET_NETWORK = "hedera-testnet" as const;

export type X402Version = 1 | 2;

export interface PaymentRequirement {
  scheme: string;
  network: string;
  amount?: string;
  maxAmountRequired?: string;
  asset?: string;
  payTo?: string;
  resource?: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
  [key: string]: unknown;
}
export interface PaymentRequired {
  x402Version: X402Version;
  accepts: PaymentRequirement[];
  resource?: { url?: string; [key: string]: unknown };
  error?: string;
  extensions?: Record<string, unknown>;
}

export interface PaymentPayload {
  x402Version: X402Version;
  scheme?: string;
  network?: string;
  resource?: { url?: string; [key: string]: unknown };
  accepted?: PaymentRequirement;
  payload: Record<string, unknown>;
  extensions?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface PaymentSignerContext {
  method: string;
  url: string;
  body?: Uint8Array;
}

/** The wallet/scheme-specific portion is injected so private keys stay outside Broker code. */
export interface HederaPaymentSigner {
  createPaymentPayload(
    requirement: PaymentRequirement,
    context: PaymentSignerContext,
  ): Promise<PaymentPayload>;
}

export interface HederaWalletSignerConfig {
  accountId: string;
  privateKey: string;
  network?: typeof HEDERA_TESTNET_NETWORK;
}

export interface PaymentRequest {
  method: string;
  url: string;
  headers?: HeadersInit;
  body?: Uint8Array;
  maxAmount?: string;
}

export interface PaymentClientResult {
  response: Response;
  payment?: PaymentEvidence;
  challenged: boolean;
}

export interface HederaX402ClientConfig {
  signer: HederaPaymentSigner;
  fetcher?: (input: string, init: RequestInit) => Promise<Response>;
  network?: typeof HEDERA_TESTNET_NETWORK;
  maxAmount?: string;
  requireSettlementEvidence?: boolean;
}

export class PaymentError extends Error {
  readonly code:
    | "PAYMENT_REQUIRED"
    | "PAYMENT_LIMIT_EXCEEDED"
    | "PAYMENT_NETWORK_UNSUPPORTED"
    | "PAYMENT_FAILED";

  constructor(
    code: PaymentError["code"],
    message = code,
  ) {
    super(message);
    this.name = "PaymentError";
    this.code = code;
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Signs Hedera x402 v2 exact payments locally with the configured wallet. */
export class ExactHederaPaymentSigner implements HederaPaymentSigner {
  private readonly scheme: ExactHederaScheme;

  constructor(config: HederaWalletSignerConfig) {
    if (!/^\d+\.\d+\.\d+$/u.test(config.accountId) || (config.network && config.network !== HEDERA_TESTNET_NETWORK)) {
      throw new PaymentError("PAYMENT_NETWORK_UNSUPPORTED");
    }
    try {
      const privateKey = PrivateKey.fromStringECDSA(config.privateKey);
      const signer = createClientHederaSigner(config.accountId, privateKey, {
        network: HEDERA_TESTNET_NETWORK,
      });
      this.scheme = new ExactHederaScheme(signer);
    } catch {
      throw new PaymentError("PAYMENT_FAILED");
    }
  }

  async createPaymentPayload(
    requirement: PaymentRequirement,
    context: PaymentSignerContext,
  ): Promise<PaymentPayload> {
    void context;
    if (requirement.scheme !== "exact" || canonicalNetwork(requirement.network) !== HEDERA_TESTNET_NETWORK) {
      throw new PaymentError("PAYMENT_NETWORK_UNSUPPORTED");
    }
    try {
      const signed = await this.scheme.createPaymentPayload(
        2,
        requirement as Parameters<ExactHederaScheme["createPaymentPayload"]>[1],
      );
      const payload = asObject(signed.payload);
      if (!payload) throw new Error("invalid_payload");
      return {
        x402Version: 2,
        accepted: requirement,
        payload,
      };
    } catch (error) {
      if (error instanceof PaymentError) throw error;
      throw new PaymentError("PAYMENT_FAILED");
    }
  }
}

export function createHederaPaymentSigner(
  accountId: string,
  privateKey: string,
  network: typeof HEDERA_TESTNET_NETWORK = HEDERA_TESTNET_NETWORK,
): HederaPaymentSigner {
  return new ExactHederaPaymentSigner({ accountId, privateKey, network });
}

function decodeBase64Json(value: string): unknown {
  const normalized = value.trim().replace(/^base64,?/iu, "").replace(/-/gu, "+").replace(/_/gu, "/");
  try {
    const decoded = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(decoded, (character) => character.charCodeAt(0))));
  } catch {
    throw new PaymentError("PAYMENT_FAILED");
  }
}

function encodeBase64Json(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function version(value: unknown): X402Version | undefined {
  return value === 1 || value === 2 ? value : undefined;
}

function normalizePaymentRequired(value: unknown): PaymentRequired | undefined {
  const record = asObject(value);
  if (!record) return undefined;
  const protocolVersion = version(record.x402Version);
  const accepts = record.accepts;
  if (!protocolVersion || !Array.isArray(accepts) || accepts.length === 0) return undefined;
  const requirements = accepts.filter((item): item is PaymentRequirement => {
    const candidate = asObject(item);
    return typeof candidate?.scheme === "string" && typeof candidate.network === "string";
  });
  if (requirements.length === 0) return undefined;
  return {
    x402Version: protocolVersion,
    accepts: requirements,
    ...(asObject(record.resource) ? { resource: asObject(record.resource) as PaymentRequired["resource"] } : {}),
    ...(typeof record.error === "string" ? { error: record.error } : {}),
    ...(asObject(record.extensions) ? { extensions: asObject(record.extensions) } : {}),
  };
}

function amountOf(requirement: PaymentRequirement): bigint {
  const value = requirement.amount ?? requirement.maxAmountRequired;
  if (!value || !/^\d+$/u.test(value)) throw new PaymentError("PAYMENT_FAILED");
  try {
    return BigInt(value);
  } catch {
    throw new PaymentError("PAYMENT_FAILED");
  }
}

function canonicalNetwork(value: string): string | undefined {
  if (value === HEDERA_TESTNET_NETWORK || value === HEDERA_V1_TESTNET_NETWORK) return HEDERA_TESTNET_NETWORK;
  return undefined;
}

function cloneHeaders(input?: HeadersInit): Headers {
  const headers = new Headers(input);
  headers.delete("PAYMENT-SIGNATURE");
  headers.delete("X-PAYMENT");
  return headers;
}

function headerValue(response: Response, names: string[]): string | undefined {
  for (const name of names) {
    const value = response.headers.get(name);
    if (value) return value;
  }
  return undefined;
}

async function paymentRequiredFromResponse(response: Response): Promise<PaymentRequired | undefined> {
  const encoded = headerValue(response, ["PAYMENT-REQUIRED", "X-PAYMENT-REQUIRED"]);
  if (encoded) return normalizePaymentRequired(decodeBase64Json(encoded));
  try {
    return normalizePaymentRequired(await response.clone().json());
  } catch {
    return undefined;
  }
}

function settlementEvidence(
  value: unknown,
  expectedNetwork: string,
): PaymentEvidence | undefined {
  const record = asObject(value);
  if (!record || record.success !== true) return undefined;
  const rawNetwork = typeof record.network === "string" ? record.network : expectedNetwork;
  const network = canonicalNetwork(rawNetwork);
  if (!network) return undefined;
  const transaction = [record.transaction, record.transactionId, record.txHash]
    .find((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);
  const payer = typeof record.payer === "string" && record.payer.length > 0 ? record.payer : undefined;
  return { network, ...(transaction ? { transactionId: transaction } : {}), ...(payer ? { payer } : {}) };
}

async function settlementFromResponse(
  response: Response,
  expectedNetwork: string,
): Promise<PaymentEvidence | undefined> {
  const encoded = headerValue(response, ["PAYMENT-RESPONSE", "X-PAYMENT-RESPONSE"]);
  if (!encoded) return undefined;
  return settlementEvidence(decodeBase64Json(encoded), expectedNetwork);
}

function selectRequirement(
  payment: PaymentRequired,
  expectedNetwork: string,
  maxAmount?: string,
): PaymentRequirement {
  const candidates = payment.accepts.filter((candidate) =>
    candidate.scheme === "exact" && canonicalNetwork(candidate.network) === expectedNetwork,
  );
  if (candidates.length === 0) throw new PaymentError("PAYMENT_NETWORK_UNSUPPORTED");
  const budget = maxAmount === undefined ? undefined : BigInt(maxAmount);
  const selected = candidates.find((candidate) => {
    const amount = amountOf(candidate);
    return budget === undefined || amount <= budget;
  });
  if (!selected) throw new PaymentError("PAYMENT_LIMIT_EXCEEDED");
  return selected;
}

function matchesSelectedRequirement(payload: PaymentPayload, requirement: PaymentRequirement): boolean {
  const expectedAmount = requirement.amount ?? requirement.maxAmountRequired;
  const accepted = payload.x402Version === 2 ? asObject(payload.accepted) : undefined;
  const scheme = payload.x402Version === 1 ? payload.scheme : accepted?.scheme;
  const network = payload.x402Version === 1 ? payload.network : accepted?.network;
  if (scheme !== requirement.scheme || typeof network !== "string" || canonicalNetwork(network) !== HEDERA_TESTNET_NETWORK) return false;
  if (payload.x402Version === 2) {
    const actualAmount = accepted?.amount ?? accepted?.maxAmountRequired;
    if (typeof expectedAmount !== "string" || actualAmount !== expectedAmount) return false;
    if (requirement.asset !== undefined && accepted?.asset !== requirement.asset) return false;
    if (requirement.payTo !== undefined && accepted?.payTo !== requirement.payTo) return false;
  }
  return true;
}

/** Implements the HTTP x402 challenge, budget check, signing hook and unchanged-body retry. */
export class HederaX402Client {
  private readonly fetcher: (input: string, init: RequestInit) => Promise<Response>;
  private readonly network: typeof HEDERA_TESTNET_NETWORK;
  private readonly maxAmount?: string;
  private readonly requireSettlementEvidence: boolean;

  constructor(private readonly config: HederaX402ClientConfig) {
    this.fetcher = config.fetcher ?? ((input, init) => fetch(input, init));
    this.network = config.network ?? HEDERA_TESTNET_NETWORK;
    this.maxAmount = config.maxAmount;
    this.requireSettlementEvidence = config.requireSettlementEvidence ?? true;
    if (this.maxAmount !== undefined && !/^\d+$/u.test(this.maxAmount)) {
      throw new PaymentError("PAYMENT_LIMIT_EXCEEDED");
    }
  }

  async request(request: PaymentRequest): Promise<PaymentClientResult> {
    if (!isSafePublicHttpUrl(request.url, { requireHttps: true })) throw new PaymentError("PAYMENT_FAILED");
    const body = request.body ? new Uint8Array(request.body) : undefined;
    const initial = await this.fetcher(request.url, {
      method: request.method,
      headers: cloneHeaders(request.headers),
      ...(body ? { body: new Uint8Array(body) } : {}),
    });
    if (initial.status !== 402) return { response: initial, challenged: false };

    const required = await paymentRequiredFromResponse(initial);
    if (!required) throw new PaymentError("PAYMENT_REQUIRED");
    const maxAmount = request.maxAmount ?? this.maxAmount;
    if (maxAmount !== undefined && !/^\d+$/u.test(maxAmount)) {
      throw new PaymentError("PAYMENT_LIMIT_EXCEEDED");
    }
    const requirement = selectRequirement(required, this.network, maxAmount);
    const payload = await this.config.signer.createPaymentPayload(requirement, {
      method: request.method,
      url: request.url,
      ...(body ? { body: new Uint8Array(body) } : {}),
    });
    if (
      !payload ||
      (payload.x402Version !== 1 && payload.x402Version !== 2) ||
      payload.x402Version !== required.x402Version ||
      !asObject(payload.payload) ||
      !matchesSelectedRequirement(payload, requirement)
    ) {
      throw new PaymentError("PAYMENT_FAILED");
    }

    const paymentHeader = encodeBase64Json(payload);
    const retryHeaders = cloneHeaders(request.headers);
    if (required.x402Version === 1) retryHeaders.set("X-PAYMENT", paymentHeader);
    else {
      retryHeaders.set("PAYMENT-SIGNATURE", paymentHeader);
      // Blocky402 and some Hedera v2 deployments still consume the v1-compatible name.
      retryHeaders.set("X-PAYMENT", paymentHeader);
    }
    const retry = await this.fetcher(request.url, {
      method: request.method,
      headers: retryHeaders,
      ...(body ? { body: new Uint8Array(body) } : {}),
    });
    if (retry.status === 402) throw new PaymentError("PAYMENT_FAILED");

    const payment = await settlementFromResponse(retry, this.network);
    if (!payment && this.requireSettlementEvidence) throw new PaymentError("PAYMENT_FAILED");
    return { response: retry, ...(payment ? { payment } : {}), challenged: true };
  }
}

export function decodePaymentHeader(value: string): PaymentRequired | PaymentPayload {
  const decoded = asObject(decodeBase64Json(value));
  if (!decoded) throw new PaymentError("PAYMENT_FAILED");
  const required = normalizePaymentRequired(decoded);
  if (required) return required;
  const protocolVersion = version(decoded.x402Version);
  if (!protocolVersion || !asObject(decoded.payload)) throw new PaymentError("PAYMENT_FAILED");
  return { ...decoded, x402Version: protocolVersion, payload: decoded.payload } as PaymentPayload;
}

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
