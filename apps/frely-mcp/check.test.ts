import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLocalWallet } from "@frely-network/agent-wallet";
import rawPolicy from "../../scripts/payment-spike/fixtures/synthetic/policy.json";
import staticSuccess from "../../packages/protocol/capability-resolution/fixtures/static-success-v2.json";
import { checkFrelyMcp, type CheckPorts } from "./check.ts";

type CheckHarness = {
  configPath: string;
  ports: CheckPorts;
  signCalls(): number;
  journalCreated(): boolean;
  cleanup(): Promise<void>;
};

async function createReadyWallet(walletDir: string): Promise<string> {
  const store = await openLocalWallet({
    network: "hedera:testnet",
    walletDir,
    limits: { maxFeeTinybar: "10000000", reserveTinybar: "10000000" },
  });
  try {
    const next = structuredClone(store.snapshot);
    next.wallet.accountId = "0.0.12345";
    next.wallet.verifiedAt = "1970-01-01T00:00:00.000Z";
    next.state.phase = "Ready";
    await store.save(next);
    return next.wallet.signerRef;
  } finally {
    store.close();
  }
}

async function createCheckHarness(overrides: {
  networkResolve?: CheckPorts["networkResolve"];
  relayFetch?: CheckPorts["relayFetch"];
  enabled?: boolean;
}): Promise<CheckHarness> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "frely-mcp-check-")));
  const walletDir = join(directory, "wallet");
  const signerRef = await createReadyWallet(walletDir);
  const journalPath = join(directory, "journal.sqlite");
  const paymentConfigPath = join(directory, "payment.json");
  const paymentRegistryPath = join(directory, "registry.json");
  const configPath = join(directory, "config.json");
  const previousNetworkKey = process.env.FRELY_NETWORK_API_KEY;
  process.env.FRELY_NETWORK_API_KEY = "test-network-key";
  let signCalls = 0;
  const policy = {
    ...structuredClone(rawPolicy),
    enabled: overrides.enabled ?? true,
    payerAccountId: "0.0.12345",
    signerRef,
    keyType: "ecdsa" as const,
    resourceUrl: staticSuccess.execution.endpoint,
    journalPath,
  };
  await writeFile(paymentConfigPath, JSON.stringify(policy));
  await writeFile(paymentRegistryPath, JSON.stringify({
    version: 1,
    configPaths: [paymentConfigPath],
    journalPaths: [journalPath],
    captureSha256: [],
  }));
  await writeFile(configPath, JSON.stringify({
    schemaVersion: 2,
    network: {
      mode: "static-local",
      baseUrl: "http://127.0.0.1:13600",
      apiKeyRef: "env:FRELY_NETWORK_API_KEY",
    },
    approvedProvider: {
      id: "frely-vision-basic",
      endpoint: "https://api.frely.cloud/v1/responses",
    },
    approvedExecution: {
      endpoint: "http://127.0.0.1:13600/v1/responses",
    },
    walletDir,
    paymentConfigPath,
    paymentRegistryPath,
  }));
  return {
    configPath,
    ports: {
      networkResolve: overrides.networkResolve,
      relayFetch: overrides.relayFetch,
      sign: async () => {
        signCalls += 1;
        throw new Error("FORBIDDEN");
      },
    },
    signCalls: () => signCalls,
    journalCreated: () => existsSync(journalPath),
    cleanup: async () => {
      if (previousNetworkKey === undefined) delete process.env.FRELY_NETWORK_API_KEY;
      else process.env.FRELY_NETWORK_API_KEY = previousNetworkKey;
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("check is read-only and never contacts Relay", async () => {
  const calls: string[] = [];
  const h = await createCheckHarness({
    networkResolve: async () => { calls.push("network"); return staticSuccess; },
    relayFetch: async () => { calls.push("relay"); throw new Error("FORBIDDEN"); },
  });
  try {
    const result = await checkFrelyMcp(h.configPath, h.ports);
    expect(result.status).toBe("ready");
    expect(result.providerId).toBe("frely-vision-basic");
    expect(calls).toEqual(["network"]);
    expect(h.signCalls()).toBe(0);
    expect(h.journalCreated()).toBe(false);
  } finally {
    await h.cleanup();
  }
});

test("disabled profile stays disabled and still does not contact Relay", async () => {
  const calls: string[] = [];
  const h = await createCheckHarness({
    enabled: false,
    networkResolve: async () => { calls.push("network"); return staticSuccess; },
    relayFetch: async () => { calls.push("relay"); throw new Error("FORBIDDEN"); },
  });
  try {
    const result = await checkFrelyMcp(h.configPath, h.ports);
    expect(result).toEqual({
      status: "ready",
      paymentEnabled: false,
      providerId: "frely-vision-basic",
      reason: null,
    });
    expect(calls).toEqual(["network"]);
    expect(h.signCalls()).toBe(0);
    expect(h.journalCreated()).toBe(false);
  } finally {
    await h.cleanup();
  }
});
