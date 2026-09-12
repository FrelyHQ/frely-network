import {afterEach,expect,test} from 'bun:test';
import {mkdir,mkdtemp,writeFile,rm,symlink,readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {captureDigest,openJournal,recoveryPolicy,loadApprovedPaymentConfig} from '@frely-network/hedera-x402';
import type {Policy} from '@frely-network/hedera-x402';
import {evaluatePreflight,outcomeExitCode} from './index.ts';
import valid from './fixtures/synthetic/valid.json';
import raw from './fixtures/synthetic/policy.json';
const dirs:string[]=[];
afterEach(async()=>{await Promise.all(dirs.splice(0).map(d=>rm(d,{recursive:true,force:true})));});
async function setup(){
 const base=join(import.meta.dir,'../../.local/v4-tests');await mkdir(base,{recursive:true});const dir=await mkdtemp(join(base,'cli-'));dirs.push(dir);
 const input={...structuredClone(valid),capture:{...valid.capture,source:'W-approved-capture'}};
 const policy={...raw,enabled:false,journalPath:join(dir,'journal','payments.sqlite')};
 const registry={version:1 as const,configPaths:[join(dir,'policy.json')],journalPaths:[policy.journalPath],captureSha256:[captureDigest(input.capture)]};
 await writeFile(join(dir,'policy.json'),JSON.stringify(policy));await writeFile(join(dir,'registry.json'),JSON.stringify(registry));await writeFile(join(dir,'input.json'),JSON.stringify(input));
 // This process-only preload substitutes every network call. No socket is opened.
 await writeFile(join(dir,'mock.ts'),`import {appendFileSync} from 'node:fs';
const env=process.env;process.env=new Proxy(env,{get(t,k){if(k==='PAYMENT_TEST_KEY'){appendFileSync(${JSON.stringify(join(dir,'secret-read'))},'read');throw Error('KEY_READ_FORBIDDEN');}return Reflect.get(t,k);}});
globalThis.fetch=async request=>{appendFileSync(${JSON.stringify(join(dir,'calls'))},request.url+'\\n');if(process.env.TEST_TIMEOUT==='yes')return new Promise(()=>{});const u=new URL(request.url);if(u.hostname==='fixture.invalid')throw Error('BUSINESS_FORBIDDEN');if(u.pathname==='/supported')return Response.json({kinds:[{x402Version:2,scheme:'exact',network:'hedera:testnet',extra:{feePayer:'0.0.1235'}}]});if(u.pathname.startsWith('/api/v1/accounts/'))return Response.json({account:u.pathname.split('/').pop(),deleted:false,balance:{balance:'200000000'},receiver_sig_required:false});throw Error('QUERY_FORBIDDEN');};`);
 return {dir,input,policy,registry};
}
async function child(dir:string,mode:string,extra:Record<string,string>={}){
 const proc=Bun.spawn([process.execPath,'--preload',join(dir,'mock.ts'),join(import.meta.dir,'index.ts'),'--mode',mode,'--input',join(dir,'input.json')],{env:{FRELY_PAYMENT_REGISTRY:join(dir,'registry.json'),...extra},stdout:'pipe',stderr:'pipe'});
 const [code,out,err]=await Promise.all([proc.exited,new Response(proc.stdout).text(),new Response(proc.stderr).text()]);expect(err).toBe('');return {code,result:JSON.parse(out)};
}
test('preflight child only queries read-only routes, does not read key or create journal',async()=>{
 const {dir,policy}=await setup();const result=await child(dir,'preflight');expect(result.code).toBe(0);expect(result.result).toMatchObject({mode:'preflight',decision:'prepared',paymentStatus:'not_paid'});
 expect(await Bun.file(join(dir,'secret-read')).exists()).toBe(false);expect(await Bun.file(policy.journalPath).exists()).toBe(false);expect((await readFile(join(dir,'calls'),'utf8')).trim().split('\n')).toHaveLength(3);
});
test('preflight child absent approval exits 2; timeout exits 3 after two bounded attempts',async()=>{
 const {dir}=await setup();expect((await child(dir,'preflight',{FRELY_PAYMENT_REGISTRY:''})).code).toBe(2);
 const result=await child(dir,'preflight',{TEST_TIMEOUT:'yes'});expect(result.code).toBe(3);expect(result.result.reason).toBe('NETWORK_CHECK_FAILED');expect((await readFile(join(dir,'calls'),'utf8')).trim().split('\n')).toHaveLength(2);
},30000);
test('recover child uses journal only, settled without output takes exit 4',async()=>{
 const {dir,policy}=await setup();const journal=openJournal(policy.journalPath);journal.admit('stored','fingerprint',recoveryPolicy(policy as Policy));
 const evidence={source:'testnet' as const,transactionId:'0.0.1235@1700000000.000000001',signedDigest:'a'.repeat(64)};
 journal.update('stored',{phase:'finished',dispatched:true,evidence,outcome:{requestId:'stored',decision:'completed',paymentStatus:'settled',serviceStatus:'unknown',reason:'OUTPUT_UNAVAILABLE',retryAction:'none',evidence,output:null}});journal.close();
 await rm(join(dir,'policy.json'));await writeFile(join(dir,'input.json'),JSON.stringify({requestId:'stored',journalPath:policy.journalPath}));const result=await child(dir,'recover');expect(result.code).toBe(4);expect(result.result.paymentStatus).toBe('settled');expect(await Bun.file(join(dir,'calls')).exists()).toBe(false);
 await writeFile(join(dir,'input.json'),JSON.stringify({requestId:'absent',journalPath:policy.journalPath}));expect((await child(dir,'recover')).result.reason).toBe('REQUEST_NOT_FOUND');
 const reopened=openJournal(policy.journalPath);expect(reopened.read('absent')).toBeNull();reopened.close();
});
test('intermediate config symlink cannot escape input directory in offline or preflight',async()=>{
 const {dir,input}=await setup();const outside=join(dir,'outside');await mkdir(outside);await writeFile(join(outside,'policy.json'),JSON.stringify(raw));const nested=join(dir,'inputdir');await mkdir(nested);await symlink(outside,join(nested,'link'));
 await writeFile(join(dir,'input.json'),JSON.stringify({...input,configRef:'inputdir/link/policy.json'}));
 expect((await child(dir,'offline')).result.reason).toBe('CONFIG_INCOMPLETE');expect((await child(dir,'preflight')).result.reason).toBe('CONFIG_INCOMPLETE');
});
test('preflight rejects unapproved capture before HTTP and preserves approved files',async()=>{
 const {dir,input,policy,registry}=await setup();const before=await stat(join(dir,'registry.json'));let calls=0;
 const result=await evaluatePreflight({...input,capture:{...input.capture,url:'https://other.invalid'}},policy,registry,async()=>{calls++;throw Error();});expect(result.reason).toBe('CAPTURE_INVALID');expect(calls).toBe(0);expect((await stat(join(dir,'registry.json'))).mtimeMs).toBe(before.mtimeMs);
});
test('shared startup loader requires separately approved journal destination',async()=>{
 const {dir,registry}=await setup();const old=process.env.FRELY_PAYMENT_REGISTRY;
 try{process.env.FRELY_PAYMENT_REGISTRY=join(dir,'registry.json');expect((await loadApprovedPaymentConfig(join(dir,'policy.json'))).enabled).toBe(false);await writeFile(join(dir,'policy.json'),JSON.stringify({...raw,enabled:true,journalPath:join(dir,'journal','payments.sqlite')}));await writeFile(join(dir,'registry.json'),JSON.stringify({...registry,journalPaths:[]}));await expect(loadApprovedPaymentConfig(join(dir,'policy.json'))).rejects.toThrow('CONFIG_INCOMPLETE');}finally{if(old===undefined)delete process.env.FRELY_PAYMENT_REGISTRY;else process.env.FRELY_PAYMENT_REGISTRY=old;}
});
test('unreadable recovery input retains mode and does not claim unpaid history',async()=>{
 const {dir}=await setup();await writeFile(join(dir,'input.json'),'invalid');const result=await child(dir,'recover');expect(result.code).toBe(2);expect(result.result).toMatchObject({mode:'recover',paymentStatus:'unknown',reason:'INPUT_INVALID'});
});
