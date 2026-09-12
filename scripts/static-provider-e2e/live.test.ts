import { expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runAuthorizedLive, runLiveGate, type LiveEvidence } from "./live.ts";

const TARGET_SHA = "a".repeat(40);
const AMOUNT = "100000000";
const REQUEST_ID = "main-port-live-test";

function successfulResult(transactionId = "0.0.7162784@1789210000.123456789") {
  return {
    structuredContent: {
      requestId: REQUEST_ID,
      provider: { id: "gpt-5.6-luna" },
      resolution: { source: "static_allowlist", identityVerified: false },
      payment: { status: "settled", network: "hedera:testnet", transactionId },
      service: { status: "succeeded" },
      retryAction: "none",
      output: { id: "req_live_relay_1", status: "completed", output_text: "FRELY X402 OK" },
    },
  };
}

async function approvalFile(): Promise<{ path: string; cleanup(): Promise<void> }> {
  const directory = join(import.meta.dir, "../../.local/live-test", randomUUID());
  const path = join(directory, "approval.json");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify({
    targetSha: TARGET_SHA,
    amountAtomic: AMOUNT,
    requestId: REQUEST_ID,
    authorizedAt: "2026-09-12T15:00:00.000Z",
    expiresAt: "2026-09-12T15:15:00.000Z",
  })}\n`, { mode: 0o600 });
  return { path, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test("live runner exits before initialization when approval is missing", async () => {
  let initializations = 0;
  const result = await runLiveGate({
    approvalPath: "/tmp/does-not-exist/.local/live-approval.json",
    targetSha: TARGET_SHA,
    amountAtomic: "10",
    requestId: "live-1",
    initialize: async () => { initializations += 1; },
  });
  expect(result).toEqual({ exitCode: 2, code: "LIVE_PAYMENT_NOT_AUTHORIZED" });
  expect(initializations).toBe(0);
});

test("live runner rejects paths outside a local approval boundary before initialization", async () => {
  let initializations = 0;
  const result = await runLiveGate({
    approvalPath: "/tmp/live-approval.json",
    targetSha: TARGET_SHA,
    amountAtomic: "10",
    requestId: "live-1",
    initialize: async () => { initializations += 1; },
  });
  expect(result).toEqual({ exitCode: 2, code: "LIVE_PAYMENT_NOT_AUTHORIZED" });
  expect(initializations).toBe(0);
});

test("authorized live run replays the exact logical request and records one transaction", async () => {
  const approval = await approvalFile();
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const evidence: LiveEvidence[] = [];
  let closes = 0;
  try {
    const result = await runLiveGate({
      approvalPath: approval.path,
      targetSha: TARGET_SHA,
      amountAtomic: AMOUNT,
      requestId: REQUEST_ID,
      now: () => Date.parse("2026-09-12T15:05:00.000Z"),
      initialize: async () => {
        await runAuthorizedLive({
          targetSha: TARGET_SHA,
          amountAtomic: AMOUNT,
          requestId: REQUEST_ID,
        }, {
          env: { FRELY_ACCEPTANCE_IMAGE_URL: "https://images.example.com/frely-x402.png" },
          createTransport: async () => ({
            client: {
              async callTool(input) {
                calls.push(input);
                return successfulResult();
              },
            },
            async close() { closes += 1; },
          }),
          writeEvidence: async (value) => { evidence.push(value); },
        });
      },
    });

    expect(result).toEqual({ exitCode: 0, code: "LIVE_GATE_PASSED" });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(calls[1]);
    expect(calls[0]).toEqual({
      name: "use_capability",
      arguments: {
        requestId: REQUEST_ID,
        capabilities: ["vision"],
        task: "Read the image and return the exact visible text.",
        input: { image_url: "https://images.example.com/frely-x402.png" },
        maxAmountAtomic: AMOUNT,
      },
    });
    expect(evidence.at(-1)).toEqual({
      schemaVersion: 1,
      targetSha: TARGET_SHA,
      amountAtomic: AMOUNT,
      requestId: REQUEST_ID,
      phase: "complete",
      providerId: "gpt-5.6-luna",
      paymentStatus: "settled",
      serviceStatus: "succeeded",
      retryAction: "none",
      transactionId: "0.0.7162784@1789210000.123456789",
      relayRequestId: "req_live_relay_1",
      outputContainsExactText: true,
      replay: { status: "succeeded", equal: true, transactionIdSame: true },
    });
    expect(closes).toBe(1);
  } finally {
    await approval.cleanup();
  }
});

test("unknown first payment result stops without a replay or a new logical request", async () => {
  const approval = await approvalFile();
  let calls = 0;
  const evidence: LiveEvidence[] = [];
  try {
    const result = await runLiveGate({
      approvalPath: approval.path,
      targetSha: TARGET_SHA,
      amountAtomic: AMOUNT,
      requestId: REQUEST_ID,
      now: () => Date.parse("2026-09-12T15:05:00.000Z"),
      initialize: async () => {
        await runAuthorizedLive({ targetSha: TARGET_SHA, amountAtomic: AMOUNT, requestId: REQUEST_ID }, {
          env: { FRELY_ACCEPTANCE_IMAGE_URL: "https://images.example.com/frely-x402.png" },
          createTransport: async () => ({
            client: {
              async callTool() {
                calls += 1;
                return {
                  isError: true,
                  structuredContent: {
                    requestId: REQUEST_ID,
                    provider: { id: "gpt-5.6-luna" },
                    resolution: { source: "static_allowlist", identityVerified: false },
                    payment: { status: "unknown", network: "hedera:testnet", transactionId: "0.0.7162784@1789210000.123456789" },
                    service: { status: "unknown" },
                    retryAction: "query_original",
                  },
                };
              },
            },
            async close() {},
          }),
          writeEvidence: async (value) => { evidence.push(value); },
        });
      },
    });

    expect(result).toEqual({ exitCode: 2, code: "LIVE_PAYMENT_RESULT_UNKNOWN" });
    expect(calls).toBe(1);
    expect(evidence.at(-1)).toMatchObject({
      phase: "result_unknown",
      requestId: REQUEST_ID,
      paymentStatus: "unknown",
      retryAction: "query_original",
      transactionId: "0.0.7162784@1789210000.123456789",
      replay: { status: "not_started" },
    });
  } finally {
    await approval.cleanup();
  }
});
