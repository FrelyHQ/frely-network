import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { runSubnameCommand } from "./ens-subnames.ts";

describe("ENS subname command boundary", () => {
  test("help needs no RPC, wallet or environment configuration", async () => {
    await expect(runSubnameCommand(["--help"], {})).resolves.toEqual({ help: expect.stringContaining("No command signs, broadcasts") });
  });

  test("requires a known command and complete public configuration", async () => {
    await expect(runSubnameCommand([], {})).rejects.toThrow("ENS_CLI_COMMAND_INVALID");
    await expect(runSubnameCommand(["broadcast"], {})).rejects.toThrow("ENS_CLI_COMMAND_INVALID");
    await expect(runSubnameCommand(["inspect"], {})).rejects.toThrow("ENS_CLI_CONFIG_MISSING");
  });

  test("does not accept signing or broadcasting flags", async () => {
    await expect(runSubnameCommand(["inspect", "--private-key", "test-secret"], {})).rejects.toThrow("ENS_CLI_ARGUMENT_INVALID");
    await expect(runSubnameCommand(["prepare-subregistry", "--broadcast"], {})).rejects.toThrow("ENS_CLI_ARGUMENT_INVALID");
  });

  const env = {
    ENS_SEPOLIA_RPC_URL: "https://rpc.example",
    ENS_PARENT_NAME: "example.eth",
    ENS_OPERATOR_ADDRESS: "0x1111111111111111111111111111111111111111",
  };

  test("rejects misplaced options before making a network request", async () => {
    await expect(runSubnameCommand(["inspect", "--registry", env.ENS_OPERATOR_ADDRESS], env)).rejects.toThrow("ENS_CLI_ARGUMENT_INVALID");
    await expect(runSubnameCommand(["verify", "--label", "vision-basic"], env)).rejects.toThrow("ENS_CLI_ARGUMENT_INVALID");
    await expect(runSubnameCommand(["prepare-subname", "--labels", "vision-basic,vision-ocr"], env)).rejects.toThrow("ENS_CLI_ARGUMENT_INVALID");
    await expect(runSubnameCommand(["prepare-subname"], env)).rejects.toThrow("ENS_CLI_LABEL_REQUIRED");
  });

  test("rejects malformed local inputs without a network request", async () => {
    await expect(runSubnameCommand(["inspect", "--parent", "example.com"], env)).rejects.toThrow("ENS_SUBNAME_INPUT_INVALID");
    await expect(runSubnameCommand(["inspect", "--labels", "a,,b"], env)).rejects.toThrow("ENS_SUBNAME_INPUT_INVALID");
    await expect(runSubnameCommand(["inspect", "--rpc-url", "not-a-url"], env)).rejects.toThrow("ENS_RPC_CONFIG_INVALID");
  });

  test("CLI exits nonzero with sanitized JSON, not the rejected argument", () => {
    const entry = fileURLToPath(new URL("./ens-subnames.ts", import.meta.url));
    const result = Bun.spawnSync([process.execPath, entry, "inspect", "--private-key", "test-secret"], {
      stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("");
    expect(JSON.parse(result.stderr.toString())).toEqual({ error: { code: "ENS_CLI_ARGUMENT_INVALID" }, broadcast: false });
    expect(result.stderr.toString()).not.toContain("test-secret");
  });
});
