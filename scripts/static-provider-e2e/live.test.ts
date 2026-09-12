import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertLiveAuthorization, runLive } from "./live.ts";
import { FROZEN_PAYMENT_INTENT } from "./preflight.ts";

const IMAGE_URL = "https://images.example/frely-x402.png";
const IMAGE_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IMAGE_SHA256 = "4c4b6a3be1314ab86138bef4314dde022e600960d8689a2c8f8631802d20dab6";
const REQUIRED_GATES = ["G0", "G1", "G2", "G3", "G4", "G8", "G9", "G10", "G11", "G12"];

function successfulToolResult() {
  const structuredContent = {
    provider: { id: "frely-vision-basic" },
    resolutionSource: "static_allowlist",
    identityVerified: false,
    paymentOutcome: {
      requestId: "request-from-runner",
      decision: "completed",
      paymentStatus: "settled",
      serviceStatus: "succeeded",
      reason: "PAYMENT_COMPLETED",
      retryAction: "none",
      evidence: {
        source: "testnet",
        network: "hedera:testnet",
        asset: "0.0.0",
        amountAtomic: "100000000",
        payer: "0.0.10386782",
        payTo: "0.0.10403579",
        transactionId: "0.0.7162784@1789180800.000000001",
        verificationUrl: "https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7162784-1789180800-000000001",
        verifiedAt: "2026-09-12T10:00:01.000Z",
        consensusTimestamp: "1789180800.000000001",
      },
      output: { output_text: "FRELY X402 OK" },
    },
    payment: {
      network: "hedera:testnet",
      transactionId: "0.0.7162784@1789180800.000000001",
    },
    output: { output_text: "FRELY X402 OK" },
  };
  return {
    structuredContent,
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
  };
}

async function withPreflight(
  change: Record<string, unknown>,
  run: (paths: { evidenceDir: string; preflightPath: string }) => Promise<void>,
) {
  const evidenceDir = await mkdtemp(join(tmpdir(), "frely-live-test-"));
  const preflightPath = join(evidenceDir, "preflight.json");
  const base = {
    evidenceKind: "live",
    fetchedAt: "2026-09-12T10:00:00.000Z",
    paymentAuthorizationRecorded: true,
    paymentSent: false,
    intent: FROZEN_PAYMENT_INTENT,
    approvedRunParameters: {
      ...FROZEN_PAYMENT_INTENT,
      upstream: "https://api.frely.cloud/v1/responses",
      model: "vision-basic",
    },
    image: {
      url: IMAGE_URL,
      status: 200,
      redirected: false,
      contentType: "image/png",
      bytes: IMAGE_BYTES.byteLength,
      sha256: IMAGE_SHA256,
    },
    gates: Object.fromEntries(REQUIRED_GATES.map((name) => [name, { status: "pass" }])),
    claim: { mode: "static_allowlist", identityVerified: false, discovery: "not used" },
    ...change,
  };
  await writeFile(preflightPath, `${JSON.stringify(base)}\n`);
  try {
    await run({ evidenceDir, preflightPath });
  } finally {
    await rm(evidenceDir, { recursive: true, force: true });
  }
}

function livePorts(paths: { evidenceDir: string; preflightPath: string }, results: unknown[]) {
  let call = 0;
  return {
    ...paths,
    confirmation: "I AUTHORIZE ONE 1 HBAR TESTNET PAYMENT",
    env: { FRELY_ACCEPTANCE_IMAGE_URL: IMAGE_URL },
    now: () => new Date("2026-09-12T10:05:00.000Z"),
    fetch: async () => new Response(IMAGE_BYTES, {
      status: 200,
      headers: { "content-type": "image/png" },
    }),
    createTransport() {
      return {
        client: { callTool: async (input: { arguments: { payment: { requestId: string } } }) => {
          const result = structuredClone(results[call++]);
          const structured = (result as { structuredContent?: { paymentOutcome?: { requestId?: string } } }).structuredContent;
          if (structured?.paymentOutcome) structured.paymentOutcome.requestId = input.arguments.payment.requestId;
          return result;
        } },
        close: async () => undefined,
      };
    },
  };
}

test("does not construct transport when live confirmation is missing", async () => {
  let constructed = 0;
  await expect(runLive({
    confirmation: undefined,
    createTransport() {
      constructed += 1;
      throw new Error("transport-should-not-construct");
    },
  })).rejects.toThrow("LIVE_PAYMENT_NOT_AUTHORIZED");
  expect(constructed).toBe(0);
});

test("does not construct transport when live confirmation is wrong", async () => {
  let constructed = 0;
  await expect(runLive({
    confirmation: "yes",
    createTransport() {
      constructed += 1;
      throw new Error("transport-should-not-construct");
    },
  })).rejects.toThrow("LIVE_PAYMENT_NOT_AUTHORIZED");
  expect(constructed).toBe(0);
});

test("assertLiveAuthorization only accepts the frozen confirmation string", () => {
  expect(() => assertLiveAuthorization(undefined)).toThrow("LIVE_PAYMENT_NOT_AUTHORIZED");
  expect(() => assertLiveAuthorization("I AUTHORIZE ONE 1 HBAR TESTNET PAYMENT")).not.toThrow();
});

test("rejects synthetic preflight evidence before constructing transport", async () => {
  await withPreflight({ evidenceKind: "synthetic" }, async (paths) => {
    let constructed = 0;
    await expect(runLive({
      ...livePorts(paths, [successfulToolResult(), successfulToolResult()]),
      createTransport() {
        constructed += 1;
        throw new Error("transport-should-not-construct");
      },
    })).rejects.toThrow("PREFLIGHT_NOT_LIVE");
    expect(constructed).toBe(0);
  });
});

test("rejects stale preflight evidence before constructing transport", async () => {
  await withPreflight({ fetchedAt: "2026-09-12T09:00:00.000Z" }, async (paths) => {
    let constructed = 0;
    await expect(runLive({
      ...livePorts(paths, [successfulToolResult(), successfulToolResult()]),
      createTransport() {
        constructed += 1;
        throw new Error("transport-should-not-construct");
      },
    })).rejects.toThrow("PREFLIGHT_STALE");
    expect(constructed).toBe(0);
  });
});

test("rejects payment intent drift before constructing transport", async () => {
  await withPreflight({
    intent: { ...FROZEN_PAYMENT_INTENT, amountAtomic: "100000001" },
  }, async (paths) => {
    let constructed = 0;
    await expect(runLive({
      ...livePorts(paths, [successfulToolResult(), successfulToolResult()]),
      createTransport() {
        constructed += 1;
        throw new Error("transport-should-not-construct");
      },
    })).rejects.toThrow("PAYMENT_INTENT_MISMATCH");
    expect(constructed).toBe(0);
  });
});

test("stops after an unverified first result and never issues the replay", async () => {
  await withPreflight({}, async (paths) => {
    const failed = successfulToolResult();
    failed.structuredContent.paymentOutcome.paymentStatus = "unknown";
    failed.structuredContent.paymentOutcome.decision = "paused";
    let calls = 0;
    const ports = livePorts(paths, [failed]);
    await expect(runLive({
      ...ports,
      createTransport() {
        return {
          client: { callTool: async (input: { arguments: { payment: { requestId: string } } }) => {
            calls += 1;
            failed.structuredContent.paymentOutcome.requestId = input.arguments.payment.requestId;
            return failed;
          } },
          close: async () => undefined,
        };
      },
    })).rejects.toThrow("LIVE_PAYMENT_NOT_SETTLED");
    expect(calls).toBe(1);
    const recorded = JSON.parse(await readFile(join(paths.evidenceDir, "live.json"), "utf8"));
    expect(recorded.paymentSent).toBe(true);
    expect(recorded.paymentStatus).toBe("unknown");
    expect(recorded.retryAction).toBe("query_original");
    expect(recorded.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

test("accepts a Mirror-verified business result and an identical replay", async () => {
  await withPreflight({}, async (paths) => {
    const first = successfulToolResult();
    const second = structuredClone(first);
    const evidence = await runLive(livePorts(paths, [first, second])) as Record<string, unknown>;
    expect(evidence.authorizationMatched).toBe(true);
    expect(evidence.paymentStatus).toBe("settled");
    expect(evidence.serviceStatus).toBe("succeeded");
    expect(evidence.transactionId).toBe("0.0.7162784@1789180800.000000001");
    expect(evidence.outputContainsExactText).toBe(true);
    expect(evidence.replayEqual).toBe(true);
  });
});
