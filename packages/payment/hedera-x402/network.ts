import type {Policy,Ports} from './types.ts';
import {credentials,endpoint,integer,object,readTwice,type ReadFetcher} from './read-only.ts';
export function createNetworkCheck(policy:Policy,fetcher:ReadFetcher,options?:{payerReserveAtomic:string}):Ports['checkNetwork']{
 return async selection=>{
  const q=selection.requirements;
  if(policy.network!=='hedera:testnet'||q.network!==policy.network||q.asset!==policy.asset||q.payTo!==policy.payTo||q.scheme!=='exact'||!policy.feePayers.includes(String(q.extra?.feePayer)))throw Error('CONFIG_INCOMPLETE');
  const get=(service:'facilitator'|'mirror',path:string)=>readTwice(endpoint(service==='facilitator'?policy.facilitatorUrl:policy.mirrorNodeUrl,path),fetcher,credentials(policy.credentialRef,service));
  const supported=await get('facilitator','/supported');
  if(!object(supported)||!Array.isArray(supported.kinds)||!supported.kinds.some(k=>object(k)&&k.x402Version===2&&k.network===policy.network&&k.scheme==='exact'&&object(k.extra)&&k.extra.feePayer===q.extra?.feePayer))throw Error('NETWORK_CHECK_FAILED');
  if(policy.asset!=='0.0.0'){
   const token=await get('mirror',`/api/v1/tokens/${policy.asset}`);
   if(!object(token)||token.token_id!==policy.asset||token.deleted!==false||token.type!=='FUNGIBLE_COMMON'||integer(token.decimals)!==BigInt(policy.assetDecimals)||!object(token.custom_fees)||!['fixed_fees','fractional_fees','royalty_fees'].every(k=>token.custom_fees[k]===undefined||(Array.isArray(token.custom_fees[k])&&token.custom_fees[k].length===0)))throw Error('NETWORK_CHECK_FAILED');
  }
  for(const id of [policy.payerAccountId,policy.payTo]){
   const account=await get('mirror',`/api/v1/accounts/${id}`);
   if(!object(account)||account.account!==id||account.deleted!==false||(id===policy.payTo&&account.receiver_sig_required!==false)||!object(account.balance))throw Error('NETWORK_CHECK_FAILED');
   let balance=integer(account.balance.balance);
   if(policy.asset!=='0.0.0'){
    const related=await get('mirror',`/api/v1/accounts/${id}/tokens?token.id=${policy.asset}`);
    if(!object(related)||!Array.isArray(related.tokens)||related.tokens.length!==1||!object(related.tokens[0]))throw Error('NETWORK_CHECK_FAILED');
    const token=related.tokens[0];
    if(token.token_id!==policy.asset||!['UNFROZEN','NOT_APPLICABLE'].includes(token.freeze_status)||!['GRANTED','NOT_APPLICABLE'].includes(token.kyc_status))throw Error('NETWORK_CHECK_FAILED');
    balance=integer(token.balance);
   }
   const requiredPayerBalance=integer(q.amount)+(options?.payerReserveAtomic===undefined?0n:integer(options.payerReserveAtomic));
   if(balance<0n||(id===policy.payerAccountId&&balance<requiredPayerBalance))throw Error('NETWORK_CHECK_FAILED');
  }
 };
}
