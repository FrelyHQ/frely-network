import { describe, expect, test } from "bun:test";
import type { P0CapabilityProviderManifest, LegacyResponsesManifest } from "./index.ts";
import {
  ERC8004_REGISTRATION_TYPE,
  normalizeAgentId,
  normalizeEnsName,
  normalizeHttpsUrl,
  normalizeRegistrationMetadata,
  normalizeLegacyRegistrationMetadata,
  type RegistrationContext,
} from "./registration.ts";

// Synthetic fixtures only: these names, IDs, and URLs are not live M3 evidence.
const context: RegistrationContext = {
  chainId: 11155111,
  registryAddress: "0x1111111111111111111111111111111111111111",
  agentId: "42",
};
const endpoint = "https://provider.example/a2a";
const agentCardUrl = "https://provider.example/.well-known/agent-card.json";
const payment = { protocol: "x402", network: "hedera:testnet" } as const;

function manifest(): P0CapabilityProviderManifest {
  return {
    name: "fixture-vision",
    description: "Synthetic registration fixture",
    capabilities: ["vision"],
    identity: { ens: "fixture.example.eth", agentId: "42" },
    interfaces: [{ protocol: "a2a", endpoint, agentCardUrl }],
    payment: { ...payment },
  };
}

function manifestMetadata() {
  return { ...manifest(), active: true, x402Support: false };
}

function normalizedManifest() {
  return { ...manifest(), x402Support: false };
}

function registration() {
  return {
    type: ERC8004_REGISTRATION_TYPE,
    name: "fixture-vision",
    description: "Synthetic registration fixture",
    active: true,
    x402Support: false,
    services: [
      { name: "ENS", endpoint: "fixture.example.eth" },
      { name: "A2A", endpoint: agentCardUrl },
    ],
    interfaces: [{ protocol: "a2a", endpoint, agentCardUrl }],
    capabilities: ["vision"],
    payment: { ...payment },
    registrations: [{
      agentId: "42",
      agentRegistry: `eip155:11155111:${context.registryAddress}`,
    }],
  };
}

describe("registration metadata normalization", () => {
  test("accepts a bare manifest and normalizes identity without mutating input", () => {
    const input = manifestMetadata();
    input.identity.ens = "Fixture.EXAMPLE.eth";
    const before = structuredClone(input);
    expect(normalizeRegistrationMetadata(input, context)).toEqual(normalizedManifest());
    expect(input).toEqual(before);
  });

  test("normalizes ERC-8004 services plus explicit Frely claims", () => {
    expect(normalizeRegistrationMetadata(registration(), context)).toEqual(normalizedManifest());
  });

  test("accepts Frely claims in an Agent0 metadata bag", () => {
    const { capabilities, payment: paymentClaim, interfaces, ...input } = registration();
    expect(normalizeRegistrationMetadata({
      ...input,
      metadata: { capabilities, payment: paymentClaim, interfaces },
    }, context)).toEqual(normalizedManifest());
  });

  test("accepts agreeing duplicates after ENS, URL, and capability normalization", () => {
    const input = registration();
    input.capabilities = ["vision", "ocr"];
    const normalized = normalizeRegistrationMetadata({
      ...input,
      metadata: {
        identity: { ens: "Fixture.EXAMPLE.eth", agentId: 42 },
        protocol: "a2a",
        endpoint: "https://PROVIDER.example:443/a2a",
        interfaces: [{
          protocol: "a2a", endpoint: "https://PROVIDER.example:443/a2a",
          agentCardUrl: "https://PROVIDER.example:443/.well-known/agent-card.json",
        }],
        capabilities: ["ocr", "vision", "vision"],
        payment,
      },
    }, context);
    expect(normalized.capabilities).toEqual(["vision", "ocr"]);
    expect(normalized.interfaces).toEqual([{ protocol: "a2a", endpoint, agentCardUrl }]);
  });

  test.each([
    { ens: "different.example.eth" },
    { ensName: "different.example.eth" },
    { identity: { ens: "different.example.eth" } },
    { identity: { agentId: "43" } },
    { agentId: "43" },
    { capabilities: ["ocr"] },
    { capabilities: [] },
    { protocol: "a2a", endpoint: "https://other.example/a2a" },
    { interfaces: [{ protocol: "a2a", endpoint, agentCardUrl: "https://other.example/card.json" }] },
    { payment: { protocol: "x402", network: "hedera:mainnet" } },
    { payment: { protocol: "other", network: "hedera:testnet" } },
  ])("rejects conflicting metadata claim %j", (metadata) => {
    expect(() => normalizeRegistrationMetadata({ ...registration(), metadata }, context)).toThrow();
  });

  test("allows additional registrations on other chains", () => {
    const input = registration();
    input.registrations.push({
      agentId: "7",
      agentRegistry: "eip155:84532:0x2222222222222222222222222222222222222222",
    });
    expect(normalizeRegistrationMetadata(input, context).identity.agentId).toBe("42");
  });

  test.each([
    { registrations: [{ agentId: "43", agentRegistry: `eip155:11155111:${context.registryAddress}` }] },
    { registrations: [{ agentId: "42", agentRegistry: "eip155:11155111:0x2222222222222222222222222222222222222222" }] },
    { registrations: [{ agentId: "42", agentRegistry: `eip155:84532:${context.registryAddress}` }] },
    { registrations: [{ agentId: "42", agentRegistry: `eip155:011155111:${context.registryAddress}` }] },
    { registrations: [{ agentId: "42", agentRegistry: `eip155:9007199254740992:${context.registryAddress}` }] },
    { registrations: [] },
  ])("rejects absent or invalid current registration %j", ({ registrations }) => {
    expect(() => normalizeRegistrationMetadata({ ...registration(), registrations }, context)).toThrow();
  });

  test("rejects one conflicting current ID even if another registration agrees", () => {
    const input = registration();
    input.registrations.push({ ...input.registrations[0], agentId: "43" });
    expect(() => normalizeRegistrationMetadata(input, context)).toThrow();
  });

  test("exposes exact OASF skills without domains or guessed vision aliases", () => {
    const { capabilities: _, ...input } = registration();
    const normalized = normalizeRegistrationMetadata({
      ...input,
      services: [...input.services, {
        name: "OASF",
        endpoint: "https://oasf.example",
        skills: ["images/image_description", "images/image_description"],
        domains: ["vision", "ocr"],
      }],
    }, context);
    expect(normalized.capabilities).toEqual(["images/image_description"]);
  });

  test("uses explicit capabilities independently of the OASF taxonomy", () => {
    const input = registration();
    expect(normalizeRegistrationMetadata({
      ...input,
      services: [...input.services, {
        name: "OASF", endpoint: "https://oasf.example", skills: ["images/image_description"],
      }],
    }, context).capabilities).toEqual(["vision"]);
  });

  test("does not derive capabilities from names, descriptions, or OASF domains", () => {
    const { capabilities: _, ...input } = registration();
    expect(() => normalizeRegistrationMetadata({
      ...input,
      services: [...input.services, {
        name: "OASF", endpoint: "https://oasf.example", domains: ["vision"],
      }],
    }, context)).toThrow();
  });

  test("requires explicit active=true for both manifests and registration files", () => {
    for (const input of [manifestMetadata(), registration()]) {
      for (const active of [false, undefined, "true", 1, null]) {
        expect(() => normalizeRegistrationMetadata({ ...input, active }, context)).toThrow();
      }
    }
    expect(() => normalizeRegistrationMetadata({
      ...registration(), metadata: { active: false },
    }, context)).toThrow();
  });

  test("requires an explicit boolean x402Support and preserves the native claim including false", () => {
    for (const input of [manifestMetadata(), registration()]) {
      for (const x402Support of [undefined, "true", "false", 0, 1, null]) {
        expect(() => normalizeRegistrationMetadata({ ...input, x402Support }, context)).toThrow();
      }
      for (const x402Support of [false, true]) {
        const output = normalizeRegistrationMetadata({ ...input, x402Support }, context);
        expect(output.x402Support).toBe(x402Support);
        expect(output.payment).toEqual(payment);
        expect(normalizeRegistrationMetadata({
          ...input, x402Support, metadata: { active: true, x402Support },
        }, context)).toEqual(output);
        expect(() => normalizeRegistrationMetadata({
          ...input, x402Support, metadata: { x402Support: !x402Support },
        }, context)).toThrow();
      }
    }
  });

  test("rejects unsupported registration types and services-only files without a type", () => {
    for (const type of [undefined, "https://example.com/registration-v1"]) {
      expect(() => normalizeRegistrationMetadata({ ...registration(), type }, context)).toThrow();
    }
  });

  test("ignores unrelated services but requires an A2A Card service on registration files", () => {
    const input = registration();
    const extraService = { name: "MCP", endpoint: "https://mcp.example" };
    expect(normalizeRegistrationMetadata({ ...input, services: [...input.services, extraService] }, context))
      .toEqual(normalizedManifest());
    expect(() => normalizeRegistrationMetadata({
      ...input, services: [input.services[0], extraService],
    }, context)).toThrow();
  });

  test("keeps the A2A Card separate from execution and rejects mismatched service Card URLs", () => {
    const input = registration();
    const output = normalizeRegistrationMetadata(input, context);
    expect(output.interfaces[0].endpoint).toBe(endpoint);
    expect(input.services[1].endpoint).toBe(output.interfaces[0].agentCardUrl);
    expect(input.services[1].endpoint).not.toBe(output.interfaces[0].endpoint);
    input.services[1].endpoint = "https://other.example/card.json";
    expect(() => normalizeRegistrationMetadata(input, context)).toThrow("REGISTRATION_METADATA_INVALID");
  });

  test("fails closed for official A2A services without the explicit Frely execution extension", () => {
    const { interfaces: _, ...input } = registration();
    expect(() => normalizeRegistrationMetadata(input, context)).toThrow("A2A_EXECUTION_ENDPOINT_REQUIRED");
    expect(() => normalizeRegistrationMetadata({
      ...input, protocol: "a2a", endpoint,
    }, context)).toThrow("A2A_EXECUTION_ENDPOINT_REQUIRED");
  });

  test("rejects multiple execution interfaces even when the declarations agree", () => {
    for (const input of [manifestMetadata(), registration()]) {
      expect(() => normalizeRegistrationMetadata({
        ...input, interfaces: [...input.interfaces, ...input.interfaces],
      }, context)).toThrow("REGISTRATION_METADATA_INVALID");
    }
  });

  test("rejects a conflicting unsupported protocol even alongside valid services", () => {
    expect(() => normalizeRegistrationMetadata({ ...registration(), protocol: "mcp" }, context))
      .toThrow("PROTOCOL_NOT_SUPPORTED");
    expect(() => normalizeRegistrationMetadata({
      ...registration(), interfaces: [{ protocol: "http", endpoint }],
    }, context)).toThrow("PROTOCOL_NOT_SUPPORTED");
  });

  test.each([
    "http://provider.example/a2a",
    "https://user:secret@provider.example/a2a",
    "https://provider.example/a2a#fragment",
    "https://provider.example/a path",
    "https://provider.example\\other",
  ])("rejects unsafe endpoint %s from manifests and services", (unsafe) => {
    expect(() => normalizeRegistrationMetadata({
      ...manifestMetadata(), interfaces: [{ protocol: "a2a", endpoint: unsafe, agentCardUrl }],
    }, context)).toThrow();
    expect(() => normalizeRegistrationMetadata({
      ...manifestMetadata(), interfaces: [{ protocol: "a2a", endpoint, agentCardUrl: unsafe }],
    }, context)).toThrow();
    const input = registration();
    input.services[1].endpoint = unsafe;
    expect(() => normalizeRegistrationMetadata(input, context)).toThrow();
  });
});

describe("legacy registration management and historical audit", () => {
  const responsesEndpoint = "https://provider.example/v1/responses";
  function legacyManifest(): LegacyResponsesManifest {
    return { ...manifest(), interfaces: [{ protocol: "responses", endpoint: responsesEndpoint }] };
  }
  function legacyRegistration() {
    const { interfaces: _, ...input } = registration();
    return {
      ...input, x402Support: true,
      services: [input.services[0], { name: "Responses", endpoint: responsesEndpoint }],
    };
  }

  test("retains the historical Responses manifest output and accepts lifecycle projections", () => {
    expect(normalizeLegacyRegistrationMetadata(legacyManifest(), context)).toEqual(legacyManifest());
    expect(normalizeLegacyRegistrationMetadata(legacyRegistration(), context)).toEqual(legacyManifest());
    expect(normalizeLegacyRegistrationMetadata({
      ...legacyManifest(), active: true, x402Support: true,
    }, context)).toEqual(legacyManifest());
  });

  test("runtime normalization never falls back to Responses", () => {
    expect(() => normalizeRegistrationMetadata({
      ...legacyManifest(), active: true, x402Support: true,
    }, context)).toThrow("PROTOCOL_NOT_SUPPORTED");
    expect(() => normalizeRegistrationMetadata(legacyRegistration(), context))
      .toThrow("A2A_EXECUTION_ENDPOINT_REQUIRED");
    expect(() => normalizeLegacyRegistrationMetadata(registration(), context)).toThrow();
  });

  test("keeps the legacy payment, active, identity, and endpoint checks", () => {
    for (const patch of [
      { active: false }, { x402Support: false }, { identity: { ens: "other.example.eth" } },
      { protocol: "responses", endpoint: "https://other.example/v1/responses" },
      { payment: { protocol: "x402", network: "hedera:mainnet" } },
    ]) {
      expect(() => normalizeLegacyRegistrationMetadata({ ...legacyRegistration(), ...patch }, context)).toThrow();
    }
  });
});

describe("registration scalar validation", () => {
  test("preserves uint256 precision and rejects overflow or unsafe numeric values", () => {
    expect(normalizeAgentId(0)).toBe("0");
    expect(normalizeAgentId(Number.MAX_SAFE_INTEGER)).toBe(String(Number.MAX_SAFE_INTEGER));
    expect(normalizeAgentId(((1n << 256n) - 1n).toString())).toBe(((1n << 256n) - 1n).toString());
    for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "01", "-1", "1.0", "0x2a", " 42", (1n << 256n).toString()]) {
      expect(() => normalizeAgentId(value)).toThrow("REGISTRATION_METADATA_INVALID");
    }
  });

  test("normalizes ENS names and rejects non-names", () => {
    expect(normalizeEnsName("Fixture.EXAMPLE.eth")).toBe("fixture.example.eth");
    for (const value of ["eth", "fixture..eth", "https://fixture.eth", "", null]) {
      expect(() => normalizeEnsName(value)).toThrow("REGISTRATION_METADATA_INVALID");
    }
  });

  test("normalizes HTTPS endpoint representation without changing the path", () => {
    expect(normalizeHttpsUrl("https://PROVIDER.example:443/v1/responses?model=vision"))
      .toBe("https://provider.example/v1/responses?model=vision");
  });
});
