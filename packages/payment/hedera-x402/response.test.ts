import {expect,test} from 'bun:test';
import {encodePaymentResponseHeader} from '@x402/core/http';
import {createHarness} from './test-support.ts';
test('parseable payment hint with conflicting network remains a persisted conflict',async()=>{
 const h=createHarness();let calls=0;const original=h.ports.fetcher;
 h.ports.fetcher=async request=>{const response=await original(request);if(++calls===2)response.headers.set('PAYMENT-RESPONSE',encodePaymentResponseHeader({success:true,transaction:'synthetic-tx',network:'hedera:mainnet'}));return response;};
 try{const result=await h.session.execute(h.request);expect(result.paymentStatus).toBe('unknown');expect(h.journal.read(h.request.payment.requestId)?.responseConflict).toBe(true);}finally{h.close();}
});
