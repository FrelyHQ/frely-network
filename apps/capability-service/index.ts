import { createCapabilityServiceRuntime } from "./runtime.ts";

export function parsePort(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error("PORT_INVALID");
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT_INVALID");
  }
  return port;
}

if (import.meta.main) {
  const runtime = createCapabilityServiceRuntime();
  Bun.serve({
    hostname: runtime.host,
    port: parsePort(runtime.port),
    fetch: runtime.fetch,
  });
}
