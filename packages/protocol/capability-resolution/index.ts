import { isIP } from "node:net";
import { z } from "zod";

export type StaticResolveRequest = {
  schemaVersion: 2;
  capabilities: ["vision"];
  paymentNetwork: "hedera:testnet";
};

export type StaticResolveResult = {
  schemaVersion: 2;
  requestedCapabilities: ["vision"];
  provider: {
    id: string;
    endpoint: string;
    protocol: "responses";
  };
  execution: {
    endpoint: string;
    managedBy: "network";
  };
  resolution: {
    source: "static_allowlist";
    identityVerified: false;
  };
  payment: {
    supportsX402: true;
    network: "hedera:testnet";
    resource: string;
  };
};

const visionOnly = z.tuple([z.literal("vision")]);

const staticRequestSchema = z
  .object({
    schemaVersion: z.literal(2),
    capabilities: visionOnly,
    paymentNetwork: z.literal("hedera:testnet"),
  })
  .strict();

const loopbackResponsesUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    const port = Number(url.port);
    return (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/v1/responses" &&
      Number.isInteger(port) &&
      port >= 1 &&
      port <= 65535
    );
  } catch {
    return false;
  }
};

const publicHttpsResponsesUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.+$/, "");
    const ipHost = host.replace(/^\[|\]$/g, "");
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/v1/responses" &&
      host !== "localhost" &&
      !host.endsWith(".local") &&
      isIP(ipHost) === 0
    );
  } catch {
    return false;
  }
};

const staticResultSchema = z
  .object({
    schemaVersion: z.literal(2),
    requestedCapabilities: visionOnly,
    provider: z
      .object({
        id: z.string().trim().min(1),
        endpoint: z.string().refine(publicHttpsResponsesUrl),
        protocol: z.literal("responses"),
      })
      .strict(),
    execution: z
      .object({
        endpoint: z.string().refine(loopbackResponsesUrl),
        managedBy: z.literal("network"),
      })
      .strict(),
    resolution: z
      .object({
        source: z.literal("static_allowlist"),
        identityVerified: z.literal(false),
      })
      .strict(),
    payment: z
      .object({
        supportsX402: z.literal(true),
        network: z.literal("hedera:testnet"),
        resource: z.string().refine(loopbackResponsesUrl),
      })
      .strict(),
  })
  .strict();

export function parseStaticResolveRequest(
  value: unknown,
): StaticResolveRequest {
  const parsed = staticRequestSchema.safeParse(value);
  if (!parsed.success) throw new Error("INVALID_REQUEST");
  return parsed.data;
}

export function parseStaticResolveResult(
  value: unknown,
): StaticResolveResult {
  const parsed = staticResultSchema.safeParse(value);
  if (!parsed.success) throw new Error("INVALID_RESPONSE");
  if (parsed.data.execution.endpoint !== parsed.data.payment.resource) {
    throw new Error("INVALID_RESPONSE");
  }
  return parsed.data;
}
