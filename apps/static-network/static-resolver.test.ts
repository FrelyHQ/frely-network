import { describe, expect, test } from "bun:test";
import { createStaticCapabilityResolver } from "./static-resolver.ts";

const resolver = createStaticCapabilityResolver({
  providerId: "vision-provider",
  relayUrl: "https://relay.example.com/v1/responses",
  resourceUrl: "http://127.0.0.1:13600/v1/responses",
});

describe("static capability resolver", () => {
  test("returns the configured v2 static allowlist without verified identity", async () => {
    const result = await resolver.resolve({
      schemaVersion: 2,
      capabilities: ["vision"],
      paymentNetwork: "hedera:testnet",
    });
    expect(result.provider).toEqual({
      id: "vision-provider",
      endpoint: "https://relay.example.com/v1/responses",
      protocol: "responses",
    });
    expect(result.execution.endpoint).toBe("http://127.0.0.1:13600/v1/responses");
    expect(result.resolution).toEqual({ source: "static_allowlist", identityVerified: false });
  });

  test("rejects unsupported capabilities without a discovery fallback", async () => {
    await expect(resolver.resolve({
      schemaVersion: 2,
      capabilities: ["text"] as unknown as ["vision"],
      paymentNetwork: "hedera:testnet",
    })).rejects.toThrow("CAPABILITY_NOT_SUPPORTED");
  });
});
