import { expect, test } from "bun:test";
import { createCapabilityResolver } from "./resolver.ts";

test("sorts candidates and returns the first identity-verified x402 Relay", async () => {
  const seen: string[] = [];
  const resolver = createCapabilityResolver({
    findProviders: async () => [
      { id: "2", ensName: "z.example.eth", capabilities: ["vision"], supportsX402: true },
      { id: "1", ensName: "a.example.eth", capabilities: ["vision"], supportsX402: true },
    ],
    resolveProvider: async candidate => {
      seen.push(candidate.id);
      if (candidate.id === "1") throw new Error("IDENTITY_VERIFICATION_FAILED");
      return { id: "2", ensName: "z.example.eth", endpoint: "https://relay.example/v1/responses", protocol: "responses", verified: true };
    },
    chainId: 11155111,
    registry: "0x1111111111111111111111111111111111111111",
    allowedRelayOrigin: "https://relay.example",
  });
  const result = await resolver.resolve({ schemaVersion: 1, capabilities: ["vision"], paymentNetwork: "hedera:testnet" });
  expect(seen).toEqual(["1", "2"]);
  expect(result.provider.id).toBe("2");
});

test("filters to candidates that support every requested capability and x402", async () => {
  const seen: string[] = [];
  const resolver = createCapabilityResolver({
    findProviders: async () => [
      { id: "missing-capability", ensName: "a.example.eth", capabilities: ["vision"], supportsX402: true },
      { id: "no-x402", ensName: "b.example.eth", capabilities: ["vision", "ocr"], supportsX402: false },
      { id: "eligible", ensName: "c.example.eth", capabilities: ["vision", "ocr"], supportsX402: true },
    ],
    resolveProvider: async candidate => {
      seen.push(candidate.id);
      return { id: candidate.id, ensName: candidate.ensName, endpoint: "https://relay.example/v1/responses", protocol: "responses", verified: true };
    },
    chainId: 11155111,
    registry: "0x1111111111111111111111111111111111111111",
    allowedRelayOrigin: "https://relay.example",
  });

  const result = await resolver.resolve({ schemaVersion: 1, capabilities: ["vision", "ocr"], paymentNetwork: "hedera:testnet" });
  expect(seen).toEqual(["eligible"]);
  expect(result.provider.id).toBe("eligible");
});

test("rejects non-Relay endpoints and retries the next identity candidate", async () => {
  const seen: string[] = [];
  const resolver = createCapabilityResolver({
    findProviders: async () => [
      { id: "wrong-origin", ensName: "a.example.eth", capabilities: ["vision"], supportsX402: true },
      { id: "relay", ensName: "b.example.eth", capabilities: ["vision"], supportsX402: true },
    ],
    resolveProvider: async candidate => {
      seen.push(candidate.id);
      return {
        id: candidate.id,
        ensName: candidate.ensName,
        endpoint: candidate.id === "wrong-origin" ? "https://provider.example/v1/responses" : "https://relay.example/v1/responses",
        protocol: "responses",
        verified: true,
      };
    },
    chainId: 11155111,
    registry: "0x1111111111111111111111111111111111111111",
    allowedRelayOrigin: "https://relay.example",
  });

  const result = await resolver.resolve({ schemaVersion: 1, capabilities: ["vision"], paymentNetwork: "hedera:testnet" });
  expect(seen).toEqual(["wrong-origin", "relay"]);
  expect(result.provider.id).toBe("relay");
});

test("propagates non-identity discovery failures instead of selecting a fallback", async () => {
  const seen: string[] = [];
  const resolver = createCapabilityResolver({
    findProviders: async () => [
      { id: "first", ensName: "a.example.eth", capabilities: ["vision"], supportsX402: true },
      { id: "second", ensName: "b.example.eth", capabilities: ["vision"], supportsX402: true },
    ],
    resolveProvider: async candidate => {
      seen.push(candidate.id);
      throw new Error("GRAPH_QUERY_FAILED");
    },
    chainId: 11155111,
    registry: "0x1111111111111111111111111111111111111111",
    allowedRelayOrigin: "https://relay.example",
  });

  await expect(resolver.resolve({ schemaVersion: 1, capabilities: ["vision"], paymentNetwork: "hedera:testnet" })).rejects.toThrow("GRAPH_QUERY_FAILED");
  expect(seen).toEqual(["first"]);
});
