import { createHash } from "node:crypto";
import type {
  A2AChargeQuote,
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
import { x402Facilitator } from "@x402/core/facilitator";
import type {
  Network as X402Network,
  PaymentPayload as X402PaymentPayload,
  PaymentRequirements as X402PaymentRequirements,
  SettleResponse as X402SettleResponse,
  VerifyResponse as X402VerifyResponse,
} from "@x402/core/types";
import { createClientHederaSigner, PrivateKey, type FacilitatorHederaSigner } from "@x402/hedera";
import { ExactHederaScheme as ExactHederaFacilitatorScheme } from "@x402/hedera/exact/facilitator";
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
  /** Transient authorization data for an immediate A2A settlement adapter. Never persist or log. */
  authorization?: PaymentAuthorization;
  challenged: boolean;
}

export interface PaymentAuthorization {
  readonly paymentPayload: PaymentPayload;
  readonly paymentRequirement: PaymentRequirement;
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
        resource: { url: context.url },
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
    if (required.x402Version === 1) {
      retryHeaders.set("X-PAYMENT", paymentHeader);
      // The Frely A2A ingress has one opaque proof header independent of the
      // underlying x402 wire version; keep the legacy provider header too.
      retryHeaders.set("PAYMENT-SIGNATURE", paymentHeader);
    }
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
    return {
      response: retry,
      ...(payment ? { payment } : {}),
      authorization: { paymentPayload: payload, paymentRequirement: requirement },
      challenged: true,
    };
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
const MAX_CHARGE_UNITS_DIGITS = 19;
const MAX_CHARGE_UNITS = 9_223_372_036_854_775_807n;
const MAX_REPLAY_ENTRIES = 2_048;
const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,191}$/u;
const SAFE_CHAIN_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,191}$/u;
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
        chargeQuote: admission.chargeQuote,
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

export interface HederaX402FacilitatorPort {
  verify(paymentPayload: X402PaymentPayload, paymentRequirements: X402PaymentRequirements): Promise<X402VerifyResponse>;
  settle(paymentPayload: X402PaymentPayload, paymentRequirements: X402PaymentRequirements): Promise<X402SettleResponse>;
}

/** Build the official x402 Hedera v2 facilitator for the testnet CAIP-2 name. */
export function createHederaX402Facilitator(
  signer: FacilitatorHederaSigner,
  options: { readonly aliasPolicy?: "reject" | "allow" } = {},
): x402Facilitator {
  const scheme = new ExactHederaFacilitatorScheme(signer, options);
  return new x402Facilitator().register(HEDERA_TESTNET_NETWORK, scheme);
}

export interface LiveHederaX402AdmissionVerifierOptions {
  /** Produces a challenge whose quote and opaque x402 requirement are payee-owned. */
  requirements(input: A2APaymentRequirementsRequest): Promise<A2APaymentChallenge>;
  readonly facilitator: HederaX402FacilitatorPort;
  readonly now?: () => string;
  readonly maxReplayEntries?: number;
}

/**
 * Live Network-side adapter. It is the only boundary that decodes the opaque
 * x402 proof and invokes the official Hedera facilitator. Replay state stores
 * only a proof digest plus safe correlation/admission facts.
 */
export function createLiveHederaX402AdmissionVerifier(
  options: LiveHederaX402AdmissionVerifierOptions,
): HederaX402AdmissionVerifier {
  const now = options.now ?? (() => new Date().toISOString());
  const maxReplayEntries = options.maxReplayEntries ?? MAX_REPLAY_ENTRIES;
  if (!Number.isSafeInteger(maxReplayEntries) || maxReplayEntries < 1 || maxReplayEntries > 65_536) throw new Error("A2A_PAYMENT_REPLAY_LIMIT_INVALID");
  const acceptedProofs = new Map<string, {
    readonly resource: string;
    readonly requestHash: string;
    readonly idempotencyKeyHash: string;
    readonly requirementDigest: string;
    readonly admission: HederaX402VerifiedPayment;
  }>();

  const getChallenge = async (input: A2APaymentRequirementsRequest): Promise<A2APaymentChallenge> => {
    validateRequirementsRequest(input);
    const challenge = validateChallenge(await options.requirements(input), input.resource, now());
    decodeLivePaymentRequired(challenge);
    return challenge;
  };

  return {
    requirements: getChallenge,
    verify: async (input) => {
      validateVerifyRequest(input);
      const challenge = await getChallenge(input);
      const currentTime = now();
      const currentTimestamp = Date.parse(currentTime);
      if (!Number.isFinite(currentTimestamp)) throw new Error("A2A_PAYMENT_TIME_INVALID");
      purgeReplayEntries(acceptedProofs, currentTimestamp);

      const proofHash = sha256(input.proof);
      const previous = acceptedProofs.get(proofHash);
      if (previous) {
        if (
          previous.resource !== input.resource ||
          previous.requestHash !== input.requestHash ||
          previous.idempotencyKeyHash !== input.idempotencyKeyHash ||
          previous.requirementDigest !== challengeRequirementDigest(challenge)
        ) throw new HederaX402PaymentRejectedError("payment_replayed", challenge);
        return admissionResponse({ ...previous.admission, replayStatus: "replayed" });
      }

      let decodedProof: PaymentRequired | PaymentPayload;
      let required: PaymentRequired;
      try {
        decodedProof = decodePaymentHeader(input.proof);
        required = decodeLivePaymentRequired(challenge);
      } catch {
        throw new HederaX402PaymentRejectedError("payment_invalid", challenge);
      }
      if (isPaymentRequired(decodedProof)) throw new HederaX402PaymentRejectedError("payment_invalid", challenge);
      let requirement: PaymentRequirement;
      try {
        requirement = selectLivePaymentRequirement(required, decodedProof, challenge.resource);
      } catch {
        throw new HederaX402PaymentRejectedError("payment_invalid", challenge);
      }
      let verified: X402VerifyResponse;
      try {
        verified = await options.facilitator.verify(
          toOfficialPaymentPayload(decodedProof),
          toOfficialPaymentRequirement(requirement),
        );
      } catch {
        throw new HederaX402PaymentRejectedError("payment_invalid", challenge);
      }
      if (verified.isValid !== true || typeof verified.payer !== "string" || !verified.payer) {
        throw new HederaX402PaymentRejectedError("payment_invalid", challenge);
      }

      const admission: HederaX402VerifiedPayment = {
        paymentReference: `hedera:proof:${proofHash.slice(0, 48)}`,
        requirementRevision: challenge.requirementRevision,
        payerReference: verified.payer,
        asset: requirement.asset as string,
        authorizedAmount: (requirement.amount ?? requirement.maxAmountRequired) as string,
        chargeQuote: challenge.chargeQuote,
        verifiedAt: currentTime,
        expiresAt: challenge.expiresAt,
        replayStatus: "fresh",
      };
      let validated: HederaX402VerifiedPayment;
      try {
        validated = validateVerifiedPayment(admission, challenge, currentTime);
      } catch (error) {
        if (error instanceof HederaX402PaymentRejectedError) throw error;
        throw new HederaX402PaymentRejectedError("payment_invalid", challenge);
      }
      while (acceptedProofs.size >= maxReplayEntries) {
        const oldest = acceptedProofs.keys().next().value;
        if (typeof oldest !== "string") break;
        acceptedProofs.delete(oldest);
      }
      acceptedProofs.set(proofHash, {
        resource: input.resource,
        requestHash: input.requestHash,
        idempotencyKeyHash: input.idempotencyKeyHash,
        requirementDigest: challengeRequirementDigest(challenge),
        admission: validated,
      });
      return admissionResponse(validated);
    },
  };
}

export interface HederaX402PaymentSettlementInput {
  readonly paymentPayload: PaymentPayload;
  readonly paymentRequirement: PaymentRequirement;
  /** Optional Relay projection used by a refund implementation to calculate the release. */
  readonly payment?: PaymentEvidence;
}

export interface HederaX402PaymentSettlementPort {
  settle(input: HederaX402PaymentSettlementInput): Promise<PaymentEvidence>;
  release(input: HederaX402PaymentSettlementInput): Promise<PaymentEvidence>;
}

export interface LiveHederaX402PaymentSettlementOptions {
  readonly facilitator: HederaX402FacilitatorPort;
  /** Must issue a real compensating transfer/refund; the adapter never fabricates a release. */
  release(input: HederaX402PaymentSettlementInput): Promise<PaymentEvidence>;
}

/** Official-facilitator settlement plus an explicitly injected refund path. */
export function createLiveHederaX402PaymentSettlement(
  options: LiveHederaX402PaymentSettlementOptions,
): HederaX402PaymentSettlementPort {
  return {
    settle: async (input) => {
      let result: X402SettleResponse;
      try {
        result = await options.facilitator.settle(
          toOfficialPaymentPayload(input.paymentPayload),
          toOfficialPaymentRequirement(input.paymentRequirement),
        );
      } catch {
        throw new PaymentError("PAYMENT_FAILED");
      }
      if (result.success !== true || canonicalNetwork(result.network) !== HEDERA_TESTNET_NETWORK || !safeChainReference(result.transaction)) {
        throw new PaymentError("PAYMENT_FAILED");
      }
      const amount = input.paymentRequirement.amount ?? input.paymentRequirement.maxAmountRequired;
      if (!amount || !/^[1-9][0-9]*$/u.test(amount)) throw new PaymentError("PAYMENT_FAILED");
      if (result.payer !== undefined && !safeReference(result.payer)) throw new PaymentError("PAYMENT_FAILED");
      return {
        network: HEDERA_TESTNET_NETWORK,
        status: "settled",
        transactionId: result.transaction,
        paymentReference: paymentReferenceForPayload(input.paymentPayload),
        authorizedAmount: amount,
        ...(result.payer === undefined ? {} : { payer: result.payer }),
      };
    },
    release: async (input) => {
      try {
        return normalizeSettlementEvidence(await options.release(input));
      } catch (error) {
        if (error instanceof PaymentError) throw error;
        throw new PaymentError("PAYMENT_FAILED");
      }
    },
  };
}

function isPaymentRequired(value: PaymentRequired | PaymentPayload): value is PaymentRequired {
  return Array.isArray((value as { accepts?: unknown }).accepts);
}

function decodeLivePaymentRequired(challenge: A2APaymentChallenge): PaymentRequired {
  let decoded: PaymentRequired | PaymentPayload;
  try { decoded = decodePaymentHeader(challenge.paymentRequired); }
  catch { throw new Error("A2A_PAYMENT_REQUIREMENT_INVALID"); }
  if (!isPaymentRequired(decoded)) throw new Error("A2A_PAYMENT_REQUIREMENT_INVALID");
  if (decoded.x402Version !== 2 || !decoded.resource?.url || normalizeResource(decoded.resource.url) !== challenge.resource) throw new Error("A2A_PAYMENT_REQUIREMENT_INVALID");
  if (!decoded.accepts.some((candidate) => candidate.scheme === "exact" && canonicalNetwork(candidate.network) === HEDERA_TESTNET_NETWORK)) {
    throw new Error("A2A_PAYMENT_NETWORK_UNSUPPORTED");
  }
  return decoded;
}

function selectLivePaymentRequirement(
  required: PaymentRequired,
  payload: PaymentPayload,
  resource: string,
): PaymentRequirement {
  if (payload.x402Version !== 2 || required.x402Version !== 2) throw new Error("A2A_PAYMENT_VERSION_MISMATCH");
  if (!payload.resource?.url || normalizeResource(payload.resource.url) !== resource) throw new Error("A2A_PAYMENT_RESOURCE_MISMATCH");
  const candidates = required.accepts.filter((candidate) => candidate.scheme === "exact" && canonicalNetwork(candidate.network) === HEDERA_TESTNET_NETWORK);
  const selected = candidates.find((candidate) => matchesSelectedRequirement(payload, candidate));
  if (!selected) throw new Error("A2A_PAYMENT_REQUIREMENT_MISMATCH");
  validateOfficialRequirement(selected);
  return selected;
}

function validateOfficialRequirement(value: PaymentRequirement): void {
  const amount = value.amount ?? value.maxAmountRequired;
  if (
    value.scheme !== "exact" ||
    canonicalNetwork(value.network) === undefined ||
    typeof value.asset !== "string" ||
    !safeReference(value.asset) ||
    typeof value.payTo !== "string" ||
    !safeReference(value.payTo) ||
    typeof value.maxTimeoutSeconds !== "number" ||
    !Number.isSafeInteger(value.maxTimeoutSeconds) ||
    value.maxTimeoutSeconds < 1 ||
    value.maxTimeoutSeconds > 86_400 ||
    typeof amount !== "string" ||
    !/^[1-9][0-9]*$/u.test(amount)
  ) throw new Error("A2A_PAYMENT_REQUIREMENT_INVALID");
  try {
    if (BigInt(amount) <= 0n) throw new Error("amount");
  } catch {
    throw new Error("A2A_PAYMENT_REQUIREMENT_INVALID");
  }
}

function toOfficialPaymentRequirement(value: PaymentRequirement): X402PaymentRequirements {
  validateOfficialRequirement(value);
  const amount = value.amount ?? value.maxAmountRequired;
  return {
    scheme: "exact",
    network: (value.network === HEDERA_V1_TESTNET_NETWORK ? HEDERA_V1_TESTNET_NETWORK : HEDERA_TESTNET_NETWORK) as X402Network,
    asset: value.asset as string,
    amount: amount as string,
    payTo: value.payTo as string,
    maxTimeoutSeconds: value.maxTimeoutSeconds as number,
    extra: asObject(value.extra) ?? {},
  };
}

function toOfficialPaymentPayload(value: PaymentPayload): X402PaymentPayload {
  if (value.x402Version !== 1 && value.x402Version !== 2) throw new Error("A2A_PAYMENT_PROOF_INVALID");
  if (!asObject(value.payload)) throw new Error("A2A_PAYMENT_PROOF_INVALID");
  return value as unknown as X402PaymentPayload;
}

function admissionResponse(value: HederaX402VerifiedPayment): A2APaymentAdmission {
  return {
    contractVersion: A2A_PAYMENT_CONTRACT_VERSION,
    paymentReference: value.paymentReference,
    requirementRevision: value.requirementRevision,
    scheme: A2A_PAYMENT_SCHEME,
    payerReference: value.payerReference,
    network: A2A_PAYMENT_NETWORK,
    asset: value.asset,
    authorizedAmount: value.authorizedAmount,
    chargeQuote: value.chargeQuote,
    verifiedAt: value.verifiedAt,
    expiresAt: value.expiresAt,
    replayStatus: value.replayStatus,
  };
}

function purgeReplayEntries(
  entries: Map<string, { readonly admission: HederaX402VerifiedPayment }>,
  currentTimestamp: number,
): void {
  for (const [key, value] of entries) {
    if (Date.parse(value.admission.expiresAt) <= currentTimestamp) entries.delete(key);
  }
}

function paymentReferenceForPayload(value: PaymentPayload): string {
  return `hedera:payload:${sha256(JSON.stringify(value)).slice(0, 48)}`;
}

function challengeRequirementDigest(value: A2APaymentChallenge): string {
  return sha256(JSON.stringify({ paymentRequired: value.paymentRequired, chargeQuote: value.chargeQuote }));
}

function safeChainReference(value: unknown): value is string {
  return typeof value === "string" && SAFE_CHAIN_REFERENCE.test(value) && !SECRET_REFERENCE_PATTERNS.some((pattern) => pattern.test(value));
}

function normalizeSettlementEvidence(value: PaymentEvidence): PaymentEvidence {
  if (!value || typeof value !== "object" || canonicalNetwork(value.network) !== HEDERA_TESTNET_NETWORK || value.status !== "released") {
    throw new PaymentError("PAYMENT_FAILED");
  }
  if (value.transactionId !== undefined && !safeChainReference(value.transactionId)) throw new PaymentError("PAYMENT_FAILED");
  if (value.payer !== undefined && !safeReference(value.payer)) throw new PaymentError("PAYMENT_FAILED");
  if (value.paymentReference !== undefined && !safeReference(value.paymentReference)) throw new PaymentError("PAYMENT_FAILED");
  return {
    network: HEDERA_TESTNET_NETWORK,
    status: "released",
    ...(value.transactionId ? { transactionId: value.transactionId } : {}),
    ...(value.payer ? { payer: value.payer } : {}),
    ...(value.paymentReference ? { paymentReference: value.paymentReference } : {}),
  };
}

export interface FixtureHederaX402Options {
  readonly expectedProof?: string;
  readonly requirementRevision?: string;
  readonly paymentRequired?: string;
  readonly quoteReference?: string;
  readonly payerReference?: string;
  readonly asset?: string;
  readonly authorizedAmount?: string;
  readonly maximumChargeUnits?: string;
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
  const quoteReference = options.quoteReference ?? "quote:fixture-v1";
  const payerReference = options.payerReference ?? "fixture:payer";
  const asset = options.asset ?? "HBAR";
  const authorizedAmount = options.authorizedAmount ?? "1";
  const maximumChargeUnits = options.maximumChargeUnits ?? "1000000";
  const acceptedProofs = new Map<string, {
    resource: string;
    requestHash: string;
    idempotencyKeyHash: string;
    requirementDigest: string;
    admission: HederaX402VerifiedPayment;
  }>();

  const verifier = createHederaX402AdmissionVerifier({
    now,
    requirements: async (input) => ({
      contractVersion: A2A_PAYMENT_CONTRACT_VERSION,
      scheme: A2A_PAYMENT_SCHEME,
      network: A2A_PAYMENT_NETWORK,
      requirementRevision,
      resource: normalizeResource(input.resource),
      paymentRequired,
      chargeQuote: {
        quoteReference,
        billingUnit: "usd_micro",
        maximumChargeUnits,
        expiresAt: futureIso(now(), expiresInSeconds),
      },
      expiresAt: futureIso(now(), expiresInSeconds),
    }),
    verifyProof: async (input) => {
      const proofHash = sha256(input.proof);
      const previous = acceptedProofs.get(proofHash);
      if (previous) {
        if (
          previous.resource !== input.challenge.resource ||
          previous.requestHash !== input.requestHash ||
          previous.idempotencyKeyHash !== input.idempotencyKeyHash ||
          previous.requirementDigest !== challengeRequirementDigest(input.challenge)
        ) {
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
        chargeQuote: input.challenge.chargeQuote,
        verifiedAt: now(),
        expiresAt: input.challenge.expiresAt,
        replayStatus: "fresh",
      };
      acceptedProofs.set(proofHash, {
        resource: input.challenge.resource,
        requestHash: input.requestHash,
        idempotencyKeyHash: input.idempotencyKeyHash,
        requirementDigest: challengeRequirementDigest(input.challenge),
        admission,
      });
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
  if (typeof value.paymentRequired !== "string" || !safeReference(value.requirementRevision) || value.paymentRequired.length === 0 || new TextEncoder().encode(value.paymentRequired).byteLength > MAX_REQUIREMENT_BYTES || /[\r\n]/u.test(value.paymentRequired)) throw new Error("A2A_PAYMENT_REQUIREMENT_INVALID");
  const normalizedResource = normalizeResource(resource);
  if (normalizeResource(value.resource) !== normalizedResource) throw new Error("A2A_PAYMENT_RESOURCE_MISMATCH");
  const expiresAt = parseIso(value.expiresAt);
  const currentTimestamp = Date.parse(currentTime);
  if (!Number.isFinite(currentTimestamp)) throw new Error("A2A_PAYMENT_TIME_INVALID");
  const chargeQuote = validateChargeQuote(value.chargeQuote, currentTimestamp, expiresAt);
  const normalizedChallenge = {
    ...value,
    resource: normalizedResource,
    chargeQuote,
    expiresAt: new Date(expiresAt).toISOString(),
  };
  if (expiresAt <= Date.parse(currentTime)) throw new HederaX402PaymentRejectedError("payment_expired", normalizedChallenge);
  return normalizedChallenge;
}

function validateVerifiedPayment(value: HederaX402VerifiedPayment, challenge: A2APaymentChallenge, currentTime: string): HederaX402VerifiedPayment {
  if (!safeReference(value.paymentReference) || !safeReference(value.payerReference) || !safeReference(value.asset)) throw new Error("A2A_PAYMENT_ADMISSION_REFERENCE_INVALID");
  if (value.requirementRevision !== challenge.requirementRevision || !/^[1-9][0-9]*$/u.test(value.authorizedAmount) || value.authorizedAmount.length > 128 || BigInt(value.authorizedAmount) <= 0n) throw new Error("A2A_PAYMENT_ADMISSION_INVALID");
  const currentTimestamp = Date.parse(currentTime);
  if (!Number.isFinite(currentTimestamp)) throw new Error("A2A_PAYMENT_TIME_INVALID");
  const chargeQuote = validateChargeQuote(value.chargeQuote, currentTimestamp, Date.parse(challenge.expiresAt));
  if (
    chargeQuote.quoteReference !== challenge.chargeQuote.quoteReference ||
    chargeQuote.billingUnit !== challenge.chargeQuote.billingUnit ||
    chargeQuote.maximumChargeUnits !== challenge.chargeQuote.maximumChargeUnits ||
    chargeQuote.expiresAt !== challenge.chargeQuote.expiresAt
  ) throw new Error("A2A_PAYMENT_QUOTE_MISMATCH");
  if (value.replayStatus !== "fresh" && value.replayStatus !== "replayed") throw new Error("A2A_PAYMENT_REPLAY_STATUS_INVALID");
  const verifiedAt = parseIso(value.verifiedAt);
  const expiresAt = parseIso(value.expiresAt);
  if (expiresAt > parseIso(challenge.expiresAt) || expiresAt <= verifiedAt || expiresAt <= currentTimestamp) {
    throw new HederaX402PaymentRejectedError("payment_expired", challenge);
  }
  return {
    ...value,
    chargeQuote,
    verifiedAt: new Date(verifiedAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

function validateChargeQuote(value: unknown, currentTimestamp: number, maximumExpiry: number): A2AChargeQuote {
  const record = asObject(value);
  if (!record || typeof record.quoteReference !== "string" || record.billingUnit !== "usd_micro" || typeof record.maximumChargeUnits !== "string" || typeof record.expiresAt !== "string") {
    throw new Error("A2A_PAYMENT_QUOTE_INVALID");
  }
  if (!safeReference(record.quoteReference) || !/^[1-9][0-9]*$/u.test(record.maximumChargeUnits) || record.maximumChargeUnits.length > MAX_CHARGE_UNITS_DIGITS) {
    throw new Error("A2A_PAYMENT_QUOTE_INVALID");
  }
  let maximumChargeUnits: bigint;
  try { maximumChargeUnits = BigInt(record.maximumChargeUnits); }
  catch { throw new Error("A2A_PAYMENT_QUOTE_INVALID"); }
  if (maximumChargeUnits <= 0n || maximumChargeUnits > MAX_CHARGE_UNITS) throw new Error("A2A_PAYMENT_QUOTE_INVALID");
  const expiresAt = parseIso(record.expiresAt);
  if (expiresAt <= currentTimestamp || expiresAt > maximumExpiry) throw new Error("A2A_PAYMENT_QUOTE_INVALID");
  return {
    quoteReference: record.quoteReference,
    billingUnit: "usd_micro",
    maximumChargeUnits: record.maximumChargeUnits,
    expiresAt: new Date(expiresAt).toISOString(),
  };
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
