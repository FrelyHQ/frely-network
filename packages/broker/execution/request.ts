import type { CapabilityRequest, ResolvedProvider } from "@frely-network/shared-types";
import type { PreparedRequest } from "@frely-network/hedera-x402";
import { isIP } from "node:net";

export type ExecutionConfig = {
  mode: "static-local";
  networkKey: string;
  origin: "http://127.0.0.1:13600";
};

const EXECUTION_ENDPOINT = "http://127.0.0.1:13600/v1/responses";

function isPublicHttpsImage(value: string): boolean {
  try {
    const image = new URL(value);
    const host = image.hostname.toLowerCase().replace(/\.+$/, "");
    return (
      image.protocol === "https:"
      && !image.username
      && !image.password
      && host !== "localhost"
      && !host.endsWith(".local")
      && isIP(host.replace(/^\[|\]$/g, "")) === 0
    );
  } catch {
    return false;
  }
}

export function prepareFrelyRequest(config: ExecutionConfig, provider: ResolvedProvider, request: CapabilityRequest): PreparedRequest {
  if (config.mode !== "static-local" || !config.networkKey || config.origin !== "http://127.0.0.1:13600") {
    throw new Error("EXECUTION_CONFIG_INVALID");
  }
  const identityAuthorized = provider.verified === true;
  const staticAuthorized = provider.verified === false
    && provider.authorizationSource === "static_allowlist";
  if (!identityAuthorized && !staticAuthorized) {
    throw new Error("IDENTITY_VERIFICATION_FAILED");
  }
  if (provider.protocol !== "responses") throw new Error("PROTOCOL_NOT_SUPPORTED");
  if (provider.endpoint !== EXECUTION_ENDPOINT) throw new Error("EXECUTION_ORIGIN_MISMATCH");
  if (request.capabilities.length !== 1 || request.capabilities[0] !== "vision") throw new Error("CAPABILITY_NOT_SUPPORTED");
  const input = request.input as { image_url?: unknown } | undefined;
  if (typeof input?.image_url !== "string" || !isPublicHttpsImage(input.image_url)) {
    throw new Error("INPUT_INVALID");
  }
  return {
    method: "POST",
    url: provider.endpoint,
    headers: {
      authorization: `Bearer ${config.networkKey}`,
      "content-type": "application/json",
      ...(request.payment?.requestId ? { "x-frely-request-id": request.payment.requestId } : {}),
    },
    body: JSON.stringify({ model: "vision-basic", instructions: request.task, input: [{ role: "user", content: [{ type: "input_image", image_url: input.image_url }] }], stream: false, store: false }),
    providerId: provider.id,
    payment: request.payment as PreparedRequest["payment"],
  };
}
