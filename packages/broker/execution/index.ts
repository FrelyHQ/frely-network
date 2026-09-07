import type { CapabilityRequest, ResolvedProvider } from "@frely-network/shared-types";
import { prepareFrelyRequest, type ExecutionConfig } from "./request.ts";
import { parseFrelyResponse } from "./response.ts";

export function createFrelyExecutor(config: ExecutionConfig, fetcher: (url: URL, init: RequestInit) => Promise<Response> = fetch) {
  return async (provider: ResolvedProvider, request: CapabilityRequest): Promise<unknown> => {
    if (request.maxAmount !== undefined) throw new Error("BUDGET_CHECK_UNAVAILABLE");
    const prepared = prepareFrelyRequest(config, provider, request);
    let response: Response;
    try {
      response = await fetcher(new URL(prepared.url), {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
        headers: prepared.headers, body: prepared.body,
      });
    } catch { throw new Error("PROVIDER_EXECUTION_FAILED"); }
    if (response.status === 402) throw new Error("PAYMENT_REQUIRED");
    if (!response.ok) throw new Error("PROVIDER_EXECUTION_FAILED");
    return parseFrelyResponse(response);
  };
}
