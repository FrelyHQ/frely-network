import { describe, expect, test } from "bun:test";
import { ensip25AgentRegistrationKey, ViemEnsReader } from "./index.ts";

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

  test("resolves the protocol-specific A2A endpoint record when requested", async () => {
    const keys: string[] = [];
    const reader = new ViemEnsReader({ rpcUrl: "https://rpc.example" }, {
      getEnsResolver: async () => "0x0000000000000000000000000000000000000001",
      getEnsText: async ({ key }: { key: string }) => {
        keys.push(key);
        return key === "agent-endpoint[a2a]" ? "https://provider.example/a2a" : null;
      },
    } as never);

    const records = await reader.resolve("a2a.example.eth", { protocol: "a2a" });
    expect(records).toMatchObject({ endpoint: "https://provider.example/a2a", protocol: "a2a" });
    expect(keys).toEqual(["agent-endpoint[a2a]"]);
  });
});
