import { parseArgs } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ProviderRegistrationManager, RegistrationError, prepareRegistrationMetadata, registrationConfig } from "./identity.ts";

const help = `Provider identity on Ethereum Sepolia (unsigned transactions only)

bun run provider:identity <command> --input <registration-input.json> [options]

Commands:
  metadata          Validate manifest and encode registration-v1 as a data URI.
  prepare-register  Verify ENS write access, simulate register(string), estimate gas.
  prepare-ens       Recover agentId from --registration-tx and prepare ENS setText.
  verify            Read back the confirmed ERC-8004 registration and ENS linkage.

Options:
  --input <file>              JSON containing manifest, active, x402Support.
  --registration-tx <0xHash>  Confirmed Registered transaction; never a predicted ID.
  --output <file>            Save the reviewable result (must not already exist).
  --help                     Show help without RPC calls.

RPC/operator/Registry use .env. No private keys, signing, or broadcasting.
False active/x402Support flags are preserved: registration does not imply discovery,
Provider execution, or payment acceptance. After a wallet timeout, recover by hash.
`;

export async function runIdentityCommand(args: string[], env: NodeJS.ProcessEnv = process.env) {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, strict: true, options: {
      help: { type: "boolean" }, input: { type: "string" }, output: { type: "string" },
      "registration-tx": { type: "string" },
    } });
  } catch { throw new RegistrationError("REGISTRATION_ARGUMENT_INVALID"); }
  const { values, positionals } = parsed;
  if (values.help) return { help };
  const command = positionals[0];
  if (positionals.length !== 1 || !["metadata", "prepare-register", "prepare-ens", "verify"].includes(command) || !values.input) {
    throw new RegistrationError("REGISTRATION_ARGUMENT_INVALID");
  }
  const needsHash = command === "prepare-ens" || command === "verify";
  if (needsHash !== (values["registration-tx"] !== undefined)) throw new RegistrationError("REGISTRATION_ARGUMENT_INVALID");
  let input: unknown;
  try { input = JSON.parse(await readFile(resolve(values.input), "utf8")); }
  catch { throw new RegistrationError("REGISTRATION_INPUT_FILE_INVALID"); }
  let result: unknown;
  if (command === "metadata") result = prepareRegistrationMetadata(input);
  else {
    const manager = new ProviderRegistrationManager(registrationConfig(env));
    if (command === "prepare-register") result = await manager.prepareRegister(input);
    else if (command === "prepare-ens") result = await manager.prepareEns(input, values["registration-tx"]!);
    else result = await manager.verify(input, values["registration-tx"]!);
  }
  if (values.output) {
    try { await writeFile(resolve(values.output), `${serialize(result)}\n`, { flag: "wx" }); }
    catch { throw new RegistrationError("REGISTRATION_OUTPUT_WRITE_FAILED"); }
  }
  return result;
}

function serialize(value: unknown) {
  return JSON.stringify(value, (_, item: unknown) => typeof item === "bigint" ? item.toString() : item, 2);
}

if (import.meta.main) {
  runIdentityCommand(process.argv.slice(2)).then((result) => {
    process.stdout.write(result && typeof result === "object" && "help" in result ? String(result.help) : `${serialize(result)}\n`);
  }).catch((error: unknown) => {
    // Raw RPC errors can contain API keys. Never print them.
    process.stderr.write(`${serialize({ error: error instanceof RegistrationError ? error.message : "REGISTRATION_RPC_OR_VERIFICATION_FAILED", broadcast: false })}\n`);
    process.exitCode = 1;
  });
}
