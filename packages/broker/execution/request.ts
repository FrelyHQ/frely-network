import type { CapabilityRequest, ResolvedProvider } from "@frely-network/shared-types";
import type { PreparedRequest } from "@frely-network/hedera-x402";

export type ExecutionConfig = { mode?: string; callerKey?: string; origin?: string };

export function prepareFrelyRequest(config: ExecutionConfig, provider: ResolvedProvider, request: CapabilityRequest): PreparedRequest {
  if (config.mode !== "integration" || !config.callerKey || !config.origin) throw new Error("EXECUTION_CONFIG_INVALID");
  if (provider.verified !== true) throw new Error("IDENTITY_VERIFICATION_FAILED");
  if (provider.protocol !== "responses") throw new Error("PROTOCOL_NOT_SUPPORTED");
  let endpoint: URL;
  try { endpoint = new URL(provider.endpoint); } catch { throw new Error("ENDPOINT_NOT_HTTPS"); }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) throw new Error("ENDPOINT_NOT_HTTPS");
  if (endpoint.origin !== config.origin) throw new Error("EXECUTION_ORIGIN_MISMATCH");
  if (request.capabilities.length !== 1 || request.capabilities[0] !== "vision") throw new Error("CAPABILITY_NOT_SUPPORTED");
  const input = request.input as { image_url?: unknown } | undefined;
  let image: URL;
  try { image = new URL(typeof input?.image_url === "string" ? input.image_url : ""); } catch { throw new Error("INPUT_INVALID"); }
  if (!['https:', 'http:'].includes(image.protocol) || image.username || image.password) throw new Error("INPUT_INVALID");
  return {
    method: "POST",
    url: provider.endpoint,
    headers: {
      authorization: `Bearer ${config.callerKey}`,
      "content-type": "application/json",
      ...(request.payment?.requestId ? { "x-frely-request-id": request.payment.requestId } : {}),
    },
    body: JSON.stringify({ model: "vision-basic", instructions: request.task, input: [{ role: "user", content: [{ type: "input_image", image_url: image.toString() }] }], stream: false, store: false }),
    providerId: provider.id,
    payment: request.payment as PreparedRequest["payment"],
  };
}
