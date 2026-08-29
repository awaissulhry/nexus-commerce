/**
 * eBay digital signatures for APIs — RFC 9421 HTTP Message Signatures +
 * RFC 9530 Content-Digest.
 *
 * Mandatory for calls made on behalf of EU/UK-domiciled sellers to: every
 * Finances API method, Fulfillment `issueRefund`, Trading `GetAccount`
 * (XML — out of scope for this helper) and the Post-Order refund /
 * decide / cancellation methods. eBay ignores the headers on any other
 * call, so over-signing is harmless.
 *
 * Algorithm (re-implemented from eBay's own reference code — the
 * `digital-signature-nodejs-sdk` `signature-base-helper.ts` /
 * `signature-helper.ts` / `digest-helper.ts`, and the
 * `digital-signature-verification-ebay-api` Java verifier eBay ships as
 * the model of its backend):
 *
 *   Content-Digest:        sha-256=:<base64(sha256(body bytes))>:
 *                          (omitted when the request has no body)
 *   x-ebay-signature-key:  <JWE from the Key Management API>
 *   Signature-Input:       sig1=("content-digest" "x-ebay-signature-key" "@method" "@path" "@authority");created=<unix seconds>
 *                          ("content-digest" is dropped from the list when there is no body)
 *   Signature:             sig1=:<base64(sign(signature base))>:
 *
 * The signature base is RFC 9421 §2.5 — one `"<component>": <value>` line
 * per covered component, in Signature-Input order, joined by "\n", then
 * the `"@signature-params": (...)` line with NO trailing newline:
 *
 *   "content-digest": sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:
 *   "x-ebay-signature-key": eyJ...
 *   "@method": POST
 *   "@path": /sell/finances/v1/transaction
 *   "@authority": apiz.ebay.com
 *   "@signature-params": ("content-digest" "x-ebay-signature-key" "@method" "@path" "@authority");created=1700000000
 *
 * `@path` is the URL path WITHOUT the query string. That is what RFC 9421
 * §2.2.6 defines (`@query` is a separate component eBay does not cover)
 * and what eBay's verifier does — `VerificationService.calculateBase`
 * appends `uri.getPath()` for "@path" (Java `URI.getPath()` excludes the
 * query) and `uri.getAuthority()` for "@authority". The Node SDK never
 * derives the path itself (the caller passes `signatureComponents.path`);
 * its example configs use bare paths such as `/ws/api.dll`.
 *
 * Signing: Ed25519 keys are signed with `crypto.sign(null, …)` (pure
 * EdDSA, RFC 9421 §3.3.6); RSA keys with `crypto.sign('sha256', …)` —
 * RSASSA-PKCS1-v1_5 / SHA-256 (RFC 9421 §3.3.1), the only RSA scheme eBay
 * documents. eBay recommends Ed25519.
 *
 * Nothing here logs: the JWE and the private key are secrets.
 */

import { createHash, createPrivateKey, sign as cryptoSign, type KeyObject } from 'node:crypto';

export const EBAY_SIGNATURE_LABEL = 'sig1';
export const EBAY_SIGNATURE_KEY_HEADER = 'x-ebay-signature-key';
export const EBAY_CONTENT_DIGEST_HEADER = 'content-digest';

/** Covered components, in the order eBay's SDK and verifier expect them. */
const COMPONENTS_WITH_BODY = [EBAY_CONTENT_DIGEST_HEADER, EBAY_SIGNATURE_KEY_HEADER, '@method', '@path', '@authority'] as const;
const COMPONENTS_WITHOUT_BODY = [EBAY_SIGNATURE_KEY_HEADER, '@method', '@path', '@authority'] as const;

export interface SignEbayRequestInput {
  /** HTTP method; upper-cased into "@method". */
  method: string;
  /** Absolute request URL — "@path" and "@authority" are derived from it. */
  url: string;
  /** Exact bytes that will be sent. Absent / empty → no Content-Digest. */
  body?: string | Buffer | null;
  /** The JWE returned by the Key Management API (`x-ebay-signature-key`). */
  jwe: string;
  /** PEM private key returned ONLY by createSigningKey (Ed25519 or RSA). */
  privateKeyPem: string;
  /** Unix seconds for `created`; defaults to now. Floored to an integer. */
  created?: number;
}

export interface EbaySignatureHeaders {
  'Content-Digest'?: string;
  'x-ebay-signature-key': string;
  'Signature-Input': string;
  Signature: string;
}

/** The body as bytes; `null` when the request carries no body. */
function bodyBytes(body: SignEbayRequestInput['body']): Buffer | null {
  if (body === undefined || body === null) return null;
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  return buf.length === 0 ? null : buf;
}

/**
 * RFC 9530 Content-Digest for a body: `sha-256=:<base64>:`.
 * `{"hello": "world"}` → `sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:`
 */
export function ebayContentDigest(body: string | Buffer): string {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  return `sha-256=:${createHash('sha256').update(buf).digest('base64')}:`;
}

/** `("a" "b" …);created=N` — the value shared by Signature-Input and @signature-params. */
function signatureParams(components: readonly string[], created: number): string {
  return `(${components.map((c) => `"${c}"`).join(' ')});created=${created}`;
}

function resolveCreated(created: number | undefined): number {
  if (created === undefined) return Math.floor(Date.now() / 1000);
  if (typeof created !== 'number' || !Number.isFinite(created)) {
    throw new Error('ebay signing: `created` must be a finite unix-seconds number');
  }
  return Math.floor(created);
}

export interface EbaySignatureBase {
  /** The exact string that is signed. */
  base: string;
  /** The component list actually covered (content-digest dropped when no body). */
  components: readonly string[];
  /** The `(…);created=N` params string. */
  params: string;
  contentDigest: string | null;
  method: string;
  path: string;
  authority: string;
  created: number;
}

/**
 * Build the RFC 9421 §2.5 signature base for an eBay request. Exported so
 * callers/tests can inspect what was signed; `signEbayRequest` is the
 * entry point.
 */
export function buildEbaySignatureBase(input: Omit<SignEbayRequestInput, 'privateKeyPem'>): EbaySignatureBase {
  if (!input.jwe) throw new Error('ebay signing: `jwe` (x-ebay-signature-key) is required');
  const url = new URL(input.url);
  const method = input.method.toUpperCase();
  // RFC 9421 §2.2.6 "@path" excludes the query; eBay's verifier uses Java URI.getPath().
  const path = url.pathname || '/';
  // RFC 9421 §2.2.3 "@authority" = host[:port]; URL.host drops a default port,
  // matching Java URI.getAuthority() for https://apiz.ebay.com.
  const authority = url.host;
  const bytes = bodyBytes(input.body);
  const contentDigest = bytes ? ebayContentDigest(bytes) : null;
  const created = resolveCreated(input.created);
  const components: readonly string[] = contentDigest ? COMPONENTS_WITH_BODY : COMPONENTS_WITHOUT_BODY;
  const params = signatureParams(components, created);

  const lines: string[] = [];
  for (const component of components) {
    let value: string;
    switch (component) {
      case EBAY_CONTENT_DIGEST_HEADER:
        value = contentDigest as string;
        break;
      case EBAY_SIGNATURE_KEY_HEADER:
        value = input.jwe;
        break;
      case '@method':
        value = method;
        break;
      case '@path':
        value = path;
        break;
      case '@authority':
        value = authority;
        break;
      default:
        throw new Error(`ebay signing: unknown component ${component}`);
    }
    lines.push(`"${component}": ${value}`);
  }
  lines.push(`"@signature-params": ${params}`);

  return { base: lines.join('\n'), components, params, contentDigest, method, path, authority, created };
}

/** Pick the signing digest from the key type: Ed25519 → null (pure EdDSA); RSA → sha256 (PKCS#1 v1.5). */
function digestFor(key: KeyObject): string | null {
  switch (key.asymmetricKeyType) {
    case 'ed25519':
      return null;
    case 'rsa':
      return 'sha256';
    default:
      throw new Error(`ebay signing: unsupported private key type ${String(key.asymmetricKeyType)} (expected ed25519 or rsa)`);
  }
}

/**
 * Produce the four eBay signature headers for a request. Pass EXACTLY the
 * body bytes you will send (the digest is over the wire bytes).
 */
export function signEbayRequest(input: SignEbayRequestInput): Record<string, string> {
  if (!input.privateKeyPem) throw new Error('ebay signing: `privateKeyPem` is required');
  const key = createPrivateKey(input.privateKeyPem);
  const digest = digestFor(key);
  const built = buildEbaySignatureBase(input);
  const signature = cryptoSign(digest, Buffer.from(built.base, 'utf8'), key).toString('base64');

  const headers: Record<string, string> = {};
  if (built.contentDigest) headers['Content-Digest'] = built.contentDigest;
  headers[EBAY_SIGNATURE_KEY_HEADER] = input.jwe;
  headers['Signature-Input'] = `${EBAY_SIGNATURE_LABEL}=${built.params}`;
  headers['Signature'] = `${EBAY_SIGNATURE_LABEL}=:${signature}:`;
  return headers;
}

// ---------------------------------------------------------------------------
// Which calls must be signed
// ---------------------------------------------------------------------------

export interface EbaySignedPathPattern {
  /** Tested against the URL path (no query, no authority). */
  path: RegExp;
  /** Upper-case methods the rule applies to; `null` = every method. */
  methods: readonly string[] | null;
  /** Human label — which eBay method this is. */
  label: string;
}

/**
 * The APIs eBay lists as in scope (digital-signature-verification-ebay-api
 * README, "APIs in Scope"). Mutable on purpose: a caller may push more
 * entries. Trading `GetAccount` is XML (`/ws/api.dll` + X-EBAY-API-CALL-NAME
 * header) and cannot be recognised by path — the Trading caller decides.
 */
export const EBAY_SIGNED_PATH_PATTERNS: EbaySignedPathPattern[] = [
  { path: /^\/sell\/finances\//, methods: null, label: 'Finances API (all methods)' },
  { path: /^\/sell\/fulfillment\/v1\/order\/[^/]+\/issue_refund$/, methods: ['POST'], label: 'Fulfillment issueRefund' },
  { path: /^\/post-order\/v2\/inquiry\/[^/]+\/issue_refund$/, methods: ['POST'], label: 'Post-Order issueInquiryRefund' },
  { path: /^\/post-order\/v2\/casemanagement\/[^/]+\/issue_refund$/, methods: ['POST'], label: 'Post-Order issueCaseRefund' },
  { path: /^\/post-order\/v2\/return\/[^/]+\/issue_refund$/, methods: ['POST'], label: 'Post-Order issueReturnRefund' },
  { path: /^\/post-order\/v2\/return\/[^/]+\/decide$/, methods: ['POST'], label: 'Post-Order processReturnRequest' },
  { path: /^\/post-order\/v2\/cancellation\/[^/]+\/approve$/, methods: ['POST'], label: 'Post-Order approveCancellationRequest' },
  { path: /^\/post-order\/v2\/cancellation$/, methods: ['POST'], label: 'Post-Order createCancellationRequest' },
];

/** Path of an absolute URL or a bare path, query and fragment stripped. */
function pathOf(url: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return new URL(url).pathname || '/';
  const cut = url.search(/[?#]/);
  const path = cut === -1 ? url : url.slice(0, cut);
  return path.startsWith('/') ? path : `/${path}`;
}

/** True when eBay requires a digital signature on this call (for an EU/UK seller). */
export function ebaySignatureAppliesTo(url: string, method: string): boolean {
  const path = pathOf(url);
  const m = method.toUpperCase();
  return EBAY_SIGNED_PATH_PATTERNS.some((rule) => rule.path.test(path) && (rule.methods === null || rule.methods.includes(m)));
}
