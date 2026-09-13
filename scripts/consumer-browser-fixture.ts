import { ConsumerStore } from "../apps/broker-mcp/consumer/store.ts";
import { ConsumerGateway } from "../apps/broker-mcp/consumer/service.ts";
import { createBrokerMcpFetch } from "../apps/broker-mcp/service.ts";
import { resolve } from "node:path";

// Test-only loopback server. It has no Broker, wallet funds, model access or persistent state.
let handler: (request: Request) => Promise<Response> = async () => new Response("Starting", { status: 503 });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => handler(request) });
const origin = `http://127.0.0.1:${server.port}`;
const store = new ConsumerStore({ origin, allowLoopback: true, databasePath: ":memory:" });
const runtime = { ready: false };
handler = createBrokerMcpFetch(runtime, { consumerGateway: new ConsumerGateway(store, runtime),
  requireConsumerAuthorization: true, staticRoot: resolve(import.meta.dir, "../apps/site/dist") });
const grant = store.start("Browser Test", "chatgpt");
console.log(JSON.stringify({ origin, verificationUri: grant.verificationUri, userCode: grant.userCode }));
function close() { server.stop(true); store.close(); process.exit(0); }
process.on("SIGTERM", close);
process.on("SIGINT", close);
