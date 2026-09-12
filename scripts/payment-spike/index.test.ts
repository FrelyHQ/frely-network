import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import valid from "./fixtures/synthetic/valid.json";
import policy from "./fixtures/synthetic/policy.json";
import { evaluateOffline } from "./index.ts";
import { openJournal } from "@frely-network/hedera-x402";
import type { Policy } from "@frely-network/hedera-x402";

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function run(args: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, import.meta.dir + "/index.ts", ...args], {
    cwd: join(import.meta.dir, "../.."),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("payment:check CLI", () => {
  test("offline synthetic input reports prepared/not_paid", async () => {
    const result = await run([
      "--mode",
      "offline",
      "--input",
      "scripts/payment-spike/fixtures/synthetic/valid.json",
    ]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      requestId: "fixture-1",
      decision: "prepared",
      paymentStatus: "not_paid",
      serviceStatus: "not_started",
      retryAction: "none",
      reason: "DRY_RUN_ONLY",
      mode: "offline",
      evidence: {
        source: "synthetic",
        network: "hedera:testnet",
        asset: "0.0.0",
        amountAtomic: "100000000",
        payer: "0.0.1236",
        payTo: "0.0.1234",
      },
      output: null,
    });
    expect(result.stderr).toBe("");
  });

  test("blocked input exits 2 without exposing its contents", async () => {
    const directory = await mkdtemp(join(tmpdir(), "frely-payment-cli-"));
    created.push(directory);
    const input = structuredClone(valid) as typeof valid;
    Reflect.deleteProperty(input.request.payment, "budget");
    const path = join(directory, "missing-budget.json");
    await writeFile(join(directory, "policy.json"), JSON.stringify(policy));
    await writeFile(path, JSON.stringify(input));

    const result = await run(["--mode", "offline", "--input", path]);
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toEqual({
      requestId: "fixture-1",
      decision: "blocked",
      paymentStatus: "not_paid",
      serviceStatus: "not_started",
      reason: "BUDGET_INVALID",
      retryAction: "none",
      mode: "offline",
      evidence: { source: "synthetic" },
      output: null,
    });
    expect(result.stdout).not.toContain("PAYMENT_TEST_KEY");
  });

  test("live is blocked before input access unless the operator authorizes it", async () => {
    const result = await run(["--mode", "live", "--input", "ignored.json"]);
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toEqual({
      requestId: null,
      decision: "blocked",
      paymentStatus: "not_paid",
      serviceStatus: "not_started",
      reason: "LIVE_AUTHORIZATION_REQUIRED",
      retryAction: "none",
      evidence: null,
      output: null,
      mode: "live",
    });
  });

  test("live config rejection preserves a settled journal outcome", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "frely-payment-cli-")));
    created.push(directory);
    const journalPath = join(directory, "payments.sqlite");
    const configPath = join(directory, "policy.json");
    const registryPath = join(directory, "registry.json");
    const inputPath = join(directory, "input.json");
    const disabledPolicy = { ...policy, enabled: false, journalPath } as Policy;
    const evidence = { source: "testnet" as const, transactionId: "0.0.1@1.000000001" };
    const journal = openJournal(journalPath);
    journal.admit("fixture-1", "stored-fingerprint", disabledPolicy);
    journal.update("fixture-1", {
      phase: "finished",
      dispatched: true,
      evidence,
      outcome: {
        requestId: "fixture-1",
        decision: "completed",
        paymentStatus: "settled",
        serviceStatus: "unknown",
        reason: "OUTPUT_UNAVAILABLE",
        retryAction: "none",
        evidence,
        output: null,
      },
    });
    journal.close();
    await writeFile(configPath, JSON.stringify(disabledPolicy));
    await writeFile(registryPath, JSON.stringify({ version: 1, configPaths: [configPath], journalPaths: [journalPath], captureSha256: [] }));
    await writeFile(inputPath, JSON.stringify({ configRef: "policy.json", request: valid.request }));

    const result = await run(["--mode", "live", "--input", inputPath], {
      PAYMENT_LIVE_AUTHORIZED: "1",
      FRELY_PAYMENT_REGISTRY: registryPath,
    });
    expect(result.exitCode).toBe(4);
    expect(JSON.parse(result.stdout)).toMatchObject({
      requestId: "fixture-1",
      decision: "blocked",
      paymentStatus: "settled",
      serviceStatus: "unknown",
      reason: "CONFIG_INCOMPLETE",
      retryAction: "none",
      evidence,
      mode: "live",
    });
  });

  test("rejects input larger than one MiB before parsing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "frely-payment-cli-"));
    created.push(directory);
    const path = join(directory, "oversized.json");
    await writeFile(path, " ".repeat(1024 * 1024 + 1));
    const result = await run(["--mode", "offline", "--input", path]);
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout).reason).toBe("INPUT_TOO_LARGE");
  });

  test("rejects unbound or undeclared captures without synthetic evidence", async () => {
    for (const change of [
      (input: Record<string, any>) => (input.capture.source = "captured"),
      (input: Record<string, any>) => (input.capture.method = "GET"),
      (input: Record<string, any>) => (input.capture.url = "https://other.invalid/"),
      (input: Record<string, any>) => (input.capture.bodySha256 = "0".repeat(64)),
      (input: Record<string, any>) => (input.capture.paymentRequiredHeader = "not base64"),
    ]) {
      const directory = await mkdtemp(join(tmpdir(), "frely-payment-cli-"));
      created.push(directory);
      const input: Record<string, any> = structuredClone(valid);
      input.configRef = "policy.json";
      change(input);
      await writeFile(join(directory, "policy.json"), JSON.stringify(policy));
      const path = join(directory, "input.json");
      await writeFile(path, JSON.stringify(input));
      const result = await run(["--mode", "offline", "--input", path]);
      expect(result.exitCode).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({
        requestId: "fixture-1",
        reason: "CAPTURE_INVALID",
        evidence: null,
      });
    }
  });

  test("offline evaluation never calls business, network, or signer ports", async () => {
    const counts = { business: 0, network: 0, sign: 0 };
    const effects = {
      businessRequest: async () => { counts.business++; throw new Error("forbidden"); },
      networkRequest: async () => { counts.network++; throw new Error("forbidden"); },
      sign: async () => { counts.sign++; throw new Error("forbidden"); },
    };
    expect(evaluateOffline(valid, policy, effects).decision).toBe("prepared");
    const rejected = structuredClone(valid) as Record<string, any>;
    delete rejected.request.payment.budget;
    expect(evaluateOffline(rejected, policy, effects).decision).toBe("blocked");
    expect(counts).toEqual({ business: 0, network: 0, sign: 0 });
  });

  test("configRef stays inside the input directory and policy files reject secret fields", async () => {
    const directory = await mkdtemp(join(tmpdir(), "frely-payment-cli-"));
    created.push(directory);
    const input: Record<string, any> = structuredClone(valid);
    input.configRef = "../policy.json";
    const path = join(directory, "input.json");
    await writeFile(path, JSON.stringify(input));
    let result = await run(["--mode", "offline", "--input", path]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      requestId: "fixture-1",
      reason: "CONFIG_INCOMPLETE",
      evidence: null,
    });

    input.configRef = "policy.json";
    await writeFile(path, JSON.stringify(input));
    await writeFile(join(directory, "policy.json"), JSON.stringify({ ...policy, privateKey: "must-not-load" }));
    result = await run(["--mode", "offline", "--input", path]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      requestId: "fixture-1",
      reason: "CONFIG_INCOMPLETE",
      evidence: { source: "synthetic" },
    });
    expect(result.stdout).not.toContain("must-not-load");
  });
});
