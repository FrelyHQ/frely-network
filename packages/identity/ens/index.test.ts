import { describe, expect, test } from "bun:test";
import { type Address, type PublicClient, zeroAddress } from "viem";
import { ENSV2_SEPOLIA_CHAIN_ID, ViemEnsReader, ensip25AgentRegistrationKey, type EnsConfig } from "./index.ts";

const registryAddress = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
const resolverAddress = "0x3e5E3EcFF4A7229b6af7E0C4508ff75B7Fb1C1d0";
const registrationKey = ensip25AgentRegistrationKey(registryAddress, "7");
const context = { registryAddress, agentId: "7" } as const;

// These RPC fixtures test fail-closed behavior, not live identity verification.
function fixture(config: Partial<EnsConfig> = {}) {
  const state = {
    chainId: ENSV2_SEPOLIA_CHAIN_ID,
    resolver: resolverAddress as string | null,
    endpoint: "https://vision.frely.network/v1/responses" as string | null,
    registration: "1" as string | null,
    failure: "",
  };
  const calls: { method: string; name?: string; key?: string; blockNumber?: bigint; strict?: boolean }[] = [];
  const check = (method: string) => {
    if (state.failure === method) throw new Error("RPC_UNAVAILABLE");
  };
  const client = {
    async getChainId() { calls.push({ method: "chain" }); check("chain"); return state.chainId; },
    async getBlockNumber() { calls.push({ method: "block" }); check("block"); return 123n; },
    async getEnsResolver(args: { name: string; blockNumber?: bigint }) {
      calls.push({ method: "resolver", ...args });
      check("resolver");
      return state.resolver;
    },
    async getEnsText(args: { name: string; key: string; blockNumber?: bigint; strict?: boolean }) {
      const method = args.key === registrationKey ? "registration" : "endpoint";
      calls.push({ method, ...args });
      check(method);
      return method === "registration" ? state.registration : state.endpoint;
    },
  } as unknown as PublicClient;
  return { state, calls, reader: new ViemEnsReader({ rpcUrl: "https://rpc.invalid", ...config }, client) };
}

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

  test("matches the official Ethereum mainnet example", () => {
    expect(ensip25AgentRegistrationKey("0x8004A169FB4a3325136EB29fA0ceB6D2e539a432", "167", 1))
      .toBe("agent-registration[0x000100000101148004a169fb4a3325136eb29fa0ceb6d2e539a432][167]");
  });

  test("pads an odd-length chain ID to whole bytes before calculating length", () => {
    expect(ensip25AgentRegistrationKey(registryAddress, "7", 256))
      .toBe("agent-registration[0x00010000020100148004a818bfb912233c491871b3d84c89a494bd9e][7]");
  });

  test.each(["", "01", "-1", "+1", "1.0", "1e2", "0x7", " 7", "7 ", "[7]", "abc", (2n ** 256n).toString()])(
    "rejects noncanonical or out-of-range ERC-8004 ID %s", (agentId) => {
      expect(() => ensip25AgentRegistrationKey(registryAddress, agentId)).toThrow("IDENTITY_VERIFICATION_FAILED");
    },
  );

  test("accepts zero and the largest uint256 ID", () => {
    expect(ensip25AgentRegistrationKey(registryAddress, "0")).toEndWith("][0]");
    const maximum = (2n ** 256n - 1n).toString();
    expect(ensip25AgentRegistrationKey(registryAddress, maximum)).toEndWith(`][${maximum}]`);
  });

  test.each(["0x1234", "0xZZ04A818BFB912233c491871b3d84c89A494BD9e", zeroAddress])(
    "rejects invalid registry %s", (address) => {
      expect(() => ensip25AgentRegistrationKey(address as Address, "7")).toThrow("IDENTITY_VERIFICATION_FAILED");
    },
  );

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid chain ID %s", (chainId) => {
      expect(() => ensip25AgentRegistrationKey(registryAddress, "7", chainId)).toThrow("IDENTITY_VERIFICATION_FAILED");
    },
  );
});

describe("ViemEnsReader (RPC fixtures)", () => {
  test.each(["1", "0", "unrelated text", " "])("accepts any non-empty ENSIP-25 value: %s", async (value) => {
    const { reader, state, calls } = fixture();
    state.registration = value;
    expect(await reader.resolve("VISION-BASIC.FRELY.ETH", context)).toEqual({
      name: "vision-basic.frely.eth",
      resolver: resolverAddress,
      endpoint: "https://vision.frely.network/v1/responses",
      protocol: "responses",
      agentRegistration: value,
      agentRegistrationKey: registrationKey,
    });
    const recordCalls = calls.filter((call) => call.name);
    expect(recordCalls).toHaveLength(3);
    expect(recordCalls.every((call) => call.name === "vision-basic.frely.eth" && call.blockNumber === 123n)).toBe(true);
    expect(recordCalls.filter((call) => call.key).every((call) => call.strict === true)).toBe(true);
  });

  test.each([undefined, {}, { registryAddress }, { agentId: "7" }])("requires complete identity context: %p", async (value) => {
    const { reader, calls } = fixture();
    await expect(reader.resolve("vision-basic.frely.eth", value)).rejects.toThrow("IDENTITY_VERIFICATION_FAILED");
    expect(calls).toHaveLength(0);
  });

  test("uses the supplied ERC-8004 snapshot without requesting a newer block", async () => {
    const { reader, calls } = fixture();
    await reader.resolve("vision-basic.frely.eth", { ...context, blockNumber: 456n });
    expect(calls.some((call) => call.method === "block")).toBe(false);
    const recordCalls = calls.filter((call) => call.name);
    expect(recordCalls).toHaveLength(3);
    expect(recordCalls.every((call) => call.blockNumber === 456n)).toBe(true);
  });

  test.each([-1n, 1 as unknown as bigint])("rejects an invalid snapshot block %p", async (blockNumber) => {
    const { reader, calls } = fixture();
    await expect(reader.resolve("vision-basic.frely.eth", { ...context, blockNumber }))
      .rejects.toThrow("IDENTITY_VERIFICATION_FAILED");
    expect(calls).toHaveLength(0);
  });

  test.each([null, ""])("rejects missing registration value %p", async (registration) => {
    const { reader, state } = fixture();
    state.registration = registration;
    await expect(reader.resolve("vision-basic.frely.eth", context)).rejects.toThrow("IDENTITY_VERIFICATION_FAILED");
  });

  test("rejects a custom key for a different agent before issuing RPC calls", async () => {
    const { reader, calls } = fixture({ agentRegistrationKey: ensip25AgentRegistrationKey(registryAddress, "17") });
    await expect(reader.resolve("vision-basic.frely.eth", context)).rejects.toThrow("IDENTITY_VERIFICATION_FAILED");
    expect(calls).toHaveLength(0);
  });

  test("rejects a custom key callback for a different chain", async () => {
    const { reader } = fixture({ agentRegistrationKey: (registry, agentId) => ensip25AgentRegistrationKey(registry, agentId, 1) });
    await expect(reader.resolve("vision-basic.frely.eth", context)).rejects.toThrow("IDENTITY_VERIFICATION_FAILED");
  });

  test("accepts an explicitly configured canonical key", async () => {
    const { reader } = fixture({ agentRegistrationKey: registrationKey });
    expect((await reader.resolve("vision-basic.frely.eth", context)).agentRegistrationKey).toBe(registrationKey);
  });

  test("rejects an RPC on the wrong chain before reading records", async () => {
    const { reader, state, calls } = fixture();
    state.chainId = 1;
    await expect(reader.resolve("vision-basic.frely.eth", context)).rejects.toThrow("IDENTITY_VERIFICATION_FAILED");
    expect(calls).toEqual([{ method: "chain" }]);
  });

  test.each([null, zeroAddress, "not-an-address"])("rejects invalid resolver %p", async (resolver) => {
    const { reader, state } = fixture();
    state.resolver = resolver;
    await expect(reader.resolve("vision-basic.frely.eth", context)).rejects.toThrow("IDENTITY_VERIFICATION_FAILED");
  });

  test.each([null, "", "not a url"])("rejects missing endpoint %p", async (endpoint) => {
    const { reader, state } = fixture();
    state.endpoint = endpoint;
    await expect(reader.resolve("vision-basic.frely.eth", context)).rejects.toThrow("ENS_ENDPOINT_MISSING");
  });

  test.each(["http://vision.frely.network/v1/responses", "ftp://vision.frely.network/v1/responses"])(
    "rejects non-HTTPS endpoint %s", async (endpoint) => {
      const { reader, state } = fixture();
      state.endpoint = endpoint;
      await expect(reader.resolve("vision-basic.frely.eth", context)).rejects.toThrow("ENDPOINT_NOT_HTTPS");
    },
  );

  test.each([
    "https://user:secret@vision.frely.network/v1/responses", "https://vision.frely.network/v1/responses#ignored",
    "https://vision.frely.network/v1/responses#", " https://vision.frely.network/v1/responses",
    "https://vision.frely.network/\\v1/responses", "https://vision.example.com/v1/responses",
    "https://provider.invalid/v1/responses", "https://localhost/v1/responses", "https://127.0.0.1/v1/responses",
  ])("rejects unsafe or placeholder endpoint %s", async (endpoint) => {
    const { reader, state } = fixture();
    state.endpoint = endpoint;
    await expect(reader.resolve("vision-basic.frely.eth", context)).rejects.toThrow("IDENTITY_VERIFICATION_FAILED");
  });

  test("cannot disable HTTPS enforcement", () => {
    expect(() => fixture({ requireHttps: false })).toThrow("ENDPOINT_NOT_HTTPS");
  });

  test.each(["agent-endpoint[unknown]", "prefix-agent-endpoint[responses]", "agent-endpoint[responses]-suffix"])(
    "rejects unsupported endpoint record key %s", async (agentEndpointKey) => {
      const { reader } = fixture({ agentEndpointKey });
      await expect(reader.resolve("vision-basic.frely.eth", context)).rejects.toThrow("IDENTITY_VERIFICATION_FAILED");
    },
  );

  test.each(["chain", "block", "resolver", "registration"])("fails closed when %s RPC fails", async (failure) => {
    const { reader, state } = fixture();
    state.failure = failure;
    await expect(reader.resolve("vision-basic.frely.eth", context)).rejects.toThrow("IDENTITY_VERIFICATION_FAILED");
  });

  test("fails closed when endpoint RPC fails", async () => {
    const { reader, state } = fixture();
    state.failure = "endpoint";
    await expect(reader.resolve("vision-basic.frely.eth", context)).rejects.toThrow("ENS_ENDPOINT_MISSING");
  });

  test.each(["", "invalid", "bad..frely.eth"])("rejects invalid ENS name %s", async (name) => {
    const { reader, calls } = fixture();
    await expect(reader.resolve(name, context)).rejects.toThrow("IDENTITY_VERIFICATION_FAILED");
    expect(calls).toHaveLength(0);
  });
});
