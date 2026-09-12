import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIdentityCommand } from "./identity-cli.ts";
import { IDENTITY_REGISTRY, ProviderRegistrationManager, RegistrationError } from "./identity.ts";

const env = {
  IDENTITY_CHAIN_ID: "11155111", ENS_SEPOLIA_RPC_URL: "https://rpc.example",
  ENS_OPERATOR_ADDRESS: "0x1111111111111111111111111111111111111111",
  ERC8004_IDENTITY_REGISTRY: IDENTITY_REGISTRY,
};
const restores: Array<() => void> = [];
const folders: string[] = [];
afterEach(async () => {
  for (const restore of restores.splice(0)) restore();
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

describe("existing provider identity command boundaries", () => {
  test("help documents update commands without requiring configuration", async () => {
    const result = await runIdentityCommand(["--help"], {});
    expect(result).toHaveProperty("help");
    expect((result as { help: string }).help).toContain("prepare-update");
  });

  test.each([
    ["inspect-current"], ["verify-current"], ["inspect-current", "--input", "absent.json"],
    ["inspect-current", "--agent-id", "1", "--input", "absent.json"],
    ["verify-current", "--agent-id", "1", "--registration-tx", "0x00"],
    ["prepare-update"], ["prepare-update", "--input", "absent.json", "--agent-id", "1"],
    ["verify-update", "--input", "absent.json", "--registration-tx", "0x00"],
    ["prepare-update", "--input", "absent.json", "--broadcast"],
    ["metadata", "--input", "absent.json", "--agent-id", "1"],
  ].map((args) => ({ args })))("rejects invalid command shape before file or RPC access: %j", async ({ args }) => {
    await expect(runIdentityCommand(args, {})).rejects.toThrow("REGISTRATION_ARGUMENT_INVALID");
  });

  test.each([
    ["inspect-current", "inspectCurrent"], ["verify-current", "verifyCurrent"],
  ] as const)("routes %s by agent ID without a registration receipt", async (command, method) => {
    const stub = spyOn(ProviderRegistrationManager.prototype, method)
      .mockRejectedValue(new RegistrationError("TEST_CURRENT_ROUTE"));
    restores.push(() => stub.mockRestore());
    await expect(runIdentityCommand([command, "--agent-id", "101"], env)).rejects.toThrow("TEST_CURRENT_ROUTE");
    expect(stub).toHaveBeenCalledWith("101");
  });

  test.each([
    ["prepare-update", "prepareUpdate"], ["verify-update", "verifyUpdate"],
  ] as const)("routes %s with the unchanged update document", async (command, method) => {
    const folder = await mkdtemp(join(tmpdir(), "frely-update-cli-"));
    folders.push(folder);
    const path = join(folder, "update.json");
    const input = { agentId: "101", expected: { metadataUri: "synthetic" }, changes: { active: false } };
    await writeFile(path, JSON.stringify(input));
    const stub = spyOn(ProviderRegistrationManager.prototype, method)
      .mockRejectedValue(new RegistrationError("TEST_UPDATE_ROUTE"));
    restores.push(() => stub.mockRestore());
    await expect(runIdentityCommand([command, "--input", path], env)).rejects.toThrow("TEST_UPDATE_ROUTE");
    expect(stub).toHaveBeenCalledWith(input);
  });
});
