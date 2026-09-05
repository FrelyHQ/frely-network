import { describe, expect, test } from "bun:test";
import { ensip25AgentRegistrationKey } from "./index.ts";

describe("ENSIP-25", () => {
  test("encodes an Ethereum Sepolia ERC-7930 registry address", () => {
    expect(
      ensip25AgentRegistrationKey("0x8004A818BFB912233c491871b3d84c89A494BD9e", "7"),
    ).toBe(
      "agent-registration[0x0001000003aa36a7148004a818bfb912233c491871b3d84c89a494bd9e][7]",
    );
  });

  test("rejects unsafe agent identifiers", () => {
    expect(() => ensip25AgentRegistrationKey("0x8004A818BFB912233c491871b3d84c89A494BD9e", "7]"))
      .toThrow("IDENTITY_VERIFICATION_FAILED");
  });
});
