// Synthetic-only process fixture. No real signer, network, or credentials.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { createHarness } from "../test-support.ts";
const [path, mode, id, gate] = process.argv.slice(2) as [string, string, string, string];
const h = createHarness({ dbPath: path });
h.request.payment.requestId = id;
const fetcher = h.ports.fetcher;
h.ports.fetcher = async request => {
  if (request.headers.has("PAYMENT-SIGNATURE")) {
    if (mode === "dispatch-crash") process.exit(0);
    if (mode === "compete") appendFileSync(gate + ".paid", id + "\n");
  } else if (mode === "compete") await Bun.sleep(300);
  return fetcher(request);
};
if (mode === "capture-crash") h.ports.verify = async () => process.exit(0);
if (mode === "compete") {
  writeFileSync(gate + "." + process.pid + ".ready", "ready");
  while (!existsSync(gate)) await Bun.sleep(5);
}
const result = await h.session.execute(h.request);
console.log(JSON.stringify({ reason: result.reason, paymentStatus: result.paymentStatus, counts: h.counts }));
h.close();
