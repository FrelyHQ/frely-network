import type {PaymentEvidence,Policy,RecoveryPolicy,Ports,Verification} from './types.ts';
import type {RecoveryVerifier} from './recovery.ts';
import {credentials,endpoint,integer,object,readJson,wait,type ReadFetcher} from './read-only.ts';
const unavailable=():Verification=>({verified:false,reason:'SETTLEMENT_UNVERIFIED'});
export function mirrorTransactionId(value:unknown):string|null{
 if(typeof value!=='string')return null;
 const match=/^((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))@((?:0|[1-9][0-9]*))\.([0-9]{1,9})$/.exec(value);
 return match?`${match[1]}-${match[2]}-${match[3]!.padStart(9,'0')}`:null;
}
function aggregate(rows:unknown):Map<string,bigint>{
 if(!Array.isArray(rows))throw Error();const net=new Map<string,bigint>();
 for(const r of rows){if(!object(r)||typeof r.account!=='string'||!/^\d+\.\d+\.\d+$/.test(r.account))throw Error();net.set(r.account,(net.get(r.account)??0n)+integer(r.amount));}
 return new Map([...net].filter(([,a])=>a!==0n));
}
// Exactly one attempt. Recovery owns its own retry boundary.
export function createVerifier(policy:RecoveryPolicy,fetcher:ReadFetcher):Ports['verify']{
 return async(evidence,responseTransaction)=>{
  if(responseTransaction && responseTransaction!==evidence.transactionId)return {verified:false,reason:'SETTLEMENT_CONFLICT'};
  const id=mirrorTransactionId(evidence.transactionId);
  const feePayer=evidence.transactionId?.split('@')[0];
  if(!id||!feePayer||!policy.feePayers.includes(feePayer)||policy.network!=='hedera:testnet'||evidence.source!=='testnet'||evidence.network!==policy.network||evidence.asset!==policy.asset||evidence.payer!==policy.payerAccountId||evidence.payTo!==policy.payTo||!evidence.signedDigest||!/^[a-f0-9]{64}$/.test(evidence.signedDigest))return unavailable();
  try{
   const amount=integer(evidence.amountAtomic);if(amount<=0n||amount>9223372036854775807n)return unavailable();
   const url=endpoint(policy.mirrorNodeUrl,`/api/v1/transactions/${id}`);
   const body=await readJson(url,fetcher,credentials(policy.credentialRef,'mirror'));
   if(!object(body)||!Array.isArray(body.transactions)||body.transactions.length!==1)return unavailable();
   const tx=body.transactions[0];
   if(!object(tx)||tx.transaction_id!==id||tx.name!=='CRYPTOTRANSFER'||tx.result!=='SUCCESS'||tx.scheduled!==false||tx.nonce!==0||typeof tx.consensus_timestamp!=='string'||!/^\d+\.[0-9]{9}$/.test(tx.consensus_timestamp)||!['nft_transfers','staking_reward_transfers'].every(k=>Array.isArray(tx[k])&&tx[k].length===0))return unavailable();
   // Native HBAR Mirror records can omit assessed_custom_fees. Exact HBAR
   // and network-fee conservation below still proves every transfer. HTS
   // remains fail-closed when custom-fee information is absent.
   if(!(policy.asset==='0.0.0'&&!Object.hasOwn(tx,'assessed_custom_fees'))&&!(Array.isArray(tx.assessed_custom_fees)&&tx.assessed_custom_fees.length===0))return unavailable();
   let net:Map<string,bigint>;
   if(policy.asset!=='0.0.0'){
    if(!Array.isArray(tx.token_transfers)||tx.token_transfers.some(r=>!object(r)||r.token_id!==policy.asset))return unavailable();
    net=aggregate(tx.token_transfers);
   }else{
    if(!Array.isArray(tx.token_transfers)||tx.token_transfers.length||feePayer===policy.payerAccountId||feePayer===policy.payTo)return unavailable();
    net=aggregate(tx.transfers);const fee=integer(tx.charged_tx_fee);
    const collectors=new Set([tx.node,'0.0.98','0.0.800','0.0.801','0.0.802']);
    if(typeof tx.node!=='string'||!/^0\.0\.[1-9][0-9]*$/.test(tx.node)||collectors.has(policy.payerAccountId)||collectors.has(policy.payTo)||collectors.has(feePayer)||fee<0n||net.get(feePayer)!==-fee)return unavailable();
    net.delete(feePayer);let distributed=0n;
    for(const account of collectors){const value=net.get(account)??0n;if(value<0n)return unavailable();distributed+=value;net.delete(account);}
    if(distributed!==fee)return unavailable();
   }
   if(net.size!==2||net.get(policy.payerAccountId)!==-amount||net.get(policy.payTo)!==amount)return unavailable();
   return {verified:true,evidence:{...evidence,verificationUrl:url,verifiedAt:new Date().toISOString(),consensusTimestamp:tx.consensus_timestamp}};
  }catch{return unavailable();}
 };
}
export const createRecoveryVerifier=(fetcher:ReadFetcher):RecoveryVerifier=>async(evidence,response,context)=>{
 if(!context.quote||context.quote.network!==evidence.network||context.quote.asset!==evidence.asset||context.quote.amount!==evidence.amountAtomic||context.quote.payTo!==evidence.payTo||context.quote.extra?.feePayer!==evidence.transactionId?.split('@')[0])return unavailable();
 return createVerifier(context.policy,fetcher)(evidence,response);
};
export function boundedVerifier(policy:Policy,fetcher:ReadFetcher,delay=wait):Ports['verify']{
 const verify=createVerifier(policy,fetcher);
 return async(evidence,response)=>{let result:Verification=unavailable();for(let i=0;i<3;i++){result=await verify(evidence,response);if(result.verified||result.reason==='SETTLEMENT_CONFLICT')return result;if(i<2)await delay(2000);}return result;};
}
