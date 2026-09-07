import JSONbig from 'json-bigint';
export type ReadFetcher = (request: Request) => Promise<Response>;
export type CredentialService = 'facilitator' | 'mirror';
export const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
export function integer(v: unknown): bigint {
 if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v);
 if (typeof v === 'string' && /^-?(0|[1-9][0-9]*)$/.test(v) && v.length <= 129) return BigInt(v);
 throw Error('NETWORK_CHECK_FAILED');
}
export const wait = (ms:number) => new Promise<void>(resolve=>setTimeout(resolve,ms));
// Operator environment only; values are per-service environment references, never
// Provider request headers. Absence means the selected service is public.
export function credentials(ref:string, service:CredentialService): HeadersInit {
 try {
  const configured:unknown = JSON.parse(process.env.FRELY_PAYMENT_CREDENTIALS ?? '{}');
  if (!object(configured)) throw Error();
  const entry = configured[ref];
  if (entry === undefined) return {};
  if (!object(entry)) throw Error();
  const envRef=entry[service];
  if (envRef === undefined) return {};
  if (typeof envRef !== 'string' || !/^env:[A-Z_][A-Z0-9_]*$/.test(envRef)) throw Error();
  const value=process.env[envRef.slice(4)];if(!value)throw Error();
  return {Authorization:value};
 } catch { throw Error('CONFIG_INCOMPLETE'); }
}
export function endpoint(base:string,path:string):string {
 const url = new URL(base);
 if(url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw Error('CONFIG_INCOMPLETE');
 return base.replace(/\/$/,'')+path;
}
export async function readJson(url:string, fetcher:ReadFetcher, headers:HeadersInit={}):Promise<unknown> {
 const controller=new AbortController();
 let timer:ReturnType<typeof setTimeout>;
 const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('NETWORK_CHECK_FAILED'));},10000);});
 const work=async()=>{
  const response=await fetcher(new Request(url,{method:'GET',redirect:'error',headers,signal:controller.signal}));
  if(!response.ok) {void response.body?.cancel();throw Error('NETWORK_CHECK_FAILED');}
  const length=response.headers.get('content-length');
  if(length && (!/^\d+$/.test(length)||Number(length)>1048576)) {void response.body?.cancel();throw Error('NETWORK_CHECK_FAILED');}
  if(!response.body)throw Error('NETWORK_CHECK_FAILED');
  const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
  try {while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>1048576)throw Error('NETWORK_CHECK_FAILED');chunks.push(value);}}
  finally {void reader.cancel();}
  const bytes=Buffer.concat(chunks);return JSONbig({storeAsString:true,strict:true,protoAction:'error',constructorAction:'error'}).parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as unknown;
 };
 try {return await Promise.race([work(),timeout]);}catch{throw Error('NETWORK_CHECK_FAILED');}finally{clearTimeout(timer!);controller.abort();}
}
export async function readTwice(url:string,fetcher:ReadFetcher,headers:HeadersInit,delay=wait):Promise<unknown>{
 for(let i=0;i<2;i++){try{return await readJson(url,fetcher,headers);}catch{if(i===1)throw Error('NETWORK_CHECK_FAILED');await delay(1000);}}
 throw Error('NETWORK_CHECK_FAILED');
}
