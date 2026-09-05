import { describe, expect, test } from "bun:test";
import { TheGraphDiscovery } from "./index.ts";

const manifest = {
  name: "vision-basic",
  capabilities: ["vision"],
  identity: { ens: "vision.example.eth", agentId: "7" },
  interfaces: [{ protocol: "responses", endpoint: "https://provider.example/v1/responses" }],
  payment: { protocol: "x402", network: "hedera-testnet" },
};

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

describe("The Graph discovery", () => {
  test("uses validated manifest capabilities", async () => {
    const calls: string[] = [];
    const discovery = new TheGraphDiscovery(
      { endpoint: "https://graph.example/query", paymentNetwork: "hedera-testnet" },
      async (endpoint) => {
        calls.push(endpoint);
        if (endpoint.includes("graph.example")) {
          return response({ data: { agents: [{ id: "7", ensName: "vision.example.eth", active: true, supportsX402: true, capabilities: ["incorrect"], metadataUri: "https://metadata.example/7.json" }] } });
        }
        return response(manifest);
      },
    );

    const providers = await discovery.findProviders(["vision"]);
    expect(providers).toEqual([{ id: "7", ensName: "vision.example.eth", capabilities: ["vision"], supportsX402: true }]);
    expect(calls).toEqual(["https://graph.example/query", "https://metadata.example/7.json"]);
  });

  test("excludes invalid metadata instead of trusting Graph capabilities", async () => {
    const discovery = new TheGraphDiscovery(
      { endpoint: "https://graph.example/query", paymentNetwork: "hedera-testnet" },
      async (endpoint) => endpoint.includes("graph.example")
        ? response({ data: { agents: [{ id: "7", ensName: "vision.example.eth", active: true, supportsX402: true, capabilities: ["vision"], metadataUri: "https://metadata.example/7.json" }] } })
        : response({ ...manifest, capabilities: [] }),
    );

    await expect(discovery.findProviders(["vision"])).rejects.toThrow("NO_PROVIDER");
  });
});
