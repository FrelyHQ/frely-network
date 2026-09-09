import type {Policy,Journal,Ports} from './types.ts';
import {createNetworkCheck} from './network.ts';
import {createSdkSigner} from './signer.ts';
import {boundedVerifier} from './verifier.ts';
import {loadPaymentConfig,resolveSigningKey} from './config.ts';
import {createFileKeyResolver} from './file-signer.ts';
export function createLivePorts(policy:Policy,journal:Journal,parseService:Ports['parseService']):Ports{
 const approved=loadPaymentConfig(policy);
 if(!approved.enabled)throw Error('CONFIG_INCOMPLETE');
 const fetcher=(request:Request)=>fetch(request);
 const resolveKey=approved.signerRef.startsWith('file:')?createFileKeyResolver(approved,fetcher):resolveSigningKey;
 return {source:'testnet',journal,parseService,now:Date.now,fetcher,sign:createSdkSigner(approved,resolveKey),checkNetwork:createNetworkCheck(approved,fetcher),verify:boundedVerifier(approved,fetcher)};
}
