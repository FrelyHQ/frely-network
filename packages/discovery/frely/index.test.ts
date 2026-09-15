import { describe, expect, test } from "bun:test";
import { FrelyAgentDiscovery, FrelyAgentResolver } from "./index.ts";

const model = "user/vm-0123456789abcdef0123456789abcdef/v1";
const agentId = "vm-0123456789abcdef0123456789abcdef";
const payload = {
  object: "list",
  data: [{
    id: model,
    object: "agent",
    model,
    name: "Bob Security Agent",
    owned_by: "user:bob",
    agent_id: agentId,
    version: "v1",
    capabilities: [
      { id: "web3-safety", level: "advanced", entrypoints: ["model", "a2a"], priceRef: "price-safety" },
      { id: "local-only", level: "base", entrypoints: ["model"] },
    ],
  }],
};

describe("Frely Agent discovery", () => {
  test("reads the authenticated Web2 Agent catalog and returns A2A-capable underlying Agents", async () => {
    let authorization = "";
    const discovery = new FrelyAgentDiscovery({ origin: "https://api.frely.cloud", apiKey: "frely-test-key" }, async (input, init) => {
      expect(input).toBe("https://api.frely.cloud/v1/agents");
      authorization = new Headers(init.headers).get("authorization") ?? "";
      return Response.json(payload);
    });
    const candidates = await discovery.findProviders(["web3-safety"]);
    expect(authorization).toBe("Bearer frely-test-key");
    expect(candidates).toEqual([{
      id: agentId,
      capabilities: ["web3-safety"],
      supportsX402: false,
      protocol: "a2a",
      endpoint: "https://api.frely.cloud/a2a",
      model,
      source: "frely",
      underlyingAgent: { platform: "frely", agentId, model, version: "v1", ownerRef: "user:bob" },
    }]);
  });

  test("does not advertise capabilities without an A2A entrypoint", async () => {
    const discovery = new FrelyAgentDiscovery({ origin: "https://api.frely.cloud", apiKey: "key" }, async () => Response.json(payload));
    await expect(discovery.findProviders(["local-only"])).rejects.toThrow("NO_PROVIDER");
  });

  test("resolves a Frely row as an underlying Web2 execution target", async () => {
    const discovery = new FrelyAgentDiscovery({ origin: "https://api.frely.cloud", apiKey: "key" }, async () => Response.json(payload));
    const candidate = (await discovery.findProviders(["web3-safety"]))[0]!;
    expect(await new FrelyAgentResolver("https://api.frely.cloud").resolveProvider(candidate)).toEqual({
      id: agentId,
      endpoint: "https://api.frely.cloud/a2a",
      protocol: "a2a",
      verified: true,
      model,
      source: "frely",
      underlyingAgent: { platform: "frely", agentId, model, version: "v1", ownerRef: "user:bob" },
    });
  });
});
