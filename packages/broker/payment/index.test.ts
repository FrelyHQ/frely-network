import { expect, test } from "bun:test";
import { createHarness } from "../../payment/hedera-x402/test-support.ts";
import { createPaidExecutor } from "./index.ts";

test("paid executor maps the validated capability request into one payment session", async () => {
  const harness = createHarness();
  const execute = createPaidExecutor({
    policy: harness.policy,
    ports: harness.ports,
    executionConfig: { mode: "static-local", origin: "http://127.0.0.1:13600", networkKey: "caller-test" },
  });
  const outcome = await execute(
    { id: "provider-1", verified: true, protocol: "responses", endpoint: harness.policy.resourceUrl },
    { capabilities: ["vision"], task: "Describe", input: { image_url: "https://images.example/a.png" }, payment: harness.request.payment },
  );
  expect(outcome.paymentStatus).toBe("settled");
  expect(outcome.serviceStatus).toBe("succeeded");
  expect(outcome.output).toEqual({ output_text: "synthetic output" });
  expect(harness.counts.http).toBe(2);
  harness.close();
});
