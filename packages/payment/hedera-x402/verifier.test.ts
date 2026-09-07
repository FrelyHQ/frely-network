import {expect,test} from 'bun:test';
import {createVerifier} from './verifier.ts';
import raw from '../../../scripts/payment-spike/fixtures/synthetic/policy.json';
import type {PaymentEvidence,Policy} from './types.ts';
const p={...raw,asset:'0.0.9876',assetDecimals:6} as Policy;
export const evidence:PaymentEvidence={source:'testnet',network:p.network,asset:p.asset,amountAtomic:'9007199254740993',payer:p.payerAccountId,payTo:p.payTo,transactionId:'0.0.1235@1700000000.000000001',signedDigest:'a'.repeat(64)};
export function transaction(){return {transaction_id:'0.0.1235-1700000000-000000001',name:'CRYPTOTRANSFER',result:'SUCCESS',scheduled:false,nonce:0,consensus_timestamp:'1700000001.000000002',node:'0.0.3',charged_tx_fee:100,transfers:[],token_transfers:[{token_id:p.asset,account:p.payerAccountId,amount:'-9007199254740993'},{token_id:p.asset,account:p.payTo,amount:'9007199254740993'}],nft_transfers:[],assessed_custom_fees:[],staking_reward_transfers:[]};}
test('lossless exact HTS settlement proof ignores arbitrary response links',async()=>{
 const t=transaction(); const result=await createVerifier(p,async req=>{expect(req.url).toBe('https://mirror.invalid/api/v1/transactions/0.0.1235-1700000000-000000001');return new Response(JSON.stringify({transactions:[t],links:{next:'https://attacker.invalid'}}).replace(/"(-?9007199254740993)"/g,'$1'));})(evidence);
 expect(result.verified).toBe(true);if(result.verified)expect(result.evidence.consensusTimestamp).toBe(t.consensus_timestamp);
});
test('rejects success words, wrong records, transfers, conflicts and index delay',async()=>{
 const variants=[(t:any)=>t.token_transfers=[],(t:any)=>t.token_transfers[0].account='0.0.8',(t:any)=>t.token_transfers[1].amount='9007199254740992',(t:any)=>t.token_transfers[1].token_id='0.0.8',(t:any)=>t.scheduled=true,(t:any)=>t.result='FAIL_INVALID',(t:any)=>t.transaction_id='0.0.1235-1700000000-000000002'];
 for(const mutate of variants){const t=transaction();mutate(t);expect((await createVerifier(p,async()=>Response.json({transactions:[t]}))(evidence)).verified).toBe(false);}
 expect((await createVerifier(p,async()=>Response.json({transactions:[transaction(),transaction()]}))(evidence)).verified).toBe(false);
 let calls=0;expect((await createVerifier(p,async()=>{calls++;return new Response(null,{status:404});})(evidence)).verified).toBe(false);expect(calls).toBe(1);
 calls=0;expect((await createVerifier(p,async()=>{calls++;throw Error('forbidden');})(evidence,'other')).verified).toBe(false);expect(calls).toBe(0);
 expect((await createVerifier(p,async()=>Response.json({transactions:[transaction()]}))({...evidence,network:'hedera:mainnet'})).verified).toBe(false);
});
test('HBAR separately proves business and exact fee distribution',async()=>{
 const h={...p,asset:'0.0.0',assetDecimals:8} as Policy;
 const e={...evidence,asset:'0.0.0',amountAtomic:'1000'};
 const t={...transaction(),token_transfers:[],transfers:[{account:p.payerAccountId,amount:-1000},{account:p.payTo,amount:1000},{account:'0.0.1235',amount:-100},{account:'0.0.3',amount:10},{account:'0.0.98',amount:90}]};
 const verify=(body:unknown)=>createVerifier(h,async()=>Response.json({transactions:[body]}))(e);
 expect((await verify(t)).verified).toBe(true);
 for(const change of [
 {...t,transfers:[...t.transfers,{account:'0.0.777',amount:1}]},
 {...t,charged_tx_fee:99},
 {...t,staking_reward_transfers:[{account:p.payTo,amount:10}]},
 {...t,node:p.payTo},
 {...t,transfers:t.transfers.map(r=>r.account==='0.0.98'?{...r,amount:89}:r)},
 ])expect((await verify(change)).verified).toBe(false);
 expect((await createVerifier(h,async()=>Response.json({transactions:[t]}))({...e,payer:'0.0.1235'})).verified).toBe(false);
});
test('HTS extra positive receiver and wrong payer evidence never settle',async()=>{
 const t=transaction();t.token_transfers.push({token_id:p.asset,account:'0.0.7',amount:'1'});
 expect((await createVerifier(p,async()=>Response.json({transactions:[t]}))(evidence)).verified).toBe(false);
 expect((await createVerifier(p,async()=>{throw Error('must not query');})({...evidence,payer:'0.0.7'})).verified).toBe(false);
});
test('captured native HBAR proof permits omitted custom-fee field but rejects fees and changed amounts',async()=>{
 const captured=await Bun.file(new URL('../../../scripts/payment-spike/fixtures/testnet/hbar-settlement.json',import.meta.url)).json();
 const h={...p,asset:'0.0.0',assetDecimals:8,payerAccountId:'0.0.10386782',payTo:'0.0.10403579',feePayers:['0.0.7162784']} as Policy;
 const e={...evidence,asset:h.asset,amountAtomic:'1000000',payer:h.payerAccountId,payTo:h.payTo,transactionId:'0.0.7162784@1788768330.364206661'};
 const verify=(body:unknown)=>createVerifier(h,async()=>Response.json(body))(e);
 expect((await verify(captured)).verified).toBe(true);
 for(const fees of [null,{},[{amount:1}]])expect((await verify({transactions:[{...captured.transactions[0],assessed_custom_fees:fees}]})).verified).toBe(false);
 const changed=structuredClone(captured);changed.transactions[0].transfers[3].amount++;
 expect((await verify(changed)).verified).toBe(false);
});
