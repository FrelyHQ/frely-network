import { describe, expect, test } from "bun:test";
import { registerProvider, type ProviderRegistrationAdapter } from "./index.ts";

const manifest = {
  name: "vision-basic",
  capabilities: ["vision"],
  identity: { ens: "vision.example.eth" },
  interfaces: [{ protocol: "responses", endpoint: "https://provider.example/v1/responses" }],
  payment: { protocol: "x402", network: "hedera-testnet" },
};

function adapter(endpoint = "https://provider.example/v1/responses"): ProviderRegistrationAdapter {
  return {
    async registerErc8004() {
      return { agentId: "7", metadataUri: "https://provider.example/manifest.json", transactionId: "0xerc" };
    },
    async writeEnsRecords() {
      return { transactionId: "0xens" };
    },
    async readEnsEndpoint() {
      return endpoint;
    },
  };
}

describe("provider registration orchestration", () => {
  test("validates, writes, reads back, and returns provenance", async () => {
    await expect(registerProvider(manifest, adapter())).resolves.toEqual({
      manifestName: "vision-basic",
      ensName: "vision.example.eth",
      agentId: "7",
      metadataUri: "https://provider.example/manifest.json",
      endpoint: "https://provider.example/v1/responses",
      erc8004TransactionId: "0xerc",
      ensTransactionId: "0xens",
    });
  });

  test("fails closed when ENS does not contain the expected endpoint", async () => {
    await expect(registerProvider(manifest, adapter("https://other.example/v1/responses"))).rejects.toThrow(
      "ENS_ENDPOINT_MISMATCH",
    );
  });
});
