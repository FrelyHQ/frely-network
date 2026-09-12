import { expect, test } from "bun:test";
import staticSuccess from "../../packages/protocol/capability-resolution/fixtures/static-success-v2.json";
import { FrelyNetworkClient, type NetworkFetcher } from "./network-client.ts";

process.env.FRELY_NETWORK_API_KEY = "network-test-only";

const clientConfig = {
  network: {
    mode: "static-local" as const,
    baseUrl: "http://127.0.0.1:13600" as const,
    apiKeyRef: "env:FRELY_NETWORK_API_KEY" as const,
  },
  approvedProvider: {
    id: "frely-vision-basic" as const,
    endpoint: "https://api.frely.cloud/v1/responses" as const,
  },
  approvedExecution: {
    endpoint: "http://127.0.0.1:13600/v1/responses" as const,
  },
};

test("posts a v2 request with Network Bearer and redirect error", async () => {
  let captured: Request | undefined;
  const fetcher: NetworkFetcher = async (request) => {
    captured = request;
    return Response.json(staticSuccess);
  };
  const client = new FrelyNetworkClient(clientConfig, fetcher);
  const result = await client.resolve(["vision"]);
  expect(captured!.redirect).toBe("error");
  expect(captured!.headers.get("authorization")).toBe("Bearer network-test-only");
  expect(await captured!.json()).toEqual({
    schemaVersion: 2,
    capabilities: ["vision"],
    paymentNetwork: "hedera:testnet",
  });
  expect(result.provider.id).toBe("frely-vision-basic");
  expect(result.resolution).toEqual({ source: "static_allowlist", identityVerified: false });
});

test("rejects provider, execution, protocol, capability, payment and resolution drift", async () => {
  const drifts: unknown[] = [
    { ...staticSuccess, provider: { ...staticSuccess.provider, id: "other" } },
    { ...staticSuccess, provider: { ...staticSuccess.provider, endpoint: "https://other.example/v1/responses" } },
    { ...staticSuccess, execution: { ...staticSuccess.execution, endpoint: "http://127.0.0.1:13601/v1/responses" } },
    { ...staticSuccess, provider: { ...staticSuccess.provider, protocol: "mcp" } },
    { ...staticSuccess, requestedCapabilities: ["audio"] },
    { ...staticSuccess, payment: { ...staticSuccess.payment, network: "hedera:mainnet" } },
    { ...staticSuccess, payment: { ...staticSuccess.payment, resource: "http://127.0.0.1:13601/v1/responses" } },
    { ...staticSuccess, resolution: { source: "ens", identityVerified: false } },
    { ...staticSuccess, resolution: { source: "static_allowlist", identityVerified: true } },
  ];
  for (const drifted of drifts) {
    const fetcher: NetworkFetcher = async () => Response.json(drifted);
    const client = new FrelyNetworkClient(clientConfig, fetcher);
    await expect(client.resolve(["vision"])).rejects.toThrow("NETWORK_UNAVAILABLE");
  }
});
