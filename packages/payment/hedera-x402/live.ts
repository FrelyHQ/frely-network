import type {Policy,Journal,Ports} from './types.ts';
import {createNetworkCheck} from './network.ts';
import {createSdkSigner} from './signer.ts';
import {boundedVerifier} from './verifier.ts';
import {loadPaymentConfig,resolveSigningKey} from './config.ts';
export function createLivePorts(policy:Policy,journal:Journal,parseService:Ports['parseService']):Ports{
 const approved=loadPaymentConfig(policy);
 if(!approved.enabled)throw Error('CONFIG_INCOMPLETE');
 return {source:'testnet',journal,parseService,now:Date.now,fetcher:request=>fetch(request),sign:createSdkSigner(approved,resolveSigningKey),checkNetwork:createNetworkCheck(approved,request=>fetch(request)),verify:boundedVerifier(approved,request=>fetch(request))};
}
