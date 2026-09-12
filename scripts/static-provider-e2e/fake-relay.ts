const port = Number(process.env.FIXTURE_PORT);
const eventPath = process.env.FIXTURE_EVENT_PATH;
if (!Number.isSafeInteger(port) || port < 1 || !eventPath) throw new Error("FIXTURE_CONFIG_INVALID");

const state = {
  relay: 0,
  paymentHeaders: [] as string[],
  authorizationValues: [] as string[],
};

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/__state") return Response.json(state);
    if (request.method !== "POST" || url.pathname !== "/v1/responses") return new Response(null, { status: 404 });
    state.relay += 1;
    state.authorizationValues.push(request.headers.get("authorization") ?? "");
    for (const [name] of request.headers) {
      const lower = name.toLowerCase();
      if (lower.startsWith("payment-") || lower.startsWith("x-payment") || lower.includes("wallet")) {
        state.paymentHeaders.push(lower);
      }
    }
    appendFileSync(eventPath, "relay\n", { encoding: "utf8", mode: 0o600 });
    const body = await request.text();
    if (body.includes("relay-failure")) return Response.json({ code: "fixture_failure" }, { status: 503 });
    return Response.json({ output_text: "synthetic vision result" }, { headers: { "x-request-id": `relay-${state.relay}` } });
  },
});

process.stdout.write(`${JSON.stringify({ ready: true, port: server.port })}\n`);
const close = () => server.stop(true);
process.once("SIGINT", close);
process.once("SIGTERM", close);

export {};
import { appendFileSync } from "node:fs";
