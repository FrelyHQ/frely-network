import { parseArgs } from "node:util";
import { EnsSubnameManager, SubnameError, type SubnameOptions } from "@frely-network/ens/subnames";

const help = `ENSv2 Sepolia subnames (read-only and unsigned transaction preparation)

bun run ens:subnames <command> --parent <name.eth> --operator <0xAddress>

Commands:
  inspect              Read the parent, registry, child states and text permissions.
  prepare-subregistry  Simulate deployment; with --registry, simulate attaching it.
  prepare-subname      Simulate one child registration; requires --label.
  verify               Check registered children and simulate existing text writes.

Options:
  --rpc-url <url>       Sepolia RPC, or ENS_SEPOLIA_RPC_URL.
  --parent <name.eth>   Owned .eth parent, or ENS_PARENT_NAME.
  --operator <address>  Parent owner and child owner, or ENS_OPERATOR_ADDRESS.
  --labels <a,b>        Children to inspect/verify; default: vision-basic,vision-ocr.
  --label <label>       One child for prepare-subname.
  --registry <address>  Deployed official UserRegistry to attach after wallet confirmation.
  --help               Print this help without making network requests.

No command signs, broadcasts, accepts a private key, or writes placeholder records.
After each confirmed wallet transaction, rerun inspection/preparation against live state.
`;

export async function runSubnameCommand(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<unknown> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args, allowPositionals: true, strict: true,
      options: {
        help: { type: "boolean" },
        "rpc-url": { type: "string" },
        parent: { type: "string" },
        operator: { type: "string" },
        labels: { type: "string" },
        label: { type: "string" },
        registry: { type: "string" },
      },
    });
  } catch { throw new SubnameError("ENS_CLI_ARGUMENT_INVALID"); }
  const { values, positionals } = parsed;
  if (values.help) return { help };
  const command = positionals[0];
  if (positionals.length !== 1 || !["inspect", "prepare-subregistry", "prepare-subname", "verify"].includes(command)) {
    throw new SubnameError("ENS_CLI_COMMAND_INVALID");
  }
  const rpcUrl = values["rpc-url"] ?? env.ENS_SEPOLIA_RPC_URL;
  const parent = values.parent ?? env.ENS_PARENT_NAME;
  const operator = values.operator ?? env.ENS_OPERATOR_ADDRESS;
  if (typeof rpcUrl !== "string" || typeof parent !== "string" || typeof operator !== "string") {
    throw new SubnameError("ENS_CLI_CONFIG_MISSING");
  }
  if ((values.registry !== undefined && command !== "prepare-subregistry") ||
      (values.label !== undefined && command !== "prepare-subname") ||
      (values.labels !== undefined && command === "prepare-subname")) {
    throw new SubnameError("ENS_CLI_ARGUMENT_INVALID");
  }
  const options: SubnameOptions = {
    parent, operator: operator as SubnameOptions["operator"],
    ...(typeof values.labels === "string" ? { labels: values.labels.split(",") } : {}),
  };
  const manager = new EnsSubnameManager(rpcUrl);
  if (command === "inspect") return manager.inspect(options);
  if (command === "verify") return manager.verify(options);
  if (command === "prepare-subregistry") {
    return manager.prepareSubregistry(options, values.registry as SubnameOptions["operator"] | undefined);
  }
  if (typeof values.label !== "string") throw new SubnameError("ENS_CLI_LABEL_REQUIRED");
  return manager.prepareSubname(options, values.label);
}

if (import.meta.main) {
  runSubnameCommand(process.argv.slice(2)).then((result) => {
    if (result && typeof result === "object" && "help" in result) {
      process.stdout.write(String(result.help));
    } else {
      process.stdout.write(`${JSON.stringify(result, (_, value: unknown) => typeof value === "bigint" ? value.toString() : value, 2)}\n`);
    }
  }).catch((error: unknown) => {
    const code = error instanceof SubnameError ? error.code : "ENS_SUBNAME_COMMAND_FAILED";
    process.stderr.write(`${JSON.stringify({ error: { code }, broadcast: false })}\n`);
    process.exitCode = 1;
  });
}
