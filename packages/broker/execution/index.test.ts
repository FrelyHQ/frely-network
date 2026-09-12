import { expect, test } from "bun:test";
import { createFrelyExecutor } from "./index.ts";

const provider = {
  id: "frely-vision-basic",
  verified: false,
  authorizationSource: "static_allowlist" as const,
  protocol: "responses" as const,
  endpoint: "http://127.0.0.1:13600/v1/responses",
};
const request = { capabilities: ["vision"], task: "Describe", input: { image_url: "https://images.example/a.png" } };
const config = { mode: "static-local" as const, networkKey: "test-only", origin: "http://127.0.0.1:13600" as const };

test("maps request and uses only the local Network URL, with redirects disabled", async () => {
  const execute = createFrelyExecutor(config, async (url, init) => {
    expect(String(url)).toBe(provider.endpoint);
    expect(init?.redirect).toBe("error");
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer test-only");
    expect(JSON.parse(String(init?.body))).toEqual({ model: "vision-basic", instructions: "Describe", input: [{ role: "user", content: [{ type: "input_image", image_url: "https://images.example/a.png" }] }], stream: false, store: false });
    return Response.json({ output_text: "A bicycle" });
  });
  expect(await execute(provider, request)).toEqual({ output_text: "A bicycle" });
});

test("missing opt-in, unverified identities and foreign origin cannot send network key", async () => {
  let called = false;
  const fetcher = async () => { called = true; return Response.json({ output_text: "x" }); };
  await expect(createFrelyExecutor({ ...config, networkKey: "" }, fetcher)(provider, request)).rejects.toThrow("EXECUTION_CONFIG_INVALID");
  await expect(createFrelyExecutor(config, fetcher)({ ...provider, verified: false, authorizationSource: undefined }, request)).rejects.toThrow("IDENTITY_VERIFICATION_FAILED");
  await expect(createFrelyExecutor(config, fetcher)({ ...provider, endpoint: "https://other.example/v1/responses" }, request)).rejects.toThrow("EXECUTION_ORIGIN_MISMATCH");
  expect(called).toBe(false);
});

test("402 and empty results are failures, never paid success or retried", async () => {
  for (const [response, code] of [[new Response("payment", { status: 402 }), "PAYMENT_REQUIRED"], [Response.json({}), "PROVIDER_RESULT_INVALID"]] as const) {
    let calls = 0;
    const execute = createFrelyExecutor(config, async () => { calls++; return response; });
    await expect(execute(provider, request)).rejects.toThrow(code);
    expect(calls).toBe(1);
  }
});

test("an unenforceable maxAmount stops instead of silently bypassing budget", async () => {
  let called = false;
  const execute = createFrelyExecutor(config, async () => { called = true; return Response.json({ output_text: "x" }); });
  await expect(execute(provider, { ...request, maxAmount: "1" })).rejects.toThrow("BUDGET_CHECK_UNAVAILABLE");
  expect(called).toBe(false);
});

test("accepts only an explicitly static-authorized provider when verified is false", async () => {
  const execute = createFrelyExecutor(config, async () =>
    Response.json({ output_text: "static-ok" }));
  await expect(execute({
    ...provider,
    verified: false,
    authorizationSource: "static_allowlist",
  }, request)).resolves.toBeDefined();
  await expect(execute({ ...provider, verified: false, authorizationSource: undefined }, request))
    .rejects.toThrow("IDENTITY_VERIFICATION_FAILED");
});

test("rejects non-public image URLs before sending the Network key", async () => {
  let called = false;
  const execute = createFrelyExecutor(config, async () => { called = true; return Response.json({ output_text: "x" }); });
  for (const image_url of [
    "http://images.example/a.png",
    "https://localhost/a.png",
    "https://printer.local/a.png",
    "https://127.0.0.1/a.png",
  ]) {
    await expect(execute(provider, { ...request, input: { image_url } })).rejects.toThrow("INPUT_INVALID");
  }
  expect(called).toBe(false);
});
