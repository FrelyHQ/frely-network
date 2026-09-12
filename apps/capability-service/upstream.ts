const RELAY_URL = "https://api.frely.cloud/v1/responses";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

export type RelayUpstreamConfig = {
  url: string;
  apiKey: string;
};

export type RelayUpstream = {
  invoke(body: string, requestId: string): Promise<Response>;
};

export type RelayFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function createRelayUpstream(
  config: RelayUpstreamConfig,
  fetcher: RelayFetcher = fetch,
): RelayUpstream {
  const apiKey = config.apiKey.trim();
  if (config.url !== RELAY_URL || !apiKey) throw new Error("UPSTREAM_NOT_CONFIGURED");
  return {
    async invoke(body: string, requestId: string): Promise<Response> {
      assertVisionBasicBody(body);
      let response: Response;
      try {
        response = await fetcher(new Request(RELAY_URL, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
            accept: "application/json",
            "x-frely-request-id": requestId,
          },
          body,
          redirect: "error",
          signal: AbortSignal.timeout(TIMEOUT_MS),
        }));
      } catch {
        throw new Error("UPSTREAM_FAILED");
      }
      if (response.redirected) throw new Error("UPSTREAM_FAILED");
      if (response.status === 402) throw new Error("UPSTREAM_PAYMENT_UNEXPECTED");
      if (response.status < 200 || response.status >= 300) throw new Error("UPSTREAM_FAILED");
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error("UPSTREAM_FAILED");
      return new Response(bytes, {
        status: response.status,
        headers: {
          "content-type": response.headers.get("content-type") ?? "application/json",
          "cache-control": "no-store",
        },
      });
    },
  };
}

function assertVisionBasicBody(body: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("UPSTREAM_FAILED");
  }
  if (
    !parsed
    || typeof parsed !== "object"
    || Array.isArray(parsed)
    || (parsed as { model?: unknown }).model !== "vision-basic"
    || (parsed as { stream?: unknown }).stream !== false
  ) {
    throw new Error("UPSTREAM_FAILED");
  }
}
