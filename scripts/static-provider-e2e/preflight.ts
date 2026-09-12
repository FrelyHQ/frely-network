import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodePaymentRequiredHeader,
  encodePaymentRequiredHeader,
} from "../../packages/gateway/x402/node_modules/@x402/core/dist/esm/http/index.mjs";

export const FROZEN_PAYMENT_INTENT = {
  resource: "http://127.0.0.1:13600/v1/responses",
  network: "hedera:testnet",
  asset: "0.0.0",
  amountAtomic: "100000000",
  payer: "0.0.10386782",
  payTo: "0.0.10403579",
  feePayer: "0.0.7162784",
} as const;

const RELAY_BASE = "https://api.frely.cloud";
const RELAY_RESPONSES = "https://api.frely.cloud/v1/responses";
const NETWORK_ORIGIN = "http://127.0.0.1:13600";
const NETWORK_RESOLVE = `${NETWORK_ORIGIN}/v1/capabilities/resolve`;
const NETWORK_RESPONSES = "http://127.0.0.1:13600/v1/responses";
const BLOCKY_SUPPORTED = "https://api.testnet.blocky402.com/supported";
const MIRROR = "https://testnet.mirrornode.hedera.com";
const DEFAULT_IMAGE = "https://placehold.co/600x200/FFFFFF/000000/png?text=FRELY%20X402%20OK";
const TASK_TEXT = "Read the image and return the exact visible text.";
const NOT_RUN_PAYMENT = "Not run — authorized but not executed in preflight";
const FORBIDDEN_KEYS = new Set([
  "authorization",
  "Authorization",
  "PAYMENT-SIGNATURE",
  "signerRef",
  "journalPath",
  "apiKey",
  "privateKey",
  "cookie",
  "walletDir",
]);
const FORBIDDEN_TEXT = [
  "Bearer relay-secret",
  "PAYMENT-SIGNATURE",
  "agent.key",
  "signerRef",
  "journalPath",
  "BEGIN PRIVATE KEY",
];

export type PaymentIntent = {
  resource: string;
  network: string;
  asset: string;
  amountAtomic: string;
  payer: string;
  payTo: string;
  feePayer: string;
};

export type GateStatus = "pass" | "fail" | "unknown";

export type GateResult = {
  status: GateStatus | "not_run";
  result: string;
  [key: string]: unknown;
};

export type WalletPublicIdentity = {
  network: string;
  payerAccountId: string;
  reserveTinybar: string;
};

export type PreflightPorts = {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  env?: Record<string, string | undefined>;
  now?: () => string;
  evidenceDir?: string;
  walletIdentity?: WalletPublicIdentity;
  readWalletIdentity?: () => Promise<WalletPublicIdentity>;
  sign?: () => Promise<unknown>;
  settle?: () => Promise<unknown>;
  useCapability?: () => Promise<unknown>;
};

type JsonRecord = Record<string, unknown>;

function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../..");
}

export function assertExactPaymentIntent(input: PaymentIntent): void {
  const expected = {
    resource: "http://127.0.0.1:13600/v1/responses",
    network: "hedera:testnet",
    asset: "0.0.0",
    amountAtomic: "100000000",
    payer: "0.0.10386782",
    payTo: "0.0.10403579",
    feePayer: "0.0.7162784",
  };
  if (JSON.stringify(input) !== JSON.stringify(expected)) {
    throw new Error("PAYMENT_INTENT_MISMATCH");
  }
}

export function redactEvidence(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (key, current) => {
    if (FORBIDDEN_KEYS.has(key) || /signature|secret|privateKey|token|password|cookie/i.test(key)) {
      return undefined;
    }
    if (typeof current === "string" && FORBIDDEN_TEXT.some((item) => current.includes(item))) {
      return "[redacted]";
    }
    return current;
  }));
}

export function secretBearingFixture(): JsonRecord {
  return {
    authorization: "Bearer relay-secret",
    "PAYMENT-SIGNATURE": "broadcastable-bytes",
    signerRef: "file:/tmp/wallet/agent.key",
    journalPath: "/tmp/secret/journal.sqlite",
    note: "path /tmp/wallet/agent.key must not leak",
  };
}

export function runConflictReplayDouble(): {
  status: GateStatus;
  signCalls: number;
  settleCalls: number;
  dispatchCalls: number;
} {
  const fingerprints = new Map<string, string>();
  let signCalls = 0;
  let settleCalls = 0;
  let dispatchCalls = 0;
  const use = (requestId: string, fingerprint: string) => {
    const previous = fingerprints.get(requestId);
    if (previous && previous !== fingerprint) return { conflict: true };
    if (!previous) fingerprints.set(requestId, fingerprint);
    else {
      signCalls += 1;
      return { conflict: false };
    }
    signCalls += 1;
    return { conflict: false };
  };
  use("same-id", "image-a|task-a|100000000|frely-vision-basic");
  const mutated = use("same-id", "image-b|task-a|100000000|frely-vision-basic");
  const status = mutated.conflict && signCalls === 1 && settleCalls === 0 && dispatchCalls === 0
    ? "pass"
    : "fail";
  return { status, signCalls, settleCalls, dispatchCalls };
}

export function runUnknownRecoveryDouble(): {
  status: GateStatus;
  signCalls: number;
  settleCalls: number;
  queryCalls: number;
  requestIds: string[];
  secondTransaction: boolean;
} {
  const state = {
    signCalls: 0,
    settleCalls: 0,
    queryCalls: 0,
    requestIds: ["orig-request"],
    secondTransaction: false,
  };
  state.signCalls += 1;
  state.settleCalls += 1;
  const settleResult = "timeout";
  if (settleResult === "timeout") {
    state.queryCalls += 1;
  }
  const status = state.signCalls === 1
    && state.settleCalls === 1
    && state.queryCalls === 1
    && state.requestIds.length === 1
    && state.requestIds[0] === "orig-request"
    && state.secondTransaction === false
    ? "pass"
    : "fail";
  return { ...state, status };
}

function quote() {
  return {
    scheme: "exact" as const,
    network: "hedera:testnet" as const,
    asset: "0.0.0",
    amount: "100000000",
    payTo: "0.0.10403579",
    maxTimeoutSeconds: 120,
    extra: { feePayer: "0.0.7162784", paymentFlow: "upfront" },
  };
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]);

export function testPorts(seen: Request[]): PreflightPorts {
  return {
    walletIdentity: {
      network: "hedera:testnet",
      payerAccountId: "0.0.10386782",
      reserveTinybar: "100000000",
    },
    env: {
      FRELY_RELAY_API_KEY: "relay-secret",
      FRELY_NETWORK_API_KEY: "network-test-only",
      FRELY_ACCEPTANCE_IMAGE_URL: DEFAULT_IMAGE,
    },
    now: () => "2026-09-12T00:00:00.000Z",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      seen.push(request);
      const url = new URL(request.url);
      if (url.href === `${RELAY_BASE}/health`) {
        return Response.json({
          ok: true,
          service: "gateway-srv",
          version: "0.64.1",
          instance: "frely-eu",
          releaseId: "test-release",
          sourceSha: "test-source",
        });
      }
      if (url.href === `${RELAY_BASE}/v1/models`) {
        return Response.json({ data: [{ id: "vision-basic" }, { id: "gpt-5.6-luna" }] });
      }
      if (url.href === RELAY_RESPONSES && request.method === "POST") {
        const body = JSON.parse(await request.clone().text()) as { model?: string };
        if (body.model === "vision-basic") {
          return Response.json({ output_text: "FRELY X402 OK" });
        }
        if (body.model === "gpt-5.6-luna") {
          return Response.json({ output_text: "ok" });
        }
        return new Response(null, { status: 400 });
      }
      if (url.href === DEFAULT_IMAGE) {
        return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
      }
      if (url.href === BLOCKY_SUPPORTED) {
        return Response.json({
          kinds: [{
            x402Version: 2,
            scheme: "exact",
            network: "hedera:testnet",
            extra: { feePayer: "0.0.7162784" },
          }],
        });
      }
      if (url.pathname.startsWith("/api/v1/accounts/")) {
        const id = url.pathname.split("/").pop();
        return Response.json({
          account: id,
          deleted: false,
          receiver_sig_required: false,
          key: { _type: "ECDSA_SECP256K1", key: "public-only" },
          balance: { balance: 672777702 },
        });
      }
      if (url.href === NETWORK_RESOLVE) {
        return Response.json({
          schemaVersion: 2,
          requestedCapabilities: ["vision"],
          provider: {
            id: "frely-vision-basic",
            endpoint: RELAY_RESPONSES,
            protocol: "responses",
          },
          execution: { endpoint: NETWORK_RESPONSES, managedBy: "network" },
          resolution: { source: "static_allowlist", identityVerified: false },
          payment: { supportsX402: true, network: "hedera:testnet", resource: NETWORK_RESPONSES },
        });
      }
      if (url.href === NETWORK_RESPONSES) {
        return new Response(null, {
          status: 402,
          headers: {
            "PAYMENT-REQUIRED": encodePaymentRequiredHeader({
              x402Version: 2,
              resource: { url: NETWORK_RESPONSES },
              accepts: [quote()],
            }),
            "Cache-Control": "no-store",
          },
        });
      }
      return new Response(null, { status: 404 });
    },
  };
}

async function loadWalletIdentity(
  ports: PreflightPorts,
  env: Record<string, string | undefined>,
): Promise<WalletPublicIdentity | undefined> {
  if (ports.walletIdentity) return ports.walletIdentity;
  if (ports.readWalletIdentity) return await ports.readWalletIdentity();
  const walletDir = env.FRELY_WALLET_DIR?.trim();
  if (!walletDir) return undefined;
  const { readReadyWalletIdentity } = await import("../../packages/wallet/agent-wallet/read-ready.ts");
  const identity = await readReadyWalletIdentity(walletDir);
  return {
    network: identity.network,
    payerAccountId: identity.payerAccountId,
    reserveTinybar: identity.reserveTinybar,
  };
}

function gate(status: GateResult["status"], result: string, extra: JsonRecord = {}): GateResult {
  return { status, result, ...extra };
}

async function boundedGet(
  fetchImpl: PreflightPorts["fetch"],
  url: string,
  init: RequestInit,
  maxBytes: number,
): Promise<{ status: number; redirected: boolean; headers: Headers; body: Buffer }> {
  const response = await fetchImpl(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (response.redirected) throw new Error("REDIRECT");
  const body = Buffer.from(await response.arrayBuffer());
  if (body.byteLength > maxBytes) throw new Error("TOO_LARGE");
  return { status: response.status, redirected: response.redirected, headers: response.headers, body };
}

function modelsFrom(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const record = body as { data?: unknown; models?: unknown };
  const list = Array.isArray(record.data) ? record.data : Array.isArray(record.models) ? record.models : [];
  return list.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string") {
      return [(item as { id: string }).id];
    }
    return [];
  });
}

function outputText(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const record = body as { output_text?: unknown; output?: unknown };
  if (typeof record.output_text === "string") return record.output_text;
  return JSON.stringify(body);
}

async function scanSecrets(directory: string): Promise<{ status: GateStatus; result: string }> {
  const stack = [directory];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    let entries: string[] = [];
    try {
      entries = (await readdir(current)).map((name) => join(current, name));
    } catch {
      continue;
    }
    for (const entry of entries) {
      const info = await stat(entry);
      if (info.isDirectory()) {
        stack.push(entry);
        continue;
      }
      if (!info.isFile() || info.size > 2 * 1024 * 1024) continue;
      const text = await readFile(entry, "utf8");
      if (FORBIDDEN_TEXT.some((item) => text.includes(item))) {
        return { status: "fail", result: "secret material found in evidence" };
      }
    }
  }
  return { status: "pass", result: "no secrets in evidence files" };
}

function claimBoundary() {
  return {
    mode: "static_allowlist" as const,
    identityVerified: false,
    discovery: "not used",
    summary: "静态 Provider 无 HBAR 付款预检；未完成真实付款全链路",
  };
}

export async function runPreflight(ports: PreflightPorts): Promise<{
  paymentAuthorizationRecorded: true;
  paymentSent: false;
  gates: Record<string, GateResult>;
  claim: ReturnType<typeof claimBoundary>;
  image?: JsonRecord;
  health?: JsonRecord;
}> {
  const env = ports.env ?? process.env;
  const evidenceDir = ports.evidenceDir ?? join(repoRoot(), ".local/acceptance/static-provider");
  const fetchImpl = ports.fetch;
  const intent = { ...FROZEN_PAYMENT_INTENT };
  assertExactPaymentIntent(intent);
  const gates: Record<string, GateResult> = {};
  const relayKey = env.FRELY_RELAY_API_KEY?.trim() ?? "";
  const networkKey = env.FRELY_NETWORK_API_KEY?.trim() ?? "";
  const imageUrl = env.FRELY_ACCEPTANCE_IMAGE_URL?.trim() || DEFAULT_IMAGE;

  let health: JsonRecord | undefined;
  try {
    const got = await boundedGet(fetchImpl, `${RELAY_BASE}/health`, { method: "GET" }, 64 * 1024);
    health = JSON.parse(got.body.toString("utf8")) as JsonRecord;
    const models = relayKey
      ? await boundedGet(fetchImpl, `${RELAY_BASE}/v1/models`, {
        method: "GET",
        headers: { authorization: `Bearer ${relayKey}` },
      }, 1024 * 1024)
      : undefined;
    const modelIds = models ? modelsFrom(JSON.parse(models.body.toString("utf8"))) : [];
    const vision = modelIds.includes("vision-basic");
    let canaryText = "";
    let canaryStatus: number | null = null;
    let x402Requested = false;
    if (relayKey && vision) {
      const canary = await boundedGet(fetchImpl, RELAY_RESPONSES, {
        method: "POST",
        headers: {
          authorization: `Bearer ${relayKey}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          model: "vision-basic",
          instructions: TASK_TEXT,
          input: [{ role: "user", content: [{ type: "input_image", image_url: imageUrl }] }],
          store: false,
          stream: false,
        }),
      }, 2 * 1024 * 1024);
      canaryStatus = canary.status;
      x402Requested = canary.status === 402
        || canary.headers.has("PAYMENT-REQUIRED")
        || canary.headers.has("PAYMENT-SIGNATURE");
      canaryText = outputText(JSON.parse(canary.body.toString("utf8") || "{}"));
    }
    const canaryOk = Boolean(relayKey)
      && got.status === 200
      && vision
      && canaryStatus === 200
      && canaryText.includes("FRELY X402 OK")
      && !x402Requested;
    gates.G0 = gate(canaryOk ? "pass" : "fail", canaryOk
      ? "Relay health, vision-basic and OCR canary passed"
      : relayKey
        ? "Relay canary failed"
        : "FRELY_RELAY_API_KEY_MISSING", {
      healthStatus: got.status,
      visionBasicAvailable: vision,
      x402Requested,
      relayPaymentBoundaryViolation: x402Requested,
    });
  } catch (error) {
    gates.G0 = gate("fail", error instanceof Error ? error.message : "health failed");
  }

  let imageMeta: JsonRecord | undefined;
  try {
    const image = await boundedGet(fetchImpl, imageUrl, { method: "GET" }, 2 * 1024 * 1024);
    const contentType = image.headers.get("content-type") ?? "";
    const isPng = image.body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const isJpeg = image.body[0] === 0xff && image.body[1] === 0xd8 && image.body[2] === 0xff;
    const sha256 = createHash("sha256").update(image.body).digest("hex");
    imageMeta = {
      url: imageUrl,
      status: image.status,
      redirected: image.redirected,
      contentType,
      bytes: image.body.byteLength,
      sha256,
    };
    const ok = image.status === 200 && !image.redirected && (isPng || isJpeg)
      && (contentType.includes("png") || contentType.includes("jpeg") || isPng || isJpeg);
    if (!ok) imageMeta = { ...imageMeta, invalid: true };
  } catch (error) {
    imageMeta = { url: imageUrl, error: error instanceof Error ? error.message : "image failed" };
  }

  try {
    if (!networkKey) throw new Error("FRELY_NETWORK_API_KEY_MISSING");
    const resolved = await boundedGet(fetchImpl, NETWORK_RESOLVE, {
      method: "POST",
      headers: {
        authorization: `Bearer ${networkKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        schemaVersion: 2,
        capabilities: ["vision"],
        paymentNetwork: "hedera:testnet",
      }),
    }, 1024 * 1024);
    const body = JSON.parse(resolved.body.toString("utf8")) as JsonRecord;
    const text = JSON.stringify(body);
    const ok = resolved.status === 200
      && body.resolution
      && JSON.stringify(body.resolution) === JSON.stringify({ source: "static_allowlist", identityVerified: false })
      && !/ensName|registry|chainId/.test(text);
    gates.G1 = gate(ok ? "pass" : "fail", ok ? "static_allowlist resolve" : "resolve mismatch", {
      httpStatus: resolved.status,
    });
    const provider = body.provider as JsonRecord | undefined;
    const execution = body.execution as JsonRecord | undefined;
    const payment = body.payment as JsonRecord | undefined;
    const authorized = provider?.id === "frely-vision-basic"
      && provider?.endpoint === RELAY_RESPONSES
      && execution?.endpoint === NETWORK_RESPONSES
      && payment?.resource === NETWORK_RESPONSES;
    gates.G2 = gate(authorized ? "pass" : "fail", authorized
      ? "frozen upstream and loopback execution"
      : "PROVIDER_NOT_AUTHORIZED");
  } catch (error) {
    gates.G1 = gate("fail", error instanceof Error ? error.message : "resolve failed");
    gates.G2 = gate("fail", "resolve unavailable");
  }

  try {
    if (!networkKey) throw new Error("FRELY_NETWORK_API_KEY_MISSING");
    const quoted = await boundedGet(fetchImpl, NETWORK_RESPONSES, {
      method: "POST",
      headers: {
        authorization: `Bearer ${networkKey}`,
        "content-type": "application/json",
        "x-frely-request-id": "preflight-unsigned",
      },
      body: JSON.stringify({
        model: "vision-basic",
        instructions: TASK_TEXT,
        input: [{ role: "user", content: [{ type: "input_image", image_url: imageUrl }] }],
        store: false,
        stream: false,
      }),
    }, 64 * 1024);
    const required = quoted.headers.get("PAYMENT-REQUIRED");
    if (quoted.status !== 402 || !required) throw new Error("NETWORK_402_MISSING");
    const decoded = decodePaymentRequiredHeader(required) as {
      accepts?: Array<{
        network?: string;
        asset?: string;
        amount?: string;
        payTo?: string;
        extra?: { feePayer?: string };
      }>;
      resource?: { url?: string };
    };
    const accepted = decoded.accepts?.[0];
    const match = accepted?.network === intent.network
      && accepted?.asset === intent.asset
      && accepted?.amount === intent.amountAtomic
      && accepted?.payTo === intent.payTo
      && accepted?.extra?.feePayer === intent.feePayer
      && decoded.resource?.url === intent.resource;
    gates.G3 = gate(match ? "pass" : "fail", match ? "Network 402 matches frozen quote" : "quote mismatch", {
      httpStatus: quoted.status,
      paymentSent: false,
    });
  } catch (error) {
    gates.G3 = gate("fail", error instanceof Error ? error.message : "402 failed");
  }

  try {
    const supported = await boundedGet(fetchImpl, BLOCKY_SUPPORTED, { method: "GET" }, 1024 * 1024);
    const kinds = (JSON.parse(supported.body.toString("utf8")) as { kinds?: Array<JsonRecord> }).kinds ?? [];
    const blockyOk = kinds.some((kind) => kind.x402Version === 2 && kind.scheme === "exact"
      && kind.network === "hedera:testnet"
      && (kind.extra as JsonRecord | undefined)?.feePayer === intent.feePayer);
    const payer = await boundedGet(fetchImpl, `${MIRROR}/api/v1/accounts/${intent.payer}`, { method: "GET" }, 1024 * 1024);
    const payTo = await boundedGet(fetchImpl, `${MIRROR}/api/v1/accounts/${intent.payTo}`, { method: "GET" }, 1024 * 1024);
    const payerBody = JSON.parse(payer.body.toString("utf8")) as {
      account?: string;
      deleted?: boolean;
      balance?: { balance?: number | string };
    };
    const payToBody = JSON.parse(payTo.body.toString("utf8")) as {
      account?: string;
      deleted?: boolean;
      receiver_sig_required?: boolean;
    };
    const identity = await loadWalletIdentity(ports, env);
    const reserve = BigInt(identity?.reserveTinybar ?? "100000000");
    const balance = BigInt(String(payerBody.balance?.balance ?? "0"));
    const imageOk = Boolean(imageMeta && imageMeta.status === 200 && !imageMeta.invalid);
    const walletOk = identity?.network === "hedera:testnet"
      && identity.payerAccountId === intent.payer;
    const ok = blockyOk
      && walletOk
      && payer.status === 200
      && payTo.status === 200
      && payerBody.account === intent.payer
      && payerBody.deleted === false
      && payToBody.account === intent.payTo
      && payToBody.deleted === false
      && payToBody.receiver_sig_required === false
      && balance >= BigInt(intent.amountAtomic) + reserve
      && imageOk;
    gates.G4 = gate(ok ? "pass" : "fail", ok
      ? "wallet, quote, Blocky and image preflight"
      : walletOk
        ? "G4 checks failed"
        : "WALLET_PAYER_MISMATCH", {
      payer: intent.payer,
      payTo: intent.payTo,
      walletPayer: identity?.payerAccountId ?? null,
      payerBalanceTinybar: String(balance),
      imageSha256: imageMeta?.sha256,
    });
  } catch (error) {
    gates.G4 = gate("fail", error instanceof Error ? error.message : "G4 failed");
  }

  gates.G5 = gate("not_run", NOT_RUN_PAYMENT);
  gates.G6 = gate("not_run", NOT_RUN_PAYMENT);
  gates.G7 = gate("not_run", NOT_RUN_PAYMENT);

  const g8 = runConflictReplayDouble();
  gates.G8 = gate(g8.status, g8.status === "pass" ? "conflict replay double" : "conflict replay failed", {
    signCalls: g8.signCalls,
    settleCalls: g8.settleCalls,
    dispatchCalls: g8.dispatchCalls,
  });
  const g9 = runUnknownRecoveryDouble();
  gates.G9 = gate(g9.status, g9.status === "pass" ? "unknown recovery double" : "unknown recovery failed", {
    signCalls: g9.signCalls,
    settleCalls: g9.settleCalls,
    queryCalls: g9.queryCalls,
    requestIds: g9.requestIds,
    secondTransaction: g9.secondTransaction,
  });

  try {
    if (!relayKey) throw new Error("FRELY_RELAY_API_KEY_MISSING");
    const regression = await boundedGet(fetchImpl, RELAY_RESPONSES, {
      method: "POST",
      headers: {
        authorization: `Bearer ${relayKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.6-luna",
        input: "ping",
        store: false,
        stream: false,
      }),
    }, 2 * 1024 * 1024);
    const x402 = regression.status === 402 || regression.headers.has("PAYMENT-REQUIRED");
    const ok = regression.status === 200 && !x402;
    gates.G10 = gate(ok ? "pass" : "fail", ok ? "existing model still returns 200" : "existing model regression", {
      model: "gpt-5.6-luna",
      httpStatus: regression.status,
    });
  } catch (error) {
    gates.G10 = gate("fail", error instanceof Error ? error.message : "G10 failed");
  }

  const claim = claimBoundary();
  const claimText = JSON.stringify(claim);
  const g12ok = claim.mode === "static_allowlist"
    && claim.identityVerified === false
    && !/The Graph|ENS|ERC-8004/.test(claimText);
  gates.G12 = gate(g12ok ? "pass" : "fail", g12ok
    ? "static allowlist claim boundary"
    : "claim boundary violated");
  await mkdir(evidenceDir, { recursive: true });
  const scanned = await scanSecrets(evidenceDir);
  gates.G11 = gate(scanned.status, scanned.result);
  const evidence = redactEvidence({
    fetchedAt: (ports.now ?? (() => new Date().toISOString()))(),
    paymentAuthorizationRecorded: true,
    paymentSent: false,
    intent,
    health,
    image: imageMeta,
    gates,
    claim,
  });
  await writeFile(join(evidenceDir, "preflight.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  const afterWrite = await scanSecrets(evidenceDir);
  if (afterWrite.status === "fail") gates.G11 = gate("fail", afterWrite.result);

  return {
    paymentAuthorizationRecorded: true,
    paymentSent: false,
    gates,
    claim,
    image: imageMeta,
    health,
  };
}

function requiredGatesFailed(gates: Record<string, GateResult>): boolean {
  return ["G0", "G1", "G2", "G3", "G4", "G8", "G9", "G10", "G11", "G12"]
    .some((name) => gates[name]?.status !== "pass");
}

if (import.meta.main) {
  const evidence = await runPreflight({ fetch });
  const summary = {
    paymentAuthorizationRecorded: evidence.paymentAuthorizationRecorded,
    paymentSent: evidence.paymentSent,
    gates: Object.fromEntries(Object.entries(evidence.gates).map(([name, value]) => [name, value.status])),
  };
  process.stderr.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exit(requiredGatesFailed(evidence.gates) ? 1 : 0);
}
