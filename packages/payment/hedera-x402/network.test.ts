import { expect, test } from 'bun:test';
import { createNetworkCheck } from './network.ts';
import { preflight } from './preflight.ts';
import raw from '../../../scripts/payment-spike/fixtures/synthetic/policy.json';
import valid from '../../../scripts/payment-spike/fixtures/synthetic/valid.json';
import type { Policy } from './types.ts';
export function networkFixture(asset = '0.0.0') {
 const p = {...raw, asset, assetDecimals: asset === '0.0.0' ? 8 : 6} as Policy;
 const result = preflight({policy:raw, payment:valid.request.payment, http:valid.capture});
 if(result.decision !== 'prepared') throw Error('fixture');
 result.selection.requirements.asset = asset;
 const responses: Record<string,unknown> = {
 '/supported':{kinds:[{x402Version:2, scheme:'exact', network:'hedera:testnet', extra:{feePayer:'0.0.1235'}}]},
 '/api/v1/tokens/0.0.9876':{token_id:asset, decimals:'6', deleted:false, type:'FUNGIBLE_COMMON', custom_fees:{fixed_fees:[],fractional_fees:[],royalty_fees:[]}},
 };
 for(const id of [p.payerAccountId,p.payTo]) {
 responses[`/api/v1/accounts/${id}`]={account:id, deleted:false, receiver_sig_required:false, balance:{balance:'9007199254740993000',tokens:[]}};
 responses[`/api/v1/accounts/${id}/tokens?token.id=${asset}`]={tokens:[{token_id:asset,balance:'9007199254740993000',freeze_status:'UNFROZEN',kyc_status:'GRANTED'}],links:{next:null}};
 }
 return {p,selection:result.selection,responses};
}
test('read-only HBAR and HTS preflight use bound hosts without provider auth', async()=>{
 for(const asset of ['0.0.0','0.0.9876']) {
 const {p,selection,responses}=networkFixture(asset); const seen:string[]=[];
 await createNetworkCheck(p,async req=>{seen.push(req.url);expect(req.method).toBe('GET');expect(req.redirect).toBe('error');expect(req.headers.has('Authorization')).toBe(false);const u=new URL(req.url);return Response.json(responses[u.pathname+u.search]);})(selection);
 expect(seen.some(u=>u.includes('fixture.invalid'))).toBe(false);
 }
});
test('blocked token, account and supported conditions never pass', async()=>{
 for(const mutate of [
 (r:Record<string,any>)=>r['/supported'].kinds[0].extra.feePayer='0.0.9',
 (r:Record<string,any>)=>r['/api/v1/tokens/0.0.9876'].deleted=true,
 (r:Record<string,any>)=>r['/api/v1/tokens/0.0.9876'].decimals='7',
 (r:Record<string,any>)=>r['/api/v1/tokens/0.0.9876'].custom_fees.fixed_fees=[{amount:1}],
 (r:Record<string,any>)=>r['/api/v1/accounts/0.0.1236'].deleted=true,
 (r:Record<string,any>)=>r['/api/v1/accounts/0.0.1236/tokens?token.id=0.0.9876'].tokens[0].balance='999',
 (r:Record<string,any>)=>r['/api/v1/accounts/0.0.1234/tokens?token.id=0.0.9876'].tokens[0].freeze_status='FROZEN',
 (r:Record<string,any>)=>r['/api/v1/accounts/0.0.1234/tokens?token.id=0.0.9876'].tokens[0].kyc_status='REVOKED',
 ]) {const {p,selection,responses}=networkFixture('0.0.9876');mutate(responses);await expect(createNetworkCheck(p,async req=>{const u=new URL(req.url);return Response.json(responses[u.pathname+u.search]);})(selection)).rejects.toThrow();}
});
test('payTo requiring additional signature is blocked',async()=>{
 const {p,selection,responses}=networkFixture();(responses['/api/v1/accounts/0.0.1234'] as any).receiver_sig_required=true;
 await expect(createNetworkCheck(p,async req=>{const u=new URL(req.url);return Response.json(responses[u.pathname+u.search]);})(selection)).rejects.toThrow();
});
test('requires payer balance to cover amount plus wallet reserve', async () => {
 const {p,selection,responses}=networkFixture();
 selection.requirements.amount = '100000000';
 const setPayerBalance = (value: string) => {
  (responses[`/api/v1/accounts/${p.payerAccountId}`] as {balance:{balance:string}}).balance.balance = value;
 };
 const fetch = async (req: Request) => {
  const u = new URL(req.url);
  return Response.json(responses[u.pathname+u.search]);
 };
 const check = createNetworkCheck(p, fetch, { payerReserveAtomic: '10000000' });
 setPayerBalance('109999999');
 await expect(check(selection)).rejects.toThrow('NETWORK_CHECK_FAILED');
 setPayerBalance('110000000');
 await expect(check(selection)).resolves.toBeUndefined();
});
