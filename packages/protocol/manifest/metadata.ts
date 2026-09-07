import { normalizeHttpsUrl } from "./registration.ts";

export interface MetadataFetcher {
  (url: string, init: RequestInit): Promise<Response>;
}

const MAX_METADATA_BYTES = 1024 * 1024;

/** IPFS is supported only through an explicitly configured HTTPS gateway. */
export function registrationMetadataUrl(uri: string, gateway?: string): string {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol === "https:") return normalizeHttpsUrl(uri);
    if (parsed.protocol !== "ipfs:" || !gateway || !parsed.hostname || parsed.username ||
        parsed.password || parsed.port || parsed.search || parsed.hash || /[<>\s\\]/.test(uri) ||
        !/^[a-zA-Z0-9]+$/.test(parsed.hostname)) throw new Error();
    const path = `${parsed.hostname}${parsed.pathname}`;
    return normalizeHttpsUrl(gateway.includes("{cid}")
      ? gateway.replace("{cid}", path)
      : `${gateway.replace(/\/$/, "")}/${path}`);
  } catch { throw new Error("METADATA_URI_INVALID"); }
}

export async function fetchRegistrationMetadata(
  uri: string,
  options: { gateway?: string; timeoutMs?: number } = {},
  fetcher: MetadataFetcher = (url, init) => fetch(url, init),
): Promise<unknown> {
  const url = registrationMetadataUrl(uri, options.gateway);
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("METADATA_CONFIG_INVALID");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetcher(url, {
      method: "GET", headers: { accept: "application/json" }, redirect: "error", signal: controller.signal,
    });
    if (!response.ok || response.redirected || !response.body) throw new Error();
    if (Number(response.headers.get("content-length")) > MAX_METADATA_BYTES) throw new Error();
    reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let size = 0;
    let text = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_METADATA_BYTES || controller.signal.aborted) throw new Error();
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    if (controller.signal.aborted) throw new Error();
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("METADATA_FETCH_FAILED");
  } finally {
    clearTimeout(timeout);
    controller.abort();
    if (reader) await reader.cancel().catch(() => {});
  }
}
