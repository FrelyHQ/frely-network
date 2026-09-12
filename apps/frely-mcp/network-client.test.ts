import { describe, expect, test } from "bun:test";
import { parseStaticResolveResult } from "@frely-network/capability-resolution";
import success from "../../packages/protocol/capability-resolution/fixtures/static-success-v2.json";
import { FrelyNetworkClient } from "./network-client.ts";

const staticSuccess = parseStaticResolveResult(success);

const config = {
  network: { baseUrl: "http://127.0.0.1:18765" as const, apiKeyRef: "env:FRELY_NETWORK_API_KEY" as const },
  approvedProvider: { id: "example-vision", relayUrl: "https://relay.example.com/v1/responses" },
  approvedExecution: { resourceUrl: "http://127.0.0.1:18765/v1/responses" },
};

describe("Frely Network client", () => {
  test("resolves v2 through loopback with bounded authenticated JSON", async () => {
    let captured: Request | undefined;
    const client = new FrelyNetworkClient(config, {
      environment: { FRELY_NETWORK_API_KEY: "network-key" },
      fetcher: async (request) => {
        captured = request;
        return Response.json(staticSuccess);
      },
    });
    expect(await client.resolve(["vision"])).toEqual(staticSuccess);
    expect(captured?.url).toBe("http://127.0.0.1:18765/v1/capabilities/resolve");
    expect(captured?.headers.get("authorization")).toBe("Bearer network-key");
    expect(captured?.redirect).toBe("error");
  });

  test("rejects response drift after schema parsing", async () => {
    const client = new FrelyNetworkClient(config, {
      environment: { FRELY_NETWORK_API_KEY: "network-key" },
      fetcher: async () => Response.json({ ...staticSuccess, provider: { ...staticSuccess.provider, id: "other" } }),
    });
    await expect(client.resolve(["vision"])).rejects.toThrow("PROVIDER_NOT_AUTHORIZED");
  });

  test("maps only allowlisted server errors and hides malformed or oversized responses", async () => {
    const known = new FrelyNetworkClient(config, {
      environment: { FRELY_NETWORK_API_KEY: "network-key" },
      fetcher: async () => Response.json({ code: "CAPABILITY_NOT_SUPPORTED" }, { status: 422 }),
    });
    await expect(known.resolve(["vision"])).rejects.toThrow("CAPABILITY_NOT_SUPPORTED");

    for (const response of [
      Response.json({ code: "SENSITIVE_UPSTREAM_DETAIL" }, { status: 500 }),
      new Response(new Uint8Array(1024 * 1024 + 1), { status: 200 }),
    ]) {
      const client = new FrelyNetworkClient(config, {
        environment: { FRELY_NETWORK_API_KEY: "network-key" },
        fetcher: async () => response,
      });
      await expect(client.resolve(["vision"])).rejects.toThrow("NETWORK_UNAVAILABLE");
    }
  });

  test("adds Network authorization to execution but never changes the exact resource", async () => {
    let captured: Request | undefined;
    const client = new FrelyNetworkClient(config, {
      environment: { FRELY_NETWORK_API_KEY: "network-key" },
      fetcher: async (request) => { captured = request; return new Response(null, { status: 402 }); },
    });
    await client.execute(new Request(config.approvedExecution.resourceUrl, { method: "POST", body: "{}" }));
    expect(captured?.url).toBe(config.approvedExecution.resourceUrl);
    expect(captured?.headers.get("authorization")).toBe("Bearer network-key");
    await expect(client.execute(new Request("http://127.0.0.1:18765/other"))).rejects.toThrow("PROVIDER_NOT_AUTHORIZED");
  });
});
