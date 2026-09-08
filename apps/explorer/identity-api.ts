import { readFile } from "node:fs/promises";
import {
  ProviderRegistrationManager, RegistrationError, registrationConfig,
} from "../../scripts/register-provider/identity.ts";

type EnsPlan = Awaited<ReturnType<ProviderRegistrationManager["prepareEns"]>>;
export type IdentityBindingPlan = Pick<EnsPlan,
  "ensName" | "agentId" | "endpoint" | "owner" | "resolver" | "records" | "transactions"
> & { chainId: number; registrationTx: string; blockNumber: string };

export async function identityBindingResponse(pathname: string): Promise<Response> {
  const json = (body: unknown, status = 200) => Response.json(body, {
    status, headers: { "Cache-Control": "no-store" },
  });
  try {
    const inputPath = Bun.env.PROVIDER_REGISTRATION_INPUT;
    const registrationTx = Bun.env.PROVIDER_REGISTRATION_TX;
    if (!inputPath || !registrationTx) return json({ error: "IDENTITY_BINDING_NOT_CONFIGURED" }, 503);
    let input: unknown;
    try { input = JSON.parse(await readFile(inputPath, "utf8")); }
    catch { return json({ error: "REGISTRATION_INPUT_FILE_INVALID" }, 503); }
    const manager = new ProviderRegistrationManager(registrationConfig(Bun.env));
    if (pathname === "/api/identity-binding/verify") {
      const result = await manager.verify(input, registrationTx);
      return json({ ensName: result.ensName, agentId: result.agentId,
        blockNumber: result.blockNumber.toString(), registrationAndEnsVerified: true,
        executionVerified: false, paymentVerified: false });
    }
    const result = await manager.prepareEns(input, registrationTx);
    const plan: IdentityBindingPlan = {
      chainId: 11155111, registrationTx, ensName: result.ensName, agentId: result.agentId,
      endpoint: result.endpoint, owner: result.owner, resolver: result.resolver,
      blockNumber: result.blockNumber.toString(), records: result.records, transactions: result.transactions,
    };
    return json(plan);
  } catch (error) {
    // RPC errors can contain credentials. Expose only our fixed validation codes.
    const code = error instanceof RegistrationError && /^REGISTRATION_[A-Z_]+$/.test(error.message)
      ? error.message : "REGISTRATION_RPC_OR_VERIFICATION_FAILED";
    return json({ error: code }, 502);
  }
}
