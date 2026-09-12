#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { checkFrelyMcp } from "./check.ts";
import { loadFrelyMcpConfig } from "./config.ts";
import { FrelyNetworkClient } from "./network-client.ts";
import { createFrelyMcpRuntime } from "./runtime.ts";
import { createFrelyMcpServer } from "./server.ts";

export async function runCli(args: string[]): Promise<number> {
  try {
    if (args[0] === "--help" || args[0] === "-h") {
      process.stdout.write("frely-mcp start --config /absolute/config.json\nfrely-mcp check --config /absolute/config.json\n");
      return 0;
    }
    const command = args[0];
    const configPath = parseConfigFlag(args.slice(1));
    if (command === "check") {
      const result = await checkFrelyMcp(configPath);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return result.status === "ready" ? 0 : 2;
    }
    if (command !== "start") throw new Error("INPUT_INVALID");
    const config = await loadFrelyMcpConfig(configPath);
    const runtime = createFrelyMcpRuntime({ config, networkClient: new FrelyNetworkClient(config) });
    const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 1024 * 1024 });
    const server = createFrelyMcpServer(runtime);
    const close = () => runtime.close();
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
    try {
      await server.connect(transport);
      await waitForInputClose();
      return 0;
    } finally {
      process.removeListener("SIGINT", close);
      process.removeListener("SIGTERM", close);
      runtime.close();
      await server.close();
    }
  } catch (error) {
    const code = error instanceof Error && ["INPUT_INVALID", "CONFIG_INVALID"].includes(error.message)
      ? error.message
      : "EXECUTION_FAILED";
    process.stderr.write(`${code}\n`);
    return 2;
  }
}

function parseConfigFlag(args: string[]): string {
  try {
    const parsed = parseArgs({ args, strict: true, allowPositionals: false, options: { config: { type: "string" } } });
    if (!parsed.values.config) throw new Error();
    return parsed.values.config;
  } catch {
    throw new Error("INPUT_INVALID");
  }
}

function waitForInputClose(): Promise<void> {
  if (process.stdin.readableEnded || process.stdin.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    process.stdin.once("end", resolve);
    process.stdin.once("close", resolve);
  });
}

if (import.meta.main) process.exitCode = await runCli(process.argv.slice(2));
