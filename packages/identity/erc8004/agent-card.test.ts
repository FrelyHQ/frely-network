import { describe, expect, mock, test } from "bun:test";
import { inspectAgentCard, publicA2AUrl } from "./agent-card.ts";

// Synthetic documents and injected HTTP responses only; these are not live Card evidence.
const endpoint = "https://provider.frely.network/a2a";
const agentCardUrl = "https://provider.frely.network/.well-known/agent-card.json";

function card03() {
  return {
    name: "Fixture provider", description: "A2A discovery fixture", version: "1.2.3",
    protocolVersion: "0.3.0", preferredTransport: "JSONRPC", url: endpoint,
    capabilities: {}, defaultInputModes: ["text/plain"], defaultOutputModes: ["text/plain"],
    skills: [{ id: "vision", name: "Vision", description: "Image understanding", tags: ["vision"] }],
  };
}

function card10() {
  const { protocolVersion: _, preferredTransport: _transport, url: _url, ...base } = card03();
  return { ...base, supportedInterfaces: [{ protocolVersion: "1.0", protocolBinding: "JSONRPC", url: endpoint }] };
}

function fixture(value: unknown = card03()) {
  const fetcher = mock(async (_url: string, _init: RequestInit) => Response.json(value));
  return { fetcher, inspect: () => inspectAgentCard(agentCardUrl, endpoint, { fetcher }) };
}

describe("Agent Card public HTTPS targets", () => {
  test("normalizes a public HTTPS URL without changing path or query case", () => {
    expect(publicA2AUrl("https://PROVIDER.FRELY.NETWORK:443/A2A?Agent=Vision"))
      .toBe("https://provider.frely.network/A2A?Agent=Vision");
    expect(publicA2AUrl("https://8.8.8.8/a2a")).toBe("https://8.8.8.8/a2a");
  });

  test.each([
    "http://provider.frely.network/a2a", "https://user:secret@provider.frely.network/a2a",
    "https://provider.frely.network/a2a#fragment", "https://provider.frely.network/a2a#",
    "https://provider.frely.network/a path", "https://provider.frely.network\\a2a",
    "https://localhost/a2a", "https://provider.local/a2a", "https://provider.internal/a2a", "https://host/a2a",
    "https://0.0.0.0/a2a", "https://127.0.0.1/a2a", "https://10.1.2.3/a2a",
    "https://172.16.0.1/a2a", "https://172.31.255.255/a2a", "https://192.168.1.1/a2a",
    "https://169.254.169.254/a2a", "https://100.64.0.1/a2a", "https://100.127.255.255/a2a",
    "https://192.0.2.1/a2a", "https://198.18.0.1/a2a", "https://198.19.0.1/a2a",
    "https://198.51.100.1/a2a", "https://203.0.113.1/a2a",
    "https://224.0.0.1/a2a", "https://255.255.255.255/a2a",
    "https://[::1]/a2a", "https://[::ffff:127.0.0.1]/a2a",
    "https://2130706433/a2a", "https://0x7f000001/a2a", "https://127.1/a2a",
  ])("rejects an unsafe target before Card transport: %s", async (unsafe) => {
    for (const [cardUrl, executionUrl] of [[unsafe, endpoint], [agentCardUrl, unsafe]]) {
      const { fetcher } = fixture();
      await expect(inspectAgentCard(cardUrl!, executionUrl!, { fetcher })).rejects.toThrow("A2A_CARD_INVALID");
      expect(fetcher).not.toHaveBeenCalled();
    }
  });
});

describe("Agent Card discovery validation", () => {
  test("accepts explicit 0.3 JSON-RPC and only reads the declared Card URL", async () => {
    const { inspect, fetcher } = fixture();
    expect(await inspect()).toEqual({ agentCardUrl, endpoint, a2aProtocolVersion: "0.3.0" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe(agentCardUrl);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "GET", redirect: "error" });
    expect(fetcher.mock.calls[0]?.[1].body).toBeUndefined();
  });

  test("selects the A2A 1.0 JSON-RPC interface matching the verified execution URL", async () => {
    const card = card10();
    card.supportedInterfaces.unshift({ protocolVersion: "1.0", protocolBinding: "HTTP+JSON", url: "https://provider.frely.network/rest" });
    expect(await fixture(card).inspect()).toEqual({ agentCardUrl, endpoint, a2aProtocolVersion: "1.0" });
  });

  test("normalizes Card execution URL representation while preserving path case", async () => {
    expect((await fixture({ ...card03(), url: "https://PROVIDER.FRELY.NETWORK:443/a2a" }).inspect()).endpoint).toBe(endpoint);
    await expect(fixture({ ...card03(), url: "https://provider.frely.network/A2A" }).inspect())
      .rejects.toThrow("A2A_ENDPOINT_MISMATCH");
  });

  test.each([
    { protocolVersion: undefined }, { protocolVersion: "0.2.9" }, { protocolVersion: "1.0" },
    { preferredTransport: undefined }, { preferredTransport: "HTTP+JSON" }, { preferredTransport: "GRPC" },
  ])("rejects unsupported or implicit 0.3 transport/version: %j", async (change) => {
    await expect(fixture({ ...card03(), ...change }).inspect()).rejects.toThrow("A2A_PROTOCOL_NOT_SUPPORTED");
  });

  test.each([
    { protocolVersion: "1.0.0" }, { protocolVersion: "0.3.0" }, { protocolBinding: "HTTP+JSON" },
    { tenant: "tenant-1" }, { tenant: null },
  ])("rejects unsupported 1.0 interface selection or tenant: %j", async (change) => {
    const card = card10();
    await expect(fixture({ ...card, supportedInterfaces: [{ ...card.supportedInterfaces[0], ...change }] }).inspect())
      .rejects.toThrow("A2A_PROTOCOL_NOT_SUPPORTED");
  });

  test("reports a 1.0 JSON-RPC execution URL mismatch separately from unsupported protocols", async () => {
    const card = card10();
    await expect(fixture({ ...card, supportedInterfaces: [{
      ...card.supportedInterfaces[0], url: "https://other.frely.network/a2a",
    }] }).inspect()).rejects.toThrow("A2A_ENDPOINT_MISMATCH");
    await expect(fixture({ ...card, supportedInterfaces: [
      { ...card.supportedInterfaces[0], url: "https://provider.frely.network/A2A" },
      { ...card.supportedInterfaces[0], protocolBinding: "HTTP+JSON" },
    ] }).inspect()).rejects.toThrow("A2A_ENDPOINT_MISMATCH");
  });

  test("normalizes the selected 1.0 execution URL and rejects an unsupported tenant only after matching", async () => {
    const card = card10();
    const matching = { ...card.supportedInterfaces[0], url: "https://PROVIDER.FRELY.NETWORK:443/a2a" };
    expect(await fixture({ ...card, supportedInterfaces: [matching] }).inspect())
      .toEqual({ agentCardUrl, endpoint, a2aProtocolVersion: "1.0" });
    await expect(fixture({ ...card, supportedInterfaces: [
      { ...card.supportedInterfaces[0], url: "https://other.frely.network/a2a" },
      { ...matching, tenant: "tenant-1" },
    ] }).inspect()).rejects.toThrow("A2A_PROTOCOL_NOT_SUPPORTED");
  });

  test.each([
    null, [], "interface", {},
    { protocolVersion: "1.0", protocolBinding: "JSONRPC" },
    { protocolVersion: "1.0", protocolBinding: "", url: endpoint },
    { protocolVersion: "", protocolBinding: "JSONRPC", url: endpoint },
    { protocolVersion: 1, protocolBinding: "JSONRPC", url: endpoint },
    { protocolVersion: "1.0", protocolBinding: ["JSONRPC"], url: endpoint },
    { protocolVersion: "1.0", protocolBinding: "JSONRPC", url: 42 },
    { protocolVersion: "1.0", protocolBinding: "JSONRPC", url: "invalid-url" },
  ])("rejects malformed 1.0 interface entries even alongside a valid interface: %j", async (entry) => {
    const card = card10();
    for (const supportedInterfaces of [[entry], [entry, ...card.supportedInterfaces]]) {
      await expect(fixture({ ...card, supportedInterfaces }).inspect()).rejects.toThrow("A2A_CARD_INVALID");
    }
  });

  test("accepts the unscoped empty tenant in A2A 1.0", async () => {
    const card = card10();
    expect((await fixture({ ...card, supportedInterfaces: [{ ...card.supportedInterfaces[0], tenant: "" }] }).inspect())
      .a2aProtocolVersion).toBe("1.0");
  });

  test.each([{ url: endpoint }, { protocolVersion: "0.3.0" }, { preferredTransport: "JSONRPC" }])(
    "rejects mixed 0.3 and 1.0 Card shapes: %j", async (change) => {
      await expect(fixture({ ...card10(), ...change }).inspect()).rejects.toThrow("A2A_CARD_INVALID");
    },
  );

  test.each([
    { name: "" }, { description: undefined }, { version: 1 }, { capabilities: [] },
    { defaultInputModes: [] }, { defaultOutputModes: [""] }, { skills: [] },
    { skills: [{ id: "vision", name: "Vision", description: "Vision", tags: [1] }] },
  ])("requires the minimum Agent Card structure: %j", async (change) => {
    await expect(fixture({ ...card03(), ...change }).inspect()).rejects.toThrow("A2A_CARD_INVALID");
  });

  test("rejects duplicate Card skill IDs", async () => {
    const card = card03();
    await expect(fixture({ ...card, skills: [...card.skills, ...card.skills] }).inspect()).rejects.toThrow("A2A_CARD_INVALID");
  });

  test("does not infer execution or payment proof from native x402 support", async () => {
    const { inspect, fetcher } = fixture({ ...card03(), x402Support: false });
    expect(await inspect()).toEqual({ agentCardUrl, endpoint, a2aProtocolVersion: "0.3.0" });
    expect(fetcher.mock.calls[0]?.[1].headers).toEqual({ accept: "application/json" });
    expect(fetcher.mock.calls[0]?.[1].method).toBe("GET");
  });

  test("rejects malformed Cards, transport errors, redirects, and invalid timeout settings with stable errors", async () => {
    for (const value of [null, [], "invalid-card"]) {
      await expect(fixture(value).inspect()).rejects.toThrow("A2A_CARD_INVALID");
    }
    const { fetcher } = fixture();
    fetcher.mockRejectedValueOnce(new Error("https://private.example/secret-token"));
    await expect(inspectAgentCard(agentCardUrl, endpoint, { fetcher })).rejects.toThrow(/^A2A_CARD_INVALID$/);
    fetcher.mockResolvedValueOnce(new Response("", { status: 302, headers: { location: "https://127.0.0.1/card" } }));
    await expect(inspectAgentCard(agentCardUrl, endpoint, { fetcher })).rejects.toThrow(/^A2A_CARD_INVALID$/);
    const before = fetcher.mock.calls.length;
    await expect(inspectAgentCard(agentCardUrl, endpoint, { fetcher, timeoutMs: 0 })).rejects.toThrow(/^A2A_CARD_INVALID$/);
    expect(fetcher.mock.calls).toHaveLength(before);
  });
});
