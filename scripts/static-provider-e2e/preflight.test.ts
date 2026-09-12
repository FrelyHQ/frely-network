import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertExactPaymentIntent,
  FROZEN_AUTHORIZATION,
  redactEvidence,
  runConflictReplayDouble,
  runPreflight,
  runUnknownRecoveryDouble,
  secretBearingFixture,
  testPorts,
} from "./preflight.ts";

test("preflight never sends PAYMENT-SIGNATURE", async () => {
  const seen: Request[] = [];
  await runPreflight(testPorts(seen));
  expect(seen.some((request) => request.headers.has("PAYMENT-SIGNATURE"))).toBe(false);
});

test("test preflight writes only synthetic evidence outside the repository acceptance directory", () => {
  const ports = testPorts([]);
  expect(ports.evidenceKind).toBe("synthetic");
  expect(ports.evidenceDir?.startsWith(tmpdir())).toBe(true);
  expect(ports.evidenceDir).not.toContain("/.local/acceptance/static-provider");
});

test("preflight never calls signer, settle or use_capability", async () => {
  const seen: Request[] = [];
  const ports = testPorts(seen);
  let signerCalls = 0;
  let settleCalls = 0;
  let useCapabilityCalls = 0;
  await runPreflight({
    ...ports,
    sign: async () => {
      signerCalls += 1;
      throw new Error("signer-disabled");
    },
    settle: async () => {
      settleCalls += 1;
      throw new Error("settle-disabled");
    },
    useCapability: async () => {
      useCapabilityCalls += 1;
      throw new Error("use-capability-disabled");
    },
  });
  expect(signerCalls).toBe(0);
  expect(settleCalls).toBe(0);
  expect(useCapabilityCalls).toBe(0);
  expect(seen.some((request) => request.headers.has("PAYMENT-SIGNATURE"))).toBe(false);
});

test("evidence redacts secrets, signatures and local secret paths", () => {
  const publicEvidence = redactEvidence(secretBearingFixture());
  const text = JSON.stringify(publicEvidence);
  for (const forbidden of [
    "Bearer relay-secret",
    "PAYMENT-SIGNATURE",
    "agent.key",
    "signerRef",
    "journalPath",
  ]) expect(text).not.toContain(forbidden);
});

test("rejects a drifted payment intent before any outbound work", () => {
  expect(() => assertExactPaymentIntent({
    resource: "http://127.0.0.1:13600/v1/responses",
    network: "hedera:testnet",
    asset: "0.0.0",
    amountAtomic: "100000000",
    payer: "0.0.10386782",
    payTo: "0.0.10403579",
    feePayer: "0.0.7162784",
  })).not.toThrow();
  expect(() => assertExactPaymentIntent({
    resource: "http://127.0.0.1:13600/v1/responses",
    network: "hedera:mainnet",
    asset: "0.0.0",
    amountAtomic: "100000000",
    payer: "0.0.10386782",
    payTo: "0.0.10403579",
    feePayer: "0.0.7162784",
  })).toThrow("PAYMENT_INTENT_MISMATCH");
});

test("G8 conflict replay double does not sign a mutated same requestId", () => {
  const result = runConflictReplayDouble();
  expect(result.status).toBe("pass");
  expect(result.signCalls).toBe(1);
  expect(result.settleCalls).toBe(0);
  expect(result.dispatchCalls).toBe(0);
});

test("G9 unknown recovery double only queries the original transaction", () => {
  const result = runUnknownRecoveryDouble();
  expect(result.status).toBe("pass");
  expect(result.signCalls).toBe(1);
  expect(result.settleCalls).toBe(1);
  expect(result.queryCalls).toBe(1);
  expect(result.requestIds).toEqual(["orig-request"]);
  expect(result.secondTransaction).toBe(false);
});

test("preflight records authorization without sending payment", async () => {
  const ports = testPorts([]);
  const evidence = await runPreflight(ports);
  expect(evidence.paymentAuthorizationRecorded).toBe(true);
  expect(evidence.paymentSent).toBe(false);
  expect(evidence.gates.G5.result).toBe("Not run — authorized but not executed in preflight");
  expect(evidence.gates.G6.result).toBe("Not run — authorized but not executed in preflight");
  expect(evidence.gates.G7.result).toBe("Not run — authorized but not executed in preflight");
  const recorded = JSON.parse(await readFile(join(ports.evidenceDir!, "preflight.json"), "utf8"));
  expect(recorded.approvedRunParameters).toEqual(FROZEN_AUTHORIZATION);
});

test("G11 scan rejects secret-bearing evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "frely-e2e-g11-"));
  try {
    await mkdir(join(directory, "nested"), { recursive: true });
    await writeFile(join(directory, "nested", "leak.json"), JSON.stringify({
      authorization: "Bearer relay-secret",
    }));
    const evidence = await runPreflight({
      ...testPorts([]),
      evidenceDir: directory,
    });
    expect(evidence.gates.G11.status).toBe("fail");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("G12 claim boundary forbids Graph ENS and ERC-8004 completion claims", async () => {
  const evidence = await runPreflight(testPorts([]));
  expect(evidence.gates.G12.status).toBe("pass");
  const text = JSON.stringify(evidence.claim);
  expect(text).not.toMatch(/The Graph|ENS|ERC-8004/);
  expect(evidence.claim.mode).toBe("static_allowlist");
  expect(evidence.claim.identityVerified).toBe(false);
});

test("mocked G10 records an existing-model regression result", async () => {
  const evidence = await runPreflight(testPorts([]));
  expect(evidence.gates.G10.status).toBe("pass");
  expect(evidence.gates.G10.model).toBe("gpt-5.6-luna");
  expect(evidence.gates.G10.httpStatus).toBe(200);
});

test("G0 records a business subscription 402 without treating it as x402", async () => {
  const base = testPorts([]);
  const evidence = await runPreflight({
    ...base,
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      if (request.url === "https://api.frely.cloud/v1/models") {
        return Response.json({ data: [{ id: "gpt-5.6-luna" }] });
      }
      if (request.url === "https://api.frely.cloud/v1/responses"
        && JSON.parse(await request.clone().text()).model === "vision-basic") {
        return Response.json({ error: { code: "plan_subscription_required" } }, { status: 402 });
      }
      return base.fetch(request);
    },
  });
  expect(evidence.gates.G0.status).toBe("fail");
  expect(evidence.gates.G0.canaryStatus).toBe(402);
  expect(evidence.gates.G0.canaryCode).toBe("plan_subscription_required");
  expect(evidence.gates.G0.x402Requested).toBe(false);
});

test("G4 fails when Ready wallet payer drifts from the frozen payer", async () => {
  const evidence = await runPreflight({
    ...testPorts([]),
    walletIdentity: {
      network: "hedera:testnet",
      payerAccountId: "0.0.10431569",
      reserveTinybar: "100000000",
    },
  });
  expect(evidence.gates.G4.status).toBe("fail");
  expect(evidence.paymentSent).toBe(false);
});
