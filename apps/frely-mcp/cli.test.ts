import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import rawPolicy from "../../scripts/payment-spike/fixtures/synthetic/policy.json";
import successFixture from "../../packages/protocol/capability-resolution/fixtures/success.json";
import { PassThrough } from "node:stream";
import { runCli, runStart, waitUntilStdioCloses } from "./index.ts";

const known = new Set(["INPUT_INVALID", "CONFIG_INVALID", "CONFIG_INCOMPLETE", "WALLET_NOT_READY", "EXECUTION_FAILED"]);

async function createStartFixture(options: { enabled?: boolean } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "frely-mcp-cli-")));
  const paymentConfigPath = join(directory, "payment.json");
  const paymentRegistryPath = join(directory, "registry.json");
  const configPath = join(directory, "config.json");
  const journalPath = join(directory, "journal.sqlite");
  const suffix = directory.replace(/[^A-Za-z0-9]/g, "").slice(-12).toUpperCase();
  const networkKey = `FRELY_API_KEY_${suffix}`;
  const relayKey = `FRELY_RELAY_API_KEY_${suffix}`;
  process.env[networkKey] = "test-network-key";
  process.env[relayKey] = "test-relay-key";
  const enabled = options.enabled === true;
  const policy = {
    ...structuredClone(rawPolicy),
    enabled,
    resourceUrl: successFixture.provider.endpoint,
    journalPath,
  };
  await writeFile(paymentConfigPath, JSON.stringify(policy));
  await writeFile(paymentRegistryPath, JSON.stringify({
    version: 1,
    configPaths: [paymentConfigPath],
    journalPaths: enabled ? [journalPath] : [],
    captureSha256: [],
  }));
  await writeFile(configPath, JSON.stringify({
    schemaVersion: 1,
    network: {
      baseUrl: "https://network.example",
      apiKeyRef: `env:${networkKey}`,
      chainId: 11155111,
      registry: "0x1111111111111111111111111111111111111111",
    },
    relay: { apiKeyRef: `env:${relayKey}` },
    walletDir: join(directory, "wallet"),
    approvedProviderId: "provider-1",
    paymentConfigPath,
    paymentRegistryPath,
  }));
  return {
    configPath,
    cleanup: async () => {
      delete process.env[networkKey];
      delete process.env[relayKey];
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("wallet init is handed to the existing agent CLI", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(["wallet", "init", "--help"], {
    isTTY: false,
    ask: async () => {
      throw new Error("NO_ASK");
    },
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  });
  expect(code).toBe(0);
  expect(stdout.join("")).toContain("wallet init");
  expect(stdout.join("")).toContain("--network");
  expect(stderr.join("")).toBe("");
});

test("check and start require an absolute --config", async () => {
  for (const args of [["check"], ["start"], ["check", "--config"], ["nope"]]) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runCli(args, {
      isTTY: false,
      ask: async () => {
        throw new Error("NO_ASK");
      },
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    });
    expect(code).toBe(2);
    expect(stdout.join("")).toBe("");
    expect(known.has(stderr.join("").trim())).toBe(true);
  }
});

test("enabled runStart does not close until injected stdin ends", async () => {
  const fixture = await createStartFixture({ enabled: true });
  const stdin = new PassThrough();
  stdin.resume();
  let finished = false;
  try {
    const started = runStart(["--config", fixture.configPath], stdin).then((code) => {
      finished = true;
      return code;
    });
    await Bun.sleep(50);
    expect(finished).toBe(false);
    stdin.end();
    expect(await started).toBe(0);
    expect(finished).toBe(true);
  } finally {
    stdin.end();
    await fixture.cleanup();
  }
});

test("stdio session wait does not resolve while the stream is open", async () => {
  const stdin = new PassThrough();
  stdin.resume();
  let ended = false;
  const waiting = waitUntilStdioCloses(stdin).then(() => {
    ended = true;
  });
  await Bun.sleep(30);
  expect(ended).toBe(false);
  stdin.end();
  await waiting;
  expect(ended).toBe(true);
});

test("start writes only MCP frames and does not resolve on boot", async () => {
  const fixture = await createStartFixture();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dir, "index.ts"), "start", "--config", fixture.configPath],
    stderr: "pipe",
  });
  const errors: string[] = [];
  transport.stderr?.on("data", (chunk) => errors.push(String(chunk)));
  const client = new Client({ name: "cli-test", version: "0.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(["find_capability", "use_capability"]);
    expect(errors.join("")).toBe("");
  } finally {
    await client.close();
    await transport.close();
    await fixture.cleanup();
  }
});

test("enabled start keeps serving until stdin EOF", async () => {
  const fixture = await createStartFixture({ enabled: true });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dir, "index.ts"), "start", "--config", fixture.configPath],
    stderr: "pipe",
  });
  const errors: string[] = [];
  transport.stderr?.on("data", (chunk) => errors.push(String(chunk)));
  const client = new Client({ name: "cli-test", version: "0.0.0" });
  try {
    await client.connect(transport);
    const first = await client.listTools();
    await Bun.sleep(50);
    const second = await client.listTools();
    expect(first.tools.map((tool) => tool.name)).toEqual(["find_capability", "use_capability"]);
    expect(second.tools.map((tool) => tool.name)).toEqual(["find_capability", "use_capability"]);
    expect(errors.join("")).toBe("");
  } finally {
    await client.close();
    await transport.close();
    await fixture.cleanup();
  }
});

test("start closes after stdin EOF", async () => {
  const fixture = await createStartFixture();
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "index.ts"), "start", "--config", fixture.configPath],
    { stdout: "pipe", stderr: "pipe", stdin: "pipe" },
  );
  try {
    await Bun.sleep(400);
    child.stdin.end();
    const status = await Promise.race([
      child.exited,
      new Promise<number>((_, reject) => {
        setTimeout(() => reject(new Error("start did not exit after stdin EOF")), 4000);
      }),
    ]);
    expect(status).toBe(0);
  } finally {
    child.kill();
    await fixture.cleanup();
  }
});

test("spawned errors contain only a fixed code", async () => {
  for (const args of [[], ["nope"], ["check", "--config", "relative.json"]]) {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "index.ts"), ...args], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const code = stderr.trim().split("\n").at(-1) ?? "";
    expect(status).toBe(2);
    expect(stdout).toBe("");
    expect(known.has(code)).toBe(true);
    expect(code).not.toContain("/");
    expect(code).not.toContain("sk-");
  }
});
