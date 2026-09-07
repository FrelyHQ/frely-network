import {expect,test} from 'bun:test';
import {readJson,readTwice,credentials} from './read-only.ts';
test('safe JSON keeps integers losslessly and rejects hostile or oversized bodies',async()=>{
 expect(await readJson('https://mirror.invalid',async()=>new Response('{"amount":9007199254740993}'))).toEqual({amount:'9007199254740993'});
 for(const body of ['{"amount":1,"amount":2}','{"__proto__":{}}','not json',' '.repeat(1048577)])await expect(readJson('https://mirror.invalid',async()=>new Response(body))).rejects.toThrow('NETWORK_CHECK_FAILED');
 for(const status of [302,429,500])await expect(readJson('https://mirror.invalid',async()=>new Response('remote-secret',{status}))).rejects.toThrow('NETWORK_CHECK_FAILED');
});
test('read-only attempts are at most two with a one-second interval',async()=>{
 let calls=0;const delays:number[]=[];
 await expect(readTwice('https://mirror.invalid',async()=>{calls++;return new Response('secret',{status:503});},{},async ms=>{delays.push(ms);})).rejects.toThrow('NETWORK_CHECK_FAILED');
 expect(calls).toBe(2);expect(delays).toEqual([1000]);
});
test('credential references select only their own service',()=>{
 const old=process.env.FRELY_PAYMENT_CREDENTIALS;const a=process.env.V4_FACILITATOR_AUTH;const b=process.env.V4_MIRROR_AUTH;
 try {process.env.FRELY_PAYMENT_CREDENTIALS=JSON.stringify({service:{facilitator:'env:V4_FACILITATOR_AUTH',mirror:'env:V4_MIRROR_AUTH'}});process.env.V4_FACILITATOR_AUTH='Bearer fixture-f';process.env.V4_MIRROR_AUTH='Bearer fixture-m';expect(credentials('service','mirror')).toEqual({Authorization:'Bearer fixture-m'});expect(credentials('service','facilitator')).toEqual({Authorization:'Bearer fixture-f'});expect(credentials('absent','mirror')).toEqual({});}
 finally{for(const [name,value] of [['FRELY_PAYMENT_CREDENTIALS',old],['V4_FACILITATOR_AUTH',a],['V4_MIRROR_AUTH',b]]){if(value===undefined)delete process.env[name!];else process.env[name!]=value;}}
});
