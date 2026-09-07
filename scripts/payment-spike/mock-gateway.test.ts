import {expect, test} from 'bun:test';
import type {PaymentRequired} from '@x402/core/types';
import {createMockGateway} from './mock-gateway.ts';

test('mock resource withholds output until facilitator settlement succeeds', async () => {
  const required: PaymentRequired = {x402Version: 2, resource: {url: 'https://localhost:9443/v1/responses'}, accepts: [{scheme: 'exact', network: 'hedera:testnet', asset: '0.0.0', amount: '1000000', payTo: '0.0.2', maxTimeoutSeconds: 120, extra: {feePayer: '0.0.3'}}]};
  let release!: (v: any) => void;
  let settling!: () => void;
  const entered = new Promise<void>(resolve => {settling = resolve;});
  const handler = createMockGateway({required, requestId: 'one', body: '{}', facilitator: {
    verify: async () => ({isValid: true}),
    settle: () => {settling(); return new Promise(resolve => {release = resolve;});},
  }, onEvent: () => {}});
  const request = (header?: string) => new Request(required.resource.url, {method: 'POST', body: '{}', headers: {'x-frely-request-id': 'one', ...(header ? {'PAYMENT-SIGNATURE': header} : {})}});
  expect((await handler(request())).status).toBe(402);
  const signature = Buffer.from(JSON.stringify({x402Version: 2, resource: required.resource, accepted: required.accepts[0], payload: {transaction: 'test-only'}})).toString('base64');
  let finished = false;
  const pending = handler(request(signature)).then(response => {finished = true; return response;});
  await entered;
  expect(finished).toBe(false);
  release({success: true, network: 'hedera:testnet', transaction: '0.0.3@1700000000.000000001'});
  const response = await pending;
  expect(response.status).toBe(200);
  expect(response.headers.get('PAYMENT-RESPONSE')).toBeTruthy();
  expect((await response.json()).output_text).toBe('Local test service: x402 payment settled.');
});
