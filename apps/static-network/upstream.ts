const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,191}$/u;

export type RelayFetcher = (request: Request) => Promise<Response>;

export type RelayUpstream = {
  invoke(body: string, requestId: string): Promise<Response>;
};

export function createRelayUpstream(
  config: { url: string; apiKey: string; timeoutMs?: number },
  fetcher: RelayFetcher = (request) => fetch(request),
): RelayUpstream {
  const apiKey = config.apiKey.trim();
  const timeoutMs = config.timeoutMs ?? 30_000;
  if (!apiKey || /[\r\n\0]/u.test(apiKey) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("UPSTREAM_NOT_CONFIGURED");
  }
  const endpoint = relayEndpoint(config.url);

  return {
    async invoke(body, requestId) {
      if (!REQUEST_ID.test(requestId)) throw new Error("UPSTREAM_FAILED");
      try {
        const response = await fetcher(new Request(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            accept: "application/json",
            "content-type": "application/json",
            "x-frely-request-id": requestId,
          },
          body,
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        }));
        if (response.redirected || response.status < 200 || response.status >= 300) throw new Error();
        const bytes = await boundedBytes(response, MAX_RESPONSE_BYTES);
        const headers = new Headers({ "cache-control": "no-store" });
        const contentType = response.headers.get("content-type");
        if (contentType && !/[\r\n\0]/u.test(contentType)) headers.set("content-type", contentType);
        const upstreamRequestId = response.headers.get("x-request-id");
        if (upstreamRequestId && REQUEST_ID.test(upstreamRequestId)) headers.set("x-request-id", upstreamRequestId);
        return new Response(bytes, { status: response.status, statusText: response.statusText, headers });
      } catch {
        throw new Error("UPSTREAM_FAILED");
      }
    },
  };
}

function relayEndpoint(value: string): string {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.pathname !== "/v1/responses" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) throw new Error();
    return url.toString();
  } catch {
    throw new Error("UPSTREAM_NOT_CONFIGURED");
  }
}

async function boundedBytes(response: Response, maximum: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const size = Number(declared);
    if (!Number.isSafeInteger(size) || size < 0 || size > maximum) throw new Error();
  }
  if (!response.body) return new Uint8Array(new ArrayBuffer(0));
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new Error();
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(new ArrayBuffer(size));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
