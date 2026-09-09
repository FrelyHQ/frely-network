import { describe, expect, test } from "bun:test";
import { TheGraphDiscovery } from "./index.ts";

const manifest = {
  name: "vision-basic",
  capabilities: ["vision"],
  identity: { ens: "vision.example.eth", agentId: "7" },
  interfaces: [{ protocol: "responses", endpoint: "https://provider.example/v1/responses" }],
  payment: { protocol: "x402", network: "hedera:testnet" },
};

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

describe("The Graph discovery", () => {
  test("uses validated manifest capabilities", async () => {
    const calls: string[] = [];
    const discovery = new TheGraphDiscovery(
      { endpoint: "https://graph.example/query", paymentNetwork: "hedera:testnet" },
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
      { endpoint: "https://graph.example/query", paymentNetwork: "hedera:testnet" },
      async (endpoint) => endpoint.includes("graph.example")
        ? response({ data: { agents: [{ id: "7", ensName: "vision.example.eth", active: true, supportsX402: true, capabilities: ["vision"], metadataUri: "https://metadata.example/7.json" }] } })
        : response({ ...manifest, capabilities: [] }),
    );

    await expect(discovery.findProviders(["vision"])).rejects.toThrow("NO_PROVIDER");
  });

  test("maps official registrationFile fields without trusting row capabilities", async () => {
    const discovery = new TheGraphDiscovery(
      { endpoint: "https://graph.example/query", paymentNetwork: "hedera:testnet" },
      async () => response({ data: { agents: [{ agentId: "8", registrationFile: {
        ens: "indexed.example.eth", active: true, x402Support: true,
        oasfSkills: ["vision"], endpointsRawJson: [{ protocol: "responses", endpoint: "https://indexed.example/v1/responses" }],
      } }] } }),
    );

    const providers = await discovery.findProviders(["vision"]);
    expect(providers[0]?.id).toBe("8");
    expect(providers[0]?.ensName).toBe("indexed.example.eth");
  });

  test("marks a validated A2A manifest for protocol-aware identity resolution", async () => {
    const discovery = new TheGraphDiscovery(
      { endpoint: "https://graph.example/query", paymentNetwork: "hedera:testnet" },
      async (endpoint) => endpoint.includes("graph.example")
        ? response({ data: { agents: [{ agentId: "10", ensName: "a2a.example.eth", active: true, supportsX402: true, metadataUri: "https://metadata.example/10.json" }] } })
        : response({ ...manifest, identity: { ens: "a2a.example.eth", agentId: "10" }, interfaces: [{ protocol: "a2a", endpoint: "https://provider.example/a2a" }] }),
    );

    await expect(discovery.findProviders(["vision"])).resolves.toMatchObject([{ id: "10", protocol: "a2a" }]);
  });

  test("resolves ipfs agentURI through the configured metadata gateway", async () => {
    const discovery = new TheGraphDiscovery(
      { endpoint: "https://graph.example/query", paymentNetwork: "hedera:testnet", metadataGateway: "https://gateway.example/ipfs/{cid}" },
      async (endpoint) => endpoint.includes("graph.example")
        ? response({ data: { agents: [{ agentId: "9", ensName: "ipfs.example.eth", active: true, supportsX402: true, agentURI: "ipfs://bafy-test/manifest.json" }] } })
        : response({ ...manifest, identity: { ens: "ipfs.example.eth", agentId: "9" } }),
    );

    const providers = await discovery.findProviders(["vision"]);
    expect(providers[0]?.id).toBe("9");
  });
});
