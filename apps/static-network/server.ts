import type { StaticNetworkRuntime } from "./runtime.ts";

export function serveStaticNetwork(runtime: StaticNetworkRuntime): Bun.Server<undefined> {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: runtime.port,
    fetch: runtime.fetch,
  });
}
