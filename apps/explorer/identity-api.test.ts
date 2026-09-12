import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identityBindingResponse } from "./identity-api.ts";
import { IDENTITY_REGISTRY, ProviderRegistrationManager } from "../../scripts/register-provider/identity.ts";

const keys = ["PROVIDER_REGISTRATION_INPUT", "PROVIDER_REGISTRATION_TX", "IDENTITY_CHAIN_ID",
  "ENS_SEPOLIA_RPC_URL", "ENS_OPERATOR_ADDRESS", "ERC8004_IDENTITY_REGISTRY"] as const;
const original = Object.fromEntries(keys.map((key) => [key, Bun.env[key]]));
const restores: Array<() => void> = [];
let folder: string | undefined;
afterEach(async () => {
  for (const restore of restores.splice(0)) restore();
  for (const key of keys) {
    if (original[key] === undefined) delete Bun.env[key]; else Bun.env[key] = original[key];
  }
  if (folder) await rm(folder, { recursive: true, force: true });
  folder = undefined;
});

async function configure() {
  folder = await mkdtemp(join(tmpdir(), "frely-binding-api-"));
  const input = join(folder, "original-registration.json");
  await writeFile(input, "{}");
  Object.assign(Bun.env, {
    PROVIDER_REGISTRATION_INPUT: input, PROVIDER_REGISTRATION_TX: `0x${"aa".repeat(32)}`,
    IDENTITY_CHAIN_ID: "11155111", ENS_SEPOLIA_RPC_URL: "https://rpc.example",
    ENS_OPERATOR_ADDRESS: "0x1111111111111111111111111111111111111111", ERC8004_IDENTITY_REGISTRY: IDENTITY_REGISTRY,
  });
  const read = spyOn(ProviderRegistrationManager.prototype, "readRegistration");
  read.mockResolvedValue({ agentId: "42" } as Awaited<ReturnType<ProviderRegistrationManager["readRegistration"]>>);
  restores.push(() => read.mockRestore());
  return read;
}

describe("local binding API after an identity update", () => {
  test.each(["responses", "a2a"] as const)("uses the original receipt to locate the Agent and current %s metadata to prepare ENS", async (protocol) => {
    const read = await configure();
    const prepare = spyOn(ProviderRegistrationManager.prototype, "prepareCurrentEns");
    const endpoint = `https://provider.example/${protocol}`;
    prepare.mockResolvedValue({ ensName: "vision.example.eth", agentId: "42", endpoint, protocol,
      owner: Bun.env.ENS_OPERATOR_ADDRESS, resolver: "0x3333333333333333333333333333333333333333",
      blockNumber: 300n, records: [], transactions: [] } as unknown as Awaited<ReturnType<ProviderRegistrationManager["prepareCurrentEns"]>>);
    restores.push(() => prepare.mockRestore());
    const response = await identityBindingResponse("/api/identity-binding");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ agentId: "42", endpoint, protocol, blockNumber: "300" });
    expect(read).toHaveBeenCalledWith({}, Bun.env.PROVIDER_REGISTRATION_TX);
    expect(prepare).toHaveBeenCalledWith("42");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  test("verifies updated metadata by ID without comparing it against the initial URI", async () => {
    await configure();
    const verify = spyOn(ProviderRegistrationManager.prototype, "verifyCurrent");
    verify.mockResolvedValue({ ensName: "vision.example.eth", agentId: "42", blockNumber: 301n,
      registrationAndEnsVerified: true } as Awaited<ReturnType<ProviderRegistrationManager["verifyCurrent"]>>);
    restores.push(() => verify.mockRestore());
    const response = await identityBindingResponse("/api/identity-binding/verify");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ agentId: "42", blockNumber: "301", registrationAndEnsVerified: true,
      executionVerified: false, paymentVerified: false });
    expect(verify).toHaveBeenCalledWith("42");
  });

  test("does not expose RPC credentials in failed current-state reads", async () => {
    await configure();
    const prepare = spyOn(ProviderRegistrationManager.prototype, "prepareCurrentEns")
      .mockRejectedValue(new Error("Failed https://rpc.example/synthetic-secret"));
    restores.push(() => prepare.mockRestore());
    const response = await identityBindingResponse("/api/identity-binding");
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "REGISTRATION_RPC_OR_VERIFICATION_FAILED" });
  });
});
