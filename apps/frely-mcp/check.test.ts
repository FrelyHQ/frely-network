import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { parseStaticResolveResult } from "@frely-network/capability-resolution";
import success from "../../packages/protocol/capability-resolution/fixtures/static-success-v2.json";
import { checkFrelyMcp } from "./check.ts";

const staticSuccess = parseStaticResolveResult(success);

test("check validates discovery without signing, paying, querying balance or contacting Relay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "frely-mcp-check-"));
  try {
    const configPath = join(directory, "config.json");
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 2,
      network: { baseUrl: "http://127.0.0.1:18765", apiKeyRef: "env:FRELY_NETWORK_API_KEY" },
      approvedProvider: { id: "example-vision", relayUrl: "https://relay.example.com/v1/responses" },
      approvedExecution: { resourceUrl: "http://127.0.0.1:18765/v1/responses" },
    }));
    let resolveCalls = 0;
    const result = await checkFrelyMcp(configPath, {
      environment: { FRELY_NETWORK_API_KEY: "network-key" },
      resolve: async () => { resolveCalls += 1; return staticSuccess; },
      forbiddenSideEffect: () => { throw new Error("FORBIDDEN"); },
    });
    expect(result).toEqual({
      status: "ready",
      findReady: true,
      useReady: false,
      providerId: "example-vision",
      reason: "PAYMENT_DISABLED",
    });
    expect(resolveCalls).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
