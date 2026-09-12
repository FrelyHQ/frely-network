import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import { PaymentPayloadSchema } from "@x402/core/schemas";
import {
  HTTPFacilitatorClient,
  x402HTTPResourceServer,
  x402ResourceServer,
  type FacilitatorClient,
  type HTTPAdapter,
  type HTTPProcessResult,
  type HTTPRequestContext,
  type HTTPResponseInstructions,
} from "@x402/core/server";
import { SettleError } from "@x402/core/types";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { ExactHederaScheme } from "@x402/hedera/exact/server";

const PAYMENT_HEADER_LIMIT_BYTES = 64 * 1024;
const MAX_TIMEOUT_SECONDS = 120;
const NETWORK = "hedera:testnet";
const HBAR_ASSET = "0.0.0";
const BODY_SHA256 = /^[0-9a-f]{64}$/;

const FROZEN = {
  resourceUrl: "http://127.0.0.1:13600/v1/responses",
  amountAtomic: "100000000",
  payTo: "0.0.10403579",
  feePayer: "0.0.7162784",
  facilitatorUrl: "https://api.testnet.blocky402.com",
} as const;

// verify 拒绝可重试；一旦调用 Blocky settle，同 requestId 只查询原交易。
const paymentAttempt = new AsyncLocalStorage<{ blockySettleCalled: boolean }>();

export type NetworkX402Admission =
  | { kind: "response"; response: Response }
  | { kind: "settled"; finish(response: Response): Promise<Response> };

export type NetworkX402Gate = {
  admit(request: Request, body: string): Promise<NetworkX402Admission>;
};

export type NetworkX402GateConfig = {
  resourceUrl: string;
  amountAtomic: string;
  payTo: string;
  feePayer: string;
  facilitatorUrl: string;
  facilitator?: FacilitatorClient;
};

type AttemptState = "paying" | "settled" | "delivered";
type AttemptRecord = { fingerprint: string; state: AttemptState };

const STATE_RANK: Record<AttemptState, number> = {
  paying: 1,
  settled: 2,
  delivered: 3,
};

class NetworkRequestAdapter implements HTTPAdapter {
  constructor(
    private readonly request: Request,
    private readonly body: string,
  ) {}

  getHeader(name: string): string | undefined {
    return this.request.headers.get(name) ?? undefined;
  }

  getMethod(): string {
    return this.request.method;
  }

  getPath(): string {
    return new URL(this.request.url).pathname;
  }

  getUrl(): string {
    return this.request.url;
  }

  getAcceptHeader(): string {
    return this.request.headers.get("accept") ?? "";
  }

  getUserAgent(): string {
    return this.request.headers.get("user-agent") ?? "";
  }

  getBody(): unknown {
    return this.body;
  }
}

// 官方 upfront 不会调用 facilitator.verify；在 settle 内先 verify 再 settle。
class UpfrontFacilitator implements FacilitatorClient {
  constructor(private readonly delegate: FacilitatorClient) {}

  getSupported() {
    return this.delegate.getSupported();
  }

  verify(payload: PaymentPayload, requirements: PaymentRequirements) {
    return this.delegate.verify(payload, requirements);
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    const verification = await this.delegate.verify(payload, requirements);
    if (!verification.isValid) return failedVerification(verification, requirements);
    const attempt = paymentAttempt.getStore();
    if (attempt) attempt.blockySettleCalled = true;
    return settleOnce(this.delegate, payload, requirements);
  }
}

export function readNetworkX402Config(
  env: Record<string, string | undefined> = process.env,
): Omit<NetworkX402GateConfig, "facilitator"> {
  const config = {
    resourceUrl: env.FRELY_X402_RESOURCE_URL?.trim() ?? "",
    amountAtomic: env.FRELY_X402_AMOUNT_ATOMIC?.trim() ?? "",
    payTo: env.FRELY_X402_PAY_TO?.trim() ?? "",
    feePayer: env.FRELY_X402_FEE_PAYER?.trim() ?? "",
    facilitatorUrl: env.FRELY_X402_FACILITATOR_URL?.trim() ?? "",
  };
  assertFrozenConfig(config);
  return config;
}

export async function createNetworkX402Gate(config: NetworkX402GateConfig): Promise<NetworkX402Gate> {
  assertFrozenConfig(config);
  const expected = expectedQuote();
  const resourcePath = new URL(FROZEN.resourceUrl).pathname;
  const facilitator = new UpfrontFacilitator(
    config.facilitator ?? new HTTPFacilitatorClient({ url: FROZEN.facilitatorUrl, timeoutMs: 12_000 }),
  );
  const resourceServer = new x402ResourceServer(facilitator)
    .register(NETWORK, new ExactHederaScheme());
  const httpServer = new x402HTTPResourceServer(resourceServer, {
    "POST /v1/responses": {
      accepts: {
        scheme: "exact",
        network: NETWORK,
        payTo: FROZEN.payTo,
        price: { asset: HBAR_ASSET, amount: FROZEN.amountAtomic },
        maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
        extra: { feePayer: FROZEN.feePayer, paymentFlow: "upfront" },
      },
      resource: FROZEN.resourceUrl,
      description: "Frely Network vision-basic",
      mimeType: "application/json",
    },
  });
  await httpServer.initialize();
  // 进程内幂等；重启后不恢复，不引入数据库或分布式锁。
  const attempts = new Map<string, AttemptRecord>();
  return {
    admit: (request, body) => admitRequest({
      request,
      body,
      expected,
      resourcePath,
      httpServer,
      attempts,
    }),
  };
}

async function admitRequest(input: {
  request: Request;
  body: string;
  expected: PaymentRequirements;
  resourcePath: string;
  httpServer: x402HTTPResourceServer;
  attempts: Map<string, AttemptRecord>;
}): Promise<NetworkX402Admission> {
  const bound = bindIncomingRequest(input.request, input.body, input.expected, input.resourcePath);
  if (!bound.ok) return bound.admission;
  const adapter = new NetworkRequestAdapter(input.request, input.body);
  const context: HTTPRequestContext = {
    adapter,
    path: adapter.getPath(),
    method: adapter.getMethod(),
    ...(bound.paymentHeader ? { paymentHeader: bound.paymentHeader } : {}),
  };
  if (!bound.paymentHeader) return processHttpAdmission(input.httpServer, context);
  return admitPaidRequest(input, bound, context);
}

async function admitPaidRequest(
  input: {
    httpServer: x402HTTPResourceServer;
    attempts: Map<string, AttemptRecord>;
  },
  bound: { requestId: string; fingerprint: string },
  context: HTTPRequestContext,
): Promise<NetworkX402Admission> {
  const occupied = occupiedAdmission(input.attempts, bound.requestId, bound.fingerprint);
  if (occupied) return occupied;
  input.attempts.set(bound.requestId, { fingerprint: bound.fingerprint, state: "paying" });
  const attempt = { blockySettleCalled: false };
  return paymentAttempt.run(attempt, async () => {
    try {
      const processed = await input.httpServer.processHTTPRequest(context);
      const admission = await settleVerifiedPayment(
        processed,
        input.httpServer,
        context,
        input.attempts,
        bound.requestId,
      );
      if (admission.kind !== "settled" && !attempt.blockySettleCalled) {
        input.attempts.delete(bound.requestId);
      }
      return admission;
    } catch {
      if (!attempt.blockySettleCalled) input.attempts.delete(bound.requestId);
      return reject("PAYMENT_PROCESSING_UNKNOWN", 503);
    }
  });
}

function bindIncomingRequest(
  request: Request,
  body: string,
  expected: PaymentRequirements,
  resourcePath: string,
): { ok: true; requestId: string; fingerprint: string; paymentHeader: string | undefined } | { ok: false; admission: NetworkX402Admission } {
  const requestId = request.headers.get("x-frely-request-id")?.trim() ?? "";
  if (request.method !== "POST") return { ok: false, admission: reject("INVALID_REQUEST", 400) };
  if (new URL(request.url).pathname !== resourcePath) {
    return { ok: false, admission: reject("INVALID_REQUEST", 400) };
  }
  if (!requestId) return { ok: false, admission: reject("INVALID_REQUEST", 400) };
  const paymentHeader = request.headers.get("PAYMENT-SIGNATURE") ?? undefined;
  if (paymentHeader && Buffer.byteLength(paymentHeader, "utf8") > PAYMENT_HEADER_LIMIT_BYTES) {
    return { ok: false, admission: reject("INVALID_REQUEST", 400) };
  }
  if (paymentHeader && !isBoundV2Payment(paymentHeader, expected, body)) {
    return { ok: false, admission: reject("INVALID_REQUEST", 400) };
  }
  return {
    ok: true,
    requestId,
    fingerprint: requestFingerprint(requestId, request.method, FROZEN.resourceUrl, body),
    paymentHeader,
  };
}

async function processHttpAdmission(
  httpServer: x402HTTPResourceServer,
  context: HTTPRequestContext,
): Promise<NetworkX402Admission> {
  try {
    const processed = await httpServer.processHTTPRequest(context);
    if (processed.type === "payment-error") {
      return { kind: "response", response: fromInstructions(processed.response) };
    }
    return reject("PAYMENT_UNVERIFIED", 402);
  } catch {
    return reject("PAYMENT_PROCESSING_UNKNOWN", 503);
  }
}

async function settleVerifiedPayment(
  processed: HTTPProcessResult,
  httpServer: x402HTTPResourceServer,
  context: HTTPRequestContext,
  attempts: Map<string, AttemptRecord>,
  requestId: string,
): Promise<NetworkX402Admission> {
  if (processed.type === "payment-error") {
    return { kind: "response", response: fromInstructions(processed.response) };
  }
  if (processed.type !== "payment-verified") return reject("PAYMENT_UNVERIFIED", 500);
  const receipt = processed.beforeHandlerSettlement?.result;
  if (!receipt?.success) return reject("SETTLEMENT_FAILED", 402);
  advanceAttempt(attempts, requestId, "settled");
  return {
    kind: "settled",
    async finish(response) {
      const settled = await attachPaymentResponse(httpServer, processed, context, response);
      advanceAttempt(attempts, requestId, "delivered");
      return settled;
    },
  };
}

async function attachPaymentResponse(
  httpServer: x402HTTPResourceServer,
  processed: Extract<HTTPProcessResult, { type: "payment-verified" }>,
  context: HTTPRequestContext,
  response: Response,
): Promise<Response> {
  const bodyBytes = Buffer.from(await response.arrayBuffer());
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });
  const settlement = await httpServer.processSettlement(
    processed.paymentPayload,
    processed.paymentRequirements,
    processed.declaredExtensions,
    { request: context, responseBody: bodyBytes, responseHeaders },
    undefined,
    processed.beforeHandlerSettlement,
  );
  if (!settlement.success) return fromInstructions(settlement.response);
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(settlement.headers)) headers.set(key, value);
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  return new Response(bodyBytes, { status: response.status, headers });
}

function expectedQuote(): PaymentRequirements {
  return {
    scheme: "exact",
    network: NETWORK,
    asset: HBAR_ASSET,
    amount: FROZEN.amountAtomic,
    payTo: FROZEN.payTo,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    extra: { feePayer: FROZEN.feePayer, paymentFlow: "upfront" },
  };
}

function isBoundV2Payment(header: string, expected: PaymentRequirements, body: string): boolean {
  try {
    const payload = PaymentPayloadSchema.parse(decodePaymentSignatureHeader(header));
    if (payload.x402Version !== 2 || payload.resource?.url !== FROZEN.resourceUrl) return false;
    const accepted = payload.accepted;
    return accepted.scheme === expected.scheme
      && accepted.network === expected.network
      && accepted.asset === expected.asset
      && accepted.amount === expected.amount
      && accepted.payTo === expected.payTo
      && accepted.maxTimeoutSeconds === expected.maxTimeoutSeconds
      && hasExactExtra(accepted.extra, expected.extra)
      && paymentBodyHashMatches(payload, body);
  } catch {
    return false;
  }
}

function paymentBodyHashMatches(
  payload: { extensions?: Record<string, unknown> | null | undefined },
  body: string,
): boolean {
  // 必需小写 64 位 extensions.bodySha256，缺失或大小写不符即拒绝。
  const declared = payload.extensions?.bodySha256;
  if (typeof declared !== "string" || !BODY_SHA256.test(declared)) return false;
  return declared === createHash("sha256").update(body).digest("hex");
}

function occupiedAdmission(
  attempts: Map<string, AttemptRecord>,
  requestId: string,
  fingerprint: string,
): NetworkX402Admission | undefined {
  const existing = attempts.get(requestId);
  if (!existing) return undefined;
  if (existing.fingerprint !== fingerprint) return reject("REQUEST_ID_CONFLICT", 409);
  return reject("DUPLICATE_REQUEST", 409);
}

function hasExactExtra(
  actual: Record<string, unknown> | null | undefined,
  expected: Record<string, unknown> | null | undefined,
): boolean {
  const actualRecord = actual ?? {};
  const expectedRecord = expected ?? {};
  const actualKeys = Object.keys(actualRecord).sort();
  const expectedKeys = Object.keys(expectedRecord).sort();
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => key === expectedKeys[index] && actualRecord[key] === expectedRecord[key]);
}

function requestFingerprint(requestId: string, method: string, resourceUrl: string, body: string): string {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  return createHash("sha256").update(`${method}\n${resourceUrl}\n${bodyHash}\n${requestId}`).digest("hex");
}

function advanceAttempt(attempts: Map<string, AttemptRecord>, requestId: string, state: AttemptState): void {
  const current = attempts.get(requestId);
  if (!current || STATE_RANK[state] <= STATE_RANK[current.state]) return;
  attempts.set(requestId, { fingerprint: current.fingerprint, state });
}

function failedVerification(verification: VerifyResponse, requirements: PaymentRequirements): SettleResponse {
  const reason = verification.invalidReason ?? "payment_verification_failed";
  return {
    success: false,
    errorReason: reason,
    errorMessage: verification.invalidMessage ?? reason,
    ...(verification.payer ? { payer: verification.payer } : {}),
    network: requirements.network,
    transaction: "",
  };
}

async function settleOnce(
  delegate: FacilitatorClient,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
): Promise<SettleResponse> {
  try {
    const receipt = await delegate.settle(payload, requirements);
    if (!receipt.success && receipt.errorReason === "settlement_pending") return unknownSettlement(receipt);
    return receipt;
  } catch (error) {
    if (error instanceof SettleError && error.errorReason === "settlement_pending") {
      return unknownSettlement({
        success: false,
        errorReason: error.errorReason,
        ...(error.errorMessage ? { errorMessage: error.errorMessage } : {}),
        ...(error.payer ? { payer: error.payer } : {}),
        network: error.network,
        transaction: error.transaction,
      });
    }
    throw error;
  }
}

function unknownSettlement(receipt: SettleResponse): SettleResponse {
  return {
    ...receipt,
    success: false,
    errorReason: "settlement_unknown",
    errorMessage: receipt.errorMessage ?? "Settlement pending; query the original transaction",
  };
}

function fromInstructions(value: HTTPResponseInstructions): Response {
  const headers = new Headers(value.headers);
  if (value.body === undefined) return new Response(null, { status: value.status, headers });
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  const body = typeof value.body === "string" ? value.body : JSON.stringify(value.body);
  return new Response(body, { status: value.status, headers });
}

function reject(code: string, status: number): NetworkX402Admission {
  return {
    kind: "response",
    response: Response.json({ code }, { status, headers: { "cache-control": "no-store" } }),
  };
}

function assertFrozenConfig(config: Omit<NetworkX402GateConfig, "facilitator">): void {
  if (
    config.resourceUrl !== FROZEN.resourceUrl
    || config.amountAtomic !== FROZEN.amountAtomic
    || config.payTo !== FROZEN.payTo
    || config.feePayer !== FROZEN.feePayer
    || config.facilitatorUrl !== FROZEN.facilitatorUrl
  ) {
    throw new Error("X402_NOT_CONFIGURED");
  }
}
