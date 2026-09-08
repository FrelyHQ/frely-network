import { describe, expect, test } from "bun:test";
import { fetchRegistrationMetadata, registrationMetadataUrl, type MetadataFetcher } from "./metadata.ts";

// Synthetic fixtures only; no network request or real registration is used here.
const uri = "https://metadata.example/provider.json";
const cid = "QmYwAPJzv5CZsnAzt8auVTLkGa1CXyjRbfGLbcpuuoQfNk";
const content = { name: "fixture-provider", proof: "not-live-evidence" };

describe("registration metadata URLs", () => {
  test("accepts HTTPS and preserves case-sensitive paths and queries", () => {
    expect(registrationMetadataUrl("https://METADATA.example/Provider.json?version=2"))
      .toBe("https://metadata.example/Provider.json?version=2");
  });

  test("preserves an IPFS CID and subpath with explicit gateways", () => {
    expect(registrationMetadataUrl(`ipfs://${cid}/agents/Provider.json`, "https://gateway.example/ipfs/"))
      .toBe(`https://gateway.example/ipfs/${cid}/agents/Provider.json`);
    expect(registrationMetadataUrl(`ipfs://${cid}/agents/Provider.json`, "https://gateway.example/ipfs/{cid}"))
      .toBe(`https://gateway.example/ipfs/${cid}/agents/Provider.json`);
  });

  test("does not represent inline metadata as a remote fetch URL", () => {
    expect(() => registrationMetadataUrl(`data:application/json;base64,${btoa("{}")}`))
      .toThrow("METADATA_URI_INVALID");
  });

  test.each([
    ["http://metadata.example/file.json", undefined],
    ["https://user:secret@metadata.example/file.json", undefined],
    ["https://metadata.example/file.json#fragment", undefined],
    ["data:application/json,{}", undefined],
    [`ipfs://${cid}/file.json`, undefined],
    [`ipfs://${cid}/file.json`, "http://gateway.example/ipfs"],
    [`ipfs://${cid}/file.json?token=secret`, "https://gateway.example/ipfs"],
    [`ipfs://${cid}/file.json#fragment`, "https://gateway.example/ipfs"],
    [`ipfs://user:secret@${cid}/file.json`, "https://gateway.example/ipfs"],
  ])("rejects unsafe or unsupported metadata URI %s", (value, gateway) => {
    expect(() => registrationMetadataUrl(value!, gateway)).toThrow("METADATA_URI_INVALID");
  });
});

describe("registration metadata fetch", () => {
  test("decodes inline base64 JSON including UTF-8 without a transport or gateway", async () => {
    const expected = { ...content, description: "图像识别" };
    const encoded = Buffer.from(JSON.stringify(expected), "utf8").toString("base64");
    let calls = 0;
    const fetcher: MetadataFetcher = async () => { calls++; throw new Error("must not fetch"); };
    expect(await fetchRegistrationMetadata(`data:application/json;base64,${encoded}`, {}, fetcher))
      .toEqual(expected);
    expect(calls).toBe(0);
  });

  test("rejects invalid inline media, base64, UTF-8, or JSON without exposing payloads", async () => {
    const invalid = [
      "data:application/json,{}",
      `data:text/plain;base64,${btoa("{}")}`,
      `data:application/json;charset=utf-8;base64,${btoa("{}")}`,
      "data:application/json;base64,",
      "data:application/json;base64,e30", // Missing padding.
      "data:application/json;base64,e31=", // Noncanonical padding bits.
      "data:application/json;base64,e30=\n",
      "data:application/json;base64,e30%3D",
      "data:application/json;base64,____",
      "data:application/json;base64,/w==", // Invalid UTF-8.
      `data:application/json;base64,${btoa("SECRET invalid JSON")}`,
    ];
    let calls = 0;
    const fetcher: MetadataFetcher = async () => { calls++; return Response.json(content); };
    for (const value of invalid) {
      await expect(fetchRegistrationMetadata(value, {}, fetcher)).rejects.toThrow(/^METADATA_URI_INVALID$/);
    }
    expect(calls).toBe(0);
  });

  test("limits inline metadata by decoded bytes, including exactly the maximum", async () => {
    const limit = 1024 * 1024;
    const value = "x".repeat(limit - 2);
    const atLimit = `data:application/json;base64,${btoa(JSON.stringify(value))}`;
    expect(await fetchRegistrationMetadata(atLimit)).toBe(value);
    for (const excess of [1, 2, 3]) {
      const oversized = `data:application/json;base64,${btoa(JSON.stringify(value + "x".repeat(excess)))}`;
      await expect(fetchRegistrationMetadata(oversized)).rejects.toThrow(/^METADATA_URI_INVALID$/);
    }
  });

  test("validates timeout configuration for inline metadata too", async () => {
    await expect(fetchRegistrationMetadata(`data:application/json;base64,${btoa("{}")}`, { timeoutMs: 0 }))
      .rejects.toThrow(/^METADATA_CONFIG_INVALID$/);
  });

  test("fetches JSON through injected transport with explicit redirect and timeout policy", async () => {
    let calls = 0;
    const fetcher: MetadataFetcher = async (url, init) => {
      calls++;
      expect(url).toBe(uri);
      expect(init.method).toBe("GET");
      expect(init.headers).toEqual({ accept: "application/json" });
      expect(init.redirect).toBe("error");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return Response.json(content);
    };
    expect(await fetchRegistrationMetadata(uri, {}, fetcher)).toEqual(content);
    expect(calls).toBe(1);
  });

  test("uses only the configured HTTPS gateway for IPFS fetches", async () => {
    expect(await fetchRegistrationMetadata(`ipfs://${cid}/file.json`, {
      gateway: "https://gateway.example/ipfs/",
    }, async (url) => {
      expect(url).toBe(`https://gateway.example/ipfs/${cid}/file.json`);
      return Response.json(content);
    })).toEqual(content);
  });

  test("rejects invalid URI or timeout before calling transport", async () => {
    let calls = 0;
    const fetcher: MetadataFetcher = async () => { calls++; return Response.json(content); };
    await expect(fetchRegistrationMetadata(`ipfs://${cid}`, {}, fetcher)).rejects.toThrow("METADATA_URI_INVALID");
    for (const timeoutMs of [0, -1, 0.5, NaN, Infinity]) {
      await expect(fetchRegistrationMetadata(uri, { timeoutMs }, fetcher)).rejects.toThrow("METADATA_CONFIG_INVALID");
    }
    expect(calls).toBe(0);
  });

  test("rejects HTTP failures and redirects", async () => {
    for (const status of [302, 404, 500]) {
      await expect(fetchRegistrationMetadata(uri, {}, async () => new Response("{}", { status })))
        .rejects.toThrow("METADATA_FETCH_FAILED");
    }
    const redirected = Response.json(content);
    Object.defineProperty(redirected, "redirected", { value: true });
    await expect(fetchRegistrationMetadata(uri, {}, async () => redirected)).rejects.toThrow("METADATA_FETCH_FAILED");
  });

  test("rejects absent bodies, invalid JSON, and invalid UTF-8", async () => {
    for (const response of [new Response(null), new Response("{not json"), new Response(new Uint8Array([0xff]))]) {
      await expect(fetchRegistrationMetadata(uri, {}, async () => response)).rejects.toThrow("METADATA_FETCH_FAILED");
    }
  });

  test("rejects oversized content both from the header and while streaming", async () => {
    const limit = 1024 * 1024;
    await expect(fetchRegistrationMetadata(uri, {}, async () => new Response("{}", {
      headers: { "content-length": String(limit + 1) },
    }))).rejects.toThrow("METADATA_FETCH_FAILED");
    await expect(fetchRegistrationMetadata(uri, {}, async () => new Response("x".repeat(limit + 1))))
      .rejects.toThrow("METADATA_FETCH_FAILED");
  });

  test("decodes multi-byte UTF-8 split across stream chunks", async () => {
    const expected = { description: "\u56fe\u50cf" };
    const bytes = new TextEncoder().encode(JSON.stringify(expected));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      },
    });
    expect(await fetchRegistrationMetadata(uri, {}, async () => new Response(stream))).toEqual(expected);
  });

  test("aborts timed-out requests and never includes transport secrets in errors", async () => {
    let aborted = false;
    const fetcher: MetadataFetcher = async (_url, init) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("transport failed: https://gateway.example/api/SECRET"));
      }, { once: true });
    });
    await expect(fetchRegistrationMetadata(uri, { timeoutMs: 5 }, fetcher)).rejects.toThrow(/^METADATA_FETCH_FAILED$/);
    expect(aborted).toBe(true);
    await expect(fetchRegistrationMetadata(uri, {}, async () => {
      throw new Error("request https://metadata.example/private?token=SECRET failed");
    })).rejects.toThrow(/^METADATA_FETCH_FAILED$/);
  });

  test("redacts stream read failures", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.error(new Error("SECRET upstream URL")); },
    });
    await expect(fetchRegistrationMetadata(uri, {}, async () => new Response(stream)))
      .rejects.toThrow(/^METADATA_FETCH_FAILED$/);
  });
});
