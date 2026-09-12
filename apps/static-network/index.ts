import { loadStaticNetworkConfig } from "./config.ts";
import { createStaticNetworkRuntime } from "./runtime.ts";
import { serveStaticNetwork } from "./server.ts";

if (import.meta.main) {
  const runtime = createStaticNetworkRuntime(loadStaticNetworkConfig());
  const server = serveStaticNetwork(runtime);
  process.stderr.write(JSON.stringify({ profile: "static-local", port: runtime.port, readiness: "constructed" }) + "\n");
  const close = () => {
    server.stop(true);
    runtime.close();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
