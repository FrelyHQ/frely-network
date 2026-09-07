import type { CapabilityRequest, ResolvedProvider } from "@frely-network/shared-types";

export function createFrelyExecutor(config: { mode?: string; callerKey?: string; origin?: string }, fetcher: (url: URL, init: RequestInit) => Promise<Response> = fetch) {
  return async (provider: ResolvedProvider, request: CapabilityRequest): Promise<unknown> => {
    if (config.mode !== "integration" || !config.callerKey || !config.origin) throw new Error("EXECUTION_CONFIG_INVALID");
    if (request.maxAmount !== undefined) throw new Error("BUDGET_CHECK_UNAVAILABLE");
    if (provider.verified !== true) throw new Error("IDENTITY_VERIFICATION_FAILED");
    if (provider.protocol !== "responses") throw new Error("PROTOCOL_NOT_SUPPORTED");
    const endpoint = new URL(provider.endpoint);
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) throw new Error("ENDPOINT_NOT_HTTPS");
    // The configured origin constrains credential delivery; it never supplies the execution URL.
    if (endpoint.origin !== config.origin) throw new Error("EXECUTION_ORIGIN_MISMATCH");
    if (request.capabilities.length !== 1 || request.capabilities[0] !== "vision") throw new Error("CAPABILITY_NOT_SUPPORTED");
    const input = request.input as { image_url?: unknown } | undefined;
    let image: URL;
    try { image = new URL(typeof input?.image_url === "string" ? input.image_url : ""); } catch { throw new Error("INPUT_INVALID"); }
    if (!["https:", "http:"].includes(image.protocol) || image.username || image.password) throw new Error("INPUT_INVALID");
    let response: Response;
    try {
      response = await fetcher(endpoint, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
        headers: { authorization: `Bearer ${config.callerKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "vision-basic", instructions: request.task, input: [{ role: "user", content: [{ type: "input_image", image_url: image.toString() }] }], stream: false, store: false }),
      });
    } catch { throw new Error("PROVIDER_EXECUTION_FAILED"); }
    if (response.status === 402) throw new Error("PAYMENT_REQUIRED");
    if (!response.ok) throw new Error("PROVIDER_EXECUTION_FAILED");
    let result: { output_text?: unknown; output?: unknown; status?: unknown };
    try { result = await response.json() as typeof result; } catch { throw new Error("PROVIDER_RESULT_INVALID"); }
    if (!result || typeof result !== "object" || ["failed", "incomplete", "in_progress", "queued"].includes(String(result.status))) throw new Error("PROVIDER_RESULT_INVALID");
    const hasText = typeof result.output_text === "string" && result.output_text.trim().length > 0;
    const hasOutput = Array.isArray(result.output) && result.output.some((item) => Array.isArray(item?.content) && item.content.some((part: { type?: string; text?: string }) => part?.type === "output_text" && typeof part.text === "string" && part.text.trim()));
    if (!hasText && !hasOutput) throw new Error("PROVIDER_RESULT_INVALID");
    return result;
  };
}
