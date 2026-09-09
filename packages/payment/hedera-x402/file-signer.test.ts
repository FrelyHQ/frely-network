import {expect,test} from 'bun:test';
import {mkdtemp,realpath,rm,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openLocalWallet} from '@frely-network/agent-wallet';
import {PrivateKey,Transaction} from '@x402/hedera';
import {createFileKeyResolver} from './file-signer.ts';
import {createSdkSigner} from './signer.ts';
import {createLivePorts} from './live.ts';
import {preflight} from './preflight.ts';
import {loadPaymentConfig} from './config.ts';
import {createPaymentSession} from './session.ts';
import {recoverPayment} from './recovery.ts';
import {withTestKey} from './key-file.test-support.ts';
import {createHarness} from './test-support.ts';
import type {Journal} from './types.ts';
import raw from '../../../scripts/payment-spike/fixtures/synthetic/policy.json';
import valid from '../../../scripts/payment-spike/fixtures/synthetic/valid.json';

test('binds the configured account and signs real SDK transaction bytes',async()=>{
 await withTestKey(async file=>{
  const policy=loadPaymentConfig({...raw,signerRef:file.ref,keyType:'ecdsa'});
  const check=preflight({policy,payment:valid.request.payment,http:valid.capture});
  if(check.decision!=='prepared')throw Error('TEST_PREFLIGHT_FAILED');
  let reads=0;
  const originalFetch=globalThis.fetch;
  globalThis.fetch=Object.assign(async (input: string | URL | Request)=>{
   reads++;
   const request=input instanceof Request?input:new Request(input);
   expect(request.url).toBe(policy.mirrorNodeUrl+'/api/v1/accounts/'+policy.payerAccountId);
   return Response.json({account:policy.payerAccountId,deleted:false,key:{_type:'ECDSA_SECP256K1',key:file.key.publicKey.toStringRaw()}});
  },{preconnect:originalFetch.preconnect});
  try{
   const ports=createLivePorts(policy,{} as Journal,async()=>null);
   expect(reads).toBe(0);
   const result=await ports.sign(check.selection);
   const encoded=result.payload.payload.transaction;
   if(typeof encoded!=='string')throw Error('TEST_PAYLOAD_INVALID');
   expect(file.key.publicKey.verifyTransaction(Transaction.fromBytes(Buffer.from(encoded,'base64')))).toBe(true);
   expect(JSON.stringify(result)).not.toContain(file.key.toStringRaw());
   expect(reads).toBe(1);
  }finally{globalThis.fetch=originalFetch;}
 });
});

test('signs offline with a wallet created by agent wallet init storage',async()=>{
 const walletDir=await mkdtemp(join(await realpath(tmpdir()),'frely-wallet-handoff-'));
 try{
  const store=await openLocalWallet({network:'hedera:testnet',walletDir,limits:{maxFeeTinybar:'10000000',reserveTinybar:'10000000'}});
  const wallet={...store.snapshot.wallet};
  const publicKey=(await store.readKey()).publicKey;
  store.close();
  const policy=loadPaymentConfig({...raw,signerRef:wallet.signerRef,keyType:wallet.keyType});
  const checked=preflight({policy,payment:valid.request.payment,http:valid.capture});
  if(checked.decision!=='prepared')throw Error('TEST_PREFLIGHT_FAILED');
  const resolve=createFileKeyResolver(policy,async()=>Response.json({
   account:policy.payerAccountId,deleted:false,
   key:{_type:'ECDSA_SECP256K1',key:wallet.publicKey},
  }));
  const result=await createSdkSigner(policy,resolve)(checked.selection);
  const encoded=result.payload.payload.transaction;
  if(typeof encoded!=='string')throw Error('TEST_PAYLOAD_INVALID');
  expect(publicKey.toStringRaw()).toBe(wallet.publicKey);
  expect(publicKey.verifyTransaction(Transaction.fromBytes(Buffer.from(encoded,'base64')))).toBe(true);
 }finally{await rm(walletDir,{recursive:true,force:true});}
});

test('rejects a mismatching account key with a fixed error',async()=>{
 await withTestKey(async file=>{
  const policy=loadPaymentConfig({...raw,signerRef:file.ref,keyType:'ecdsa'});
  const other=PrivateKey.generateECDSA();
  const resolver=createFileKeyResolver(policy,async()=>Response.json({account:policy.payerAccountId,deleted:false,key:{_type:'ECDSA_SECP256K1',key:other.publicKey.toStringRaw()}}));
  await expect(resolver(file.ref)).rejects.toThrow('SIGNER_MISMATCH');
 });
});

test('missing file stops before account lookup and preserves the session error',async()=>{
 await withTestKey(async file=>{
  const h=createHarness();
  try{
   const policy={...h.policy,signerRef:file.ref,keyType:'ecdsa' as const};
   let accountReads=0;
   const sign=createSdkSigner(policy,createFileKeyResolver(policy,async()=>{accountReads++;throw Error('ACCOUNT_READ_FORBIDDEN');}));
   await unlink(file.path);
   const result=await createPaymentSession(policy,{...h.ports,sign}).execute(h.request);
   expect(result.reason).toBe('SIGNER_UNAVAILABLE');
   expect(result.paymentStatus).toBe('not_paid');
   expect(accountReads).toBe(0);
   expect(h.journal.read(h.request.payment.requestId)?.policy).not.toHaveProperty('signerRef');
  }finally{h.close();}
 });
});

test('unknown payment recovery does not need the removed key or sign again',async()=>{
 await withTestKey(async file=>{
  const h=createHarness({fault:'dispatch_timeout'});
  try{
   const policy={...h.policy,signerRef:file.ref,keyType:'ecdsa' as const};
   await createPaymentSession(policy,h.ports).execute(h.request);
   await unlink(file.path);
   const before={...h.counts};
   const recovered=await recoverPayment({requestId:h.request.payment.requestId,journal:h.journal,verify:h.ports.verify});
   expect(recovered.paymentStatus).toBe('settled');
   expect(h.counts.sign).toBe(before.sign);
   expect(h.counts.http).toBe(before.http);
   expect(h.journal.read(h.request.payment.requestId)?.policy).not.toHaveProperty('signerRef');
  }finally{h.close();}
 });
});
