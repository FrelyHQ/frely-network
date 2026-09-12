import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertExactPaymentIntent,
  FROZEN_AUTHORIZATION,
  FROZEN_PAYMENT_INTENT,
  redactEvidence,
  type PaymentIntent,
} from "./preflight.ts";

const CONFIRMATION = "I AUTHORIZE ONE 1 HBAR TESTNET PAYMENT";
const TASK_TEXT = "Read the image and return the exact visible text.";

export type LivePorts = {
  confirmation?: string;
  env?: Record<string, string | undefined>;
  createTransport?: () => unknown;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  now?: () => Date;
  evidenceDir?: string;
  preflightPath?: string;
};

export function assertLiveAuthorization(value: string | undefined): void {
  if (value !== CONFIRMATION) {
    throw new Error("LIVE_PAYMENT_NOT_AUTHORIZED");
  }
}

function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../..");
}

type JsonRecord = Record<string, unknown>;

async function assertPreflightGreen(
  path: string,
  env: Record<string, string | undefined>,
  now: Date,
  fetchImpl: NonNullable<LivePorts["fetch"]>,
): Promise<JsonRecord> {
  const raw = JSON.parse(await readFile(path, "utf8")) as {
    evidenceKind?: unknown;
    fetchedAt?: unknown;
    paymentAuthorizationRecorded?: unknown;
    paymentSent?: unknown;
    intent?: unknown;
    approvedRunParameters?: unknown;
    image?: { url?: unknown; status?: unknown; redirected?: unknown; sha256?: unknown };
    claim?: { mode?: unknown; identityVerified?: unknown; discovery?: unknown };
    gates?: Record<string, { status?: unknown }>;
  };
  if (raw.evidenceKind !== "live") throw new Error("PREFLIGHT_NOT_LIVE");
  if (raw.paymentAuthorizationRecorded !== true) throw new Error("PREFLIGHT_NOT_GREEN");
  if (raw.paymentSent !== false) throw new Error("PREFLIGHT_NOT_GREEN");
  assertExactPaymentIntent(raw.intent as PaymentIntent);
  if (JSON.stringify(raw.approvedRunParameters) !== JSON.stringify(FROZEN_AUTHORIZATION)) {
    throw new Error("LIVE_AUTHORIZATION_MISMATCH");
  }
  const fetchedAt = typeof raw.fetchedAt === "string" ? Date.parse(raw.fetchedAt) : Number.NaN;
  const age = now.getTime() - fetchedAt;
  if (!Number.isFinite(fetchedAt) || age < -30_000 || age > 15 * 60_000) {
    throw new Error("PREFLIGHT_STALE");
  }
  for (const name of ["G0", "G1", "G2", "G3", "G4", "G8", "G9", "G10", "G11", "G12"]) {
    if (raw.gates?.[name]?.status !== "pass") throw new Error("PREFLIGHT_NOT_GREEN");
  }
  if (raw.claim?.mode !== "static_allowlist" || raw.claim.identityVerified !== false || raw.claim.discovery !== "not used") {
    throw new Error("PREFLIGHT_CLAIM_MISMATCH");
  }
  const imageUrl = env.FRELY_ACCEPTANCE_IMAGE_URL?.trim();
  if (!imageUrl || raw.image?.url !== imageUrl || raw.image.status !== 200 || raw.image.redirected !== false
    || typeof raw.image.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(raw.image.sha256)) {
    throw new Error("PREFLIGHT_IMAGE_MISMATCH");
  }
  const image = await fetchImpl(imageUrl, { method: "GET", redirect: "error", signal: AbortSignal.timeout(15_000) });
  const bytes = Buffer.from(await image.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (image.status !== 200 || image.redirected || bytes.byteLength > 2 * 1024 * 1024 || sha256 !== raw.image.sha256) {
    throw new Error("PREFLIGHT_IMAGE_MISMATCH");
  }
  return raw as JsonRecord;
}

type ToolResult = {
  isError?: unknown;
  structuredContent?: unknown;
};

function object(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function assertSuccessfulResult(result: unknown, requestId: string): {
  structuredContent: JsonRecord;
  transactionId: string;
  consensusTimestamp: string;
  verificationUrl: string;
} {
  const tool = object(result) as ToolResult | null;
  const structured = object(tool?.structuredContent);
  const outcome = object(structured?.paymentOutcome);
  const payment = object(structured?.payment);
  const evidence = object(outcome?.evidence);
  const output = structured?.output;
  if (tool?.isError === true || !structured || structured.resolutionSource !== "static_allowlist"
    || structured.identityVerified !== false || object(structured.provider)?.id !== "frely-vision-basic") {
    throw new Error("LIVE_TOOL_RESULT_INVALID");
  }
  if (outcome?.requestId !== requestId || outcome.decision !== "completed"
    || outcome.paymentStatus !== "settled" || outcome.serviceStatus !== "succeeded") {
    throw new Error(outcome?.paymentStatus === "unknown" ? "LIVE_PAYMENT_NOT_SETTLED" : "LIVE_BUSINESS_NOT_SUCCEEDED");
  }
  const transactionId = typeof evidence?.transactionId === "string" ? evidence.transactionId : "";
  const verificationUrl = typeof evidence?.verificationUrl === "string" ? evidence.verificationUrl : "";
  const consensusTimestamp = typeof evidence?.consensusTimestamp === "string" ? evidence.consensusTimestamp : "";
  if (evidence?.source !== "testnet" || evidence.network !== FROZEN_PAYMENT_INTENT.network
    || evidence.asset !== FROZEN_PAYMENT_INTENT.asset || evidence.amountAtomic !== FROZEN_PAYMENT_INTENT.amountAtomic
    || evidence.payer !== FROZEN_PAYMENT_INTENT.payer || evidence.payTo !== FROZEN_PAYMENT_INTENT.payTo
    || !transactionId.startsWith(`${FROZEN_PAYMENT_INTENT.feePayer}@`)
    || payment?.transactionId !== transactionId || payment.network !== FROZEN_PAYMENT_INTENT.network
    || !verificationUrl.startsWith("https://testnet.mirrornode.hedera.com/api/v1/transactions/")
    || !/^\d+\.[0-9]{9}$/.test(consensusTimestamp)) {
    throw new Error("LIVE_SETTLEMENT_EVIDENCE_INVALID");
  }
  if (!JSON.stringify(output).includes("FRELY X402 OK")) throw new Error("LIVE_OUTPUT_MISMATCH");
  return { structuredContent: structured, transactionId, consensusTimestamp, verificationUrl };
}

async function defaultCreateTransport(env: Record<string, string | undefined>): Promise<{
  close(): Promise<void>;
  client: {
    callTool(input: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
  };
}> {
  const bin = env.FRELY_MCP_BIN?.trim();
  const configPath = env.FRELY_MCP_CONFIG_PATH?.trim();
  if (!bin || !configPath) throw new Error("MCP_CONFIG_MISSING");
  const sdkRoot = join(repoRoot(), "apps/frely-mcp/node_modules/@modelcontextprotocol/sdk");
  const { Client } = await import(pathToFileURL(join(sdkRoot, "client/index.js")).href) as {
    Client: new (info: { name: string; version: string }) => {
      connect(transport: unknown): Promise<void>;
      close(): Promise<void>;
      callTool(input: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
    };
  };
  const { StdioClientTransport } = await import(pathToFileURL(join(sdkRoot, "client/stdio.js")).href) as {
    StdioClientTransport: new (input: { command: string; args: string[]; stderr: "pipe" }) => {
      close(): Promise<void>;
    };
  };
  const transport = new StdioClientTransport({
    command: bin,
    args: ["start", "--config", configPath],
    stderr: "pipe",
  });
  const client = new Client({ name: "static-provider-e2e", version: "0.0.0" });
  await client.connect(transport);
  return {
    client,
    async close() {
      await client.close();
      await transport.close();
    },
  };
}

export async function runLive(ports: LivePorts = {}): Promise<unknown> {
  const env = ports.env ?? process.env;
  assertLiveAuthorization(ports.confirmation ?? env.FRELY_LIVE_PAYMENT_CONFIRMATION);
  const evidenceDir = ports.evidenceDir ?? join(repoRoot(), ".local/acceptance/static-provider");
  const preflightPath = ports.preflightPath ?? join(evidenceDir, "preflight.json");
  const now = ports.now?.() ?? new Date();
  const fetchImpl = ports.fetch ?? fetch;
  await assertPreflightGreen(preflightPath, env, now, fetchImpl);
  const imageUrl = env.FRELY_ACCEPTANCE_IMAGE_URL?.trim();
  if (!imageUrl) throw new Error("IMAGE_URL_MISSING");
  const createTransport = ports.createTransport ?? (() => defaultCreateTransport(env));
  const transport = await Promise.resolve(createTransport());
  const session = transport as Awaited<ReturnType<typeof defaultCreateTransport>>;
  const requestId = randomUUID();
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(join(evidenceDir, "request-id.txt"), `${requestId}\n`);
  const writeEvidence = async (value: JsonRecord) => {
    const evidence = redactEvidence({
      paymentAuthorizationRecorded: true,
      authorizationMatched: true,
      requestId,
      intent: FROZEN_PAYMENT_INTENT,
      approvedRunParameters: FROZEN_AUTHORIZATION,
      ...value,
    });
    await writeFile(join(evidenceDir, "live.json"), `${JSON.stringify(evidence, null, 2)}\n`);
    return evidence;
  };
  try {
    const argumentsForCall = {
      capabilities: ["vision"],
      task: TASK_TEXT,
      input: { image_url: imageUrl },
      payment: {
        requestId,
        budget: {
          network: FROZEN_PAYMENT_INTENT.network,
          asset: FROZEN_PAYMENT_INTENT.asset,
          maxAmountAtomic: FROZEN_PAYMENT_INTENT.amountAtomic,
        },
      },
    };
    await writeEvidence({
      paymentAttempted: true,
      paymentSent: "unknown",
      paymentStatus: "unknown",
      serviceStatus: "unknown",
      retryAction: "query_original",
      replayStatus: "not_started",
    });
    let first: unknown;
    try {
      first = await session.client.callTool({ name: "use_capability", arguments: argumentsForCall });
    } catch {
      throw new Error("LIVE_PAYMENT_RESULT_UNKNOWN");
    }
    const rawFirst = object(first);
    const rawOutcome = object(object(rawFirst?.structuredContent)?.paymentOutcome);
    const rawEvidence = object(rawOutcome?.evidence);
    const rawPaymentStatus = typeof rawOutcome?.paymentStatus === "string" ? rawOutcome.paymentStatus : "unknown";
    await writeEvidence({
      paymentAttempted: true,
      paymentSent: typeof rawEvidence?.transactionId === "string" ? true : "unknown",
      paymentStatus: rawPaymentStatus,
      serviceStatus: typeof rawOutcome?.serviceStatus === "string" ? rawOutcome.serviceStatus : "unknown",
      retryAction: rawPaymentStatus === "settled" ? "none" : "query_original",
      replayStatus: "not_started",
      first,
    });
    const firstResult = assertSuccessfulResult(first, requestId);
    await writeEvidence({
      paymentAttempted: true,
      paymentSent: true,
      paymentStatus: "settled",
      serviceStatus: "succeeded",
      retryAction: "none",
      transactionId: firstResult.transactionId,
      verificationUrl: firstResult.verificationUrl,
      consensusTimestamp: firstResult.consensusTimestamp,
      outputContainsExactText: true,
      replayStatus: "pending",
      first,
    });
    let second: unknown;
    try {
      second = await session.client.callTool({ name: "use_capability", arguments: argumentsForCall });
    } catch {
      throw new Error("LIVE_REPLAY_RESULT_UNKNOWN");
    }
    const secondResult = assertSuccessfulResult(second, requestId);
    const replayEqual = JSON.stringify(secondResult.structuredContent) === JSON.stringify(firstResult.structuredContent);
    if (!replayEqual || secondResult.transactionId !== firstResult.transactionId) {
      throw new Error("LIVE_REPLAY_MISMATCH");
    }
    return await writeEvidence({
      paymentAttempted: true,
      paymentSent: true,
      paymentStatus: "settled",
      serviceStatus: "succeeded",
      retryAction: "none",
      transactionId: firstResult.transactionId,
      verificationUrl: firstResult.verificationUrl,
      consensusTimestamp: firstResult.consensusTimestamp,
      outputContainsExactText: true,
      replayEqual,
      replayStatus: "succeeded",
      first,
      second,
    });
  } finally {
    if (session && typeof session.close === "function") await session.close();
  }
}

if (import.meta.main) {
  await runLive();
}
