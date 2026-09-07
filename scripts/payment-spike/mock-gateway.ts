import {createHash} from 'node:crypto';
import {decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader} from '@x402/core/http';
import {PaymentPayloadSchema, PaymentRequiredSchema} from '@x402/core/schemas';
import type {PaymentRequired, PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse} from '@x402/core/types';
export type GatewayEvent = {phase: string; digest?: string; receipt?: SettleResponse};
type Facilitator = {
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>;
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;
};
// Test resource only: output is mocked; verify/settle are real SDK calls in the runner.
export function createMockGateway(options: {
  required: PaymentRequired; requestId: string; body: string;
  facilitator: Facilitator; onEvent(event: GatewayEvent): void;
}): (request: Request) => Promise<Response> {
  const required = PaymentRequiredSchema.parse(options.required) as PaymentRequired;
  if (required.x402Version !== 2 || required.accepts.length !== 1) throw Error('MOCK_CONFIG_INVALID');
  const quote = required.accepts[0]!;
  let attempted = false;
  const reject = (reason: string, status = 409) => Response.json({error: reason}, {status});
  return async request => {
    if (request.url !== required.resource.url || request.method !== 'POST' || request.headers.get('x-frely-request-id') !== options.requestId) return reject('REQUEST_MISMATCH', 400);
    if ((await request.text()) !== options.body) return reject('BODY_MISMATCH', 400);
    const header = request.headers.get('PAYMENT-SIGNATURE');
    if (!header) {
      options.onEvent({phase: 'quote'});
      return new Response(null, {status: 402, headers: {'PAYMENT-REQUIRED': encodePaymentRequiredHeader(required), 'Cache-Control': 'no-store'}});
    }
    if (header.length > 65536 || attempted) return reject('PAYMENT_ATTEMPT_ALREADY_SEEN');
    let payload: PaymentPayload;
    try {
      payload = PaymentPayloadSchema.parse(decodePaymentSignatureHeader(header)) as PaymentPayload;
      if (payload.x402Version !== 2 || payload.resource?.url !== required.resource.url || JSON.stringify(payload.accepted) !== JSON.stringify(quote)) return reject('PAYMENT_BINDING_MISMATCH', 400);
    } catch { return reject('PAYMENT_INVALID', 400); }
    const digest = createHash('sha256').update(header).digest('hex');
    attempted = true;
    try {
      options.onEvent({phase: 'verify-intent', digest});
      const verification = await options.facilitator.verify(payload, quote);
      if (!verification.isValid) { options.onEvent({phase: 'verify-rejected', digest}); return reject('PAYMENT_REJECTED', 402); }
      // Callback persists intent before dispatch. An ambiguous settle is not retried.
      options.onEvent({phase: 'settle-intent', digest});
      const receipt = await options.facilitator.settle(payload, quote);
      options.onEvent({phase: receipt.success ? 'settled' : 'settlement-failed', digest, receipt});
      if (!receipt.success || receipt.network !== quote.network || !receipt.transaction) return reject('SETTLEMENT_FAILED', 502);
      options.onEvent({phase: 'delivered', digest, receipt});
      return Response.json({output_text: 'Local test service: x402 payment settled.', requestId: options.requestId}, {headers: {'PAYMENT-RESPONSE': encodePaymentResponseHeader(receipt), 'Cache-Control': 'no-store'}});
    } catch {
      return reject('PAYMENT_PROCESSING_UNKNOWN', 503);
    }
  };
}
