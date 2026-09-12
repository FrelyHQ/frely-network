import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { parseFrelyResponse } from "@frely-network/broker";
import { containedConfig, readPaymentRegistry, readBoundedJson, captureDigest, authorizedExistingPath, type Registry } from "@frely-network/hedera-x402";
import { loadPaymentConfig, loadApprovedPaymentConfig, createNetworkCheck, createLivePorts, createPaymentSession, openJournal, recordOutcome, recoverPayment, createRecoveryVerifier, preflight, validateCaptured402 } from "@frely-network/hedera-x402";
import type {
  Journal,
  PaymentEvidence,
  PaymentOutcome,
  Policy,
  PreparedRequest,
} from "@frely-network/hedera-x402";

const MAX_INPUT_BYTES = 1024 * 1024;
const REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;
const POLICY_KEYS = new Set([
  "enabled", "network", "asset", "assetDecimals", "amountAtomic", "payerAccountId", "payTo",
  "feePayers", "facilitatorUrl", "resourceUrl", "journalPath", "mirrorNodeUrl",
  "signerRef", "keyType", "credentialRef",
]);

type RecordValue = Record<string, unknown>;
type OfflineResult = PaymentOutcome & { mode: "offline" };
export type OfflineEffects = {
  businessRequest: (...args: never[]) => Promise<unknown>;
  networkRequest: (...args: never[]) => Promise<unknown>;
  sign: (...args: never[]) => Promise<unknown>;
};

const forbiddenOfflineEffects: OfflineEffects = {
  businessRequest: async () => { throw new Error("OFFLINE_EFFECT_FORBIDDEN"); },
  networkRequest: async () => { throw new Error("OFFLINE_EFFECT_FORBIDDEN"); },
  sign: async () => { throw new Error("OFFLINE_EFFECT_FORBIDDEN"); },
};

function record(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validRequestId(value: unknown): value is string {
  return typeof value === "string" && REQUEST_ID.test(value);
}

function requestIdOf(input: unknown): string | null {
  if (!record(input) || !record(input.request) || !record(input.request.payment)) return null;
  return validRequestId(input.request.payment.requestId)
    ? input.request.payment.requestId
    : null;
}

function blocked(reason: string, requestId: string | null, evidence: PaymentEvidence | null = null): OfflineResult {
  return {
    requestId,
    decision: "blocked",
    paymentStatus: "not_paid",
    serviceStatus: "not_started",
    reason,
    retryAction: "none",
    evidence,
    output: null,
    mode: "offline",
  };
}

function secureUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

function parseRequest(value: unknown): PreparedRequest | null {
  if (!record(value) || value.method !== "POST" || value.url !== "http://127.0.0.1:13600/v1/responses") return null;
  if (
    typeof value.body !== "string" ||
    !record(value.headers) ||
    !Object.values(value.headers).every((header) => typeof header === "string") ||
    typeof value.providerId !== "string" ||
    value.providerId.length === 0 ||
    value.providerId.length > 256 ||
    !record(value.payment)
  ) return null;
  return value as PreparedRequest;
}

function validCapturedAt(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function captureBound(input: RecordValue, request: PreparedRequest, source = "synthetic"): input is RecordValue & {
  capture: {
    source: "synthetic";
    capturedAt: string;
    method: "POST";
    url: string;
    bodySha256: string;
    status: 402;
    paymentRequiredHeader: string;
  };
} {
  if (!record(input.capture)) return false;
  const capture = input.capture;
  const bodySha256 = createHash("sha256").update(request.body, "utf8").digest("hex");
  return (
    capture.source === source &&
    validCapturedAt(capture.capturedAt) &&
    capture.method === request.method &&
    capture.url === request.url &&
    capture.bodySha256 === bodySha256 &&
    capture.status === 402 &&
    typeof capture.paymentRequiredHeader === "string"
  );
}

function policyDocument(value: unknown): value is Policy {
  return record(value) && Object.keys(value).every((key) => POLICY_KEYS.has(key));
}

export function evaluateOffline(
  input: unknown,
  policy: unknown,
  effects: OfflineEffects = forbiddenOfflineEffects,
): OfflineResult {
  // The ports are explicit so tests make the no-effect boundary observable. This
  // mode deliberately has no branch that invokes any of them.
  void effects;
  const requestId = requestIdOf(input);
  if (!record(input)) return blocked("INPUT_INVALID", null);
  const request = parseRequest(input.request);
  if (request === null) return blocked("INPUT_INVALID", requestId);
  if (!captureBound(input, request)) return blocked("CAPTURE_INVALID", requestId);
  if (validateCaptured402(input.capture) === null) {
    return blocked("CAPTURE_INVALID", requestId);
  }
  const sourceEvidence: PaymentEvidence = { source: "synthetic" };
  if (!policyDocument(policy)) return blocked("CONFIG_INCOMPLETE", requestId, sourceEvidence);
  if (request.url !== policy.resourceUrl) {
    return blocked("POLICY_MISMATCH", requestId, sourceEvidence);
  }

  const result = preflight({
    http: {
      status: input.capture.status,
      paymentRequiredHeader: input.capture.paymentRequiredHeader,
    },
    policy,
    payment: request.payment,
  });
  if (result.decision === "blocked") {
    return { ...result, evidence: sourceEvidence, mode: "offline" };
  }
  const quote = result.selection.requirements;
  return {
    requestId: result.requestId,
    decision: "prepared",
    paymentStatus: "not_paid",
    serviceStatus: "not_started",
    reason: "DRY_RUN_ONLY",
    retryAction: "none",
    evidence: {
      source: "synthetic",
      network: quote.network,
      asset: quote.asset,
      amountAtomic: quote.amount,
      payer: policy.payerAccountId,
      payTo: quote.payTo,
    },
    output: null,
    mode: "offline",
  };
}

function emit(output: RecordValue, exitCode: number): void {
  process.stdout.write(JSON.stringify(output) + "\n");
  process.exitCode = exitCode;
}

function argumentsOf(args: string[]): { mode: string; input: string } | null {
  if (args.length !== 4) return null;
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if ((name !== "--mode" && name !== "--input") || value === undefined || values.has(name)) return null;
    values.set(name, value);
  }
  const mode = values.get("--mode");
  const input = values.get("--input");
  return mode && input ? { mode, input } : null;
}

export function outcomeExitCode(result: PaymentOutcome): number {
  if (result.paymentStatus === "settled") return result.serviceStatus === "succeeded" && result.output !== null && result.decision === "completed" ? 0 : 4;
  if (result.paymentStatus === "unknown" || result.decision === "paused") return 3;
  return 2;
}

export async function evaluatePreflight(input: unknown, policyValue: unknown, registry: Registry, fetcher: (request: Request) => Promise<Response>): Promise<PaymentOutcome & {mode: "preflight"}> {
  const reject = (reason:string) => ({...blocked(reason,requestIdOf(input)),mode:"preflight" as const});
  if(!record(input)||!Object.keys(input).every(k=>["configRef","request","capture"].includes(k)))return reject("INPUT_INVALID");
  const request=parseRequest(input.request);
  if(!request)return reject("INPUT_INVALID");
  if(!record(input.capture)||input.capture.source==="synthetic"||typeof input.capture.source!=="string"||!captureBound(input,request,input.capture.source)||!registry.captureSha256.includes(captureDigest(input.capture)))return reject("CAPTURE_INVALID");
  let policy:Policy;
  try{policy=loadPaymentConfig(policyValue);}catch{return reject("CONFIG_INCOMPLETE");}
  if(request.url!==policy.resourceUrl)return reject("POLICY_MISMATCH");
  const local=preflight({http:input.capture,policy:{...policy,enabled:true},payment:request.payment});
  if(local.decision!=="prepared")return {...local,mode:"preflight"};
  try{await createNetworkCheck(policy,fetcher)(local.selection);}catch(error){
    if(error instanceof Error && error.message==="CONFIG_INCOMPLETE")return reject("CONFIG_INCOMPLETE");
    return {...reject("NETWORK_CHECK_FAILED"),decision:"paused"};
  }
  return {...reject("DRY_RUN_ONLY"),decision:"prepared",evidence:{source:"testnet",network:policy.network,asset:policy.asset,amountAtomic:local.selection.requirements.amount,payer:policy.payerAccountId,payTo:policy.payTo}};
}

export async function main(args: string[]): Promise<void> {
  const parsed = argumentsOf(args);
  if (parsed === null) { emit(blocked("INPUT_INVALID", null), 2); return; }
  if (!["offline", "preflight", "live", "recover"].includes(parsed.mode)) {
    emit({ ...blocked("MODE_NOT_AVAILABLE", null), mode: parsed.mode }, 2);
    return;
  }

  // This is an operator authorization for a real Hedera Testnet run. Check it
  // before reading the input or opening any configured payment resource.
  if (parsed.mode === "live" && process.env.PAYMENT_LIVE_AUTHORIZED !== "1") {
    emit({ ...blocked("LIVE_AUTHORIZATION_REQUIRED", null), mode: "live" }, 2);
    return;
  }

  let input: unknown;
  try {
    input = await readBoundedJson(parsed.input);
  } catch (error) {
    emit({...blocked(error instanceof Error && error.message === "INPUT_TOO_LARGE" ? "INPUT_TOO_LARGE" : "INPUT_INVALID", null), mode: parsed.mode, ...(["live", "recover"].includes(parsed.mode) ? {decision: "paused", paymentStatus: "unknown", serviceStatus: "unknown", retryAction: "query_original"} : {})}, parsed.mode === "live" ? 3 : 2);
    return;
  }
  const requestId = parsed.mode === "recover" && record(input) && validRequestId(input.requestId) ? input.requestId : requestIdOf(input);
  const reject=(reason:string, code=2)=>emit({...blocked(reason,requestId),mode:parsed.mode,...(["live", "recover"].includes(parsed.mode)?{decision:"paused",paymentStatus:"unknown",serviceStatus:"unknown",retryAction:"query_original"}:{})},parsed.mode==="live"?3:code);
  let registry:Registry|undefined;
  if(parsed.mode!=="offline"){
    try{registry=await readPaymentRegistry();}catch{reject("CONFIG_INCOMPLETE");return;}
  }
  if(parsed.mode==="recover"){
    if(!record(input)||!validRequestId(input.requestId)||typeof input.journalPath!=="string"||Object.keys(input).some(k=>!["requestId","journalPath"].includes(k))){reject("INPUT_INVALID");return;}
    let journal;
    try{const path=await authorizedExistingPath(input.journalPath,registry!.journalPaths);journal=openJournal(path);}catch{reject("JOURNAL_UNAVAILABLE");return;}
    try{const result=await recoverPayment({requestId:input.requestId,journal,verify:createRecoveryVerifier(request=>fetch(request))});emit({...result,mode:"recover"},outcomeExitCode(result));}finally{journal.close();}
    return;
  }
  let policy:unknown;
  let configPath:string;
  try{
    if(!record(input)||typeof input.configRef!=="string")throw Error();
    configPath=await containedConfig(dirname(resolve(parsed.input)),input.configRef);
    if(registry&&!registry.configPaths.includes(configPath))throw Error();
    policy=await readBoundedJson(configPath);
  }catch{reject("CONFIG_INCOMPLETE");return;}
  const rejectLive = async (reason: string, journal?: Journal) => {
    let opened: Journal | undefined;
    try {
      if (!requestId) throw Error();
      if (!journal) {
        const parsedPolicy = loadPaymentConfig(policy);
        const path = await authorizedExistingPath(parsedPolicy.journalPath, registry!.journalPaths);
        opened = openJournal(path);
        journal = opened;
      }
      const stored = journal.read(requestId);
      if (!stored) throw Error();
      const result = { ...recordOutcome(stored), decision: "blocked" as const, reason };
      emit({ ...result, mode: "live" }, outcomeExitCode(result));
    } catch {
      reject(reason, 3);
    } finally {
      opened?.close();
    }
  };
  if(parsed.mode==="preflight"){
    const result=await evaluatePreflight(input,policy,registry!,request=>fetch(request));
    emit(result,result.decision==="prepared"?0:result.decision==="paused"?3:2);return;
  }
  if(parsed.mode==="live"){
    if(!record(input)||!Object.keys(input).every(k=>["configRef","request"].includes(k))){reject("INPUT_INVALID");return;}
    const request=parseRequest(input.request);
    if(!request){reject("INPUT_INVALID");return;}
    let approved:Policy;
    try{approved=await loadApprovedPaymentConfig(configPath!);if(!approved.enabled)throw Error();}
    catch{await rejectLive("CONFIG_INCOMPLETE");return;}
    let journal;
    try{journal=openJournal(approved.journalPath);}catch{reject("JOURNAL_UNAVAILABLE");return;}
    try{
      const ports=createLivePorts(approved,journal,parseFrelyResponse);
      const result=await createPaymentSession(approved,ports).execute(request);
      emit({...result,mode:"live"},outcomeExitCode(result));
    }catch(error){
      const reason=error instanceof Error && ["CONFIG_INCOMPLETE","JOURNAL_UNAVAILABLE"].includes(error.message)?error.message:"PAYMENT_EXECUTION_FAILED";
      await rejectLive(reason,journal);
    }finally{journal.close();}
    return;
  }
  const result=evaluateOffline(input,policy);emit(result,result.decision==="prepared"?0:2);
}

if (import.meta.main) await main(Bun.argv.slice(2));
