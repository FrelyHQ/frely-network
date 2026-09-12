import { describe, expect, test } from "bun:test";
import {
  isValidManifest,
  ManifestValidationError,
  validateManifest,
  validateLegacyManifest,
  type P0CapabilityProviderManifest,
  type LegacyResponsesManifest,
} from "./index.ts";

const validManifest: P0CapabilityProviderManifest = {
  name: "vision-ocr",
  description: "Image understanding and OCR capability",
  capabilities: ["vision", "ocr"],
  identity: { ens: "vision-ocr.capabilities.example.eth", agentId: "42" },
  interfaces: [{
    protocol: "a2a", endpoint: "https://provider.example/a2a",
    agentCardUrl: "https://provider.example/.well-known/agent-card.json",
  }],
  payment: { protocol: "x402", network: "hedera:testnet" },
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

  test("requires exactly one A2A execution interface with an HTTPS Agent Card URL", () => {
    expect(() => validateManifest({
      ...validManifest, interfaces: [...validManifest.interfaces, ...validManifest.interfaces],
    })).toThrow(/exactly one A2A/);
    for (const agentCardUrl of [undefined, "", "http://provider.example/card.json"]) {
      expect(() => validateManifest({
        ...validManifest, interfaces: [{ ...validManifest.interfaces[0], agentCardUrl }],
      })).toThrow(/agentCardUrl/);
    }
    expect(() => validateManifest({
      ...validManifest, interfaces: [{ ...validManifest.interfaces[0], endpoint: "http://provider.example/a2a" }],
    })).toThrow(/endpoint/);
  });

  test("Responses is accepted only by the explicitly named legacy validator", () => {
    const legacy: LegacyResponsesManifest = {
      ...validManifest,
      interfaces: [{ protocol: "responses", endpoint: "https://provider.example/v1/responses" }],
    };
    expect(validateLegacyManifest(legacy)).toBe(legacy);
    expect(isValidManifest(legacy)).toBe(false);
    expect(() => validateManifest(legacy)).toThrow(/must be "a2a"/);
    expect(() => validateLegacyManifest(validManifest)).toThrow(/must be "responses"/);
  });
});
