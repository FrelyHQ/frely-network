import { describe, expect, test } from "bun:test";
import { offeringsFromRegistrationMetadata, offeringRegistrationExtension, validateOffering, validateOfferings } from "./index.ts";

const offering = {
  id: "off_alice_security_1",
  publisherId: "alice",
  publisherEnsName: "web3-safety.frely.eth",
  underlyingAgent: {
    platform: "frely",
    agentId: "vm-0123456789abcdef0123456789abcdef",
    model: "user/vm-0123456789abcdef0123456789abcdef/v1",
    ownerRef: "user:bob",
  },
  capabilities: ["web3-safety"],
  price: {
    network: "hedera:testnet",
    asset: "HBAR",
    amountAtomic: "1000000",
    publisherPayTo: "0.0.1234",
    networkFeeBps: 500,
  },
  status: "published",
} as const;

describe("Network Offering", () => {
  test("models Alice's Offering separately from Bob's Web2 Agent", () => {
    expect(validateOffering(offering)).toEqual(offering);
    expect(offeringRegistrationExtension([offering])).toEqual({ offerings: [offering] });
    expect(offeringsFromRegistrationMetadata({ name: "Alice Agent", offerings: [offering] })).toEqual([offering]);
  });

  test("preserves an explicit underlying Frely Agent version for purchase provenance", () => {
    const versioned = { ...offering, underlyingAgent: { ...offering.underlyingAgent, version: "v1" } };
    expect(validateOffering(versioned).underlyingAgent.version).toBe("v1");
  });

  test("supports many Offerings for the same underlying Agent", () => {
    const second = { ...offering, id: "off_alice_security_2", capabilities: ["domain-safety"] };
    const result = validateOfferings([offering, second]);
    expect(result[0]!.underlyingAgent).toEqual(result[1]!.underlyingAgent);
    expect(result.map((item) => item.id)).toEqual(["off_alice_security_1", "off_alice_security_2"]);
  });

  test("rejects invalid price, duplicate capabilities and duplicate Offering IDs", () => {
    expect(() => validateOffering({ ...offering, capabilities: ["web3-safety", "web3-safety"] })).toThrow("OFFERING_INVALID");
    expect(() => validateOffering({ ...offering, price: { ...offering.price, networkFeeBps: 10001 } })).toThrow("OFFERING_INVALID");
    expect(() => validateOfferings([offering, offering])).toThrow("OFFERING_INVALID");
  });
});