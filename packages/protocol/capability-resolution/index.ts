import { isIP } from "node:net";
import { z } from "zod";

export type ResolveCapabilitiesRequest = {
  schemaVersion: 1;
  capabilities: string[];
  paymentNetwork: "hedera:testnet";
};

export type ResolvedCapability = {
  schemaVersion: 1;
  requestedCapabilities: string[];
  provider: {
    id: string;
    ensName: string;
    endpoint: string;
    protocol: "responses";
  };
  identity: {
    verified: true;
    chainId: 11155111;
    registry: `0x${string}`;
  };
  payment: {
    supportsX402: true;
    network: "hedera:testnet";
  };
};

export type CapabilityResolutionErrorCode =
  | "INVALID_REQUEST"
  | "UNAUTHORIZED"
  | "NO_PROVIDER"
  | "NETWORK_DISCOVERY_FAILED"
  | "IDENTITY_VERIFICATION_FAILED"
  | "CAPABILITY_NOT_SUPPORTED";

const capabilities = z
  .array(z.string().trim().min(1))
  .min(1)
  .refine((values) => new Set(values).size === values.length);

const safeEndpoint = (value: string): boolean => {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const ipHost = host.replace(/^\[|\]$/g, "");

    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      host !== "localhost" &&
      !host.endsWith(".local") &&
      isIP(ipHost) === 0
    );
  } catch {
    return false;
  }
};

const registry = z
  .string()
  .regex(/^0x[0-9a-f]{40}$/i)
  .refine((value) => !/^0x0{40}$/i.test(value));

const requestSchema = z
  .object({
    schemaVersion: z.literal(1),
    capabilities,
    paymentNetwork: z.literal("hedera:testnet"),
  })
  .strict();

const responseSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestedCapabilities: capabilities,
    provider: z
      .object({
        id: z.string().trim().min(1),
        ensName: z.string().trim().min(1),
        endpoint: z.string().refine(safeEndpoint),
        protocol: z.literal("responses"),
      })
      .strict(),
    identity: z
      .object({
        verified: z.literal(true),
        chainId: z.literal(11155111),
        registry,
      })
      .strict(),
    payment: z
      .object({
        supportsX402: z.literal(true),
        network: z.literal("hedera:testnet"),
      })
      .strict(),
  })
  .strict();

export function parseResolveCapabilitiesRequest(
  value: unknown,
): ResolveCapabilitiesRequest {
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success) throw new Error("INVALID_REQUEST");
  return parsed.data;
}

export function parseResolvedCapability(value: unknown): ResolvedCapability {
  const parsed = responseSchema.safeParse(value);
  if (!parsed.success) throw new Error("INVALID_RESPONSE");
  return parsed.data as ResolvedCapability;
}
