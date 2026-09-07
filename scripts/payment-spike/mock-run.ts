import {readFileSync, writeFileSync, existsSync, renameSync, openSync, fsyncSync, closeSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {HTTPFacilitatorClient} from '@x402/core/server';
import type {PaymentRequired} from '@x402/core/types';
import {loadApprovedPaymentConfig, readBoundedJson, openJournal, createLivePorts, createPaymentSession, requestFingerprint, recoverPayment, createRecoveryVerifier} from '@frely-network/hedera-x402';
import type {PreparedRequest, PaymentOutcome, Journal} from '@frely-network/hedera-x402';
import {parseFrelyResponse} from '../../packages/broker/execution/response.ts';
import {createMockGateway, type GatewayEvent} from './mock-gateway.ts';

function save(path: string, data: unknown) {
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', {mode: 0o600});
  const fd = openSync(tmp, 'r'); fsyncSync(fd); closeSync(fd); renameSync(tmp, path);
}
const exitFor = (outcome: PaymentOutcome) => outcome.paymentStatus === 'settled' ? outcome.serviceStatus === 'succeeded' && outcome.output !== null ? 0 : 4 : outcome.paymentStatus === 'unknown' ? 3 : 2;

export async function runMock(mode: string, inputPath: string) {
  if (!['prepare', 'run', 'recover'].includes(mode)) throw Error('MODE_INVALID');
  if (mode === 'run' && process.env.PAYMENT_LIVE_AUTHORIZED !== '1') throw Error('LIVE_AUTHORIZATION_REQUIRED');
  const directory = dirname(resolve(inputPath));
  const settings = await readBoundedJson(resolve(inputPath)) as {policyFile: string; tlsCert: string; tlsKey: string; amountAtomic: string; request: PreparedRequest};
  if (!settings || typeof settings !== 'object' || ![settings.policyFile, settings.tlsCert, settings.tlsKey, settings.amountAtomic].every(v => typeof v === 'string')) throw Error('INPUT_INVALID');
  const policy = await loadApprovedPaymentConfig(resolve(directory, settings.policyFile));
  const request = settings.request;
  const url = new URL(policy.resourceUrl);
  if (url.hostname !== '127.0.0.1' || url.protocol !== 'https:' || !url.port || request?.url !== policy.resourceUrl || request.method !== 'POST' || typeof request.body !== 'string' || request.headers?.['x-frely-request-id'] !== request.payment?.requestId || !/^[1-9][0-9]*$/.test(settings.amountAtomic)) throw Error('MOCK_CONFIG_INVALID');
  const eventsPath = join(directory, 'gateway-events.json');
  const events: GatewayEvent[] = existsSync(eventsPath) ? JSON.parse(readFileSync(eventsPath, 'utf8')) : [];
  let journal: Journal | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    if (mode !== 'prepare') {
      if (mode === 'recover' && !existsSync(policy.journalPath)) throw Error('REQUEST_NOT_FOUND');
      journal = openJournal(policy.journalPath);
      const existing = journal.read(request.payment.requestId);
      if (existing) {
        if (mode !== "recover" && existing.fingerprint !== requestFingerprint(request, policy)) throw Error("REQUEST_ID_CONFLICT");
        const cachedPorts = createLivePorts(policy, journal, parseFrelyResponse);
        cachedPorts.fetcher = async () => {throw Error('REPEAT_BUSINESS_REQUEST_FORBIDDEN');};
        cachedPorts.sign = async () => {throw Error('REPEAT_SIGNATURE_FORBIDDEN');};
        const outcome = mode === 'recover' ? await recoverPayment({requestId: request.payment.requestId, journal, verify: createRecoveryVerifier(r => fetch(r))}) : await createPaymentSession(policy, cachedPorts).execute(request);
        save(join(directory, 'repeat-result.json'), {outcome, noNewBusinessRequest: true, noNewSignature: true});
        console.log(JSON.stringify(outcome)); process.exitCode = exitFor(outcome); return;
      }
      if (mode === 'recover') throw Error('REQUEST_NOT_FOUND');
      if (events.some(e => e.phase !== 'quote')) throw Error('PREVIOUS_GATEWAY_ATTEMPT_REQUIRES_REVIEW');
    }
    const facilitator = new HTTPFacilitatorClient({url: policy.facilitatorUrl, timeoutMs: 12000});
    const supported = await facilitator.getSupported();
    const kind = supported.kinds.find(k => k.x402Version === 2 && k.scheme === 'exact' && k.network === policy.network && policy.feePayers.includes(String(k.extra?.feePayer)));
    if (!kind) throw Error('FACILITATOR_PROFILE_MISMATCH');
    save(join(directory, 'supported.json'), {capturedAt: new Date().toISOString(), url: policy.facilitatorUrl + '/supported', response: supported});
    const required: PaymentRequired = {x402Version: 2, resource: {url: policy.resourceUrl, description: 'Local mock business; real Hedera Testnet settlement', mimeType: 'application/json'}, accepts: [{scheme: 'exact', network: policy.network, asset: policy.asset, amount: settings.amountAtomic, payTo: policy.payTo, maxTimeoutSeconds: 120, extra: {feePayer: kind.extra!.feePayer}}]};
    const handler = createMockGateway({required, requestId: request.payment.requestId, body: request.body, facilitator, onEvent: event => {
      events.push(event); save(eventsPath, events); console.log(JSON.stringify({gatewayPhase: event.phase}));
    }});
    const cert = readFileSync(resolve(directory, settings.tlsCert));
    server = Bun.serve({hostname: '127.0.0.1', port: Number(url.port), tls: {cert, key: readFileSync(resolve(directory, settings.tlsKey))}, maxRequestBodySize: 1048576, fetch: handler});
    const localFetch = (r: Request) => {
      if (r.url !== policy.resourceUrl) throw Error('RESOURCE_MISMATCH');
      return fetch(r, {tls: {ca: cert, rejectUnauthorized: true}, redirect: 'error'});
    };
    if (mode === 'prepare') {
      const response = await localFetch(new Request(request.url, {method: request.method, body: request.body, headers: request.headers}));
      if (response.status !== 402 || !response.headers.get('PAYMENT-REQUIRED')) throw Error('CAPTURE_INVALID');
      const capture = {source: 'operator-approved-local-mock', capturedAt: new Date().toISOString(), method: request.method, url: request.url, bodySha256: createHash('sha256').update(request.body).digest('hex'), status: 402, paymentRequiredHeader: response.headers.get('PAYMENT-REQUIRED')};
      save(join(directory, 'preflight-input.json'), {configRef: settings.policyFile, request, capture});
      save(join(directory, 'requirements.json'), required);
      console.log(JSON.stringify({prepared: true, paymentStatus: 'not_paid', captureFile: join(directory, 'preflight-input.json')})); return;
    }
    const ports = createLivePorts(policy, journal!, parseFrelyResponse);
    ports.fetcher = localFetch; // Only the loopback resource trusts this test certificate.
    const session = createPaymentSession(policy, ports);
    const outcome = await session.execute(request);
    save(join(directory, 'result.json'), outcome);
    console.log(JSON.stringify(outcome));
    if (outcome.paymentStatus === 'settled' && outcome.serviceStatus === 'succeeded') {
      const calls = events.length;
      const repeated = await session.execute(request);
      save(join(directory, 'repeat-result.json'), {outcome: repeated, noNewBusinessRequest: events.length === calls, sameTransaction: repeated.evidence?.transactionId === outcome.evidence?.transactionId});
    }
    process.exitCode = exitFor(outcome);
  } finally {server?.stop(true); journal?.close();}
}
if (import.meta.main) {
  runMock(process.argv[2] ?? '', process.argv[3] ?? '').catch(() => {console.log(JSON.stringify({status: 'blocked', reason: 'MOCK_RUN_CONFIGURATION_OR_RUNTIME_ERROR'})); process.exitCode = 2;});
}
