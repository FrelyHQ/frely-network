import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import { PaymentPayloadSchema } from "@x402/core/schemas";
import { inspectHederaTransaction } from "@x402/hedera";
import { parseStaticResolvedCapability } from "@frely-network/capability-resolution";
import staticSuccess from "../../../packages/protocol/capability-resolution/fixtures/static-success-v2.json";

type Counts = {
  resolve: number;
  networkQuote: number;
  sign: number;
  networkSettle: number;
  relayDispatch: number;
  mirror: number;
};

const eventsPath = process.env.FRELY_FULL_CHAIN_EVENTS ?? "";
const payer = process.env.FRELY_FULL_CHAIN_PAYER ?? "0.0.1236";
const payTo = process.env.FRELY_FULL_CHAIN_PAY_TO ?? "0.0.1234";
const feePayer = process.env.FRELY_FULL_CHAIN_FEE_PAYER ?? "0.0.1235";
const amount = process.env.FRELY_FULL_CHAIN_AMOUNT ?? "100000000";
const payerPub = process.env.FRELY_FULL_CHAIN_PAYER_PUB ?? "";
const networkKey = process.env.FRELY_NETWORK_API_KEY ?? process.env.FRELY_API_KEY ?? "";
const resourceUrl = "http://127.0.0.1:13600/v1/responses";
const forbidden = [
  process.env.FRELY_FULL_CHAIN_WALLET ?? "",
  process.env.FRELY_FULL_CHAIN_SECRET ?? "",
].filter(Boolean);

const counts: Counts = {
  resolve: 0,
  networkQuote: 0,
  sign: 0,
  networkSettle: 0,
  relayDispatch: 0,
  mirror: 0,
};
const seenSignatures = new Set<string>();
const pendingMirrorIds = new Set<string>();

function persist() {
  if (!eventsPath) return;
  mkdirSync(dirname(eventsPath), { recursive: true });
  writeFileSync(eventsPath, JSON.stringify(counts));
}

function quote() {
  return {
    scheme: "exact" as const,
    network: "hedera:testnet" as const,
    asset: "0.0.0",
    amount,
    payTo,
    maxTimeoutSeconds: 120,
    extra: { feePayer, paymentFlow: "upfront" },
  };
}

function assertNoSecrets(request: Request, body: string, extra: string[] = []) {
  const haystack = `${request.url}\n${[...request.headers.entries()].map(([key, value]) => `${key}:${value}`).join("\n")}\n${body}`;
  for (const secret of [...forbidden, ...extra].filter(Boolean)) {
    if (secret && haystack.includes(secret)) throw new Error("SECRET_LEAK");
  }
}

function bodySha256Of(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const extensions = (payload as { extensions?: unknown }).extensions;
  if (!extensions || typeof extensions !== "object" || Array.isArray(extensions)) return null;
  const value = (extensions as { bodySha256?: unknown }).bodySha256;
  return typeof value === "string" ? value : null;
}

async function networkFetch(request: Request): Promise<Response> {
  const body = await request.text();
  assertNoSecrets(request, body, [process.env.FRELY_RELAY_API_KEY ?? ""]);
  if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/capabilities/resolve") {
    return new Response("not found", { status: 404 });
  }
  counts.resolve += 1;
  persist();
  return Response.json(parseStaticResolvedCapability(staticSuccess));
}

function mirrorAccount(id: string) {
  return {
    account: id,
    deleted: false,
    receiver_sig_required: false,
    balance: { balance: Number(amount) + 10_000_000 },
    key: id === payer && payerPub
      ? { _type: "ECDSA_SECP256K1", key: payerPub }
      : { _type: "ECDSA_SECP256K1", key: "02" + "ab".repeat(32) },
  };
}

function mirrorTransaction(rawId: string) {
  const id = rawId.includes("-")
    ? rawId
    : rawId.replace("@", "-").replace(/\.(\d+)$/, (_, nanos: string) => `-${nanos.padStart(9, "0")}`);
  return {
    transactions: [{
      transaction_id: id,
      name: "CRYPTOTRANSFER",
      result: "SUCCESS",
      scheduled: false,
      nonce: 0,
      consensus_timestamp: "1700000001.000000002",
      node: "0.0.3",
      charged_tx_fee: 100,
      transfers: [
        { account: payer, amount: -Number(amount) },
        { account: payTo, amount: Number(amount) },
        { account: feePayer, amount: -100 },
        { account: "0.0.3", amount: 10 },
        { account: "0.0.98", amount: 90 },
      ],
      token_transfers: [],
      nft_transfers: [],
      staking_reward_transfers: [],
    }],
  };
}

async function relayFetch(request: Request): Promise<Response> {
  const body = await request.text();
  assertNoSecrets(request, body);
  for (const name of ["PAYMENT-SIGNATURE", "PAYMENT-REQUIRED", "PAYMENT-RESPONSE"]) {
    if (request.headers.has(name)) throw new Error("PAYMENT_HEADER_LEAK");
  }
  counts.relayDispatch += 1;
  persist();
  return Response.json({ output_text: "FRELY X402 OK" });
}

async function networkExecute(request: Request): Promise<Response> {
  const body = await request.text();
  assertNoSecrets(request, body, [process.env.FRELY_RELAY_API_KEY ?? ""]);
  const header = request.headers.get("PAYMENT-SIGNATURE");
  if (!header) {
    counts.networkQuote += 1;
    persist();
    return new Response(null, {
      status: 402,
      headers: {
        "PAYMENT-REQUIRED": encodePaymentRequiredHeader({
          x402Version: 2,
          resource: { url: resourceUrl },
          accepts: [quote()],
        }),
        "Cache-Control": "no-store",
      },
    });
  }
  const payload = PaymentPayloadSchema.parse(decodePaymentSignatureHeader(header));
  const expectedHash = createHash("sha256").update(body).digest("hex");
  if (bodySha256Of(payload) !== expectedHash) {
    return new Response(null, { status: 400 });
  }
  const digest = createHash("sha256").update(header).digest("hex");
  if (!seenSignatures.has(digest)) {
    seenSignatures.add(digest);
    counts.sign += 1;
    counts.networkSettle += 1;
    persist();
  }
  const rawTx = payload.payload && typeof payload.payload === "object" && "transaction" in payload.payload
    ? String((payload.payload as { transaction: string }).transaction)
    : "";
  const transactionId = rawTx ? inspectHederaTransaction(rawTx).transactionId : "0.0.1235@1700000000.000000001";
  const requestId = request.headers.get("x-frely-request-id") ?? "";
  if (requestId.startsWith("pending-")) {
    const mirrorId = transactionId.replace("@", "-").replace(/\.(\d+)$/, (_, nanos: string) => `-${nanos.padStart(9, "0")}`);
    pendingMirrorIds.add(mirrorId);
    persist();
    return new Response(null, {
      status: 402,
      headers: {
        "PAYMENT-RESPONSE": encodePaymentResponseHeader({
          success: false,
          network: "hedera:testnet",
          transaction: transactionId,
        }),
        "Cache-Control": "no-store",
      },
    });
  }
  const upstream = await relayFetch(new Request("https://api.frely.cloud/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.FRELY_RELAY_API_KEY ?? ""}`,
      "content-type": "application/json",
      accept: "application/json",
      "x-frely-request-id": requestId,
    },
    body,
  }));
  const receipt = {
    success: true,
    network: "hedera:testnet" as const,
    transaction: transactionId,
  };
  return new Response(await upstream.arrayBuffer(), {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "PAYMENT-RESPONSE": encodePaymentResponseHeader(receipt),
      "Cache-Control": "no-store",
    },
  });
}

async function route(request: Request): Promise<Response> {
  const url = request.url;
  const parsed = new URL(url);
  const hostname = parsed.hostname;
  if (hostname === "127.0.0.1" && parsed.port === "13600") {
    if (parsed.pathname === "/v1/capabilities/resolve") return networkFetch(request);
    if (parsed.pathname === "/v1/responses") return networkExecute(request);
  }
  if (hostname === "api.frely.cloud" && parsed.pathname === "/v1/responses") {
    return relayFetch(request);
  }
  if (hostname.includes("facilitator")) {
    return Response.json({
      kinds: [{ x402Version: 2, scheme: "exact", network: "hedera:testnet", extra: { feePayer } }],
    });
  }
  const path = new URL(url).pathname;
  const account = /\/api\/v1\/accounts\/([^/]+)$/.exec(path);
  if (account) return Response.json(mirrorAccount(decodeURIComponent(account[1]!)));
  const tx = /\/api\/v1\/transactions\/([^/]+)$/.exec(path);
  if (tx) {
    counts.mirror += 1;
    persist();
    const id = decodeURIComponent(tx[1]!);
    if (pendingMirrorIds.has(id)) return Response.json({ transactions: [] });
    return Response.json(mirrorTransaction(id));
  }
  return new Response("not intercepted", { status: 599 });
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = input instanceof Request ? input : new Request(String(input), init);
  return route(request);
}) as typeof fetch;

persist();
