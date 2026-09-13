import { privateKeyToAccount } from "viem/accounts";
import type { CapabilityRequest } from "@frely-network/shared-types";
import { createBrokerMcpFetch, type BrokerRuntime } from "../service.ts";
import { ConsumerStore } from "./store.ts";
import { ConsumerGateway } from "./service.ts";
export const ORIGIN = "https://network.example";
export const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
export const otherAccount = privateKeyToAccount(`0x${"22".repeat(32)}`);
export const target = `0x${"ab".repeat(20)}`;
export const requestId = "f6bd6261-5fc5-456d-8f9c-e023e05b169d";
export const input = { address: target, chainId: "1" };
export const makeReport = (overrides: Record<string, unknown> = {}) => ({ targetType: "ADDRESS", target, chainId: "1",
  status: "KNOWN_MALICIOUS", riskLevel: "HIGH", scamProbability: null,
  signals: [{ type: "phishing_activities", source: "GOPLUS", value: "1" }],
  checkedAt: "2026-09-13T10:00:00.000Z", source: { provider: "GoPlus" }, ...overrides });
export function setup(options: Partial<ConstructorParameters<typeof ConsumerStore>[0]> = {}, output: unknown = makeReport()) {
  const store = new ConsumerStore({ origin: ORIGIN, databasePath: ":memory:", ...options });
  const calls: CapabilityRequest[] = [];
  const runtime: BrokerRuntime = { ready: true, broker: {
    async findCapability() { return [{ id: "agent-fixture", capabilities: ["web3.address-risk"], verified: true }]; },
    async useCapability(request) {
      calls.push(request);
      return { provider: { id: "agent-fixture", ensName: "risk.example.eth" }, billing: { mode: "frely_account" },
        output, correlationId: "execution-fixture", evidence: { discoverySource: "test_fixture", identityVerified: true } };
    },
  } };
  const gateway = new ConsumerGateway(store, runtime);
  return { store, runtime, gateway, calls, fetch: createBrokerMcpFetch(runtime, { consumerGateway: gateway, requireConsumerAuthorization: true }) };
}
export async function authorize(store: ConsumerStore, signer = account, chainId = 1) {
  const grant = store.start("Frely CLI", "chatgpt") as { deviceCode: string; userCode: string; verificationUri: string; expiresAt: string };
  const challenge = store.challenge(grant.userCode, signer.address, chainId);
  const signature = await signer.signMessage({ message: String(challenge.message) });
  await store.approve(grant.userCode, challenge.message, signature);
  const session = store.exchange(grant.deviceCode) as { accessToken: string; sessionId: string; walletAddress: string; remainingCalls: number };
  return { grant, challenge, signature, ...session };
}
export function api(path: string, body?: unknown, token?: string, origin: string | null = null, method = body === undefined ? "GET" : "POST") {
  return new Request(`${ORIGIN}/api/network/${path}`, { method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(origin ? { origin } : {}), ...(path === "capabilities/use" && body && typeof body === "object" && "requestId" in body ? { "idempotency-key": String(body.requestId) } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
export const useBody = (id = requestId, suppliedInput: unknown = input) => ({ requestId: id, capabilities: ["web3.address-risk"], task: "Check this wallet", input: suppliedInput });
