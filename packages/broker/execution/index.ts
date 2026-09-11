import {
  BrokerError,
  type CapabilityRequest,
  type PaymentEvidence,
  type ResolvedProvider,
} from "@frely-network/shared-types";
import { isSafePublicHttpUrl } from "@frely-network/shared-types";
import {
  PaymentError,
  type PaymentAuthorization,
  type PaymentRequest,
  type HederaX402PaymentSettlementPort,
} from "@frely-network/hedera-x402";
import type { BrokerPaymentPort } from "../payment/index.ts";

export interface InvocationResult {
  output: unknown;
  payment?: PaymentEvidence;
}

export interface CapabilityInvocationPort {
  invoke(
    provider: ResolvedProvider,
    request: CapabilityRequest,
    correlationId: string,
  ): Promise<InvocationResult>;
}

export interface ResponsesInvocationConfig {
  payment: BrokerPaymentPort;
  headers?: HeadersInit;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  requirePayment?: boolean;
  defaultModel?: string;
}

export type A2APaymentSettlementPort = HederaX402PaymentSettlementPort;

export interface A2AServiceInvocationConfig {
  payment: BrokerPaymentPort;
  headers?: HeadersInit;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  defaultModel?: string;
  agentId?: string;
  settlement?: A2APaymentSettlementPort;
  /** When true, a real Network settle/release adapter is mandatory before returning. */
  requireSettlement?: boolean;
}

async function readResponse(response: Response, maxBytes: number): Promise<unknown> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new BrokerError("PROVIDER_RESPONSE_INVALID");
  const text = new TextDecoder().decode(bytes);
  if (!text) return null;
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("json")) {
    try {
      return JSON.parse(text);
    } catch {
      throw new BrokerError("PROVIDER_RESPONSE_INVALID");
    }
  }
  return text;
}

/** Responses-compatible invocation. It never calls a final Provider directly outside the selected endpoint. */
export class ResponsesInvocation implements CapabilityInvocationPort {
  private readonly maxRequestBytes: number;
  private readonly maxResponseBytes: number;
  private readonly requirePayment: boolean;
  private readonly defaultModel: string;

  constructor(private readonly config: ResponsesInvocationConfig) {
    this.maxRequestBytes = config.maxRequestBytes ?? 512 * 1024;
    this.maxResponseBytes = config.maxResponseBytes ?? 2 * 1024 * 1024;
    this.requirePayment = config.requirePayment ?? true;
    this.defaultModel = config.defaultModel ?? "vision-basic";
  }

  async invoke(
    provider: ResolvedProvider,
    request: CapabilityRequest,
    correlationId: string,
  ): Promise<InvocationResult> {
    if (!provider.verified || provider.protocol !== "responses") throw new BrokerError("PROTOCOL_NOT_SUPPORTED");
    if (!isSafePublicHttpUrl(provider.endpoint, { requireHttps: true })) throw new BrokerError("IDENTITY_VERIFICATION_FAILED");
    let body: Uint8Array;
    try {
      body = new TextEncoder().encode(JSON.stringify({
        model: request.model ?? this.defaultModel,
        input: request.input ?? request.task,
      }));
    } catch {
      throw new BrokerError("INVALID_REQUEST");
    }
    if (body.byteLength > this.maxRequestBytes) throw new BrokerError("INVALID_REQUEST");

    const headers = new Headers(this.config.headers);
    headers.set("accept", "application/json");
    headers.set("content-type", "application/json");
    headers.set("x-correlation-id", correlationId);
    const paymentRequest: PaymentRequest = {
      method: "POST",
      url: provider.endpoint,
      headers,
      body,
      ...(request.maxAmount !== undefined ? { maxAmount: request.maxAmount } : {}),
    };
    let paid;
    try {
      paid = await this.config.payment.request(paymentRequest);
    } catch (error) {
      if (error instanceof PaymentError) {
        const code = error.code === "PAYMENT_LIMIT_EXCEEDED"
          ? "PAYMENT_LIMIT_EXCEEDED"
          : error.code === "PAYMENT_NETWORK_UNSUPPORTED"
            ? "PAYMENT_NETWORK_UNSUPPORTED"
            : error.code === "PAYMENT_REQUIRED"
              ? "PAYMENT_REQUIRED"
              : "PAYMENT_FAILED";
        throw new BrokerError(code);
      }
      throw new BrokerError("PAYMENT_FAILED");
    }
    if (this.requirePayment && !paid.payment) throw new BrokerError("PAYMENT_REQUIRED");
    if (!paid.response.ok) throw new BrokerError("PROVIDER_REQUEST_FAILED");
    return {
      output: await readResponse(paid.response, this.maxResponseBytes),
      ...(paid.payment ? { payment: paid.payment } : {}),
    };
  }
}

interface A2AServiceResponse {
  readonly protocolVersion: "frely.a2a.v1";
  readonly task: {
    readonly id: string;
    readonly kind: "model.inference";
    readonly model: string;
    readonly status: "submitted" | "working" | "completed" | "failed";
    readonly requestId: string;
    readonly message?: { readonly role: "assistant"; readonly parts: readonly [{ readonly kind: "text"; readonly text: string }] };
    readonly errorCode?: string;
  };
  readonly payment: {
    readonly status: "settled" | "released" | "pending_settlement";
    readonly paymentReference: string;
    readonly billingUnit: "usd_micro";
    readonly maximumChargeUnits: string;
    readonly authorizedAmount: string;
    readonly finalChargeUnits?: string;
    readonly releasedChargeUnits?: string;
  };
}

const A2A_PROTOCOL_VERSION = "frely.a2a.v1" as const;
const A2A_TASK_KIND = "model.inference" as const;
const A2A_PAYMENT_NETWORK = "hedera:testnet" as const;
const A2A_BILLING_UNIT = "usd_micro" as const;
const MAX_A2A_CHARGE_UNITS = 9_223_372_036_854_775_807n;
const SAFE_A2A_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,191}$/u;

/** Calls a verified Frely A2A service and keeps x402 authorization transient. */
export class A2AServiceInvocation implements CapabilityInvocationPort {
  private readonly maxRequestBytes: number;
  private readonly maxResponseBytes: number;
  private readonly defaultModel: string;
  private readonly requireSettlement: boolean;

  constructor(private readonly config: A2AServiceInvocationConfig) {
    this.maxRequestBytes = config.maxRequestBytes ?? 256 * 1024;
    this.maxResponseBytes = config.maxResponseBytes ?? 2 * 1024 * 1024;
    this.defaultModel = config.defaultModel ?? "vision-basic";
    this.requireSettlement = config.requireSettlement ?? true;
    if (!Number.isSafeInteger(this.maxRequestBytes) || this.maxRequestBytes < 1 || !Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes < 1) {
      throw new BrokerError("INVALID_REQUEST");
    }
  }

  async invoke(
    provider: ResolvedProvider,
    request: CapabilityRequest,
    correlationId: string,
  ): Promise<InvocationResult> {
    if (!provider.verified || provider.protocol !== "a2a") throw new BrokerError("PROTOCOL_NOT_SUPPORTED");
    if (!isSafePublicHttpUrl(provider.endpoint, { requireHttps: true })) throw new BrokerError("IDENTITY_VERIFICATION_FAILED");
    if (request.input !== undefined) throw new BrokerError("INVALID_REQUEST");
    const endpoint = a2aTaskEndpoint(provider.endpoint);
    const body = encodeA2ARequest(request, this.defaultModel, this.maxRequestBytes);
    const headers = new Headers(this.config.headers);
    headers.set("accept", "application/json");
    headers.set("content-type", "application/json");
    headers.set("x-correlation-id", boundedHeader(correlationId, "correlation"));
    headers.set("idempotency-key", idempotencyKey(correlationId));
    if (this.config.agentId !== undefined) headers.set("x-a2a-agent-id", boundedHeader(this.config.agentId, "agent"));
    const paymentRequest: PaymentRequest = {
      method: "POST",
      url: endpoint,
      headers,
      body,
      ...(request.maxAmount !== undefined ? { maxAmount: request.maxAmount } : {}),
    };

    let paid: Awaited<ReturnType<BrokerPaymentPort["request"]>>;
    try {
      paid = await this.config.payment.request(paymentRequest);
    } catch (error) {
      throw paymentBrokerError(error);
    }
    if (!paid.authorization) throw new BrokerError("PAYMENT_REQUIRED");

    let serviceResponse: A2AServiceResponse;
    try {
      serviceResponse = await readA2AServiceResponse(paid.response, this.maxResponseBytes);
    } catch {
      throw new BrokerError(paid.response.ok ? "PROVIDER_RESPONSE_INVALID" : "PROVIDER_REQUEST_FAILED");
    }
    const projectedPayment = paymentEvidence(serviceResponse.payment);
    let settledPayment: PaymentEvidence;
    try {
      settledPayment = await this.finalizePayment(paid.authorization, projectedPayment);
    } catch (error) {
      if (error instanceof BrokerError) throw error;
      throw new BrokerError("PAYMENT_FAILED");
    }
    if (!paid.response.ok || serviceResponse.task.status === "failed") {
      throw new BrokerError("PROVIDER_REQUEST_FAILED");
    }
    return {
      output: serviceResponse.task.message?.parts[0]?.text ?? null,
      payment: settledPayment,
    };
  }

  private async finalizePayment(
    authorization: PaymentAuthorization,
    projected: PaymentEvidence,
  ): Promise<PaymentEvidence> {
    const settlement = this.config.settlement;
    if (!settlement) {
      if (this.requireSettlement) throw new BrokerError("PAYMENT_FAILED");
      return { ...projected, status: "pending_settlement" };
    }
    const input = { ...authorization, payment: projected };
    try {
      if (projected.status === "pending_settlement") {
        if (this.requireSettlement) throw new BrokerError("PAYMENT_FAILED");
        return projected;
      }
      // A released Relay projection means that no provider usage was charged.
      // The x402 transaction has not been broadcast yet, so there is nothing
      // to refund. Only a settled maximum is eligible for a compensating
      // release of the unused difference below.
      if (projected.status === "released") return projected;
      const settled = await settlement.settle(input);
      let result = mergePaymentEvidence(projected, settled, "settled");
      if (projected.releasedChargeUnits !== undefined && projected.releasedChargeUnits !== "0") {
        const released = await settlement.release({ ...input, payment: result });
        result = mergePaymentEvidence(result, released, "settled");
      }
      return result;
    } catch (error) {
      if (error instanceof BrokerError) throw error;
      throw new BrokerError("PAYMENT_FAILED");
    }
  }

}

export interface ProtocolInvocationConfig {
  responses: ResponsesInvocation;
  a2a: A2AServiceInvocation;
}

/** Routes only to protocols that have been verified by discovery and identity. */
export class ProtocolInvocation implements CapabilityInvocationPort {
  constructor(private readonly config: ProtocolInvocationConfig) {}

  invoke(provider: ResolvedProvider, request: CapabilityRequest, correlationId: string): Promise<InvocationResult> {
    if (provider.protocol === "responses") return this.config.responses.invoke(provider, request, correlationId);
    if (provider.protocol === "a2a") return this.config.a2a.invoke(provider, request, correlationId);
    throw new BrokerError("PROTOCOL_NOT_SUPPORTED");
  }
}

function paymentBrokerError(error: unknown): BrokerError {
  if (error instanceof PaymentError) {
    const code = error.code === "PAYMENT_LIMIT_EXCEEDED"
      ? "PAYMENT_LIMIT_EXCEEDED"
      : error.code === "PAYMENT_NETWORK_UNSUPPORTED"
        ? "PAYMENT_NETWORK_UNSUPPORTED"
        : error.code === "PAYMENT_REQUIRED"
          ? "PAYMENT_REQUIRED"
          : "PAYMENT_FAILED";
    return new BrokerError(code);
  }
  return new BrokerError("PAYMENT_FAILED");
}

function a2aTaskEndpoint(value: string): string {
  const url = new URL(value);
  const pathname = url.pathname.replace(/\/+$/u, "") || "/";
  if (pathname.endsWith("/a2a/tasks")) return url.toString();
  if (pathname.endsWith("/a2a")) {
    url.pathname = `${pathname}/tasks`;
    return url.toString();
  }
  throw new BrokerError("IDENTITY_VERIFICATION_FAILED");
}

function encodeA2ARequest(request: CapabilityRequest, model: string, maxBytes: number): Uint8Array {
  let encoded: string;
  try {
    encoded = JSON.stringify({
      protocolVersion: A2A_PROTOCOL_VERSION,
      kind: A2A_TASK_KIND,
      model: request.model ?? model,
      message: { role: "user", parts: [{ kind: "text", text: request.task }] },
    });
  } catch {
    throw new BrokerError("INVALID_REQUEST");
  }
  const body = new TextEncoder().encode(encoded);
  if (body.byteLength > maxBytes) throw new BrokerError("INVALID_REQUEST");
  return body;
}

async function readA2AServiceResponse(response: Response, maxBytes: number): Promise<A2AServiceResponse> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) throw new BrokerError("PROVIDER_RESPONSE_INVALID");
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new BrokerError("PROVIDER_RESPONSE_INVALID"); }
  return parseA2AServiceResponse(value);
}

function parseA2AServiceResponse(value: unknown): A2AServiceResponse {
  const record = object(value);
  assertKeys(record, ["protocolVersion", "task", "payment"]);
  if (record.protocolVersion !== A2A_PROTOCOL_VERSION) throw new BrokerError("PROVIDER_RESPONSE_INVALID");
  const task = object(record.task);
  assertKeys(task, ["id", "kind", "model", "status", "requestId", "message", "errorCode"]);
  if (!safeReference(task.id) || task.kind !== A2A_TASK_KIND || !boundedText(task.model, 256) || !safeReference(task.requestId)) throw new BrokerError("PROVIDER_RESPONSE_INVALID");
  if (task.status !== "submitted" && task.status !== "working" && task.status !== "completed" && task.status !== "failed") throw new BrokerError("PROVIDER_RESPONSE_INVALID");
  const message = task.message === undefined ? undefined : parseAssistantMessage(task.message);
  const errorCode = task.errorCode === undefined ? undefined : safeErrorCode(task.errorCode);
  const payment = parsePaymentProjection(record.payment);
  if ((task.status === "submitted" || task.status === "working") && payment.status !== "pending_settlement") {
    throw new BrokerError("PROVIDER_RESPONSE_INVALID");
  }
  return {
    protocolVersion: A2A_PROTOCOL_VERSION,
    task: {
      id: task.id,
      kind: A2A_TASK_KIND,
      model: task.model,
      status: task.status,
      requestId: task.requestId,
      ...(message ? { message } : {}),
      ...(errorCode ? { errorCode } : {}),
    },
    payment,
  };
}

function parseAssistantMessage(value: unknown): NonNullable<A2AServiceResponse["task"]["message"]> {
  const record = object(value);
  assertKeys(record, ["role", "parts"]);
  if (record.role !== "assistant" || !Array.isArray(record.parts) || record.parts.length !== 1) throw new BrokerError("PROVIDER_RESPONSE_INVALID");
  const part = object(record.parts[0]);
  assertKeys(part, ["kind", "text"]);
  if (part.kind !== "text" || !boundedText(part.text, 128 * 1024)) throw new BrokerError("PROVIDER_RESPONSE_INVALID");
  return { role: "assistant", parts: [{ kind: "text", text: part.text }] };
}

function parsePaymentProjection(value: unknown): A2AServiceResponse["payment"] {
  const record = object(value);
  assertKeys(record, ["status", "paymentReference", "billingUnit", "maximumChargeUnits", "authorizedAmount", "finalChargeUnits", "releasedChargeUnits"]);
  if (record.status !== "settled" && record.status !== "released" && record.status !== "pending_settlement") throw new BrokerError("PROVIDER_RESPONSE_INVALID");
  if (!safeReference(record.paymentReference) || record.billingUnit !== A2A_BILLING_UNIT) throw new BrokerError("PROVIDER_RESPONSE_INVALID");
  const maximumChargeUnits = positiveChargeUnits(record.maximumChargeUnits);
  const authorizedAmount = positiveDecimal(record.authorizedAmount, 128);
  const finalChargeUnits = optionalNonNegativeChargeUnits(record.finalChargeUnits);
  const releasedChargeUnits = optionalNonNegativeChargeUnits(record.releasedChargeUnits);
  if (record.status === "pending_settlement" && (finalChargeUnits !== undefined || releasedChargeUnits !== undefined)) throw new BrokerError("PROVIDER_RESPONSE_INVALID");
  if (record.status !== "pending_settlement" && (finalChargeUnits === undefined || releasedChargeUnits === undefined)) throw new BrokerError("PROVIDER_RESPONSE_INVALID");
  if (finalChargeUnits !== undefined && BigInt(finalChargeUnits) > BigInt(maximumChargeUnits)) throw new BrokerError("PROVIDER_RESPONSE_INVALID");
  if (releasedChargeUnits !== undefined && BigInt(releasedChargeUnits) > BigInt(maximumChargeUnits)) throw new BrokerError("PROVIDER_RESPONSE_INVALID");
  if (finalChargeUnits !== undefined && releasedChargeUnits !== undefined && BigInt(finalChargeUnits) + BigInt(releasedChargeUnits) !== BigInt(maximumChargeUnits)) throw new BrokerError("PROVIDER_RESPONSE_INVALID");
  return {
    status: record.status,
    paymentReference: record.paymentReference,
    billingUnit: A2A_BILLING_UNIT,
    maximumChargeUnits,
    authorizedAmount,
    ...(finalChargeUnits === undefined ? {} : { finalChargeUnits }),
    ...(releasedChargeUnits === undefined ? {} : { releasedChargeUnits }),
  };
}

function paymentEvidence(value: A2AServiceResponse["payment"]): PaymentEvidence {
  return {
    network: A2A_PAYMENT_NETWORK,
    status: value.status,
    paymentReference: value.paymentReference,
    billingUnit: value.billingUnit,
    maximumChargeUnits: value.maximumChargeUnits,
    authorizedAmount: value.authorizedAmount,
    ...(value.finalChargeUnits === undefined ? {} : { finalChargeUnits: value.finalChargeUnits }),
    ...(value.releasedChargeUnits === undefined ? {} : { releasedChargeUnits: value.releasedChargeUnits }),
  };
}

function mergePaymentEvidence(base: PaymentEvidence, extra: PaymentEvidence, status: NonNullable<PaymentEvidence["status"]>): PaymentEvidence {
  return {
    ...base,
    network: extra.network,
    status,
    ...(base.transactionId ?? extra.transactionId ? { transactionId: base.transactionId ?? extra.transactionId } : {}),
    ...(base.payer ?? extra.payer ? { payer: base.payer ?? extra.payer } : {}),
  };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BrokerError("PROVIDER_RESPONSE_INVALID");
  return value as Record<string, unknown>;
}

function assertKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new BrokerError("PROVIDER_RESPONSE_INVALID");
}

function safeReference(value: unknown): value is string {
  return typeof value === "string" && SAFE_A2A_REFERENCE.test(value);
}

function safeErrorCode(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]{1,96}$/u.test(value)) throw new BrokerError("PROVIDER_RESPONSE_INVALID");
  return value;
}

function boundedText(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && new TextEncoder().encode(value).byteLength <= maxBytes;
}

function positiveDecimal(value: unknown, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || !/^[1-9][0-9]*$/u.test(value)) throw new BrokerError("PROVIDER_RESPONSE_INVALID");
  return value;
}

function positiveChargeUnits(value: unknown): string {
  const result = positiveDecimal(value, 19);
  try { if (BigInt(result) > MAX_A2A_CHARGE_UNITS) throw new Error("charge"); }
  catch { throw new BrokerError("PROVIDER_RESPONSE_INVALID"); }
  return result;
}

function optionalNonNegativeChargeUnits(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > 19 || !/^\d+$/u.test(value)) throw new BrokerError("PROVIDER_RESPONSE_INVALID");
  try { if (BigInt(value) > MAX_A2A_CHARGE_UNITS) throw new Error("charge"); }
  catch { throw new BrokerError("PROVIDER_RESPONSE_INVALID"); }
  return value;
}

function boundedHeader(value: string, field: string): string {
  void field;
  if (typeof value !== "string" || value.length === 0 || value.length > 192 || /[\r\n]/u.test(value)) throw new BrokerError("INVALID_REQUEST");
  return value;
}

function idempotencyKey(correlationId: string): string {
  const normalized = correlationId.replace(/[^A-Za-z0-9._:-]/gu, "-").slice(0, 160);
  if (!normalized) throw new BrokerError("INVALID_REQUEST");
  return `a2a-${normalized}`;
}
