import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type P0CapabilityProviderManifest,
  validateManifest,
} from "@frely-network/protocol-manifest";

export interface Erc8004Registration {
  agentId: string;
  metadataUri: string;
  transactionId?: string;
}

export interface EnsWriteResult {
  transactionId?: string;
}

/** Chain writes are injected until ENSv2/ERC-8004 write ABIs are confirmed. */
export interface ProviderRegistrationAdapter {
  registerErc8004(input: {
    manifest: P0CapabilityProviderManifest;
  }): Promise<Erc8004Registration>;
  writeEnsRecords(input: {
    manifest: P0CapabilityProviderManifest;
    agentId: string;
    metadataUri: string;
  }): Promise<EnsWriteResult>;
  readEnsEndpoint(input: {
    ensName: string;
  }): Promise<string>;
}

export interface ProviderRegistrationProvenance {
  manifestName: string;
  ensName: string;
  agentId: string;
  metadataUri: string;
  endpoint: string;
  erc8004TransactionId?: string;
  ensTransactionId?: string;
}

function normalizedUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") throw new Error("ENDPOINT_NOT_HTTPS");
    return url.toString();
  } catch (error) {
    if (error instanceof Error && error.message === "ENDPOINT_NOT_HTTPS") throw error;
    throw new Error("ENS_ENDPOINT_MISSING");
  }
}

/**
 * Register a provider and verify the endpoint written to ENS.
 *
 * The adapter owns chain-specific transactions. This function owns ordering,
 * validation and the fail-closed readback check used by the CLI and tests.
 */
export async function registerProvider(
  value: unknown,
  adapter: ProviderRegistrationAdapter,
): Promise<ProviderRegistrationProvenance> {
  const manifest = validateManifest(value);
  const ensName = manifest.identity.ens;
  const registration = await adapter.registerErc8004({ manifest });
  if (!registration.agentId || !registration.metadataUri) {
    throw new Error("REGISTRATION_INCOMPLETE");
  }

  const ensWrite = await adapter.writeEnsRecords({
    manifest,
    agentId: registration.agentId,
    metadataUri: registration.metadataUri,
  });

  const expectedEndpoint = normalizedUrl(manifest.interfaces[0].endpoint);
  const actualEndpoint = normalizedUrl(await adapter.readEnsEndpoint({ ensName }));
  if (actualEndpoint !== expectedEndpoint) throw new Error("ENS_ENDPOINT_MISMATCH");

  return {
    manifestName: manifest.name,
    ensName,
    agentId: registration.agentId,
    metadataUri: registration.metadataUri,
    endpoint: actualEndpoint,
    ...(registration.transactionId
      ? { erc8004TransactionId: registration.transactionId }
      : {}),
    ...(ensWrite.transactionId ? { ensTransactionId: ensWrite.transactionId } : {}),
  };
}

async function loadAdapter(): Promise<ProviderRegistrationAdapter> {
  const modulePath = process.env.REGISTER_PROVIDER_ADAPTER_MODULE;
  if (!modulePath) throw new Error("REGISTRATION_ADAPTER_MISSING");
  const loaded = await import(resolve(modulePath)) as {
    default?: ProviderRegistrationAdapter;
    adapter?: ProviderRegistrationAdapter;
  };
  const adapter = loaded.default ?? loaded.adapter;
  if (!adapter) throw new Error("REGISTRATION_ADAPTER_INVALID");
  return adapter;
}

async function main(): Promise<void> {
  const manifestPath = process.argv[2];
  if (!manifestPath) throw new Error("MANIFEST_PATH_REQUIRED");
  const input = JSON.parse(await readFile(resolve(manifestPath), "utf8")) as unknown;
  const provenance = await registerProvider(input, await loadAdapter());
  process.stdout.write(`${JSON.stringify(provenance, null, 2)}\n`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
