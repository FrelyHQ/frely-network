import { expect, test } from "bun:test";
import successFixture from "../../packages/protocol/capability-resolution/fixtures/success.json";
import { FrelyNetworkClient, type NetworkFetcher } from "./network-client.ts";

process.env.FRELY_API_KEY = "network-secret";

const networkConfig = {
  baseUrl: "https://network.example",
  apiKeyRef: "env:FRELY_API_KEY" as const,
  chainId: 11155111 as const,
  registry: "0x1111111111111111111111111111111111111111" as const,
};

test("posts only capabilities and validates the frozen response", async () => {
  let captured: Request | undefined;
  const fetcher: NetworkFetcher = async (request) => {
    captured = request;
    return Response.json(successFixture);
  };
  const client = new FrelyNetworkClient(networkConfig, fetcher);
  const result = await client.resolve(["vision"]);
  expect(await captured!.json()).toEqual({
    schemaVersion: 1,
    capabilities: ["vision"],
    paymentNetwork: "hedera:testnet",
  });
  expect(captured!.headers.get("authorization")).toBe("Bearer network-secret");
  expect(result.provider.id).toBe("provider-1");
});

test("rejects identity configuration drift", async () => {
  const drifted = {
    ...successFixture,
    identity: { ...successFixture.identity, registry: "0x2222222222222222222222222222222222222222" },
  };
  const fetcher: NetworkFetcher = async () => Response.json(drifted);
  const client = new FrelyNetworkClient(networkConfig, fetcher);
  await expect(client.resolve(["vision"])).rejects.toThrow("IDENTITY_VERIFICATION_FAILED");
});
