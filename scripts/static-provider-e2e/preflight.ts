#!/usr/bin/env bun
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { initAgentWallet } from "@frely-network/agent-wallet";
import { recoverPayerRequest, type PayerPolicy } from "@frely-network/x402-payer-session";
import { buildFrelyMcpPackage } from "../../apps/frely-mcp/build-package.ts";
import { SYNTHETIC } from "./fixtures/synthetic.ts";

type Child = ReturnType<typeof Bun.spawn>;
type Counters = { challenges: number; proofs: number; verifies: number; settlements: number; externalPayment: number; relay: number };

export type SyntheticPreflightResult = {
  mode: "synthetic";
  targetSha: string;
  components: { bun: string; frelyMcp: string; staticNetwork: string };
  order: string[];
  identity: { source: "static_allowlist"; verified: false };
  first: { payment: string; service: string; output: string };
  repeat: { cached: boolean; signDelta: number; settleDelta: number; relayDelta: number };
  conflict: { code: string; signDelta: number; settleDelta: number; relayDelta: number };
  relayFailure: { payment: string; service: string; retryAction: string };
  unknown: { payment: string; service: string; retryAction: string };
  unknownRepeat: { signDelta: number; settleDelta: number; relayDelta: number };
  recovery: { verifyOriginal: number; signDelta: number; relayDelta: number };
  relayPaymentHeaders: string[];
  counters: Counters;
};

export async function runSyntheticPreflight(): Promise<SyntheticPreflightResult> {
  const directory = await mkdtemp(join(tmpdir(), "frely-static-preflight-"));
  await chmod(directory, 0o700);
  const eventPath = join(directory, "events.log");
  await writeFile(eventPath, "", { mode: 0o600 });
  const relayPort = availablePort();
  const networkPort = availablePort();
  const relayUrl = `http://127.0.0.1:${relayPort}/v1/responses`;
  const networkUrl = `http://127.0.0.1:${networkPort}`;
  const relay = spawnFixture("fake-relay.ts", {
    FIXTURE_PORT: String(relayPort),
    FIXTURE_EVENT_PATH: eventPath,
  });
  let network: Child | undefined;
  let transport: StdioClientTransport | undefined;
  let client: Client | undefined;
  try {
    await waitForHttp(`http://127.0.0.1:${relayPort}/__state`);
    const attemptStorePath = join(directory, "network-attempts");
    const staticConfig = {
      listen: { hostname: "127.0.0.1", port: networkPort },
      provider: { id: SYNTHETIC.providerId, relayUrl: "https://relay.example.com/v1/responses" },
      auth: { apiKeyRef: "env:FRELY_NETWORK_API_KEY", relayKeyRef: "env:FRELY_RELAY_API_KEY" },
      payment: {
        network: "hedera:testnet",
        resourceUrl: `${networkUrl}/v1/responses`,
        asset: SYNTHETIC.asset,
        amountAtomic: SYNTHETIC.amountAtomic,
        payTo: SYNTHETIC.payTo,
        feePayer: SYNTHETIC.feePayer,
        facilitatorUrl: "https://facilitator.example.com/",
        attemptStorePath,
      },
    };
    network = spawnFixture("fixture-network.ts", {
      FIXTURE_CONFIG_JSON: JSON.stringify(staticConfig),
      FIXTURE_RELAY_URL: relayUrl,
      FIXTURE_EVENT_PATH: eventPath,
      FRELY_NETWORK_API_KEY: SYNTHETIC.networkKey,
      FRELY_RELAY_API_KEY: SYNTHETIC.relayKey,
    });
    await waitForHttp(`${networkUrl}/healthz`);

    const walletDirectory = join(directory, "wallet");
    await initAgentWallet({ directory: walletDirectory, network: "hedera:testnet" });
    const journalPath = join(directory, "payer-journal", "journal.sqlite");
    const configPath = join(directory, "mcp-config.json");
    const payment = {
      livePaymentEnabled: true,
      network: "hedera:testnet" as const,
      asset: SYNTHETIC.asset,
      amountAtomic: SYNTHETIC.amountAtomic,
      payTo: SYNTHETIC.payTo,
      feePayer: SYNTHETIC.feePayer,
      facilitatorUrl: "https://facilitator.example.com/",
      payerAccountId: SYNTHETIC.payerAccountId,
      maxTimeoutSeconds: 60,
      walletDirectory,
      journalPath,
    };
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 2,
      network: { baseUrl: networkUrl, apiKeyRef: "env:FRELY_NETWORK_API_KEY" },
      approvedProvider: { id: SYNTHETIC.providerId, relayUrl: "https://relay.example.com/v1/responses" },
      approvedExecution: { resourceUrl: `${networkUrl}/v1/responses` },
      payment,
    }), { mode: 0o600 });
    const entry = await buildFrelyMcpPackage();
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry, "start", "--config", configPath],
      cwd: directory,
      env: { PATH: process.env.PATH ?? "", FRELY_NETWORK_API_KEY: SYNTHETIC.networkKey },
      stderr: "pipe",
    });
    client = new Client({ name: "static-preflight", version: "0.0.0" });
    await client.connect(transport);

    const found = structured(await client.callTool({ name: "find_capability", arguments: { capabilities: ["vision"] } }));
    const successInput = useArguments("success-1", "describe");
    const firstResult = structured(await client.callTool({ name: "use_capability", arguments: successInput }));
    const afterFirst = await counters(networkUrl, relayPort);
    const firstEvents = (await readFile(eventPath, "utf8")).trim().split("\n");

    const repeated = structured(await client.callTool({ name: "use_capability", arguments: successInput }));
    const afterRepeat = await counters(networkUrl, relayPort);
    const conflictResult = await client.callTool({
      name: "use_capability",
      arguments: useArguments("success-1", "changed-body"),
    });
    const afterConflict = await counters(networkUrl, relayPort);

    const relayFailed = structured(await client.callTool({
      name: "use_capability",
      arguments: useArguments("failure-1", "relay-failure"),
    }));
    const unknown = structured(await client.callTool({
      name: "use_capability",
      arguments: useArguments("unknown-1", "drop-response"),
    }));
    const beforeUnknownRepeat = await counters(networkUrl, relayPort);
    structured(await client.callTool({ name: "use_capability", arguments: useArguments("unknown-1", "drop-response") }));
    const afterUnknownRepeat = await counters(networkUrl, relayPort);

    let verifyOriginal = 0;
    const beforeRecovery = await counters(networkUrl, relayPort);
    const policy: PayerPolicy = {
      ...payment,
      maxAmountAtomic: payment.amountAtomic,
      resourceUrl: `${networkUrl}/v1/responses`,
    };
    await recoverPayerRequest({
      requestId: "unknown-1",
      journalPath,
      policy,
      verifyOriginal: async () => { verifyOriginal += 1; return "settled"; },
    });
    const afterRecovery = await counters(networkUrl, relayPort);
    const relayState = await json<{ paymentHeaders: string[]; authorizationValues: string[] }>(`http://127.0.0.1:${relayPort}/__state`);
    if (relayState.authorizationValues.some((value) => value !== `Bearer ${SYNTHETIC.relayKey}`)) throw new Error("RELAY_AUTH_LEAK");
    const final = await counters(networkUrl, relayPort);
    return {
      mode: "synthetic",
      targetSha: headSha(),
      components: {
        bun: Bun.version,
        frelyMcp: await packageVersion(join(import.meta.dir, "../../apps/frely-mcp/package.json")),
        staticNetwork: await packageVersion(join(import.meta.dir, "../../apps/static-network/package.json")),
      },
      order: firstEvents.filter((event) => ["challenge", "sign", "settle", "relay"].includes(event)).slice(0, 4),
      identity: { source: String((found.resolution as Record<string, unknown>).source) as "static_allowlist", verified: (found.resolution as Record<string, unknown>).identityVerified as false },
      first: {
        payment: String((firstResult.payment as Record<string, unknown>).status),
        service: String((firstResult.service as Record<string, unknown>).status),
        output: String((firstResult.output as Record<string, unknown>).output_text),
      },
      repeat: {
        cached: JSON.stringify(repeated) === JSON.stringify(firstResult),
        signDelta: afterRepeat.proofs - afterFirst.proofs,
        settleDelta: afterRepeat.settlements - afterFirst.settlements,
        relayDelta: afterRepeat.relay - afterFirst.relay,
      },
      conflict: {
        code: textCode(conflictResult),
        signDelta: afterConflict.proofs - afterRepeat.proofs,
        settleDelta: afterConflict.settlements - afterRepeat.settlements,
        relayDelta: afterConflict.relay - afterRepeat.relay,
      },
      relayFailure: {
        payment: String((relayFailed.payment as Record<string, unknown>).status),
        service: String((relayFailed.service as Record<string, unknown>).status),
        retryAction: String(relayFailed.retryAction),
      },
      unknown: {
        payment: String((unknown.payment as Record<string, unknown>).status),
        service: String((unknown.service as Record<string, unknown>).status),
        retryAction: String(unknown.retryAction),
      },
      unknownRepeat: {
        signDelta: afterUnknownRepeat.proofs - beforeUnknownRepeat.proofs,
        settleDelta: afterUnknownRepeat.settlements - beforeUnknownRepeat.settlements,
        relayDelta: afterUnknownRepeat.relay - beforeUnknownRepeat.relay,
      },
      recovery: {
        verifyOriginal,
        signDelta: afterRecovery.proofs - beforeRecovery.proofs,
        relayDelta: afterRecovery.relay - beforeRecovery.relay,
      },
      relayPaymentHeaders: relayState.paymentHeaders,
      counters: final,
    };
  } finally {
    await client?.close().catch(() => {});
    await transport?.close().catch(() => {});
    stop(network);
    stop(relay);
    await rm(directory, { recursive: true, force: true });
  }
}

function spawnFixture(file: string, environment: Record<string, string>): Child {
  return Bun.spawn([process.execPath, join(import.meta.dir, file)], {
    cwd: import.meta.dir,
    env: { PATH: process.env.PATH ?? "", ...environment },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

function availablePort(): number {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
  const port = server.port;
  server.stop(true);
  if (typeof port !== "number") throw new Error("PORT_UNAVAILABLE");
  return port;
}

async function waitForHttp(url: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {}
    await Bun.sleep(25);
  }
  throw new Error("FIXTURE_START_TIMEOUT");
}

async function json<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error("FIXTURE_STATE_UNAVAILABLE");
  return response.json() as Promise<T>;
}

async function counters(networkUrl: string, relayPort: number): Promise<Counters> {
  const network = await json<Omit<Counters, "relay">>(`${networkUrl}/__state`);
  const relay = await json<{ relay: number }>(`http://127.0.0.1:${relayPort}/__state`);
  return { ...network, relay: relay.relay };
}

function structured(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  if (!result.structuredContent || typeof result.structuredContent !== "object") throw new Error(textCode(result));
  return result.structuredContent as Record<string, unknown>;
}

function textCode(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const first = Array.isArray(result.content) ? result.content[0] : undefined;
  return first && first.type === "text" ? first.text : "EXECUTION_FAILED";
}

function useArguments(requestId: string, task: string) {
  return {
    requestId,
    capabilities: ["vision"],
    task,
    input: { image_url: "https://images.example.com/fixture.png" },
    maxAmountAtomic: SYNTHETIC.amountAtomic,
  };
}

function headSha(): string {
  const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: join(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" });
  const value = result.stdout.toString().trim();
  if (result.exitCode !== 0 || !/^[0-9a-f]{40}$/u.test(value)) throw new Error("TARGET_SHA_UNAVAILABLE");
  return value;
}

async function packageVersion(path: string): Promise<string> {
  const value = await Bun.file(path).json() as Record<string, unknown>;
  if (typeof value.version !== "string" || !value.version) throw new Error("COMPONENT_VERSION_UNAVAILABLE");
  return value.version;
}

function stop(child: Child | undefined): void {
  if (child && child.exitCode === null) child.kill("SIGTERM");
}

if (import.meta.main) {
  try {
    process.stdout.write(`${JSON.stringify(await runSyntheticPreflight())}\n`);
  } catch {
    process.stderr.write("SYNTHETIC_PREFLIGHT_FAILED\n");
    process.exitCode = 1;
  }
}
