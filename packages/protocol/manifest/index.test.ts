import { describe, expect, test } from "bun:test";
import {
  isValidManifest,
  ManifestValidationError,
  validateManifest,
  type P0CapabilityProviderManifest,
} from "./index.ts";

const validManifest: P0CapabilityProviderManifest = {
  name: "vision-ocr",
  description: "Image understanding and OCR capability",
  capabilities: ["vision", "ocr"],
  identity: { ens: "vision-ocr.capabilities.example.eth", agentId: "42" },
  interfaces: [{ protocol: "responses", endpoint: "https://provider.example/v1/responses" }],
  payment: { protocol: "x402", network: "hedera-testnet" },
};

describe("P0 manifest validation", () => {
  test("accepts the minimal manifest and preserves extensions", () => {
    const manifest = { ...validManifest, provenance: { source: "test" } };
    expect(validateManifest(manifest)).toBe(manifest);
    expect(isValidManifest(manifest)).toBe(true);
  });

  test("rejects missing ENS, capabilities, and interfaces", () => {
    const manifest = { ...validManifest, capabilities: [], identity: {}, interfaces: [] };
    expect(() => validateManifest(manifest)).toThrow(ManifestValidationError);
    try {
      validateManifest(manifest);
    } catch (error) {
      expect(error).toBeInstanceOf(ManifestValidationError);
      expect((error as ManifestValidationError).issues.map((issue) => issue.path)).toEqual(
        expect.arrayContaining(["capabilities", "identity.ens", "interfaces"]),
      );
    }
  });

  test("rejects non-string capability, protocol, network, and HTTP endpoint", () => {
    const manifest = {
      ...validManifest,
      capabilities: ["vision", 42],
      interfaces: [{ protocol: "mcp", endpoint: "http://provider.example" }],
      payment: { protocol: "other", network: "hedera:mainnet" },
    };
    expect(isValidManifest(manifest)).toBe(false);
    expect(() => validateManifest(manifest)).toThrow(/capabilities\[1\]/);
  });
});
