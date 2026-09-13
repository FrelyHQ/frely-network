import { BrokerError } from "@frely-network/shared-types";
import type { BrokerRuntime } from "../service.ts";
import { ConsumerError, ConsumerStore, digest, type ConsumerSession } from "./store.ts";

const PREFIX = "/api/network/";
const CAPABILITIES = ["web3.address-risk", "web3.url-risk"] as const;
type Capability = typeof CAPABILITIES[number];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: {
    "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
    "x-frame-options": "DENY", "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  } });
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:;|$)/iu.test(request.headers.get("content-type") ?? "")) throw new ConsumerError("JSON_REQUIRED", 415);
  const reader = request.body?.getReader();
  if (!reader) throw new ConsumerError("INVALID_REQUEST");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 16 * 1024) { await reader.cancel(); throw new ConsumerError("REQUEST_TOO_LARGE", 413); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new ConsumerError("INVALID_REQUEST"); }
  if (!record(value)) throw new ConsumerError("INVALID_REQUEST");
  return value;
}

function capabilityFrom(value: unknown): Capability {
  if (!Array.isArray(value) || value.length !== 1 || !CAPABILITIES.includes(value[0] as Capability)) {
    throw new ConsumerError("CAPABILITY_NOT_SUPPORTED");
  }
  return value[0] as Capability;
}

function cleanInput(capability: Capability, value: unknown): Record<string, string> {
  if (!record(value)) throw new ConsumerError("INVALID_REQUEST");
  if (capability === "web3.address-risk") {
    if (typeof value.address !== "string" || !/^0x[0-9a-fA-F]{40}$/u.test(value.address)) throw new ConsumerError("INVALID_ADDRESS");
    if (value.chainId === undefined) throw new ConsumerError("TARGET_CHAIN_REQUIRED");
    // This onboarding slice supports Ethereum mainnet. Login chains are a separate contract.
    if (String(value.chainId) !== "1") throw new ConsumerError("UNSUPPORTED_TARGET_CHAIN");
    if (Object.keys(value).some((key) => !["address", "chainId"].includes(key))) throw new ConsumerError("INVALID_REQUEST");
    return { address: value.address.toLowerCase(), chainId: "1" };
  }
  if (typeof value.url !== "string" || value.url.length > 2048 || Object.keys(value).some((key) => key !== "url")) throw new ConsumerError("INVALID_URL");
  let url: URL;
  try { url = new URL(value.url); } catch { throw new ConsumerError("INVALID_URL"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash) throw new ConsumerError("INVALID_URL");
  return { url: url.toString() };
}

/** Locate a typed service report; prose is not interpreted as risk evidence. */
export function extractSafetyReport(output: unknown, capability: Capability, input: Record<string, string>): Record<string, unknown> {
  const candidates: unknown[] = [output];
  let found: Record<string, unknown> | undefined;
  for (let i = 0; i < candidates.length && i < 80; i++) {
    const item = candidates[i];
    if (typeof item === "string" && item.length <= 128 * 1024) {
      const text = item.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/u, "$1");
      try { candidates.push(JSON.parse(text)); } catch { /* Prose cannot supply a structured verdict. */ }
    } else if (record(item)) {
      if (typeof item.target === "string" && typeof item.status === "string" && record(item.source) && item.source.provider === "GoPlus") {
        found = item; break;
      }
      for (const key of ["output", "output_text", "content", "text", "result", "data"]) {
        if (Array.isArray(item[key])) candidates.push(...(item[key] as unknown[]).slice(0, 20));
        else if (item[key] !== undefined) candidates.push(item[key]);
      }
    }
  }
  if (!found) throw new ConsumerError("PROVIDER_RESPONSE_INVALID", 502);
  const statuses = ["KNOWN_MALICIOUS", "SUSPICIOUS", "NO_KNOWN_RISK", "UNKNOWN"];
  const levels = ["HIGH", "MEDIUM", "NONE", "UNKNOWN"];
  if (!statuses.includes(String(found.status)) || !levels.includes(String(found.riskLevel)) || !Array.isArray(found.signals) || found.signals.length > 64 ||
      typeof found.checkedAt !== "string" || !Number.isFinite(Date.parse(found.checkedAt))) throw new ConsumerError("PROVIDER_RESPONSE_INVALID", 502);
  const expectedLevels: Record<string, string> = { KNOWN_MALICIOUS: "HIGH", SUSPICIOUS: "MEDIUM", NO_KNOWN_RISK: "NONE", UNKNOWN: "UNKNOWN" };
  if (found.riskLevel !== expectedLevels[String(found.status)]) throw new ConsumerError("PROVIDER_RESPONSE_INVALID", 502);
  const targetType = capability === "web3.address-risk" ? "ADDRESS" : "URL";
  const expectedTarget = input.address ?? input.url;
  const actualTarget = targetType === "ADDRESS" ? String(found.target).toLowerCase() : found.target;
  if (found.targetType !== targetType || actualTarget !== expectedTarget ||
      (targetType === "ADDRESS" && String(found.chainId) !== input.chainId)) throw new ConsumerError("PROVIDER_TARGET_MISMATCH", 502);
  const signals = found.signals.map((signal: unknown) => {
    if (!record(signal) || signal.source !== "GOPLUS" || typeof signal.type !== "string" ||
        !/^[A-Za-z0-9_]{1,80}$/u.test(signal.type) || (signal.value !== undefined && (typeof signal.value !== "string" || signal.value.length > 128))) {
      throw new ConsumerError("PROVIDER_RESPONSE_INVALID", 502);
    }
    return { type: signal.type, source: "GOPLUS", ...(signal.value === undefined ? {} : { value: signal.value }) };
  });
  if ((found.status === "KNOWN_MALICIOUS" || found.status === "SUSPICIOUS") && !signals.length) throw new ConsumerError("PROVIDER_RESPONSE_INVALID", 502);
  if (found.status === "NO_KNOWN_RISK" && (signals.length || found.riskLevel !== "NONE")) throw new ConsumerError("PROVIDER_RESPONSE_INVALID", 502);
  const disclaimers: Record<string, string> = {
    KNOWN_MALICIOUS: "The queried source reports malicious activity. This is not a calibrated scam probability.",
    SUSPICIOUS: "The queried source reports risk signals. Policy and mixer associations do not prove fraud.",
    NO_KNOWN_RISK: "No known risk was found in the queried source. This does not guarantee safety.",
    UNKNOWN: "The risk check could not be verified. No risk conclusion is available.",
  };
  return { targetType, target: expectedTarget, ...(targetType === "ADDRESS" ? { chainId: input.chainId } : {}),
    status: found.status, riskLevel: found.riskLevel, scamProbability: null, signals,
    checkedAt: found.checkedAt, source: { provider: "GoPlus" }, disclaimer: disclaimers[String(found.status)],
    ...(found.status === "UNKNOWN" ? { error: { code: "RISK_UNVERIFIED" } } : {}) };
}

export class ConsumerGateway {
  private readonly inflight = new Set<string>();
  constructor(readonly store: ConsumerStore, private readonly runtime: BrokerRuntime) {}

  private session(request: Request): ConsumerSession {
    return this.store.authenticate(request.headers.get("authorization"));
  }
  private origin(request: Request, required = false): void {
    const value = request.headers.get("origin");
    if ((required && value !== this.store.origin) || (value !== null && value !== this.store.origin)) throw new ConsumerError("ORIGIN_FORBIDDEN", 403);
  }
  private requireBroker(): NonNullable<BrokerRuntime["broker"]> {
    if (!this.runtime.ready || !this.runtime.broker) throw new ConsumerError("BROKER_NOT_READY", 503);
    return this.runtime.broker;
  }

  async find(request: Request, body: Record<string, unknown>): Promise<unknown> {
    this.origin(request);
    const session = this.session(request);
    this.store.rateLimit(`find:${digest(session.wallet_address.toLowerCase())}`, 30);
    const capability = capabilityFrom(body.capabilities);
    const capabilities = await this.requireBroker().findCapability([capability]);
    return { capabilities, paymentMode: "platform_demo" };
  }

  async use(request: Request, body: Record<string, unknown>, fromMcp = false): Promise<unknown> {
    this.origin(request);
    const session = this.session(request);
    const broker = this.requireBroker();
    const capability = capabilityFrom(body.capabilities);
    const input = cleanInput(capability, body.input);
    if (typeof body.requestId !== "string" || !UUID.test(body.requestId)) throw new ConsumerError("REQUEST_ID_REQUIRED");
    const requestId = body.requestId.toLowerCase();
    if (!fromMcp && request.headers.get("idempotency-key")?.toLowerCase() !== requestId) throw new ConsumerError("IDEMPOTENCY_KEY_REQUIRED");
    if (typeof body.task !== "string" || !body.task.trim() || body.task.length > 4000 ||
        Object.keys(body).some((key) => !["requestId", "capabilities", "task", "input"].includes(key))) throw new ConsumerError("INVALID_REQUEST");
    const key = `${session.wallet_address.toLowerCase()}:${requestId}`;
    if (this.inflight.has(key)) throw new ConsumerError("REQUEST_IN_PROGRESS", 409);
    const fingerprint = digest(JSON.stringify({ capability, input }));
    const claim = this.store.claim(session, requestId, fingerprint);
    if (claim.kind === "cached") return claim.result;
    this.inflight.add(key);
    try {
      const task = `Use the ${capability === "web3.address-risk" ? "check_address_risk" : "check_url_risk"} tool for ${JSON.stringify(input)}. Return the tool's SafetyCheckResult as JSON including checkedAt, source, signals and chainId for an address. Do not infer a probability. Do not replace an unavailable source with your own judgment.`;
      // Text works for Responses and A2A; the host cannot override the model or endpoint.
      const value = await broker.useCapability({ capabilities: [capability], task, model: capability.replace(".", "/") });
      if (!record(value) || !record(value.provider)) throw new ConsumerError("PROVIDER_RESPONSE_INVALID", 502);
      const report = extractSafetyReport(value.output, capability, input);
      const evidence = record(value.evidence) ? value.evidence : {};
      const result = { requestId, status: "succeeded", paymentMode: "platform_demo", result: report,
        evidence: { ...evidence, agentId: value.provider.id, ensName: value.provider.ensName ?? null,
          executionId: value.correlationId, resultSource: "GoPlus", checkedAt: report.checkedAt,
          paymentMode: "platform_demo", chainSettlement: false }, remainingCalls: this.store.remainingCalls(session.wallet_address) };
      this.store.succeed(session, requestId, result);
      return result;
    } catch (error) {
      const code = error instanceof ConsumerError || error instanceof BrokerError ? error.code : "REQUEST_OUTCOME_UNKNOWN";
      this.store.fail(session, requestId, code);
      throw error instanceof ConsumerError ? error : new ConsumerError(code, 502);
    } finally { this.inflight.delete(key); }
  }

  async mcp(request: Request, name: unknown, argumentsValue: unknown): Promise<unknown> {
    if (!record(argumentsValue)) throw new ConsumerError("INVALID_REQUEST");
    if (name === "find_capability") return this.find(request, argumentsValue);
    if (name === "use_capability") return this.use(request, argumentsValue, true);
    throw new ConsumerError("INVALID_REQUEST");
  }

  async handle(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(PREFIX)) return undefined;
    let body: Record<string, unknown> = {};
    try {
      this.origin(request);
      const route = url.pathname.slice(PREFIX.length);
      if (route === "session") {
        const session = this.session(request);
        if (request.method === "GET") return json(this.store.sessionView(session));
        if (request.method === "DELETE") { this.store.revoke(session); return json({ status: "revoked" }); }
        throw new ConsumerError("METHOD_NOT_ALLOWED", 405);
      }
      if (route === "device/request" && request.method === "GET") {
        this.store.rateLimit("device-inspect", 300);
        return json(this.store.inspect(url.searchParams.get("user_code")));
      }
      if (request.method !== "POST") throw new ConsumerError("METHOD_NOT_ALLOWED", 405);
      body = await readJson(request);
      if (route === "device/start") return json(this.store.start(body.clientName, body.host), 201);
      if (route === "device/token") {
        this.store.rateLimit("device-exchange", 600);
        const result = this.store.exchange(body.deviceCode);
        return json(result, result.status === "awaiting_wallet" ? 202 : 200);
      }
      if (["device/challenge", "device/approve", "device/reject"].includes(route)) {
        this.origin(request, true);
        this.store.rateLimit("device-browser", 120);
        if (route === "device/challenge") return json(this.store.challenge(body.userCode, body.address, body.chainId));
        if (route === "device/approve") return json(await this.store.approve(body.userCode, body.message, body.signature));
        return json(this.store.reject(body.userCode));
      }
      if (route === "capabilities/find") return json(await this.find(request, body));
      if (route === "capabilities/use") return json(await this.use(request, body));
      throw new ConsumerError("NOT_FOUND", 404);
    } catch (error) {
      const known = error instanceof ConsumerError || error instanceof BrokerError;
      const code = known ? error.code : "NETWORK_REQUEST_FAILED";
      return json({ code, ...(typeof body.requestId === "string" && UUID.test(body.requestId) ? { requestId: body.requestId } : {}) },
        error instanceof ConsumerError ? error.status : 502);
    }
  }
}

export function createConsumerGatewayFromEnv(runtime: BrokerRuntime, env: Record<string, string | undefined> = process.env): ConsumerGateway | undefined {
  if (env.NETWORK_ONBOARDING_ENABLED !== "true") return undefined;
  if (!env.NETWORK_PUBLIC_ORIGIN || !env.NETWORK_SESSION_DB || env.NETWORK_SESSION_DB === ":memory:") throw new ConsumerError("NETWORK_CONFIG_INVALID");
  const number = (key: string, fallback: number): number => {
    if (env[key] === undefined) return fallback;
    if (!/^[0-9]+$/u.test(env[key]!)) throw new ConsumerError("NETWORK_CONFIG_INVALID");
    return Number(env[key]);
  };
  return new ConsumerGateway(new ConsumerStore({
    origin: env.NETWORK_PUBLIC_ORIGIN, databasePath: env.NETWORK_SESSION_DB,
    allowLoopback: env.FRELY_NETWORK_ALLOW_LOOPBACK === "1",
    walletCallLimit: number("NETWORK_DEMO_WALLET_CALL_LIMIT", 10),
    globalCallLimit: number("NETWORK_DEMO_GLOBAL_CALL_LIMIT", 100),
  }), runtime);
}
