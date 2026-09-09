import {
  BrokerError,
  type CapabilityRequest,
  type CapabilityResult,
  type PaymentEvidence,
  type ResolvedProvider,
} from "@frely-network/shared-types";
import { isSafePublicHttpUrl } from "@frely-network/shared-types";
import { PaymentError, type PaymentRequest } from "@frely-network/hedera-x402";
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
