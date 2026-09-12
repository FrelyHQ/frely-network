import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { createStaticNetworkRuntime } from "./runtime.ts";

test("runtime composes local dependencies without external calls and closes cleanly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "static-network-"));
  let externalCalls = 0;
  try {
    const runtime = createStaticNetworkRuntime({
      listen: { hostname: "127.0.0.1", port: 13600 },
      provider: { id: "vision-provider", relayUrl: "https://relay.example.com/v1/responses" },
      auth: { apiKeyRef: "env:FRELY_NETWORK_API_KEY", relayKeyRef: "env:FRELY_RELAY_API_KEY" },
      payment: {
        network: "hedera:testnet",
        resourceUrl: "http://127.0.0.1:13600/v1/responses",
        asset: "0.0.123",
        amountAtomic: "10",
        payTo: "0.0.456",
        feePayer: "0.0.789",
        facilitatorUrl: "https://facilitator.example.com/",
        attemptStorePath: directory,
      },
    }, {
      environment: { FRELY_NETWORK_API_KEY: "network-key", FRELY_RELAY_API_KEY: "relay-key" },
      gatewayPorts: {
        verifier: { verify: async () => ({ isValid: true }) },
        settler: { settle: async () => ({ success: true, network: "hedera:testnet", transaction: "tx-1" }) },
      },
      fetcher: async () => {
        externalCalls += 1;
        return Response.json({ ok: true });
      },
    });
    const ready = await runtime.fetch(new Request("http://127.0.0.1:13600/readyz"));
    expect(ready.status).toBe(200);
    const challenge = await runtime.fetch(new Request("http://127.0.0.1:13600/v1/responses", {
      method: "POST",
      headers: {
        authorization: "Bearer network-key",
        "content-type": "application/json",
        "x-frely-request-id": "req-1",
      },
      body: JSON.stringify({ model: "vision-provider", stream: false, input: [] }),
    }));
    expect(challenge.status).toBe(402);
    expect(externalCalls).toBe(0);
    runtime.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
