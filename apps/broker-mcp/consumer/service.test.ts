import { afterEach, expect, test } from "bun:test";
import { BrokerError } from "@frely-network/shared-types";
import { createBrokerMcpFetch } from "../service.ts";
import { ConsumerStore } from "./store.ts";
import { extractSafetyReport } from "./service.ts";
import { ORIGIN, account, otherAccount, setup, authorize, api, useBody, requestId, input, makeReport } from "./test-support.ts";
const stores: ConsumerStore[] = [];
function create(options: Partial<ConstructorParameters<typeof ConsumerStore>[0]> = {}, output: unknown = makeReport()) {
  const ctx = setup(options, output); stores.push(ctx.store); return ctx;
}
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

test("discovery and execution require consumer authorization", async () => {
  const ctx = create();
  expect((await ctx.fetch(api("capabilities/find", { capabilities: ["web3.address-risk"] }))).status).toBe(401);
  expect((await ctx.fetch(api("capabilities/use", useBody()))).status).toBe(401);
  expect(ctx.calls).toHaveLength(0);
});
test("calls the Broker with a bounded model and projects source evidence without a probability", async () => {
  const ctx = create({}, makeReport({ scamProbability: 0.99, raw: { confidential: "must-not-escape" } }));
  const session = await authorize(ctx.store, account, 11155111);
  const response = await ctx.fetch(api("capabilities/use", useBody(), session.accessToken));
  expect(response.status).toBe(200); const body = await response.json();
  expect(body.result.scamProbability).toBeNull(); expect(body.result.chainId).toBe("1");
  expect(body.result.raw).toBeUndefined(); expect(body.evidence.discoverySource).toBe("test_fixture");
  expect(body.evidence.chainSettlement).toBe(false); expect(body.evidence.agentId).toBe("agent-fixture");
  expect(body.remainingCalls).toBe(9); expect(ctx.calls[0]!.model).toBe("web3/address-risk");
  expect(ctx.calls[0]!.input).toBeUndefined(); expect(ctx.calls[0]!.task).toContain('"chainId":"1"');
});
test("repeated request is cached, changed input conflicts", async () => {
  const ctx = create(); const session = await authorize(ctx.store);
  const first = await ctx.fetch(api("capabilities/use", useBody(), session.accessToken));
  const second = await ctx.fetch(api("capabilities/use", useBody(), session.accessToken));
  expect(await second.json()).toEqual(await first.json()); expect(ctx.calls).toHaveLength(1);
  const conflict = await ctx.fetch(api("capabilities/use", useBody(requestId, { ...input, address: account.address }), session.accessToken));
  expect(conflict.status).toBe(409); expect((await conflict.json()).code).toBe("IDEMPOTENCY_CONFLICT");
});
test("wallet quota persists across new sessions and login chains", async () => {
  const ctx = create({ walletCallLimit: 1 }); const first = await authorize(ctx.store);
  await ctx.fetch(api("capabilities/use", useBody(), first.accessToken));
  const second = await authorize(ctx.store, account, 11155111); expect(second.remainingCalls).toBe(0);
  const response = await ctx.fetch(api("capabilities/use", useBody("ce4bbd3f-4a7e-4832-9cd2-43ddcae51919"), second.accessToken));
  expect(response.status).toBe(429); expect(ctx.calls).toHaveLength(1);
});
test("global quota bounds calls across wallets", async () => {
  const ctx = create({ globalCallLimit: 1 }); const first = await authorize(ctx.store);
  await ctx.fetch(api("capabilities/use", useBody(), first.accessToken));
  const second = await authorize(ctx.store, otherAccount);
  expect((await ctx.fetch(api("capabilities/use", useBody(), second.accessToken))).status).toBe(429);
  expect(ctx.calls).toHaveLength(1);
});
test("invalid input, missing target chain and caller model override never invoke", async () => {
  const ctx = create(); const session = await authorize(ctx.store);
  for (const value of [{ address: input.address }, { ...input, chainId: "56" }, { ...input, address: "0x123" }]) {
    expect((await ctx.fetch(api("capabilities/use", useBody(requestId, value), session.accessToken))).status).toBe(400);
  }
  expect((await ctx.fetch(api("capabilities/use", { ...useBody(), model: "expensive-model" }, session.accessToken))).status).toBe(400);
  expect(ctx.calls).toHaveLength(0);
});
test("discovery failure is not replaced by a fixed service", async () => {
  const ctx = create(); ctx.runtime.broker!.useCapability = async () => { throw new BrokerError("NO_PROVIDER"); };
  const session = await authorize(ctx.store);
  const response = await ctx.fetch(api("capabilities/use", useBody(), session.accessToken));
  expect(response.status).toBe(502); expect(await response.json()).toEqual({ code: "NO_PROVIDER", requestId });
  expect(ctx.calls).toHaveLength(0);
});
test("an ambiguous attempt cannot execute twice under the same ID", async () => {
  const ctx = create(); let attempts = 0;
  ctx.runtime.broker!.useCapability = async () => { attempts++; throw new Error("socket closed after dispatch"); };
  const session = await authorize(ctx.store);
  expect((await ctx.fetch(api("capabilities/use", useBody(), session.accessToken))).status).toBe(502);
  const retry = await ctx.fetch(api("capabilities/use", useBody(), session.accessToken));
  expect(retry.status).toBe(409); expect((await retry.json()).code).toBe("REQUEST_OUTCOME_UNKNOWN"); expect(attempts).toBe(1);
});
test("a concurrent retry is blocked while execution is active", async () => {
  const ctx = create(); const original = ctx.runtime.broker!.useCapability.bind(ctx.runtime.broker);
  let finish!: () => void; const waiting = new Promise<void>((resolve) => { finish = resolve; });
  ctx.runtime.broker!.useCapability = async (request) => { await waiting; return original(request); };
  const session = await authorize(ctx.store);
  const first = ctx.gateway.use(api("capabilities/use", useBody(), session.accessToken), useBody());
  await expect(ctx.gateway.use(api("capabilities/use", useBody(), session.accessToken), useBody())).rejects.toThrow("REQUEST_IN_PROGRESS");
  finish(); await first; expect(ctx.calls).toHaveLength(1);
});
test("MCP calls use the same authentication and quota gate", async () => {
  const ctx = create(); const rpc = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "use_capability", arguments: useBody() } };
  const request = (token?: string) => new Request(`${ORIGIN}/mcp`, { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {}, body: JSON.stringify(rpc) });
  expect((await ctx.fetch(request())).status).toBe(401); const session = await authorize(ctx.store);
  const response = await ctx.fetch(request(session.accessToken));
  expect((await response.json()).result.structuredContent.result.status).toBe("KNOWN_MALICIOUS"); expect(ctx.calls).toHaveLength(1);
});
test("unconfigured production-style MCP cannot bypass consumer authorization", async () => {
  const ctx = create(); const handler = createBrokerMcpFetch(ctx.runtime, { requireConsumerAuthorization: true });
  const response = await handler(new Request(`${ORIGIN}/mcp`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "use_capability", arguments: useBody() } }) }));
  expect(response.status).toBe(503); expect(ctx.calls).toHaveLength(0);
  expect((await handler(api("device/start", { clientName: "Frely CLI", host: "generic" }))).status).toBe(503);
});
test("large JSON bodies are bounded", async () => {
  const ctx = create(); const response = await ctx.fetch(api("device/start", { clientName: "x".repeat(20_000), host: "generic" }));
  expect(response.status).toBe(413);
});
test("report extraction accepts typed Responses output, not prose or inconsistent targets", () => {
  const output = { output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(makeReport({ raw: "private" })) }] }] };
  expect(extractSafetyReport(output, "web3.address-risk", input).status).toBe("KNOWN_MALICIOUS");
  expect(extractSafetyReport(output, "web3.address-risk", input).raw).toBeUndefined();
  for (const value of [{}, "This wallet is 99% fraudulent", makeReport({ chainId: undefined }), makeReport({ target: account.address }), makeReport({ status: "NO_KNOWN_RISK" }), makeReport({ checkedAt: "invalid" })]) {
    expect(() => extractSafetyReport(value, "web3.address-risk", input)).toThrow();
  }
  const unknown = extractSafetyReport(makeReport({ status: "UNKNOWN", riskLevel: "UNKNOWN", signals: [] }), "web3.address-risk", input);
  expect(unknown.status).toBe("UNKNOWN"); expect(unknown.scamProbability).toBeNull();
});


test("readiness cannot advertise an unconfigured consumer gateway", async () => {
  const ctx = create();
  const handler = createBrokerMcpFetch(ctx.runtime, { requireConsumerAuthorization: true });
  const response = await handler(new Request(`${ORIGIN}/readyz`));
  expect(response.status).toBe(503);
  expect((await response.json()).code).toBe("NETWORK_ONBOARDING_NOT_CONFIGURED");
});

test("risk report retains the fixed source reference and rejects an injected link", () => {
  const report = extractSafetyReport(makeReport(), "web3.address-risk", input);
  expect(report.source).toEqual({provider:"GoPlus",referenceUrl:"https://docs.gopluslabs.io/reference/addresscontractusingget_1"});
  expect(() => extractSafetyReport(makeReport({ source:{provider:"GoPlus", referenceUrl:"https://attacker.example"} }), "web3.address-risk", input)).toThrow("PROVIDER_RESPONSE_INVALID");
});
