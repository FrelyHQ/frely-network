import {
  validateNetworkWeb2FulfillmentRequest,
  validateNetworkWeb2FulfillmentResponse,
  validateNetworkWeb2PurchaseIntent,
  type NetworkWeb2FulfillmentRequest,
  type NetworkWeb2FulfillmentResponse,
  type NetworkWeb2PurchaseIntent,
} from "@frely-network/web2-fulfillment-contract";
import type { PaymentEvidence } from "@frely-network/shared-types";

export interface FrelyWeb2FulfillmentClientConfig {
  readonly origin: string;
  readonly token: string;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export interface CreatePlanPurchaseIntentInput {
  readonly planId: string;
  readonly planVersion: string;
  readonly recipientFrelyUserId: string;
}

export interface CreateOfficialSkillPurchaseIntentInput {
  readonly productId: string;
  readonly productVersion: string;
  readonly recipientFrelyUserId: string;
}


export interface SettledFrelyWeb2PaymentInput {
  readonly intent: NetworkWeb2PurchaseIntent;
  readonly purchaseId: string;
  readonly payment: PaymentEvidence;
  readonly settledAt: string;
}

export class FrelyWeb2FulfillmentClientError extends Error {
  constructor(readonly code: "CONFIG_INVALID" | "REQUEST_FAILED" | "RESPONSE_INVALID") {
    super(code);
    this.name = "FrelyWeb2FulfillmentClientError";
  }
}

export class FrelyWeb2FulfillmentClient {
  private readonly origin: URL;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(
    private readonly config: FrelyWeb2FulfillmentClientConfig,
    private readonly fetcher: (input: string, init: RequestInit) => Promise<Response> = (input, init) => fetch(input, init),
  ) {
    this.origin = validOrigin(config.origin);
    if (typeof config.token !== "string" || config.token.trim().length < 32 || /[\r\n\u0000]/u.test(config.token)) throw failure("CONFIG_INVALID");
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.maxResponseBytes = config.maxResponseBytes ?? 131_072;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || !Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes < 1) throw failure("CONFIG_INVALID");
  }

  async createPlanPurchaseIntent(input: CreatePlanPurchaseIntentInput): Promise<NetworkWeb2PurchaseIntent> {
    const payload = exactPlanIntentInput(input);
    return validateNetworkWeb2PurchaseIntent(await this.postJson("/api/internal/network/web2-purchases/intents", payload));
  }



  async createOfficialSkillPurchaseIntent(input: CreateOfficialSkillPurchaseIntentInput): Promise<NetworkWeb2PurchaseIntent> {
    const payload = exactOfficialSkillIntentInput(input);
    return validateNetworkWeb2PurchaseIntent(await this.postJson("/api/internal/network/web2-purchases/official-skill-intents", payload));
  }

  async fulfillSettledPayment(input: SettledFrelyWeb2PaymentInput): Promise<NetworkWeb2FulfillmentResponse> {
    const intent = validateNetworkWeb2PurchaseIntent(input.intent);
    const evidence = input.payment;
    if (evidence.status !== "settled" || !evidence.transactionId || !evidence.paymentReference || !evidence.payer ||
        !evidence.authorizedAmount || evidence.authorizedAmount !== intent.payment.amountAtomic || evidence.network !== intent.payment.network) {
      throw failure("RESPONSE_INVALID");
    }
    const request: NetworkWeb2FulfillmentRequest = validateNetworkWeb2FulfillmentRequest({
      contractVersion: intent.contractVersion,
      intentId: intent.intentId,
      payment: {
        sourceKind: "network_purchase",
        purchaseId: exactReference(input.purchaseId),
        network: evidence.network,
        asset: intent.payment.asset,
        amountAtomic: evidence.authorizedAmount,
        transactionId: evidence.transactionId,
        paymentReference: evidence.paymentReference,
        payerReference: evidence.payer,
        payeeReference: intent.payment.payeeReference,
        settledAt: exactTimestamp(input.settledAt),
      },
    });
    return this.fulfill(request);
  }

  async fulfill(requestValue: unknown): Promise<NetworkWeb2FulfillmentResponse> {
    const request: NetworkWeb2FulfillmentRequest = validateNetworkWeb2FulfillmentRequest(requestValue);
    return validateNetworkWeb2FulfillmentResponse(await this.postJson("/api/internal/network/web2-purchases/fulfillments", request));
  }

  private async postJson(path: string, body: unknown): Promise<unknown> {
    const endpoint = new URL(path, this.origin).toString();
    let response: Response;
    try {
      response = await this.fetcher(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", "x-frely-network-token": this.config.token },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch { throw failure("REQUEST_FAILED"); }
    if (!response.ok || response.redirected) throw failure("REQUEST_FAILED");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength < 1 || bytes.byteLength > this.maxResponseBytes) throw failure("RESPONSE_INVALID");
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw failure("RESPONSE_INVALID"); }
  }
}

function exactPlanIntentInput(value: CreatePlanPurchaseIntentInput): CreatePlanPurchaseIntentInput {
  const reference = (input: unknown): string => {
    if (typeof input !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,255}$/u.test(input)) throw failure("CONFIG_INVALID");
    return input;
  };
  return { planId: reference(value.planId), planVersion: reference(value.planVersion), recipientFrelyUserId: reference(value.recipientFrelyUserId) };
}


function exactOfficialSkillIntentInput(value: CreateOfficialSkillPurchaseIntentInput): CreateOfficialSkillPurchaseIntentInput {
  return { productId: exactReference(value.productId), productVersion: exactReference(value.productVersion), recipientFrelyUserId: exactReference(value.recipientFrelyUserId) };
}

function exactReference(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,255}$/u.test(value)) throw failure("CONFIG_INVALID");
  return value;
}

function exactTimestamp(value: unknown): string {
  if (typeof value !== "string" || value.length > 64 || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) throw failure("CONFIG_INVALID");
  return value;
}

function validOrigin(value: string): URL {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw new Error();
    return url;
  } catch { throw failure("CONFIG_INVALID"); }
}

function failure(code: FrelyWeb2FulfillmentClientError["code"]): FrelyWeb2FulfillmentClientError {
  return new FrelyWeb2FulfillmentClientError(code);
}
