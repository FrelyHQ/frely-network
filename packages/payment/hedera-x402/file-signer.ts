import type {Policy} from './types.ts';
import {readAgentKey} from './key-file.ts';
import {credentials,endpoint,object,readTwice,type ReadFetcher} from './read-only.ts';

export function createFileKeyResolver(policy:Policy,fetcher:ReadFetcher){
 return async(ref:string):Promise<string>=>{
  if(ref!==policy.signerRef||policy.network!=='hedera:testnet'||policy.keyType!=='ecdsa')throw Error('CONFIG_INCOMPLETE');
  const key=await readAgentKey(ref);
  const account=await readTwice(endpoint(policy.mirrorNodeUrl,'/api/v1/accounts/'+policy.payerAccountId),fetcher,credentials(policy.credentialRef,'mirror'));
  if(!object(account)||typeof account.account!=='string'||typeof account.deleted!=='boolean'||!('key' in account))throw Error('NETWORK_CHECK_FAILED');
  if(account.account!==policy.payerAccountId||account.deleted||account.key===null)throw Error('SIGNER_MISMATCH');
  if(!object(account.key)||typeof account.key._type!=='string')throw Error('NETWORK_CHECK_FAILED');
  if(account.key._type!=='ECDSA_SECP256K1')throw Error('SIGNER_MISMATCH');
  if(typeof account.key.key!=='string'||!/^(02|03)[0-9a-fA-F]{64}$/.test(account.key.key))throw Error('NETWORK_CHECK_FAILED');
  if(account.key.key.toLowerCase()!==key.publicKey.toStringRaw().toLowerCase())throw Error('SIGNER_MISMATCH');
  return key.toStringRaw();
 };
}
