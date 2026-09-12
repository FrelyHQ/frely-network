import response from "../../../packages/protocol/capability-resolution/fixtures/static-success-v2.json";

const port = Number(process.env.FRELY_NETWORK_FIXTURE_PORT ?? "3011");

Bun.serve({
  port,
  fetch(request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/capabilities/resolve") {
      return new Response("not found", { status: 404 });
    }
    return Response.json(response);
  },
});
