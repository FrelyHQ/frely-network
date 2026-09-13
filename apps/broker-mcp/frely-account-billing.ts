import type { PaymentClientResult, PaymentRequest } from "@frely-network/hedera-x402";

/** Ordinary Frely account billing: the API key identifies the balance owner. */
export class FrelyAccountBillingClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetcher: (input: string, init: RequestInit) => Promise<Response> = (input, init) => fetch(input, init),
  ) {
    if (!apiKey.trim() || /[\r\n\u0000]/u.test(apiKey)) throw new Error("FRELY_API_KEY_INVALID");
  }

  async request(request: PaymentRequest): Promise<PaymentClientResult> {
    const headers = new Headers(request.headers);
    headers.set("authorization", `Bearer ${this.apiKey}`);
    headers.delete("x-payment");
    headers.delete("payment-signature");
    headers.delete("payment-required");
    headers.delete("x-payment-proof");
    const response = await this.fetcher(request.url, {
      method: request.method,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers,
      body: request.body ? request.body as unknown as BodyInit : undefined,
    });
    return { response, challenged: false };
  }
}
