import {expect,test} from 'bun:test';
import {loadPaymentConfig} from './config.ts';
import {createLivePorts} from './live.ts';
import raw from '../../../scripts/payment-spike/fixtures/synthetic/policy.json';
import type {Journal,Policy} from './types.ts';
import {loadApprovedPaymentConfig} from './approval.ts';
import {mkdtempSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('explicit fields are mandatory, no default asset/account/key type or secret values',()=>{
 for(const change of [{keyType:undefined},{signerRef:'raw-key'},{network:'hedera:mainnet'},{privateKey:'never-display'},{assetDecimals:7,asset:'0.0.0'}])expect(()=>loadPaymentConfig({...raw,...change})).toThrow('CONFIG_INCOMPLETE');
 const {enabled,...disabled}=raw;
 expect(loadPaymentConfig(disabled).enabled).toBe(false);
 expect(()=>loadPaymentConfig({})).toThrow('CONFIG_INCOMPLETE');
 expect(()=>createLivePorts({...raw,enabled:false} as Policy,{} as Journal,async()=>null)).toThrow('CONFIG_INCOMPLETE');
});
test('live composition fixes source and defers key/environment reads until sign',()=>{
 const ports=createLivePorts(raw as Policy,{} as Journal,async()=>null);
 expect(ports.source).toBe('testnet');
 expect(typeof ports.sign).toBe('function');
});
test('approved disabled config does not require an approved journal destination',async()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'frely-disabled-')));const configPath=join(dir,'config.json');const registryPath=join(dir,'registry.json');
 writeFileSync(configPath,JSON.stringify({...raw,enabled:false,journalPath:join(dir,'must-not-open.sqlite')}));
 writeFileSync(registryPath,JSON.stringify({version:1,configPaths:[configPath],journalPaths:[],captureSha256:[]}));
 const before=process.env.FRELY_PAYMENT_REGISTRY;process.env.FRELY_PAYMENT_REGISTRY=registryPath;
 try{expect((await loadApprovedPaymentConfig(configPath)).enabled).toBe(false);}
 finally{if(before===undefined)delete process.env.FRELY_PAYMENT_REGISTRY;else process.env.FRELY_PAYMENT_REGISTRY=before;rmSync(dir,{recursive:true,force:true});}
});
