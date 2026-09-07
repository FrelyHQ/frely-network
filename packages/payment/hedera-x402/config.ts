import { validPolicy } from './preflight.ts';
import type { Policy } from './types.ts';
const keys = new Set(['enabled','network','asset','assetDecimals','payerAccountId','payTo','feePayers','facilitatorUrl','resourceUrl','journalPath','mirrorNodeUrl','signerRef','keyType','credentialRef']);
export function loadPaymentConfig(value: unknown): Policy {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).every(k => keys.has(k))) throw Error('CONFIG_INCOMPLETE');
  const candidate = { ...value, enabled: (value as {enabled?: unknown}).enabled ?? false };
  if (typeof candidate.enabled !== 'boolean' || !validPolicy({...candidate, enabled: true})) throw Error('CONFIG_INCOMPLETE');
  return structuredClone(candidate) as Policy;
}
export function resolveSigningKey(ref: string): string {
  if (!/^env:[A-Z_][A-Z0-9_]*$/.test(ref)) throw Error('CONFIG_INCOMPLETE');
  const key = process.env[ref.slice(4)];
  if (!key) throw Error('SIGNER_UNAVAILABLE');
  return key;
}
