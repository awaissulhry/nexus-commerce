/**
 * eBay Key Management API — the keypairs behind digital signatures.
 *
 * Reference: https://developer.ebay.com/api-docs/developer/key-management/resources/signing_key/methods/createSigningKey
 *
 *   POST https://apiz.ebay.com/developer/key_management/v1/signing_key
 *   GET  https://apiz.ebay.com/developer/key_management/v1/signing_key/{signing_key_id}
 *   GET  https://apiz.ebay.com/developer/key_management/v1/signing_key
 *
 * Sandbox: replace `apiz.ebay.com` with `apiz.sandbox.ebay.com`. Auth: an
 * APPLICATION token (client-credentials grant, scope
 * `https://api.ebay.com/oauth/api_scope`) — not a user token.
 *
 * Request body: `{ "signingKeyCipher": "ED25519" | "RSA" }` (eBay recommends
 * ED25519). Response (`SigningKey`): `creationTime`, `expirationTime`,
 * `jwe`, `privateKey`, `publicKey`, `signingKeyCipher`, `signingKeyId`.
 *
 * eBay's own words: "eBay does not store the Private Key value in any
 * system" — `privateKey` comes back ONLY from createSigningKey, never from
 * the two GETs. The caller must persist it (encrypted) at once; a lost
 * private key means a new keypair.
 *
 * Nothing here logs — tokens, JWEs and private keys are secrets.
 */

import { generateKeyPairSync } from 'node:crypto';

export const EBAY_KEY_MANAGEMENT_BASE = 'https://apiz.ebay.com';
export const EBAY_KEY_MANAGEMENT_SANDBOX_BASE = 'https://apiz.sandbox.ebay.com';
const SIGNING_KEY_PATH = '/developer/key_management/v1/signing_key';

export type EbaySigningKeyCipher = 'ED25519' | 'RSA';

export interface EbaySigningKey {
  signingKeyId: string;
  /** Public key as JWE — the `x-ebay-signature-key` header value. */
  jwe: string;
  /** PEM private key. Returned by createSigningKey ONLY; eBay never stores it. */
  privateKey: string;
  /** PEM public key. */
  publicKey: string;
  signingKeyCipher: string;
  /** eBay returns epoch seconds; normalised to a string here. */
  expirationTime?: string;
  creationTime?: string;
}

/** What the GETs return — everything but the private key. */
export type EbaySigningKeyPublic = Omit<EbaySigningKey, 'privateKey'>;

export interface EbayKeyManagementAuth {
  /** Application access token (client-credentials grant). */
  appAccessToken: string;
  /** Defaults to production `https://apiz.ebay.com`. */
  apiBase?: string;
}

export interface CreateEbaySigningKeyOptions extends EbayKeyManagementAuth {
  /** Defaults to ED25519 (eBay's recommendation; smaller headers). */
  cipher?: EbaySigningKeyCipher;
}

export class EbayKeyManagementError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(op: string, status: number, statusText: string, body: string) {
    super(`ebay key management ${op} failed: HTTP ${status}${statusText ? ` ${statusText}` : ''}${body ? ` — ${body}` : ''}`);
    this.name = 'EbayKeyManagementError';
    this.status = status;
    this.body = body;
  }
}

function baseUrl(apiBase: string | undefined): string {
  return (apiBase ?? EBAY_KEY_MANAGEMENT_BASE).replace(/\/+$/, '');
}

const PEM_LINE = 64;

/** eBay hands keys back as bare base64 DER; Node's crypto wants PEM. Leave a PEM untouched. */
function toPem(value: string, label: 'PRIVATE KEY' | 'PUBLIC KEY'): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('-----BEGIN ')) return trimmed;
  const compact = trimmed.replace(/\s+/g, '');
  const lines = compact.match(new RegExp(`.{1,${PEM_LINE}}`, 'g')) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----`;
}

function optionalString(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  return String(v);
}

function requireString(obj: Record<string, unknown>, field: string, op: string): string {
  const v = obj[field];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`ebay key management ${op}: response is missing \`${field}\``);
  }
  return v;
}

async function call(op: string, method: 'GET' | 'POST', url: string, auth: EbayKeyManagementAuth, body?: unknown): Promise<Record<string, unknown>> {
  if (!auth.appAccessToken) throw new Error(`ebay key management ${op}: appAccessToken is required`);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.appAccessToken}`,
    Accept: 'application/json',
  };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) {
    // eBay error bodies are `{ errors: [{ errorId, domain, category, message, ... }] }`;
    // they never echo the bearer token. Truncate so a stray HTML page cannot flood a log.
    throw new EbayKeyManagementError(op, res.status, res.statusText, text.slice(0, 2000));
  }
  if (!text) throw new Error(`ebay key management ${op}: empty ${res.status} response`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`ebay key management ${op}: non-JSON ${res.status} response`);
  }
  if (!parsed || typeof parsed !== 'object') throw new Error(`ebay key management ${op}: unexpected response shape`);
  return parsed as Record<string, unknown>;
}

function publicFields(raw: Record<string, unknown>, op: string): EbaySigningKeyPublic {
  return {
    signingKeyId: requireString(raw, 'signingKeyId', op),
    jwe: requireString(raw, 'jwe', op),
    publicKey: toPem(requireString(raw, 'publicKey', op), 'PUBLIC KEY'),
    signingKeyCipher: requireString(raw, 'signingKeyCipher', op),
    expirationTime: optionalString(raw.expirationTime),
    creationTime: optionalString(raw.creationTime),
  };
}

/**
 * Create a signing keypair. The private key in the result is the ONLY copy
 * that will ever exist — persist it before returning it anywhere.
 */
export async function createEbaySigningKey(opts: CreateEbaySigningKeyOptions): Promise<EbaySigningKey> {
  const op = 'createSigningKey';
  const cipher: EbaySigningKeyCipher = opts.cipher ?? 'ED25519';
  const raw = await call(op, 'POST', `${baseUrl(opts.apiBase)}${SIGNING_KEY_PATH}`, opts, { signingKeyCipher: cipher });
  return {
    ...publicFields(raw, op),
    privateKey: toPem(requireString(raw, 'privateKey', op), 'PRIVATE KEY'),
  };
}

/** Public key, JWE and metadata for one keypair — never the private key. */
export async function getEbaySigningKey(signingKeyId: string, auth: EbayKeyManagementAuth): Promise<EbaySigningKeyPublic> {
  const op = 'getSigningKey';
  if (!signingKeyId) throw new Error(`ebay key management ${op}: signingKeyId is required`);
  const raw = await call(op, 'GET', `${baseUrl(auth.apiBase)}${SIGNING_KEY_PATH}/${encodeURIComponent(signingKeyId)}`, auth);
  return publicFields(raw, op);
}

/**
 * A local Ed25519 keypair in the same PEM shapes the signer accepts. For
 * tests and offline verification only — eBay accepts signatures solely
 * from keys IT issued (the JWE carries the public key eBay minted).
 */
export function generateLocalEd25519KeyPair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString().trim(),
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString().trim(),
  };
}
