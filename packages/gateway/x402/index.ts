import type { A2APaymentRequirementsRequest, A2APaymentVerifyRequest } from "@frely-network/shared-types";
import { createFixtureHederaX402AdmissionVerifier, HederaX402PaymentRejectedError, type HederaX402AdmissionVerifier } from "@frely-network/hedera-x402";

const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,191}$/u;
const SAFE_HASH = /^[a-f0-9]{64}$/u;

export interface X402PaymentAdmissionHttpOptions {
  readonly verifier: HederaX402AdmissionVerifier;
  /** The Relay-to-Network credential. Do not print or include it in responses. */
  readonly apiKey?: string;
  /** Optional host/application authorization hook for deployments using mTLS or an edge identity. */
  readonly authorize?: (request: Request) => boolean | Promise<boolean>;
  readonly maxBodyBytes?: number;
}

export type X402PaymentAdmissionHttpHandler = (request: Request) => Response | Promise<Response>;

/**
 * Network-side HTTP adapter. It is intentionally narrower than a general
 * x402 gateway: only Relay admission requests are accepted and only the
 * allowlisted admission facts cross back to Relay.
 */
export function createX402PaymentAdmissionHandler(options: X402PaymentAdmissionHttpOptions): X402PaymentAdmissionHttpHandler {
  const maxBodyBytes = boundedMaxBodyBytes(options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
  const configured = Boolean(options.authorize || options.apiKey);

  return async (request) => {
    const pathname = new URL(request.url).pathname;
    if (pathname !== "/a2a/payment/requirements" && pathname !== "/a2a/payment/verify") return json({ code: "NOT_FOUND" }, 404);
    if (request.method !== "POST") return json({ code: "METHOD_NOT_ALLOWED" }, 405);
    if (!configured) return json({ code: "PAYMENT_ADMISSION_NOT_CONFIGURED" }, 503);

    let authorized = false;
    try {
      authorized = options.authorize
        ? await options.authorize(request)
        : request.headers.get("authorization") === `Bearer ${options.apiKey}`;
    } catch {
      return json({ code: "PAYMENT_ADMISSION_AUTH_UNAVAILABLE" }, 503);
    }
    if (!authorized) return json({ code: "UNAUTHORIZED" }, 401, { "www-authenticate": "Bearer" });

    let body: unknown;
    try {
      body = await readJson(request, maxBodyBytes);
    } catch {
      return json({ code: "PAYMENT_REQUEST_INVALID", message: "Payment admission request is invalid" }, 400);
    }

    if (pathname.endsWith("/requirements")) {
      let input: A2APaymentRequirementsRequest;
      try {
        input = parseRequirementsRequest(body);
      } catch {
        return json({ code: "PAYMENT_REQUEST_INVALID", message: "Payment admission request is invalid" }, 400);
      }
      try {
        const payment = await options.verifier.requirements(input);
        return json({ payment }, 200);
      } catch (error) {
        if (error instanceof HederaX402PaymentRejectedError) {
          return json({ code: error.code, message: error.message, payment: error.challenge }, 402);
        }
        return json({ code: "PAYMENT_ADMISSION_UNAVAILABLE", message: "Payment admission is unavailable" }, 503);
      }
    }
    let input: A2APaymentVerifyRequest;
    try {
      input = parseVerifyRequest(body);
    } catch {
      return json({ code: "PAYMENT_REQUEST_INVALID", message: "Payment admission request is invalid" }, 400);
    }
    try {
      const admission = await options.verifier.verify(input);
      return json({ admission }, 200);
    } catch (error) {
      if (error instanceof HederaX402PaymentRejectedError) {
        return json({ code: error.code, message: error.message, payment: error.challenge }, 402);
      }
      return json({ code: "PAYMENT_ADMISSION_UNAVAILABLE", message: "Payment admission is unavailable" }, 503);
    }
  };
}

export function createFixtureX402PaymentAdmissionHandler(options: Omit<X402PaymentAdmissionHttpOptions, "verifier"> & { verifier?: HederaX402AdmissionVerifier } = {}): X402PaymentAdmissionHttpHandler {
  const verifier = options.verifier ?? createFixtureHederaX402AdmissionVerifier();
  return createX402PaymentAdmissionHandler({ ...options, verifier });
}

function parseRequirementsRequest(value: unknown): A2APaymentRequirementsRequest {
  const record = object(value);
  assertKeys(record, ["resource", "method", "requestHash"]);
  const resource = resourceValue(record.resource);
  if (record.method !== "POST" || !SAFE_HASH.test(String(record.requestHash))) throw new Error("request");
  return { resource, method: "POST", requestHash: record.requestHash as string };
}

function parseVerifyRequest(value: unknown): A2APaymentVerifyRequest {
  const record = object(value);
  assertKeys(record, ["resource", "method", "requestHash", "requestId", "idempotencyKeyHash", "proof"]);
  const base = parseRequirementsRequest({ resource: record.resource, method: record.method, requestHash: record.requestHash });
  if (typeof record.requestId !== "string" || !SAFE_REQUEST_ID.test(record.requestId)) throw new Error("requestId");
  if (typeof record.idempotencyKeyHash !== "string" || !SAFE_HASH.test(record.idempotencyKeyHash)) throw new Error("idempotency");
  if (typeof record.proof !== "string" || record.proof.length === 0 || new TextEncoder().encode(record.proof).byteLength > 128 * 1024) throw new Error("proof");
  return {
    ...base,
    requestId: record.requestId,
    idempotencyKeyHash: record.idempotencyKeyHash,
    proof: record.proof,
  };
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("object");
  return value as Record<string, unknown>;
}

function assertKeys(record: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys);
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new Error("keys");
}

function resourceValue(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) throw new Error("resource");
  const resource = new URL(value);
  if ((resource.protocol !== "http:" && resource.protocol !== "https:") || resource.username || resource.password || resource.hash) throw new Error("resource");
  return resource.toString();
}

async function readJson(request: Request, maxBodyBytes: number): Promise<unknown> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/u.test(contentLength) || Number(contentLength) > maxBodyBytes) throw new Error("body");
  }
  if (!request.body) throw new Error("body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBodyBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("body");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function boundedMaxBodyBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 4 * 1024 * 1024) throw new Error("MAX_BODY_BYTES_INVALID");
  return value;
}

function json(body: unknown, status: number, extraHeaders: Record<string, string> = {}): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}
