import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FROZEN_PAYMENT_INTENT, redactEvidence } from "./preflight.ts";

const CONFIRMATION = "I AUTHORIZE ONE 1 HBAR TESTNET PAYMENT";
const TASK_TEXT = "Read the image and return the exact visible text.";

export type LivePorts = {
  confirmation?: string;
  env?: Record<string, string | undefined>;
  createTransport?: () => unknown;
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

async function assertPreflightGreen(path: string): Promise<void> {
  const raw = JSON.parse(await readFile(path, "utf8")) as {
    paymentSent?: unknown;
    gates?: Record<string, { status?: unknown }>;
  };
  if (raw.paymentSent !== false) throw new Error("PREFLIGHT_NOT_GREEN");
  for (const name of ["G0", "G1", "G2", "G3", "G4", "G8", "G9", "G10", "G11", "G12"]) {
    if (raw.gates?.[name]?.status !== "pass") throw new Error("PREFLIGHT_NOT_GREEN");
  }
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
  await assertPreflightGreen(preflightPath);
  const imageUrl = env.FRELY_ACCEPTANCE_IMAGE_URL?.trim();
  if (!imageUrl) throw new Error("IMAGE_URL_MISSING");
  const createTransport = ports.createTransport ?? (() => defaultCreateTransport(env));
  const transport = await Promise.resolve(createTransport());
  const session = transport as Awaited<ReturnType<typeof defaultCreateTransport>>;
  const requestId = randomUUID();
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(join(evidenceDir, "request-id.txt"), `${requestId}\n`);
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
    const first = await session.client.callTool({ name: "use_capability", arguments: argumentsForCall });
    const second = await session.client.callTool({ name: "use_capability", arguments: argumentsForCall });
    const evidence = redactEvidence({
      paymentAuthorizationRecorded: true,
      paymentSent: true,
      requestId,
      intent: FROZEN_PAYMENT_INTENT,
      first,
      second,
    });
    await writeFile(join(evidenceDir, "live.json"), `${JSON.stringify(evidence, null, 2)}\n`);
    return evidence;
  } finally {
    if (session && typeof session.close === "function") await session.close();
  }
}

if (import.meta.main) {
  await runLive();
}
