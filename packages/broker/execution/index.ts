import {
  BrokerError,
  type CapabilityRequest,
  type PaymentEvidence,
  type ResolvedProvider,
} from "@frely-network/shared-types";
import { isSafePublicHttpUrl } from "@frely-network/shared-types";
import {
  PaymentError,
  type PaymentRequest,
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

export interface A2AServiceInvocationConfig {
  headers?: HeadersInit;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  defaultModel?: string;
  agentId?: string;
  fetcher?: (input: string, init: RequestInit) => Promise<Response>;
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

/** Responses-compatible invocation through a payment-aware provider endpoint. */
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

const A2A_JSONRPC_VERSION = "2.0" as const;
const A2A_METHOD_MESSAGE_SEND = "message/send" as const;

/** Calls a verified Frely A2A service as a normal authenticated API client. */
export class A2AServiceInvocation implements CapabilityInvocationPort {
  private readonly maxRequestBytes: number;
  private readonly maxResponseBytes: number;
  private readonly defaultModel: string;
  private readonly fetcher: (input: string, init: RequestInit) => Promise<Response>;

  constructor(private readonly config: A2AServiceInvocationConfig) {
    this.maxRequestBytes = config.maxRequestBytes ?? 256 * 1024;
    this.maxResponseBytes = config.maxResponseBytes ?? 2 * 1024 * 1024;
    this.defaultModel = config.defaultModel ?? "vision-basic";
    this.fetcher = config.fetcher ?? ((input, init) => globalThis.fetch(input, init));
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

    const endpoint = a2aEndpoint(provider.endpoint);
    const idempotency = idempotencyKey(correlationId);
    const body = encodeA2AJsonRpcRequest(request, this.defaultModel, correlationId, idempotency, this.maxRequestBytes);
    const headers = cleanFrelyHeaders(this.config.headers);
    headers.set("accept", "application/json");
    headers.set("content-type", "application/json");
    headers.set("x-correlation-id", boundedHeader(correlationId));
    headers.set("idempotency-key", idempotency);
    if (this.config.agentId !== undefined) headers.set("x-a2a-agent-id", boundedHeader(this.config.agentId));

    let response: Response;
    try {
      response = await this.fetcher(endpoint, { method: "POST", headers, body });
    } catch {
      throw new BrokerError("PROVIDER_REQUEST_FAILED");
    }
    if (!response.ok) throw new BrokerError("PROVIDER_REQUEST_FAILED");
    return { output: await readA2AJsonRpcResponse(response, this.maxResponseBytes, correlationId) };
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

function a2aEndpoint(value: string): string {
  const url = new URL(value);
  const pathname = url.pathname.replace(/\/+$/u, "") || "/";
  if (!pathname.endsWith("/a2a")) throw new BrokerError("IDENTITY_VERIFICATION_FAILED");
  url.pathname = pathname;
  return url.toString();
}

function encodeA2AJsonRpcRequest(
  request: CapabilityRequest,
  model: string,
  correlationId: string,
  idempotency: string,
  maxBytes: number,
): string {
  let encoded: string;
  try {
    encoded = JSON.stringify({
      jsonrpc: A2A_JSONRPC_VERSION,
      id: boundedHeader(correlationId),
      method: A2A_METHOD_MESSAGE_SEND,
      params: {
        message: {
          kind: "message",
          role: "user",
          messageId: idempotency,
          parts: [{ kind: "text", text: request.task }],
        },
        metadata: { "frely.model": request.model ?? model },
      },
    });
  } catch {
    throw new BrokerError("INVALID_REQUEST");
  }
  const byteLength = new TextEncoder().encode(encoded).byteLength;
  if (byteLength === 0 || byteLength > maxBytes) throw new BrokerError("INVALID_REQUEST");
  return encoded;
}

async function readA2AJsonRpcResponse(response: Response, maxBytes: number, correlationId: string): Promise<string> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) throw new BrokerError("PROVIDER_RESPONSE_INVALID");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new BrokerError("PROVIDER_RESPONSE_INVALID");
  }
  const record = object(value);
  if (record.jsonrpc !== A2A_JSONRPC_VERSION || record.id !== correlationId) throw new BrokerError("PROVIDER_RESPONSE_INVALID");
  if (record.error !== undefined) throw new BrokerError("PROVIDER_REQUEST_FAILED");
  const result = object(record.result);
  if (result.kind !== "task" || typeof result.id !== "string" || result.id.length === 0) throw new BrokerError("PROVIDER_RESPONSE_INVALID");
  const status = object(result.status);
  if (status.state === "failed") throw new BrokerError("PROVIDER_REQUEST_FAILED");
  if (status.state !== "completed") throw new BrokerError("PROVIDER_RESPONSE_INVALID");
  if (!Array.isArray(result.artifacts) || result.artifacts.length === 0) throw new BrokerError("PROVIDER_RESPONSE_INVALID");
  for (const artifactValue of result.artifacts) {
    const artifact = object(artifactValue);
    if (!Array.isArray(artifact.parts)) continue;
    for (const partValue of artifact.parts) {
      const part = object(partValue);
      if (part.kind === "text" && boundedText(part.text, 128 * 1024)) return part.text;
    }
  }
  throw new BrokerError("PROVIDER_RESPONSE_INVALID");
}

function cleanFrelyHeaders(source: HeadersInit | undefined): Headers {
  const headers = new Headers(source);
  for (const name of [
    "payment-signature",
    "payment-required",
    "payment-response",
    "x-payment",
    "x-payment-proof",
    "x-payment-response",
  ]) headers.delete(name);
  return headers;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BrokerError("PROVIDER_RESPONSE_INVALID");
  return value as Record<string, unknown>;
}

function boundedText(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && new TextEncoder().encode(value).byteLength <= maxBytes;
}

function boundedHeader(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 192 || /[\r\n\u0000]/u.test(value)) throw new BrokerError("INVALID_REQUEST");
  return value;
}

function idempotencyKey(correlationId: string): string {
  const normalized = correlationId.replace(/[^A-Za-z0-9._:-]/gu, "-").slice(0, 160);
  if (!normalized) throw new BrokerError("INVALID_REQUEST");
  return `a2a-${normalized}`;
}
