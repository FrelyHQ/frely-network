#!/usr/bin/env bun
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { main as walletMain, type CliIO } from "../agent-cli/index.ts";
import { createPaidExecutor, parseFrelyResponse } from "@frely-network/broker";
import { readReadyWalletIdentity } from "@frely-network/agent-wallet";
import {
  createLivePorts,
  loadApprovedPaymentConfig,
  openJournal,
  type Journal,
  type PaymentOutcome,
  type Policy,
  type Ports,
} from "@frely-network/hedera-x402";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { checkFrelyMcp } from "./check.ts";
import { loadFrelyMcpConfig, resolveSecret, type FrelyMcpConfig } from "./config.ts";
import { FrelyNetworkClient } from "./network-client.ts";
import { createFrelyMcpRuntime } from "./runtime.ts";
import { createFrelyMcpServer } from "./server.ts";

const known = new Set([
  "INPUT_INVALID",
  "CONFIG_INVALID",
  "CONFIG_INCOMPLETE",
  "WALLET_NOT_READY",
  "NETWORK_UNAVAILABLE",
  "PROVIDER_NOT_AUTHORIZED",
  "PAYMENT_DISABLED",
  "EXECUTION_FAILED",
]);

function processIo(): CliIO {
  return {
    isTTY: Boolean(process.stdin.isTTY && process.stderr.isTTY),
    ask: async () => {
      throw new Error("INPUT_INVALID");
    },
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
  };
}

function parseConfigFlag(args: string[]): string {
  try {
    const parsed = parseArgs({ args, strict: true, allowPositionals: false, options: { config: { type: "string" } } });
    if (!parsed.values.config) throw new Error("INPUT_INVALID");
    return parsed.values.config;
  } catch (error) {
    if (error instanceof Error && error.message === "INPUT_INVALID") throw error;
    throw new Error("INPUT_INVALID");
  }
}

// 发生在 402/预算通过之后、私钥读取之前。
export function wrapPaymentPorts(config: FrelyMcpConfig, policy: Policy, live: Ports): Ports {
  return {
    ...live,
    async checkNetwork(selection) {
      const identity = await readReadyWalletIdentity(config.walletDir);
      if (identity.payerAccountId !== policy.payerAccountId || identity.signerRef !== policy.signerRef) {
        throw new Error("WALLET_NOT_READY");
      }
      await live.checkNetwork(selection);
    },
  };
}

export function outcomeOrWalletError(outcome: PaymentOutcome): PaymentOutcome {
  if (outcome.reason === "WALLET_NOT_READY") throw new Error("WALLET_NOT_READY");
  return outcome;
}

// MCP SDK connect() 在 stdin 仍监听时就返回；会话寿命跟 stdin EOF / 信号，不跟 connect()。
export function waitUntilStdioCloses(input: NodeJS.ReadableStream = process.stdin): Promise<void> {
  return new Promise((resolve) => {
    const stream = input as NodeJS.ReadableStream & { readableEnded?: boolean };
    if (stream.readableEnded) {
      resolve();
      return;
    }
    const finish = () => resolve();
    input.once("end", finish);
    input.once("close", finish);
  });
}

function createStartExecutor(config: FrelyMcpConfig, policy: Policy, journal: Journal | undefined) {
  if (!policy.enabled || !journal) throw new Error("PAYMENT_DISABLED");
  const live = createLivePorts(policy, journal, parseFrelyResponse);
  const execute = createPaidExecutor({
    policy,
    ports: wrapPaymentPorts(config, policy, live),
    executionConfig: {
      mode: "integration",
      origin: new URL(policy.resourceUrl).origin,
      callerKey: resolveSecret(config.relay.apiKeyRef),
    },
  });
  return {
    execute: async (provider: Parameters<typeof execute>[0], request: Parameters<typeof execute>[1]) =>
      outcomeOrWalletError(await execute(provider, request)),
    close() {},
  };
}

async function runCheck(args: string[], io: CliIO): Promise<number> {
  const result = await checkFrelyMcp(parseConfigFlag(args));
  io.stdout(`${JSON.stringify(result)}\n`);
  return result.status === "ready" ? 0 : 2;
}

async function runStart(args: string[]): Promise<number> {
  const config = await loadFrelyMcpConfig(parseConfigFlag(args));
  const policy = await loadApprovedPaymentConfig(config.paymentConfigPath, config.paymentRegistryPath);
  const journal = policy.enabled ? openJournal(policy.journalPath) : undefined;
  const runtime = createFrelyMcpRuntime({
    config,
    paymentPolicy: policy,
    networkClient: new FrelyNetworkClient(config.network),
    createPaymentExecutor: () => createStartExecutor(config, policy, journal),
  });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    runtime.close();
    journal?.close();
  };
  const onSignal = () => {
    close();
    process.exit(0);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    await createFrelyMcpServer(runtime).connect(new StdioServerTransport());
    await waitUntilStdioCloses();
    return 0;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    close();
  }
}

export async function runCli(args: string[], io: CliIO = processIo()): Promise<number> {
  try {
    if (args[0] === "wallet") return await walletMain(args, io);
    if (args[0] === "check") return await runCheck(args.slice(1), io);
    if (args[0] === "start") return await runStart(args.slice(1));
    throw new Error("INPUT_INVALID");
  } catch (error) {
    const code = error instanceof Error && known.has(error.message) ? error.message : "EXECUTION_FAILED";
    io.stderr(`${code}\n`);
    return 2;
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === "wallet") {
    const readline = createInterface({ input: process.stdin, output: process.stderr });
    try {
      process.exitCode = await runCli(args, {
        isTTY: Boolean(process.stdin.isTTY && process.stderr.isTTY),
        ask: (prompt) => readline.question(prompt),
        stdout: (text) => process.stdout.write(text),
        stderr: (text) => process.stderr.write(text),
      });
    } finally {
      readline.close();
    }
  } else {
    process.exitCode = await runCli(args);
  }
}
