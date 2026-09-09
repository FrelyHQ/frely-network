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
