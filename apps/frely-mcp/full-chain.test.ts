import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLocalWallet } from "@frely-network/agent-wallet";
import rawPolicy from "../../scripts/payment-spike/fixtures/synthetic/policy.json";

const visionArguments = (requestId: string) => ({
  capabilities: ["vision"],
  task: "Describe the image",
  input: { image_url: "https://images.example/demo.png" },
  payment: {
    requestId,
    budget: { network: "hedera:testnet", asset: "0.0.0", maxAmountAtomic: "100000000" },
  },
});

type CommandResult = { exitCode: number; stdout: string; stderr: string };
async function run(command: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<CommandResult> {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe", env: env ?? { ...process.env } });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function createFullChainHarness() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "frely-mcp-full-")));
  const walletParent = join(root, "wallet-parent");
  const walletDir = join(walletParent, "wallet");
  await mkdir(walletParent, { recursive: true });
  const store = await openLocalWallet({
    network: "hedera:testnet",
    walletDir,
    limits: { maxFeeTinybar: "10000000", reserveTinybar: "10000000" },
  });
  const key = await store.readKey();
  const next = structuredClone(store.snapshot);
  next.wallet.accountId = "0.0.1236";
  next.wallet.verifiedAt = "1970-01-01T00:00:00.000Z";
  next.state.phase = "Ready";
  await store.save(next);
  store.close();

  const paymentConfigPath = join(root, "payment.json");
  const paymentRegistryPath = join(root, "registry.json");
  const configPath = join(root, "config.json");
  const journalPath = join(root, "journal.sqlite");
  const eventsPath = join(root, "events.json");
  const unpackDir = join(root, "unpacked");
  const installDir = join(root, "installed");
  await mkdir(unpackDir);
  await mkdir(installDir);
  const networkKey = "FRELY_NETWORK_API_KEY";
  const relayKey = "FRELY_RELAY_API_KEY";
  const policy = {
    ...structuredClone(rawPolicy),
    enabled: true,
    payerAccountId: "0.0.1236",
    signerRef: "file:" + join(walletDir, "agent.key"),
    keyType: "ecdsa" as const,
    resourceUrl: "http://127.0.0.1:13600/v1/responses",
    journalPath,
    facilitatorUrl: "https://facilitator.example",
    mirrorNodeUrl: "https://mirror.example",
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
      apiKeyRef: `env:${networkKey}`,
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

  const built = await run([process.execPath, "build-package.ts"], import.meta.dir);
  if (built.exitCode !== 0) throw new Error("PACKAGE_BUILD_FAILED");
  const packed = await run(["npm", "pack", "--json"], import.meta.dir);
  if (packed.exitCode !== 0) throw new Error("PACKAGE_BUILD_FAILED");
  const metadata = JSON.parse(packed.stdout)[0] as { filename: string };
  const archive = join(import.meta.dir, metadata.filename);
  if ((await run(["tar", "-xzf", archive, "-C", unpackDir], root)).exitCode !== 0) throw new Error("PACKAGE_BUILD_FAILED");
  if ((await run(["npm", "install", "--ignore-scripts", archive], installDir)).exitCode !== 0) throw new Error("PACKAGE_BUILD_FAILED");

  const bin = join(installDir, "node_modules/.bin/frely-mcp");
  const preload = join(import.meta.dir, "fixtures/full-chain-preload.ts");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--preload", preload, bin, "start", "--config", configPath],
    stderr: "pipe",
    env: {
      ...process.env,
      [networkKey]: "network-secret",
      [relayKey]: "relay-secret",
      FRELY_FULL_CHAIN_EVENTS: eventsPath,
      FRELY_FULL_CHAIN_PAYER: "0.0.1236",
      FRELY_FULL_CHAIN_PAY_TO: "0.0.1234",
      FRELY_FULL_CHAIN_FEE_PAYER: "0.0.1235",
      FRELY_FULL_CHAIN_AMOUNT: "100000000",
      FRELY_FULL_CHAIN_PAYER_PUB: key.publicKey.toStringRaw(),
      FRELY_FULL_CHAIN_WALLET: walletDir,
      FRELY_FULL_CHAIN_SECRET: key.toStringRaw(),
    },
  });
  const errors: string[] = [];
  transport.stderr?.on("data", (chunk) => errors.push(String(chunk)));
  const client = new Client({ name: "full-chain", version: "0.0.0" });
  await client.connect(transport);
  return {
    client,
    counts: async () => JSON.parse(await readFile(eventsPath, "utf8")) as {
      resolve: number;
      networkQuote: number;
      sign: number;
      networkSettle: number;
      relayDispatch: number;
      mirror: number;
    },
    errors: () => errors.join(""),
    close: async () => {
      await client.close();
      await transport.close();
      await rm(root, { recursive: true, force: true });
      await rm(archive, { force: true });
    },
  };
}

test("packaged MCP pays once through synthetic Network and Relay", async () => {
  const h = await createFullChainHarness();
  try {
    const found = await h.client.callTool({ name: "find_capability", arguments: { capabilities: ["vision"] } });
    expect(found.isError).not.toBe(true);

    const first = await h.client.callTool({ name: "use_capability", arguments: visionArguments("mvp-e2e-1") });
    expect(first.structuredContent).toMatchObject({
      resolutionSource: "static_allowlist",
      identityVerified: false,
      paymentOutcome: { paymentStatus: "settled", serviceStatus: "succeeded" },
      output: { output_text: "FRELY X402 OK" },
    });
    expect(await h.counts()).toMatchObject({
      networkQuote: 1,
      sign: 1,
      networkSettle: 1,
      relayDispatch: 1,
    });

    const repeated = await h.client.callTool({ name: "use_capability", arguments: visionArguments("mvp-e2e-1") });
    expect(repeated.structuredContent).toEqual(first.structuredContent);
    expect(await h.counts()).toMatchObject({
      networkQuote: 1,
      sign: 1,
      networkSettle: 1,
      relayDispatch: 1,
    });

    const afterReplay = await h.counts();
    for (const args of [
      { ...visionArguments("mvp-e2e-1"), task: "Other" },
      { ...visionArguments("mvp-e2e-1"), input: { image_url: "https://images.example/other.png" } },
      { ...visionArguments("mvp-e2e-1"), payment: { requestId: "mvp-e2e-1", budget: { network: "hedera:testnet", asset: "0.0.0", maxAmountAtomic: "1" } } },
    ]) {
      const conflict = await h.client.callTool({ name: "use_capability", arguments: args });
      expect(conflict.isError).toBe(true);
      expect(JSON.stringify(conflict.structuredContent ?? conflict.content)).toMatch(/REQUEST_ID_CONFLICT/);
      expect(await h.counts()).toMatchObject({
        networkQuote: afterReplay.networkQuote,
        sign: afterReplay.sign,
        networkSettle: afterReplay.networkSettle,
        relayDispatch: afterReplay.relayDispatch,
      });
    }
  } finally {
    await h.close();
  }
}, 120_000);

test("pending settlement only queries the original transaction", async () => {
  const h = await createFullChainHarness();
  try {
    const first = await h.client.callTool({ name: "use_capability", arguments: visionArguments("pending-e2e-1") });
    const firstContent = first.structuredContent as { paymentOutcome?: { paymentStatus?: string; retryAction?: string } };
    expect(firstContent.paymentOutcome?.paymentStatus).toBe("unknown");
    expect(firstContent.paymentOutcome?.retryAction).toBe("query_original");
    const afterFirst = await h.counts();
    expect(afterFirst.sign).toBe(1);
    expect(afterFirst.networkSettle).toBe(1);
    expect(afterFirst.relayDispatch).toBe(0);

    const repeated = await h.client.callTool({ name: "use_capability", arguments: visionArguments("pending-e2e-1") });
    const repeatedContent = repeated.structuredContent as { paymentOutcome?: { paymentStatus?: string; retryAction?: string } };
    expect(repeatedContent.paymentOutcome?.paymentStatus).toBe("unknown");
    expect(repeatedContent.paymentOutcome?.retryAction).toBe("query_original");
    const afterRepeat = await h.counts();
    expect(afterRepeat).toMatchObject({
      networkQuote: afterFirst.networkQuote,
      sign: 1,
      networkSettle: 1,
      relayDispatch: 0,
    });
    expect(afterRepeat.mirror).toBeGreaterThan(afterFirst.mirror);
  } finally {
    await h.close();
  }
}, 120_000);
