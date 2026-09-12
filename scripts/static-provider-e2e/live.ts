#!/usr/bin/env bun
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, sep } from "node:path";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadStaticNetworkConfig } from "../../apps/static-network/config.ts";
import { createStaticNetworkRuntime } from "../../apps/static-network/runtime.ts";
import { serveStaticNetwork } from "../../apps/static-network/server.ts";

export type LiveApproval = {
  targetSha: string;
  amountAtomic: string;
  requestId: string;
  authorizedAt: string;
  expiresAt: string;
};

export type LiveEvidence = {
  schemaVersion: 1;
  targetSha: string;
  amountAtomic: string;
  requestId: string;
  phase: "attempt_started" | "result_unknown" | "first_complete" | "complete";
  providerId: string;
  paymentStatus: "unknown" | "settled";
  serviceStatus: "unknown" | "failed" | "succeeded";
  retryAction: "none" | "query_original";
  transactionId?: string;
  relayRequestId?: string;
  outputContainsExactText: boolean;
  replay: {
    status: "not_started" | "pending" | "succeeded";
    equal?: boolean;
    transactionIdSame?: boolean;
  };
};

type ToolCall = { name: string; arguments: Record<string, unknown> };
type LiveTransport = {
  client: { callTool(input: ToolCall): Promise<unknown> };
  close(): Promise<void>;
};

export type LiveExecutionPorts = {
  env?: Readonly<Record<string, string | undefined>>;
  createTransport?: (env: Readonly<Record<string, string | undefined>>) => Promise<LiveTransport>;
  writeEvidence?: (value: LiveEvidence) => Promise<void>;
  evidencePath?: string;
};

export type LiveGateCode =
  | "LIVE_GATE_PASSED"
  | "LIVE_PAYMENT_NOT_AUTHORIZED"
  | "LIVE_PAYMENT_RESULT_UNKNOWN"
  | "LIVE_BUSINESS_NOT_SUCCEEDED"
  | "LIVE_REPLAY_RESULT_UNKNOWN"
  | "LIVE_REPLAY_MISMATCH"
  | "LIVE_RUN_FAILED";

const TASK_TEXT = "Read the image and return the exact visible text.";
const EXPECTED_TEXT = "FRELY X402 OK";
const EXPECTED_PROVIDER = "gpt-5.6-luna";
const HEDERA_TRANSACTION = /^\d+\.\d+\.\d+@\d+\.[0-9]{9}$/u;
const LIVE_FAILURES = new Set<LiveGateCode>([
  "LIVE_PAYMENT_RESULT_UNKNOWN",
  "LIVE_BUSINESS_NOT_SUCCEEDED",
  "LIVE_REPLAY_RESULT_UNKNOWN",
  "LIVE_REPLAY_MISMATCH",
]);

export async function runLiveGate(input: {
  approvalPath: string;
  targetSha: string;
  amountAtomic: string;
  requestId: string;
  now?: () => number;
  initialize: () => Promise<void>;
}): Promise<{ exitCode: 0 | 2; code: LiveGateCode }> {
  try {
    if (!isAbsolute(input.approvalPath) || !input.approvalPath.includes(`${sep}.local${sep}`)) throw new Error();
    const info = await lstat(input.approvalPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 2 || info.size > 4096) throw new Error();
    const approval = parseApproval(JSON.parse(await readFile(input.approvalPath, "utf8")));
    const now = input.now?.() ?? Date.now();
    const authorized = Date.parse(approval.authorizedAt);
    const expires = Date.parse(approval.expiresAt);
    if (
      approval.targetSha !== input.targetSha ||
      approval.amountAtomic !== input.amountAtomic ||
      approval.requestId !== input.requestId ||
      !Number.isFinite(authorized) ||
      !Number.isFinite(expires) ||
      authorized > now ||
      expires <= now ||
      expires - authorized > 15 * 60 * 1000 ||
      !isIgnoredAndUntracked(input.approvalPath)
    ) throw new Error();
    try {
      await input.initialize();
    } catch (error) {
      const code = error instanceof Error && LIVE_FAILURES.has(error.message as LiveGateCode)
        ? error.message as LiveGateCode
        : "LIVE_RUN_FAILED";
      return { exitCode: 2, code };
    }
    return { exitCode: 0, code: "LIVE_GATE_PASSED" };
  } catch {
    return { exitCode: 2, code: "LIVE_PAYMENT_NOT_AUTHORIZED" };
  }
}

export async function runAuthorizedLive(
  input: { targetSha: string; amountAtomic: string; requestId: string },
  ports: LiveExecutionPorts = {},
): Promise<LiveEvidence> {
  if (
    !/^[0-9a-f]{40}$/u.test(input.targetSha) ||
    !/^[1-9][0-9]*$/u.test(input.amountAtomic) ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/u.test(input.requestId)
  ) throw new Error("LIVE_RUN_FAILED");

  const env = ports.env ?? process.env;
  const imageUrl = env.FRELY_ACCEPTANCE_IMAGE_URL?.trim();
  if (!imageUrl) throw new Error("LIVE_RUN_FAILED");
  const writeEvidence = ports.writeEvidence ?? evidenceWriter(ports.evidencePath ?? env.FRELY_LIVE_EVIDENCE_PATH);
  const base: Pick<LiveEvidence, "schemaVersion" | "targetSha" | "amountAtomic" | "requestId" | "providerId"> = {
    schemaVersion: 1,
    targetSha: input.targetSha,
    amountAtomic: input.amountAtomic,
    requestId: input.requestId,
    providerId: EXPECTED_PROVIDER,
  };
  await writeEvidence({
    ...base,
    phase: "attempt_started",
    paymentStatus: "unknown",
    serviceStatus: "unknown",
    retryAction: "query_original",
    outputContainsExactText: false,
    replay: { status: "not_started" },
  });

  const createTransport = ports.createTransport ?? defaultCreateTransport;
  const transport = await createTransport(env);
  const argumentsForCall = {
    requestId: input.requestId,
    capabilities: ["vision"],
    task: TASK_TEXT,
    input: { image_url: imageUrl },
    maxAmountAtomic: input.amountAtomic,
  };

  try {
    let first: unknown;
    try {
      first = await transport.client.callTool({ name: "use_capability", arguments: argumentsForCall });
    } catch {
      throw new Error("LIVE_PAYMENT_RESULT_UNKNOWN");
    }
    const firstResult = inspectResult(first, input.requestId);
    if (firstResult.paymentStatus !== "settled") {
      await writeEvidence({
        ...base,
        phase: "result_unknown",
        paymentStatus: "unknown",
        serviceStatus: firstResult.serviceStatus === "failed" ? "failed" : "unknown",
        retryAction: "query_original",
        ...(firstResult.transactionId ? { transactionId: firstResult.transactionId } : {}),
        outputContainsExactText: false,
        replay: { status: "not_started" },
      });
      throw new Error("LIVE_PAYMENT_RESULT_UNKNOWN");
    }
    if (firstResult.serviceStatus !== "succeeded" || !firstResult.outputContainsExactText) {
      await writeEvidence({
        ...base,
        phase: "first_complete",
        paymentStatus: "settled",
        serviceStatus: "failed",
        retryAction: "none",
        transactionId: firstResult.transactionId,
        ...(firstResult.relayRequestId ? { relayRequestId: firstResult.relayRequestId } : {}),
        outputContainsExactText: firstResult.outputContainsExactText,
        replay: { status: "not_started" },
      });
      throw new Error("LIVE_BUSINESS_NOT_SUCCEEDED");
    }
    await writeEvidence({
      ...base,
      phase: "first_complete",
      paymentStatus: "settled",
      serviceStatus: "succeeded",
      retryAction: "none",
      transactionId: firstResult.transactionId,
      ...(firstResult.relayRequestId ? { relayRequestId: firstResult.relayRequestId } : {}),
      outputContainsExactText: true,
      replay: { status: "pending" },
    });

    let second: unknown;
    try {
      second = await transport.client.callTool({ name: "use_capability", arguments: argumentsForCall });
    } catch {
      throw new Error("LIVE_REPLAY_RESULT_UNKNOWN");
    }
    const secondResult = inspectResult(second, input.requestId);
    const equal = JSON.stringify(asObject(first)?.structuredContent) === JSON.stringify(asObject(second)?.structuredContent);
    const transactionIdSame = secondResult.transactionId === firstResult.transactionId;
    if (
      secondResult.paymentStatus !== "settled" ||
      secondResult.serviceStatus !== "succeeded" ||
      !secondResult.outputContainsExactText ||
      !equal ||
      !transactionIdSame
    ) throw new Error("LIVE_REPLAY_MISMATCH");

    const complete: LiveEvidence = {
      ...base,
      phase: "complete",
      paymentStatus: "settled",
      serviceStatus: "succeeded",
      retryAction: "none",
      transactionId: firstResult.transactionId,
      ...(firstResult.relayRequestId ? { relayRequestId: firstResult.relayRequestId } : {}),
      outputContainsExactText: true,
      replay: { status: "succeeded", equal: true, transactionIdSame: true },
    };
    await writeEvidence(complete);
    return complete;
  } finally {
    await transport.close();
  }
}

function parseApproval(value: unknown): LiveApproval {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  if (
    keys.length !== 5 ||
    !["targetSha", "amountAtomic", "requestId", "authorizedAt", "expiresAt"].every((key) => keys.includes(key)) ||
    typeof object.targetSha !== "string" || !/^[0-9a-f]{40}$/u.test(object.targetSha) ||
    typeof object.amountAtomic !== "string" || !/^[1-9][0-9]*$/u.test(object.amountAtomic) ||
    typeof object.requestId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/u.test(object.requestId) ||
    typeof object.authorizedAt !== "string" ||
    typeof object.expiresAt !== "string"
  ) throw new Error();
  return object as LiveApproval;
}

function isIgnoredAndUntracked(path: string): boolean {
  const root = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  if (root.exitCode !== 0) return false;
  const repository = root.stdout.toString().trim();
  const pathFromRoot = relative(repository, path);
  if (!pathFromRoot || pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) return false;
  const tracked = Bun.spawnSync(["git", "ls-files", "--error-unmatch", "--", pathFromRoot], { cwd: repository, stdout: "pipe", stderr: "pipe" });
  if (tracked.exitCode === 0) return false;
  const ignored = Bun.spawnSync(["git", "check-ignore", "--quiet", "--", pathFromRoot], { cwd: repository, stdout: "pipe", stderr: "pipe" });
  return ignored.exitCode === 0;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function inspectResult(result: unknown, requestId: string): {
  paymentStatus: "unknown" | "settled";
  serviceStatus: "unknown" | "failed" | "succeeded";
  transactionId?: string;
  relayRequestId?: string;
  outputContainsExactText: boolean;
} {
  const tool = asObject(result);
  const structured = asObject(tool?.structuredContent);
  const provider = asObject(structured?.provider);
  const resolution = asObject(structured?.resolution);
  const payment = asObject(structured?.payment);
  const service = asObject(structured?.service);
  if (
    !structured ||
    structured.requestId !== requestId ||
    provider?.id !== EXPECTED_PROVIDER ||
    resolution?.source !== "static_allowlist" ||
    resolution.identityVerified !== false ||
    payment?.network !== "hedera:testnet"
  ) throw new Error("LIVE_RUN_FAILED");
  const paymentStatus = payment.status === "settled" ? "settled" : "unknown";
  const serviceStatus = service?.status === "succeeded" ? "succeeded" : service?.status === "failed" ? "failed" : "unknown";
  const transactionId = typeof payment.transactionId === "string" && HEDERA_TRANSACTION.test(payment.transactionId)
    ? payment.transactionId
    : undefined;
  if (paymentStatus === "settled" && !transactionId) throw new Error("LIVE_RUN_FAILED");
  const output = structured.output;
  const serializedOutput = output === undefined ? "" : JSON.stringify(output);
  const relay = asObject(output);
  const relayRequestId = typeof relay?.id === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,191}$/u.test(relay.id)
    ? relay.id
    : undefined;
  return {
    paymentStatus,
    serviceStatus,
    ...(transactionId ? { transactionId } : {}),
    ...(relayRequestId ? { relayRequestId } : {}),
    outputContainsExactText: serializedOutput.includes(EXPECTED_TEXT),
  };
}

function evidenceWriter(path: string | undefined): (value: LiveEvidence) => Promise<void> {
  if (!path || !isAbsolute(path) || !path.includes(`${sep}.local${sep}`)) throw new Error("LIVE_RUN_FAILED");
  return async (value) => {
    const directory = dirname(path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const existing = await lstat(path).catch(() => undefined);
    if (existing?.isSymbolicLink() || (existing && !existing.isFile())) throw new Error("LIVE_RUN_FAILED");
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await chmod(path, 0o600);
  };
}

async function defaultCreateTransport(env: Readonly<Record<string, string | undefined>>): Promise<LiveTransport> {
  const bin = env.FRELY_MCP_BIN?.trim();
  const configPath = env.FRELY_MCP_CONFIG_PATH?.trim();
  const networkKey = env.FRELY_NETWORK_API_KEY?.trim();
  if (!bin || !configPath || !networkKey || !isAbsolute(bin) || !isAbsolute(configPath)) throw new Error("LIVE_RUN_FAILED");

  const runtime = createStaticNetworkRuntime(loadStaticNetworkConfig(env), { environment: env });
  const network = serveStaticNetwork(runtime);
  const stdio = new StdioClientTransport({
    command: bin,
    args: ["start", "--config", configPath],
    env: { PATH: env.PATH ?? process.env.PATH ?? "", FRELY_NETWORK_API_KEY: networkKey },
    stderr: "pipe",
  });
  const client = new Client({ name: "static-provider-live-e2e", version: "0.0.0" });
  try {
    await client.connect(stdio);
  } catch (error) {
    network.stop(true);
    runtime.close();
    throw error;
  }
  return {
    client,
    async close() {
      await client.close().catch(() => {});
      await stdio.close().catch(() => {});
      network.stop(true);
      runtime.close();
    },
  };
}

function headSha(): string {
  const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  const sha = result.stdout.toString().trim();
  if (result.exitCode !== 0 || !/^[0-9a-f]{40}$/u.test(sha)) throw new Error("LIVE_RUN_FAILED");
  return sha;
}

if (import.meta.main) {
  let result: Awaited<ReturnType<typeof runLiveGate>> = { exitCode: 2, code: "LIVE_PAYMENT_NOT_AUTHORIZED" };
  let evidence: LiveEvidence | undefined;
  try {
    const parsed = parseArgs({
      args: process.argv.slice(2),
      strict: true,
      allowPositionals: false,
      options: {
        approval: { type: "string" },
        "target-sha": { type: "string" },
        "amount-atomic": { type: "string" },
        "request-id": { type: "string" },
        evidence: { type: "string" },
      },
    });
    const targetSha = parsed.values["target-sha"];
    const amountAtomic = parsed.values["amount-atomic"];
    const requestId = parsed.values["request-id"];
    const approvalPath = parsed.values.approval;
    if (!approvalPath || !targetSha || !amountAtomic || !requestId || targetSha !== headSha()) throw new Error();
    result = await runLiveGate({
      approvalPath,
      targetSha,
      amountAtomic,
      requestId,
      initialize: async () => {
        evidence = await runAuthorizedLive({ targetSha, amountAtomic, requestId }, {
          evidencePath: parsed.values.evidence ?? `${approvalPath}.evidence.json`,
        });
      },
    });
  } catch {}
  if (result.exitCode === 0 && evidence) process.stdout.write(`${JSON.stringify(evidence)}\n`);
  else process.stderr.write(`${result.code}\n`);
  process.exitCode = result.exitCode;
}
