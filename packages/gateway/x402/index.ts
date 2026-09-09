import {
  decodePaymentHeader,
  type PaymentPayload,
  type PaymentRequirement,
  type PaymentRequired,
  type X402Version,
} from "@frely-network/hedera-x402";

export interface GatewayVerification {
  isValid: boolean;
  payer?: string;
  invalidReason?: string;
}

export interface GatewaySettlement {
  success: boolean;
  network: string;
  transaction?: string;
  payer?: string;
  errorReason?: string;
}

export interface X402GatewayVerifier {
  verify(payload: PaymentPayload, requirement: PaymentRequirement): Promise<GatewayVerification>;
}

export interface X402GatewaySettler {
  settle(payload: PaymentPayload, requirement: PaymentRequirement): Promise<GatewaySettlement>;
}

export interface X402GatewayConfig {
  verifier: X402GatewayVerifier;
  settler: X402GatewaySettler;
  network: string;
  maxAmount?: string;
  version?: X402Version;
}

export class GatewayPaymentError extends Error {
  readonly code = "PAYMENT_GATEWAY_FAILED" as const;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function amountOf(requirement: PaymentRequirement): bigint {
  const amount = requirement.amount ?? requirement.maxAmountRequired;
  if (!amount || !/^\d+$/u.test(amount)) throw new GatewayPaymentError();
  return BigInt(amount);
}

function encode(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function requirementsResponse(
  requirements: PaymentRequired,
  error?: string,
): Response {
  const body = {
    ...requirements,
    ...(error ? { error } : {}),
  };
  const header = encode(body);
  const headerName = requirements.x402Version === 1 ? "X-PAYMENT-REQUIRED" : "PAYMENT-REQUIRED";
  return Response.json(body, {
    status: 402,
    headers: {
      "cache-control": "no-store",
      [headerName]: header,
    },
  });
}

function settlementResponse(response: Response, settlement: GatewaySettlement, version: X402Version): Response {
  const headerName = version === 1 ? "X-PAYMENT-RESPONSE" : "PAYMENT-RESPONSE";
  const body = {
    success: settlement.success,
    network: settlement.network,
    ...(settlement.transaction ? { transaction: settlement.transaction } : {}),
    ...(settlement.payer ? { payer: settlement.payer } : {}),
  };
  const headers = new Headers(response.headers);
  headers.set(headerName, encode(body));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function paymentPayload(value: unknown): PaymentPayload | undefined {
  const record = asObject(value);
  if (!record || (record.x402Version !== 1 && record.x402Version !== 2) || !asObject(record.payload)) return undefined;
  return record as unknown as PaymentPayload;
}

function acceptedRequirement(payload: PaymentPayload, requirements: PaymentRequired): PaymentRequirement | undefined {
  const accepted = asObject(payload.accepted);
  if (payload.x402Version === 1) {
    const scheme = typeof payload.scheme === "string" ? payload.scheme : undefined;
    const network = typeof payload.network === "string" ? payload.network : undefined;
    return requirements.accepts.find((candidate) => candidate.scheme === scheme && candidate.network === network);
  }
  if (!accepted || typeof accepted.scheme !== "string" || typeof accepted.network !== "string") return undefined;
  return requirements.accepts.find((candidate) => {
    if (candidate.scheme !== accepted.scheme || candidate.network !== accepted.network) return false;
    const expectedAmount = candidate.amount ?? candidate.maxAmountRequired;
    const actualAmount = accepted.amount ?? accepted.maxAmountRequired;
    if (expectedAmount !== actualAmount) return false;
    if (candidate.asset !== undefined && candidate.asset !== accepted.asset) return false;
    if (candidate.payTo !== undefined && candidate.payTo !== accepted.payTo) return false;
    return true;
  });
}

/** Payee-side admission/settlement only. It owns no users, plans, credentials or ledger. */
export class X402Gateway {
  private readonly version: X402Version;

  constructor(private readonly config: X402GatewayConfig) {
    this.version = config.version ?? 2;
    if (config.maxAmount !== undefined && !/^\d+$/u.test(config.maxAmount)) throw new GatewayPaymentError();
  }

  async handle(
    request: Request,
    requirements: PaymentRequired,
    handler: () => Promise<Response> | Response,
  ): Promise<Response> {
    if (requirements.x402Version !== this.version) throw new GatewayPaymentError();
    const headerName = requirements.x402Version === 1 ? "X-PAYMENT" : "PAYMENT-SIGNATURE";
    const encoded = request.headers.get(headerName) ?? request.headers.get("X-PAYMENT");
    if (!encoded) return requirementsResponse(requirements);

    let payload: PaymentPayload;
    try {
      const decoded = paymentPayload(decodePaymentHeader(encoded));
      if (!decoded) return requirementsResponse(requirements, "PAYMENT_REJECTED");
      payload = decoded;
    } catch {
      return requirementsResponse(requirements, "PAYMENT_REJECTED");
    }
    if (!payload) return requirementsResponse(requirements, "PAYMENT_REJECTED");
    if (payload.x402Version !== requirements.x402Version) return requirementsResponse(requirements, "PAYMENT_REJECTED");
    const requirement = acceptedRequirement(payload, requirements);
    if (!requirement || requirement.scheme !== "exact" || requirement.network !== this.config.network) {
      return requirementsResponse(requirements, "PAYMENT_REJECTED");
    }
    if (this.config.maxAmount !== undefined && amountOf(requirement) > BigInt(this.config.maxAmount)) {
      return requirementsResponse(requirements, "PAYMENT_LIMIT_EXCEEDED");
    }

    let verification: GatewayVerification;
    try {
      verification = await this.config.verifier.verify(payload, requirement);
    } catch {
      return requirementsResponse(requirements, "PAYMENT_REJECTED");
    }
    if (!verification.isValid) return requirementsResponse(requirements, "PAYMENT_REJECTED");

    const response = await handler();
    if (!response.ok) return response;
    let settlement: GatewaySettlement;
    try {
      settlement = await this.config.settler.settle(payload, requirement);
    } catch {
      return Response.json({ code: "PAYMENT_SETTLEMENT_FAILED" }, { status: 502 });
    }
    if (!settlement.success || settlement.network !== this.config.network) return Response.json({ code: "PAYMENT_SETTLEMENT_FAILED" }, { status: 502 });
    return settlementResponse(response, {
      ...settlement,
      ...(settlement.payer ?? verification.payer ? { payer: settlement.payer ?? verification.payer } : {}),
    }, requirements.x402Version);
  }
}
