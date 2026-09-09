#!/usr/bin/env bun
import {initWallet, type Options, type Outcome, type Progress} from '@frely-network/agent-wallet';
import {realpath,stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname,join} from 'node:path';
import {parseArgs} from 'node:util';
import {createInterface} from 'node:readline/promises';

export type CliIO={
 isTTY:boolean;
 ask(prompt:string):Promise<string>;
 stdout(text:string):void;
 stderr(text:string):void;
};

const HELP=`Usage: agent wallet init --network hedera:testnet [options]

Options:
  --wallet-dir <absolute path>  Wallet directory (default: ~/.frely/wallets/hedera-testnet/default)
  --max-fee-hbar <amount>       Maximum one-time activation fee
  --reserve-hbar <amount>       Minimum HBAR balance to retain
  --format <human|json>         Output format (default: human)
  --help                        Show this help

Recovery may omit both amount options; saved limits remain authoritative.`;

const KNOWN_ERRORS=new Set([
 'INPUT_INVALID','INIT_CONFIG_CONFLICT','INIT_IN_PROGRESS','SIGNER_UNAVAILABLE',
 'WALLET_STATE_INVALID','NETWORK_CHECK_FAILED','ACCOUNT_KEY_MISMATCH',
 'ACTIVATION_INVALID','ACTIVATION_CONFLICT','ACTIVATION_REJECTED',
 'INSUFFICIENT_FUNDS','INSUFFICIENT_RESERVE','ACTIVATION_UNKNOWN','INIT_FAILED',
]);

function hbarToTinybar(input:string):string{
 const match=/^(0|[1-9][0-9]*)(?:\.([0-9]{1,8}))?$/.exec(input);
 if(!match)throw Error('INPUT_INVALID');
 const value=BigInt(match[1]!)*100_000_000n+BigInt((match[2]??'').padEnd(8,'0'));
 if(value<=0n||value>9_223_372_036_854_775_807n)throw Error('INPUT_INVALID');
 return value.toString();
}

function requestedJson(args:string[]):boolean{
 return args.some((arg,index)=>arg==='--format'&&args[index+1]==='json'||arg==='--format=json');
}

function rejectDuplicateOptions(args:string[]):void{
 const seen=new Set<string>();
 for(const arg of args){
  const match=/^--(network|wallet-dir|max-fee-hbar|reserve-hbar|format|help)(?:=|$)/.exec(arg);
  if(match&&seen.has(match[1]!))throw Error('INPUT_INVALID');
  if(match)seen.add(match[1]!);
 }
}

async function exists(path:string):Promise<boolean>{
 try{return (await stat(path)).isFile();}
 catch{return false;}
}

function recoveryCommand(walletDir:string):string{
 return `bun run agent wallet init --network hedera:testnet --wallet-dir '${walletDir.replaceAll("'", "'\\''")}'`;
}

function humanProgress(event:Progress):string{
 if(event.kind==='phase')return `Phase: ${event.phase}\nWallet: ${event.walletPath}\n`;
 return [
  'Agent wallet funding checkpoint',
  `Wallet: ${event.walletPath}`,
  `Network: Hedera Testnet`,
  `Address: ${event.evmAddress}`,
  `Current balance: ${event.balanceTinybar} tinybar`,
  `Minimum required: ${event.requiredTinybar} tinybar`,
  `Funding deficit: ${event.deficitTinybar} tinybar`,
  `Activation fee limit: ${event.limits.maxFeeTinybar} tinybar (a limit, not an estimate)`,
  `Required reserve: ${event.limits.reserveTinybar} tinybar`,
  'The local key was generated and read back successfully. After funding, initialization updates this account memo and verifies the result.',
  'Send only Testnet HBAR to this address. Back up the local key; the sender pays its own transfer and auto-creation costs.',
  `Resume: ${recoveryCommand(dirname(event.walletPath))}`,
 ].join('\n')+'\n';
}

function emitResult(outcome:Outcome,format:'human'|'json',io:CliIO):void{
 const safeOutcome={...outcome,reason:outcome.reason===null?null:KNOWN_ERRORS.has(outcome.reason)?outcome.reason:'INIT_FAILED'};
 if(format==='json'){
  io.stdout(JSON.stringify({type:'result',...safeOutcome})+'\n');
  return;
 }
 if(safeOutcome.status==='ready'){
  io.stdout(`Wallet ready: ${safeOutcome.walletPath}\n${JSON.stringify(safeOutcome.paymentIdentity,null,2)}\n`);
 }else{
  io.stderr(`${safeOutcome.reason??safeOutcome.status}\nResume: ${recoveryCommand(dirname(safeOutcome.walletPath))}\n`);
 }
}

function emitError(reason:string,format:'human'|'json',walletDir:string,io:CliIO):void{
 const safe=KNOWN_ERRORS.has(reason)?reason:'INIT_FAILED';
 const command=recoveryCommand(walletDir);
 if(format==='json')io.stdout(JSON.stringify({type:'result',status:'blocked',exitCode:2,reason:safe,recoveryCommand:command})+'\n');
 else io.stderr(`${safe}\nResume: ${command}\n`);
}

export async function main(args:string[],io:CliIO):Promise<number>{
 let format:'human'|'json'=requestedJson(args)?'json':'human';
 let walletDir=join(homedir(),'.frely','wallets','hedera-testnet','default');
 try{
  rejectDuplicateOptions(args);
  const parsed=parseArgs({args,allowPositionals:true,strict:true,options:{
   network:{type:'string'},'wallet-dir':{type:'string'},'max-fee-hbar':{type:'string'},
   'reserve-hbar':{type:'string'},format:{type:'string'},help:{type:'boolean'},
  }});
  if(parsed.values.help){io.stdout(HELP+'\n');return 0;}
  if(parsed.positionals.length!==2||parsed.positionals[0]!=='wallet'||parsed.positionals[1]!=='init')throw Error('INPUT_INVALID');
  walletDir=parsed.values['wallet-dir']??join(await realpath(homedir()),'.frely','wallets','hedera-testnet','default');
  if(parsed.values.network!=='hedera:testnet')throw Error('INPUT_INVALID');
  if(parsed.values.format!==undefined&&parsed.values.format!=='human'&&parsed.values.format!=='json')throw Error('INPUT_INVALID');
  format=(parsed.values.format??'human') as 'human'|'json';
  let maxFee=parsed.values['max-fee-hbar'];
  let reserve=parsed.values['reserve-hbar'];
  const recovering=await exists(join(walletDir,'init-state.json'));
  if(!recovering&&(maxFee===undefined||reserve===undefined)){
   if(!io.isTTY)throw Error('INPUT_INVALID');
   maxFee=maxFee??await io.ask('Maximum activation fee in HBAR: ');
   reserve=reserve??await io.ask('Required reserve in HBAR: ');
  }
  if(recovering&&((maxFee===undefined)!==(reserve===undefined))){
   if(!io.isTTY)throw Error('INPUT_INVALID');
   maxFee=maxFee??await io.ask('Maximum activation fee in HBAR: ');
   reserve=reserve??await io.ask('Required reserve in HBAR: ');
  }
  const limits=maxFee===undefined&&reserve===undefined?undefined:{
   maxFeeTinybar:hbarToTinybar(maxFee!),reserveTinybar:hbarToTinybar(reserve!),
  };
  if(limits&&BigInt(limits.maxFeeTinybar)+BigInt(limits.reserveTinybar)>9_223_372_036_854_775_807n)throw Error('INPUT_INVALID');
  const options:Options={network:'hedera:testnet',walletDir,...(limits?{limits}:{})};
  const outcome=await initWallet(options,{progress:event=>{
   if(format==='json')io.stdout(JSON.stringify({type:'progress',...event})+'\n');
   else io.stdout(humanProgress(event));
  }});
  emitResult(outcome,format,io);
  return outcome.exitCode;
 }catch(error){
  emitError(error instanceof Error?error.message:'INIT_FAILED',format,walletDir,io);
  return 2;
 }
}

if(import.meta.main){
 const readline=createInterface({input:process.stdin,output:process.stderr});
 const code=await main(process.argv.slice(2),{
  isTTY:Boolean(process.stdin.isTTY&&process.stderr.isTTY),
  ask:prompt=>readline.question(prompt),
  stdout:text=>process.stdout.write(text),stderr:text=>process.stderr.write(text),
 });
 readline.close();
 process.exitCode=code;
}
