import {constants} from "node:fs";
import {open} from "node:fs/promises";
import {loadPaymentConfig} from "./config.ts";
import {lstat,realpath} from 'node:fs/promises';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {createHash} from 'node:crypto';
export type Registry={version:1;configPaths:string[];journalPaths:string[];captureSha256:string[]};
export function parseRegistry(value:unknown):Registry{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('CONFIG_INCOMPLETE');
 const r=value as Registry;
 if(r.version!==1||!Object.keys(r).every(k=>['version','configPaths','journalPaths','captureSha256'].includes(k))||!Array.isArray(r.configPaths)||!Array.isArray(r.journalPaths)||!Array.isArray(r.captureSha256)||![...r.configPaths,...r.journalPaths].every(p=>typeof p==='string'&&isAbsolute(p)&&resolve(p)===p)||!r.captureSha256.every(h=>typeof h==='string'&&/^[a-f0-9]{64}$/.test(h)))throw Error('CONFIG_INCOMPLETE');
 return r;
}
export async function containedConfig(directory:string,reference:string):Promise<string>{
 if(!reference||isAbsolute(reference))throw Error('CONFIG_INCOMPLETE');
 const base=await realpath(directory);const target=resolve(base,reference);const rel=relative(base,target);
 if(!rel||rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))throw Error('CONFIG_INCOMPLETE');
 let current=base;
 for(const component of rel.split(sep)){current=join(current,component);if((await lstat(current)).isSymbolicLink())throw Error('CONFIG_INCOMPLETE');}
 if(await realpath(target)!==target)throw Error('CONFIG_INCOMPLETE');
 return target;
}
// Fixed field-order canonicalization avoids dependence on JSON whitespace/key order.
export function captureDigest(capture:Record<string,unknown>):string{
 return createHash('sha256').update(JSON.stringify([capture.source,capture.capturedAt,capture.method,capture.url,capture.bodySha256,capture.status,capture.paymentRequiredHeader])).digest('hex');
}
export async function authorizedExistingPath(path:string,approved:string[]):Promise<string>{
 if(!isAbsolute(path)||!approved.includes(path)||resolve(path)!==path||(await realpath(path))!==path||(await lstat(path)).isSymbolicLink())throw Error('CONFIG_INCOMPLETE');
 return path;
}

export async function readBoundedJson(path: string): Promise<unknown> {
 const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const file=await handle.stat();if(!file.isFile())throw Error("INPUT_INVALID");if(file.size>1048576)throw Error("INPUT_TOO_LARGE");
  const buffer=Buffer.alloc(file.size+1);let offset=0;
  while(offset<buffer.byteLength){const {bytesRead}=await handle.read(buffer,offset,buffer.byteLength-offset,offset);if(!bytesRead)break;offset+=bytesRead;}
  if(offset!==file.size)throw Error(offset>1048576?"INPUT_TOO_LARGE":"INPUT_INVALID");
  return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(buffer.subarray(0,offset))) as unknown;
 }finally{await handle.close();}
}
export async function readPaymentRegistry():Promise<Registry>{
 try{const path=process.env.FRELY_PAYMENT_REGISTRY;if(!path||!isAbsolute(path))throw Error();return parseRegistry(await readBoundedJson(path));}catch{throw Error("CONFIG_INCOMPLETE");}
}
export async function loadApprovedPaymentConfig(configPath:string){
 const registry=await readPaymentRegistry();
 const path=await authorizedExistingPath(configPath,registry.configPaths);
 const policy=loadPaymentConfig(await readBoundedJson(path));
 if(policy.enabled)await authorizedJournalDestination(policy.journalPath,registry.journalPaths);
 return policy;
}

export async function authorizedJournalDestination(path:string,approved:string[]):Promise<string>{
 if(!isAbsolute(path)||resolve(path)!==path||!approved.includes(path))throw Error("CONFIG_INCOMPLETE");
 let ancestor=path;
 while(true){
  try{const info=await lstat(ancestor);if(info.isSymbolicLink()||await realpath(ancestor)!==ancestor)throw Error("CONFIG_INCOMPLETE");return path;}
  catch(error){if(!(error&&typeof error==="object"&&"code" in error&&error.code==="ENOENT"))throw Error("CONFIG_INCOMPLETE");const parent=dirname(ancestor);if(parent===ancestor)throw Error("CONFIG_INCOMPLETE");ancestor=parent;}
 }
}
