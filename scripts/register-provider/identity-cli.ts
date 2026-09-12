import { parseArgs } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ProviderRegistrationManager, RegistrationError, prepareRegistrationMetadata, registrationConfig } from "./identity.ts";

const help = `Provider identity on Ethereum Sepolia (unsigned transactions only)

bun run provider:identity <command> [options]

Commands:
  metadata          Validate manifest and encode registration-v1 as a data URI.
  prepare-register  Verify ENS write access, simulate register(string), estimate gas.
  prepare-ens       Recover agentId from --registration-tx and prepare ENS setText.
  verify            Read back the confirmed ERC-8004 registration and ENS linkage.
  inspect-current   Read an existing --agent-id and return an updateInput template.
  verify-current    Verify current metadata/ENS for --agent-id after any updates.
  prepare-update    Read --input <update-input.json>, preview changes, simulate next step.
  verify-update     Verify the target state from the same update input; never simulate writes.

Options:
  --input <file>              Registration input, or updateInput for update commands.
  --agent-id <decimal>        Required only for inspect-current and verify-current.
  --registration-tx <0xHash>  Confirmed Registered transaction; never a predicted ID.
  --output <file>            Save the reviewable result (must not already exist).
  --help                     Show help without RPC calls.

RPC/operator/Registry use .env. No private keys, signing, or broadcasting.
Registration targets A2A; old Responses identities can be inspected and explicitly migrated.
False flags are preserved. Native x402Support is independent of Network payment.
Registration does not prove Graph indexing, Agent execution or payment acceptance.
Update inputs contain expected metadata URI/hash, both ENS endpoints and Resolver.
Changes allow protocol (a2a only), endpoint, agentCardUrl, description, active, x402Support.
Migrating from Responses requires protocol=a2a plus explicit endpoint and agentCardUrl.
Keep the same input when resuming. Confirm only the next prepared transaction,
then prepare again. Never resend a transaction whose wallet outcome is unknown.
`;

export async function runIdentityCommand(args: string[], env: NodeJS.ProcessEnv = process.env) {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, strict: true, options: {
      help: { type: "boolean" }, input: { type: "string" }, output: { type: "string" },
      "registration-tx": { type: "string" },
      "agent-id": { type: "string" },
    } });
  } catch { throw new RegistrationError("REGISTRATION_ARGUMENT_INVALID"); }
  const { values, positionals } = parsed;
  if (values.help) return { help };
  const command = positionals[0];
  const currentCommand = command === "inspect-current" || command === "verify-current";
  const updateCommand = command === "prepare-update" || command === "verify-update";
  if (positionals.length !== 1 || !["metadata", "prepare-register", "prepare-ens", "verify",
    "inspect-current", "verify-current", "prepare-update", "verify-update"].includes(command) ||
    (currentCommand ? !values["agent-id"] || values.input !== undefined : !values.input || values["agent-id"] !== undefined)) {
    throw new RegistrationError("REGISTRATION_ARGUMENT_INVALID");
  }
  const needsHash = command === "prepare-ens" || command === "verify";
  if (needsHash !== (values["registration-tx"] !== undefined)) throw new RegistrationError("REGISTRATION_ARGUMENT_INVALID");
  let input: unknown;
  if (values.input) {
    try { input = JSON.parse(await readFile(resolve(values.input), "utf8")); }
    catch { throw new RegistrationError("REGISTRATION_INPUT_FILE_INVALID"); }
  }
  let result: unknown;
  if (command === "metadata") result = prepareRegistrationMetadata(input);
  else {
    const manager = new ProviderRegistrationManager(registrationConfig(env));
    if (currentCommand) result = command === "inspect-current"
      ? await manager.inspectCurrent(values["agent-id"]!) : await manager.verifyCurrent(values["agent-id"]!);
    else if (updateCommand) result = command === "prepare-update"
      ? await manager.prepareUpdate(input) : await manager.verifyUpdate(input);
    else if (command === "prepare-register") result = await manager.prepareRegister(input);
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
