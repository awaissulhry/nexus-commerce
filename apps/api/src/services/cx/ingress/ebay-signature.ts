/**
 * eBay notification signature verification — the real scheme (CX.4a).
 *
 * ── What was here before ─────────────────────────────────────────────────────
 * `ebay-notification.routes.ts` verified inbound notifications with
 * `HMAC-SHA256(rawBody, verificationToken)`. eBay does not sign that way and never
 * has: the verification token exists only to compute the *challenge* response when
 * eBay probes the endpoint's ownership. Real notifications carry an ECC signature
 * over the payload, verified with a public key fetched by key id. The audit recorded
 * the mismatch (`docs/2026-08-29-cx-audit.md` §eBay/Notifications); this closes it.
 *
 * The consequence of the old check was invisible by construction — a rejected
 * notification returned 204 and wrote nothing — so "eBay has never delivered an
 * event" and "eBay's events have all been silently discarded" looked identical from
 * the database. 5,158 inbound rows on prod, every one of them Amazon.
 *
 * ── The scheme, as eBay's own SDK implements it ──────────────────────────────
 *   1. `x-ebay-signature` is base64; decode it to ASCII and parse it as JSON.
 *   2. Take `kid` from that JSON and GET
 *      `/commerce/notification/v1/public_key/{kid}` with an APPLICATION
 *      (client-credentials) token — not a user token.
 *   3. The response's `key` arrives PEM-marked but without the newlines Node needs;
 *      insert one after the BEGIN marker and one before the END marker.
 *   4. Verify the base64 `signature` over the payload with an SHA-1 digest. eBay
 *      names the algorithm `ssl3-sha1`; that is an OpenSSL alias for the same
 *      digest, and the key type (EC) is what selects ECDSA. Verified working on
 *      this runtime's OpenSSL 3.6.3 with a real EC key pair before this was written.
 *
 * Sources read to learn the protocol (Apache-2.0), then re-implemented here rather
 * than vendored, per the standing rule that we own our own connection layer:
 * github.com/eBay/event-notification-nodejs-sdk `lib/validator.js` + `lib/constants.js`.
 */
import crypto from 'node:crypto'
import { logger } from '../../../utils/logger.js'

const EBAY_NOTIFICATION_BASE = {
  production: 'https://api.ebay.com',
  sandbox: 'https://api.sandbox.ebay.com',
} as const

export type EbayEnvironment = keyof typeof EBAY_NOTIFICATION_BASE

/** Why a verification failed, in words a ledger row can carry. */
export type VerifyReason =
  | 'ok'
  | 'missing_header'
  | 'malformed_header'
  | 'missing_kid'
  | 'missing_signature'
  | 'app_token_unavailable'
  | 'public_key_forbidden'
  | 'public_key_not_found'
  | 'signature_mismatch'
  | 'body_unparseable'

export interface EbayVerifyResult {
  ok: boolean
  reason: VerifyReason
  kid: string | null
}

interface ParsedHeader {
  kid: string
  signature: string
}

/** Base64 → ASCII → JSON. Anything that is not that shape fails closed. */
export function parseEbaySignatureHeader(header: string | undefined): ParsedHeader | VerifyReason {
  if (!header) return 'missing_header'
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(header, 'base64').toString('ascii'))
  } catch {
    return 'malformed_header'
  }
  if (typeof parsed !== 'object' || parsed === null) return 'malformed_header'
  const kid = (parsed as Record<string, unknown>).kid
  const signature = (parsed as Record<string, unknown>).signature
  if (typeof kid !== 'string' || kid === '') return 'missing_kid'
  if (typeof signature !== 'string' || signature === '') return 'missing_signature'
  return { kid, signature }
}

/**
 * eBay returns the key with its PEM markers but no line breaks; Node's parser needs
 * them. Idempotent — a key that already has the newlines is unchanged.
 */
export function toPublicKeyPem(key: string): string {
  return key
    .replace(/-----BEGIN PUBLIC KEY-----\n?/, '-----BEGIN PUBLIC KEY-----\n')
    .replace(/\n?-----END PUBLIC KEY-----/, '\n-----END PUBLIC KEY-----')
}

// Public keys are stable and shared across notifications; eBay's guidance is to
// cache them for about an hour. A per-notification fetch would also make an inbound
// flood into an outbound one.
const KEY_TTL_MS = 60 * 60 * 1000
const keyCache = new Map<string, { pem: string; at: number }>()

/** Exposed for tests — a cache that cannot be cleared makes them order-dependent. */
export function clearEbayPublicKeyCache(): void {
  keyCache.clear()
}

/**
 * Fetch (and cache) the public key for a key id.
 *
 * Returns a REASON on failure rather than a bare null, because the two ways this
 * fails are opposite problems and must not share a name: a key id we cannot find is
 * a forged or stale notification, while a token we cannot get — or that eBay
 * refuses — is OUR credential being broken, which would reject every genuine
 * notification identically. Collapsing those into one "unavailable" would rebuild,
 * one level down, exactly the ambiguity this whole unit exists to remove.
 */
async function publicKeyFor(kid: string, environment: EbayEnvironment): Promise<{ pem: string } | { error: VerifyReason }> {
  const hit = keyCache.get(kid)
  if (hit && Date.now() - hit.at < KEY_TTL_MS) return { pem: hit.pem }

  let token: string
  try {
    const { ebayAppToken } = await import('../connectors/ebay/client.js')
    token = await ebayAppToken(environment)
  } catch (err) {
    logger.error('[cx-ingress] could not obtain an eBay application token — every notification will be rejected until this is fixed', {
      error: err instanceof Error ? err.message : String(err),
    })
    return { error: 'app_token_unavailable' }
  }

  try {
    const res = await fetch(`${EBAY_NOTIFICATION_BASE[environment]}/commerce/notification/v1/public_key/${encodeURIComponent(kid)}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    })
    if (res.status === 401 || res.status === 403) {
      logger.error('[cx-ingress] eBay refused our application token for the notification key lookup', { kid, status: res.status })
      return { error: 'public_key_forbidden' }
    }
    if (!res.ok) {
      logger.warn('[cx-ingress] eBay has no public key for this key id', { kid, status: res.status })
      return { error: 'public_key_not_found' }
    }
    const body = (await res.json()) as { key?: string }
    if (typeof body.key !== 'string' || body.key === '') return { error: 'public_key_not_found' }
    const pem = toPublicKeyPem(body.key)
    keyCache.set(kid, { pem, at: Date.now() })
    return { pem }
  } catch (err) {
    logger.warn('[cx-ingress] eBay public key fetch threw', { kid, error: err instanceof Error ? err.message : String(err) })
    return { error: 'public_key_not_found' }
  }
}

/**
 * Verify one inbound notification.
 *
 * `rawBody` is the bytes as they arrived. eBay's SDK signs `JSON.stringify(payload)`
 * — the re-serialised object, not the wire bytes — so that form is checked first
 * because it is the one that interoperates. The raw bytes are then checked as well:
 * accepting either cannot weaken the guarantee, since producing a signature valid
 * over EITHER still requires eBay's private key, and it removes a whole class of
 * false rejection caused by whitespace we did not choose.
 */
export async function verifyEbayNotification(opts: {
  rawBody: Buffer
  header: string | undefined
  environment?: EbayEnvironment
}): Promise<EbayVerifyResult> {
  const environment = opts.environment ?? 'production'
  const parsed = parseEbaySignatureHeader(opts.header)
  if (typeof parsed === 'string') return { ok: false, reason: parsed, kid: null }

  const key = await publicKeyFor(parsed.kid, environment)
  if ('error' in key) return { ok: false, reason: key.error, kid: parsed.kid }
  const pem = key.pem

  const candidates: Array<string | Buffer> = []
  try {
    candidates.push(JSON.stringify(JSON.parse(opts.rawBody.toString('utf8'))))
  } catch {
    // Left empty deliberately: the guard below turns this into a verdict.
  }
  candidates.push(opts.rawBody)
  // Only the raw bytes made it in, so the body was not JSON. A genuine eBay
  // notification always is, and reporting that precisely beats reporting a
  // signature mismatch for a body that was never a candidate to begin with.
  if (candidates.length === 1) {
    return { ok: false, reason: 'body_unparseable', kid: parsed.kid }
  }

  for (const candidate of candidates) {
    try {
      // 'sha1' is OpenSSL's name for the digest eBay calls 'ssl3-sha1'. The key
      // being EC is what makes this ECDSA.
      if (crypto.createVerify('sha1').update(candidate).verify(pem, parsed.signature, 'base64')) {
        return { ok: true, reason: 'ok', kid: parsed.kid }
      }
    } catch {
      // A malformed key or signature is a failed verification, never a throw that
      // takes the request down.
    }
  }
  return { ok: false, reason: 'signature_mismatch', kid: parsed.kid }
}

/**
 * The ownership challenge: SHA-256 over challenge code + verification token +
 * endpoint URL, hex.
 *
 * Unchanged in behaviour — this is what the route already computed, and prod answers
 * it correctly today. It moves here so the notification protocol lives in one file,
 * and because eBay marks an endpoint down after 24 h of unanswered challenges.
 */
export function ebayChallengeResponse(challengeCode: string, verificationToken: string, endpoint: string): string {
  return crypto.createHash('sha256').update(challengeCode).update(verificationToken).update(endpoint).digest('hex')
}
