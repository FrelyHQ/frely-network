import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { account } from "../apps/broker-mcp/consumer/test-support.ts";
import { Broker, A2AServiceInvocation } from "../packages/broker/index.ts";
import { TheGraphDiscovery } from "../packages/discovery/the-graph/index.ts";
import { ConsumerStore } from "../apps/broker-mcp/consumer/store.ts";
import { ConsumerGateway } from "../apps/broker-mcp/consumer/service.ts";
import { createBrokerMcpFetch } from "../apps/broker-mcp/service.ts";

/** Isolated integration fixture. No public API, real wallet, model endpoint or OS credential store is used. */
export async function runConsumerOnboardingSmoke(cliPath: string, swarmPath: string): Promise<Record<string, unknown>> {
  const load = (root: string, path: string) => import(pathToFileURL(resolve(root, path)).href);
  const { runNetwork } = await load(cliPath, "dist/network.js");
  const { createWeb3SafetyAgent } = await load(swarmPath, "src/mastra/agents/web3-safety-agent.ts");
  const { createDeterministicModel } = await load(swarmPath, "tests/deterministic-model.ts");
  const { handleA2ATask } = await load(swarmPath, "src/adapters/a2a/route.ts");
  const { projectSafetyOutputText } = await load(swarmPath, "src/web3-safety/output.ts");
  const origin = "https://network.fixture.test";
  const graphEndpoint = "https://graph.fixture.test/query";
  const serviceEndpoint = "https://api.frely.fixture.test/a2a";
  const registryAddress = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
  const target = `0x${"ab".repeat(20)}`;
  const home = await mkdtemp(join(await realpath(tmpdir()), "frely-cross-project-"));
  const records = new Map<string, string>();
  const phases: string[] = [];
  let indexed = true;
  let graphQueries = 0;
  let invocations = 0;
  let sourceQueries = 0;
  const manifest = {
    name: "Wallet-risk integration fixture", capabilities: ["web3.address-risk"],
    identity: { ens: "risk.fixture.eth", agentId: "7" },
    interfaces: [{ protocol: "a2a", endpoint: serviceEndpoint, agentCardUrl: "https://api.frely.fixture.test/.well-known/agent-card.json" }],
    payment: { protocol: "x402", network: "hedera:testnet" }, active: true, x402Support: false,
  };
  const row = { id: "11155111:7", chainId: "11155111", agentId: "7", agentURI: "https://metadata.fixture.test/7.json",
    registrationFile: { ens: manifest.identity.ens, active: true, x402Support: false } };
  const discovery = new TheGraphDiscovery({ endpoint: graphEndpoint, registryAddress, paymentNetwork: "hedera:testnet" }, async (url, init) => {
    assert.equal(new Headers(init.headers).has("authorization"), false);
    if (url === graphEndpoint) { graphQueries++; phases.push("graph-query-fixture"); return Response.json({ data: { agents: indexed ? [row] : [] } }); }
    assert.equal(url, row.agentURI); phases.push("registration-metadata-fixture"); return Response.json(manifest);
  });
  const invocation = new A2AServiceInvocation({ headers: { authorization: "Bearer fixture-platform-credential" }, fetcher: async (url, init) => {
    assert.equal(url, serviceEndpoint);
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer fixture-platform-credential");
    assert.equal(init.redirect, "error"); invocations++; phases.push("frely-edge-fixture");
    const request = JSON.parse(String(init.body));
    assert.equal(request.method, "message/send"); assert.equal(request.params.metadata["frely.model"], "web3/address-risk");
    const scripted = createDeterministicModel({ generateSteps: [
      { type: "tool-call", toolName: "check_address_risk", input: { address: target, chainId: "1" } },
      { type: "text", text: "A model-written verdict must not become risk evidence." },
    ] });
    const agent = createWeb3SafetyAgent({ model: scripted.model, client: {
      clock: () => new Date("2026-09-13T10:00:00Z"),
      async checkAddress(address: string, chainId: string) {
        assert.equal(address, target); assert.equal(chainId, "1"); sourceQueries++; phases.push("goplus-fixture");
        return { code: 1, result: { phishing_activities: "1" } };
      },
      async checkPhishingSite() { throw new Error("Unexpected URL check"); },
    } });
    phases.push("swarm-agent");
    const internal = await handleA2ATask(new Request("https://swarm.fixture.test/internal/a2a/tasks", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        context: { protocolVersion: "0.1", requestId: `req_${request.id}`, idempotencyKey: request.params.message.messageId, agentId: "web3-safety-agent" },
        taskType: "model.inference", model: request.params.metadata["frely.model"],
        messages: [{ role: "user", parts: [{ type: "text", text: request.params.message.parts[0].text }] }],
      }),
    }), {}, { authorize: () => undefined,
      card: { protocolVersion: "0.1", name: "fixture", description: "Fixture", capabilities: ["model.inference"], taskTypes: ["model.inference"] },
      resolveAgent: () => agent, outputText: projectSafetyOutputText,
    });
    assert.equal(internal.status, 200);
    const body = await internal.json(); const text = body.task.result.message.parts[0].text;
    return Response.json({ jsonrpc: "2.0", id: request.id, result: { kind: "task", id: body.task.id,
      status: { state: "completed" }, artifacts: [{ parts: [{ kind: "text", text }] }] } });
  } });
  const broker = new Broker({ discovery, identity: {
    async resolveProvider(candidate) {
      assert.equal(candidate.id, "7"); assert.equal(candidate.ensName, manifest.identity.ens);
      phases.push("identity-fixture");
      return { id: candidate.id, ensName: candidate.ensName!, endpoint: serviceEndpoint, protocol: "a2a", verified: true };
    },
  }, invocation }, { billingMode: "frely_account", discoverySource: "the_graph_fixture", registryChainId: "11155111" });
  const runtime = { ready: true, broker };
  const store = new ConsumerStore({ origin, databasePath: ":memory:" });
  const handler = createBrokerMcpFetch(runtime, { consumerGateway: new ConsumerGateway(store, runtime), requireConsumerAuthorization: true });
  const clientFetch = async (url: string | URL | Request, init?: RequestInit) => {
    const request = new Request(url, init);
    assert.equal(new URL(request.url).origin, origin);
    if (new URL(request.url).pathname === "/SKILL.md") {
      return new Response(await Bun.file(new URL("../apps/site/public/SKILL.md", import.meta.url)).text(), { headers: { "content-type": "text/markdown" } });
    }
    return handler(request);
  };
  const dependencies = { home, fetch: clientFetch, store: {
    async getPassword(service: string, key: string) { return records.get(`${service}:${key}`) ?? null; },
    async setPassword(service: string, key: string, value: string) { records.set(`${service}:${key}`, value); },
    async deletePassword(service: string, key: string) { return records.delete(`${service}:${key}`); },
  } };
  const browser = (path: string, body: unknown) => handler(new Request(`${origin}/api/network/${path}`, {
    method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  try {
    const setup = await runNetwork(["network", "setup", "--network", origin, "--host", "chatgpt", "--json"], dependencies);
    assert.equal(setup.status, "awaiting_wallet"); assert.equal(setup.instructionMode, "conversation"); phases.push("cli-prepared");
    const challenge = await (await browser("device/challenge", { userCode: setup.userCode, address: account.address, chainId: 11155111 })).json();
    const signature = await account.signMessage({ message: challenge.message });
    const approval = await browser("device/approve", { userCode: setup.userCode, message: challenge.message, signature });
    assert.equal(approval.status, 200); phases.push("wallet-signature-verified");
    const id = "da8a97b0-d6d5-4c8e-b86c-a303b36fc4ed";
    const args = ["network", "use", "--capability", "web3.address-risk", "--input-json", JSON.stringify({ address: target, chainId: "1" }), "--request-id", id, "--json"];
    const result = await runNetwork(args, dependencies);
    assert.equal(result.status, "succeeded"); assert.equal(result.result.status, "KNOWN_MALICIOUS");
    assert.equal(result.result.scamProbability, null); assert.equal(result.evidence.agentId, "7");
    assert.equal(result.evidence.discoverySource, "the_graph_fixture"); assert.equal(result.evidence.chainSettlement, false);
    assert.equal(result.result.chainId, "1"); assert.equal(invocations, 1); assert.equal(sourceQueries, 1);
    phases.push("source-backed-result");
    assert.deepEqual(await runNetwork(args, dependencies), result); assert.equal(invocations, 1); phases.push("cached-repeat");
    indexed = false;
    await assert.rejects(runNetwork(args.map((item) => item === id ? "a8af96a5-6704-4d5e-8f82-1e201a6cdc82" : item), dependencies), (error: unknown) => error instanceof Error && error.message === "NO_PROVIDER");
    assert.equal(invocations, 1); phases.push("graph-removal-blocks-execution");
    await runNetwork(["network", "logout", "--json"], dependencies); assert.equal(records.size, 0); phases.push("session-revoked");
    return { status: "passed", mode: "isolated_fixture", liveGraph: false, liveEns: false, liveWallet: false, liveGoPlus: false,
      model: "scripted_test_model", graphQueries, invocations, sourceQueries, phases };
  } finally { store.close(); await rm(home, { recursive: true, force: true }); }
}

if (import.meta.main) {
  const [cliPath, swarmPath] = process.argv.slice(2);
  if (!cliPath || !swarmPath) throw new Error("Usage: bun scripts/consumer-onboarding-smoke.ts <built-frely-cli-checkout> <frely-swarm-checkout>");
  console.log(JSON.stringify(await runConsumerOnboardingSmoke(cliPath, swarmPath), null, 2));
}
