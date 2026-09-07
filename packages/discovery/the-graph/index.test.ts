import { describe, expect, test } from "bun:test";
import { TheGraphDiscovery, type GraphConfig, type GraphProviderRow } from "./index.ts";

// All rows, endpoints and registration files in this suite are fixtures.
const registryAddress = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
const config: GraphConfig = {
  endpoint: "https://graph.example/query",
  registryAddress,
  paymentNetwork: "hedera:testnet",
};
const manifest = {
  name: "vision-basic fixture",
  capabilities: ["vision"],
  identity: { ens: "vision.example.eth", agentId: "7" },
  interfaces: [{ protocol: "responses", endpoint: "https://provider.example/v1/responses" }],
  payment: { protocol: "x402", network: "hedera:testnet" },
};
const row: GraphProviderRow = {
  id: "11155111:7",
  chainId: "11155111",
  agentId: "7",
  agentURI: "https://metadata.example/7.json",
  registrationFile: {
    ens: "vision.example.eth", active: true, x402Support: true,
    oasfSkills: ["wrong-indexed-skill"], oasfDomains: ["vision"],
    endpointsRawJson: JSON.stringify([{ name: "responses", endpoint: "https://untrusted.example/v1/responses" }]),
  },
};
const registration = {
  type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  name: manifest.name,
  description: "Test-only Provider metadata",
  image: "https://metadata.example/image.png",
  services: [
    { name: "ENS", endpoint: manifest.identity.ens },
    { name: "responses", endpoint: manifest.interfaces[0]!.endpoint },
  ],
  registrations: [{ agentId: 7, agentRegistry: `eip155:11155111:${registryAddress}` }],
  active: true,
  x402Support: true,
  capabilities: manifest.capabilities,
  payment: manifest.payment,
};

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function fixtureDiscovery(metadata: unknown = manifest, rows: GraphProviderRow[] = [row], overrides: Partial<GraphConfig> = {}) {
  const calls: { endpoint: string; init: RequestInit }[] = [];
  const discovery = new TheGraphDiscovery({ ...config, ...overrides }, async (endpoint, init) => {
    calls.push({ endpoint, init });
    return endpoint === config.endpoint ? response({ data: { agents: rows } }) : response(metadata);
  });
  return { discovery, calls };
}

describe("The Graph discovery", () => {
  test("uses fetched manifest capabilities, not indexed capabilities or endpoint", async () => {
    const { discovery, calls } = fixtureDiscovery();
    const providers = await discovery.findProviders(["vision"]);
    expect(providers).toEqual([{ id: "7", ensName: "vision.example.eth", capabilities: ["vision"], supportsX402: true }]);
    expect(calls.map((call) => call.endpoint)).toEqual([config.endpoint, row.agentURI!]);
    expect(String(calls[0]!.init.body)).toContain("chainId");
    expect(providers[0]).not.toHaveProperty("endpoint");
  });

  test("normalizes official services through the shared registration parser", async () => {
    const { discovery } = fixtureDiscovery(registration);
    expect((await discovery.findProviders(["vision"]))[0]?.id).toBe("7");
  });

  test("normalizes ENS names before comparing row and metadata", async () => {
    const { discovery } = fixtureDiscovery(manifest, [{ ...row, ensName: "VISION.EXAMPLE.ETH" }]);
    expect((await discovery.findProviders(["vision"]))[0]?.ensName).toBe("vision.example.eth");
  });

  test("accepts official composite IDs without confusing them with token IDs", async () => {
    const { agentId: _agentId, ...withoutAgentId } = row;
    const { discovery } = fixtureDiscovery(manifest, [withoutAgentId]);
    expect((await discovery.findProviders(["vision"]))[0]?.id).toBe("7");
  });

  test.each([
    { id: "7" }, { id: "11155111:8" }, { id: "1:7" }, { chainId: "1" },
    { agentId: "07" }, { agentId: 7.5 }, { agentId: Number.MAX_SAFE_INTEGER + 1 }, { agentId: "-7" },
  ])("excludes wrong-network, conflicting or invalid IDs: %j", async (changes) => {
    const { discovery, calls } = fixtureDiscovery(manifest, [{ ...row, ...changes }]);
    await expect(discovery.findProviders(["vision"])).rejects.toThrow("NO_PROVIDER");
    expect(calls).toHaveLength(1);
  });

  test("does not treat an arbitrary Graph row ID as an on-chain token", async () => {
    const { agentId: _agentId, ...withoutAgentId } = row;
    const { discovery } = fixtureDiscovery(manifest, [{ ...withoutAgentId, id: "provider-7" }]);
    await expect(discovery.findProviders(["vision"])).rejects.toThrow("NO_PROVIDER");
  });

  test("requires fetched metadata even when every indexed field looks usable", async () => {
    const { agentURI: _agentURI, ...withoutUri } = row;
    const { discovery, calls } = fixtureDiscovery(manifest, [withoutUri]);
    await expect(discovery.findProviders(["vision"])).rejects.toThrow("NO_PROVIDER");
    expect(calls).toHaveLength(1);
  });

  test.each(["http://metadata.example/7.json", "not-a-url", "file:///metadata.json"])(
    "does not downgrade an invalid metadata URI to indexed fields: %s", async (agentURI) => {
      const { discovery, calls } = fixtureDiscovery(manifest, [{ ...row, agentURI }]);
      await expect(discovery.findProviders(["vision"])).rejects.toThrow("NO_PROVIDER");
      expect(calls).toHaveLength(1);
    },
  );

  test("rejects conflicting metadata URI aliases without fetching either", async () => {
    const { discovery, calls } = fixtureDiscovery(manifest, [{ ...row, metadataUri: "https://other.example/7.json" }]);
    await expect(discovery.findProviders(["vision"])).rejects.toThrow("NO_PROVIDER");
    expect(calls).toHaveLength(1);
  });

  test.each([
    { ...manifest, capabilities: [] },
    { ...manifest, identity: { ens: "other.example.eth", agentId: "7" } },
    { ...manifest, identity: { ens: "vision.example.eth", agentId: "8" } },
    { ...manifest, active: false }, { ...manifest, active: "true" }, { ...manifest, x402Support: false },
    { ...manifest, payment: { protocol: "x402" } },
    { ...manifest, payment: { protocol: "x402", network: "eip155:11155111" } },
    { ...registration, registrations: [{ agentId: 8, agentRegistry: `eip155:11155111:${registryAddress}` }] },
  ])("excludes contradictory metadata instead of trusting indexed data: %j", async (metadata) => {
    const { discovery } = fixtureDiscovery(metadata);
    await expect(discovery.findProviders(["vision"])).rejects.toThrow("NO_PROVIDER");
  });

  test("never infers missing payment from the configured Hedera network", async () => {
    const { payment: _payment, ...withoutPayment } = registration;
    const { discovery } = fixtureDiscovery(withoutPayment);
    await expect(discovery.findProviders(["vision"])).rejects.toThrow("NO_PROVIDER");
  });

  test("does not infer vision from indexed OASF domains or an unrelated skill", async () => {
    const { capabilities: _capabilities, ...withoutCapabilities } = registration;
    const { discovery } = fixtureDiscovery({ ...withoutCapabilities, services: [
      ...registration.services,
      { name: "OASF", endpoint: "https://metadata.example/oasf.json", skills: ["multi_modal/image_processing/image_to_text"], domains: ["vision"] },
    ] });
    await expect(discovery.findProviders(["vision"])).rejects.toThrow("NO_PROVIDER");
  });

  test.each([
    { active: false }, { supportsX402: false }, { ensName: "different.example.eth" },
    { registrationFile: { ...row.registrationFile!, active: false } },
    { registrationFile: { ...row.registrationFile!, x402Support: false } },
    { payment: { protocol: "x402", network: "hedera:mainnet" } },
  ])("excludes contradictory indexed eligibility or identity: %j", async (changes) => {
    const { discovery } = fixtureDiscovery(manifest, [{ ...row, ...changes }]);
    await expect(discovery.findProviders(["vision"])).rejects.toThrow("NO_PROVIDER");
  });

  test("resolves IPFS using the shared gateway reader", async () => {
    const cid = "QmYwAPJzv5CZsnAzt8auVTLkGa1CXyjRbfGLbcpuuoQfNk";
    const { discovery, calls } = fixtureDiscovery(manifest, [{ ...row, agentURI: `ipfs://${cid}/manifest.json` }], {
      metadataGateway: "https://gateway.example/ipfs/{cid}",
    });
    expect((await discovery.findProviders(["vision"]))[0]?.id).toBe("7");
    expect(calls[1]!.endpoint).toBe(`https://gateway.example/ipfs/${cid}/manifest.json`);
  });

  test("excludes unreachable metadata without exposing request secrets", async () => {
    const discovery = new TheGraphDiscovery(config, async (endpoint) => {
      if (endpoint === config.endpoint) return response({ data: { agents: [row] } });
      throw new Error("private upstream URL or key");
    });
    await expect(discovery.findProviders(["vision"])).rejects.toThrow(/^NO_PROVIDER$/);
  });

  test("excludes invalid metadata JSON without indexed fallback", async () => {
    const discovery = new TheGraphDiscovery(config, async (endpoint) => endpoint === config.endpoint
      ? response({ data: { agents: [row] } }) : new Response("invalid-json"));
    await expect(discovery.findProviders(["vision"])).rejects.toThrow(/^NO_PROVIDER$/);
  });

  test("skips malformed candidates while retaining independently valid ones", async () => {
    const { discovery } = fixtureDiscovery(manifest, [{ ...row, agentId: "invalid" }, row]);
    expect(await discovery.findProviders(["vision"])).toHaveLength(1);
  });

  test.each([
    [], { data: [] }, { data: { unrelated: [row] } }, { data: { agents: [[]] } },
    { data: { agents: [null] } }, { errors: "upstream secret", data: { agents: [row] } },
  ])("rejects malformed Graph payloads with stable errors: %j", async (payload) => {
    const discovery = new TheGraphDiscovery(config, async () => response(payload));
    await expect(discovery.findProviders(["vision"])).rejects.toThrow(/^GRAPH_SCHEMA_INVALID$/);
  });

  test("does not accept partial Graph data alongside upstream errors", async () => {
    const discovery = new TheGraphDiscovery(config, async () => response({ errors: [{ message: "upstream key" }], data: { agents: [row] } }));
    await expect(discovery.findProviders(["vision"])).rejects.toThrow(/^GRAPH_QUERY_FAILED$/);
  });

  test("masks fetch errors that contain credential-bearing URLs", async () => {
    const discovery = new TheGraphDiscovery(config, async () => { throw new Error("https://graph.example/api/secret-key"); });
    await expect(discovery.findProviders(["vision"])).rejects.toThrow(/^GRAPH_QUERY_FAILED$/);
  });

  test.each([
    { network: "1" }, { registryAddress: "not-an-address" },
    { registryAddress: "0x0000000000000000000000000000000000000000" },
    { paymentNetwork: "hedera:mainnet" }, { endpoint: "http://graph.example/query" },
    { endpoint: "https://user:password@graph.example/query" }, { requestTimeoutMs: 0 },
  ])("rejects invalid configuration without leaking its values: %j", (changes) => {
    expect(() => new TheGraphDiscovery({ ...config, ...changes })).toThrow(/^GRAPH_CONFIG_INVALID$/);
  });
});
