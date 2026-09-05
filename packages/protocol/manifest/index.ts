/** The only payment profile supported by the P0 registration manifest. */
export const P0_PAYMENT_NETWORK = "hedera-testnet" as const;

export type P0PaymentNetwork = typeof P0_PAYMENT_NETWORK;

export interface ProviderInterface {
  protocol: "responses" | "mcp" | "http";
  endpoint: string;
}

export interface ResponsesProviderInterface {
  protocol: "responses";
  endpoint: `https://${string}`;
}

/** Forward-compatible manifest shape; use validateManifest for the P0 subset. */
export interface CapabilityProviderManifest {
  name: string;
  description?: string;
  capabilities: string[];
  identity: {
    ens?: string;
    agentId?: string;
  };
  interfaces: ProviderInterface[];
  payment: {
    protocol: "x402";
    network: string;
  };
}

export interface P0CapabilityProviderManifest {
  name: string;
  description?: string;
  capabilities: [string, ...string[]];
  identity: {
    ens: string;
    agentId?: string;
  };
  interfaces: [
    ResponsesProviderInterface,
    ...ResponsesProviderInterface[],
  ];
  payment: {
    protocol: "x402";
    network: P0PaymentNetwork;
  };
}

export interface ManifestValidationIssue {
  path: string;
  message: string;
}

/** Thrown when a value does not satisfy the P0 manifest contract. */
export class ManifestValidationError extends Error {
  readonly issues: readonly ManifestValidationIssue[];

  constructor(issues: ManifestValidationIssue[]) {
    super(issues.map(({ path, message }) => `${path}: ${message}`).join("; "));
    this.name = "ManifestValidationError";
    this.issues = issues;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function nonEmptyString(
  value: unknown,
  path: string,
  issues: ManifestValidationIssue[],
): value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push({ path, message: "must be a non-empty string" });
    return false;
  }
  return true;
}

function validateHttpsEndpoint(
  value: unknown,
  path: string,
  issues: ManifestValidationIssue[],
): value is `https://${string}` {
  if (!nonEmptyString(value, path, issues)) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname.length === 0) {
      issues.push({ path, message: "must be an HTTPS URL" });
      return false;
    }
  } catch {
    issues.push({ path, message: "must be a valid HTTPS URL" });
    return false;
  }
  return true;
}

/**
 * Validate and return a P0 provider manifest.
 *
 * The returned object is the original object after validation; no defaults or
 * inferred values are added. Unknown fields are retained for provenance and
 * registration metadata extensions.
 */
export function validateManifest(value: unknown): P0CapabilityProviderManifest {
  const issues: ManifestValidationIssue[] = [];
  if (!isRecord(value)) {
    throw new ManifestValidationError([{ path: "$", message: "must be an object" }]);
  }

  nonEmptyString(value.name, "name", issues);
  if (hasOwn(value, "description") && typeof value.description !== "string") {
    issues.push({ path: "description", message: "must be a string" });
  }

  if (!Array.isArray(value.capabilities) || value.capabilities.length === 0) {
    issues.push({ path: "capabilities", message: "must be a non-empty array" });
  } else {
    value.capabilities.forEach((capability, index) => {
      const path = `capabilities[${index}]`;
      if (!nonEmptyString(capability, path, issues)) return;
    });
  }

  if (!isRecord(value.identity)) {
    issues.push({ path: "identity", message: "must be an object" });
  } else {
    nonEmptyString(value.identity.ens, "identity.ens", issues);
    if (hasOwn(value.identity, "agentId")) {
      nonEmptyString(value.identity.agentId, "identity.agentId", issues);
    }
  }

  if (!Array.isArray(value.interfaces) || value.interfaces.length === 0) {
    issues.push({ path: "interfaces", message: "must be a non-empty array" });
  } else {
    value.interfaces.forEach((providerInterface, index) => {
      const path = `interfaces[${index}]`;
      if (!isRecord(providerInterface)) {
        issues.push({ path, message: "must be an object" });
        return;
      }
      if (providerInterface.protocol !== "responses") {
        issues.push({ path: `${path}.protocol`, message: 'must be "responses" for P0' });
      }
      validateHttpsEndpoint(providerInterface.endpoint, `${path}.endpoint`, issues);
    });
  }

  if (!isRecord(value.payment)) {
    issues.push({ path: "payment", message: "must be an object" });
  } else {
    if (value.payment.protocol !== "x402") {
      issues.push({ path: "payment.protocol", message: 'must be "x402" for P0' });
    }
    if (value.payment.network !== P0_PAYMENT_NETWORK) {
      issues.push({ path: "payment.network", message: `must be "${P0_PAYMENT_NETWORK}" for P0` });
    }
  }

  if (issues.length > 0) throw new ManifestValidationError(issues);
  return value as unknown as P0CapabilityProviderManifest;
}

/** Return whether a value is a valid P0 manifest without throwing. */
export function isValidManifest(value: unknown): value is P0CapabilityProviderManifest {
  try {
    validateManifest(value);
    return true;
  } catch (error) {
    if (error instanceof ManifestValidationError) return false;
    throw error;
  }
}
