/**
 * P2.5 — the Standard Webhooks signature scheme.
 *
 * `connectors/etsy/spec.ts` has declared `scheme: 'standard-webhooks'` since the
 * connector was written, and nothing implemented it. There was no Etsy receiver at all,
 * so there was nothing to verify — the same shape as eBay in P2.3, where a declared
 * capability and no delivery path meant a wrong assumption could never be contradicted.
 *
 * The scheme (standardwebhooks.com):
 *
 *   webhook-id         an id for this delivery, stable across the sender's retries
 *   webhook-timestamp  unix seconds
 *   webhook-signature  one or more space-separated `v1,<base64>` pairs
 *
 * The signed content is `{id}.{timestamp}.{body}` over the RAW bytes, and the key is
 * the base64 part of a `whsec_`-prefixed secret. Several signatures may be present at
 * once so a sender can rotate keys, and **any one** matching is a pass.
 *
 * Two things here are security properties rather than details:
 *
 * 1. Every comparison is constant-time, and length is checked first because
 *    `timingSafeEqual` throws on a length mismatch — a throw is itself a timing signal
 *    and, worse, would be caught somewhere and read as "invalid" by accident.
 * 2. The timestamp is checked against a tolerance. Without it a signature stays valid
 *    forever, and anyone who captures one delivery can replay it for good. The
 *    delivery-id dedupe in the ledger stops a replay being PROCESSED twice, but it is
 *    an application-level guard on a transport-level problem, and it cannot help at all
 *    once the original row is archived.
 */
import crypto from 'node:crypto'

export type StandardWebhookReason =
  | 'ok'
  | 'missing_headers'
  | 'missing_secret'
  | 'bad_secret'
  | 'bad_timestamp'
  | 'timestamp_out_of_tolerance'
  | 'no_v1_signature'
  | 'signature_mismatch'

export interface StandardWebhookVerdict {
  ok: boolean
  reason: StandardWebhookReason
  /** The sender's id for this delivery — the ledger's dedupe key when it verifies. */
  webhookId?: string
}

export interface StandardWebhookHeaders {
  id?: string | string[]
  timestamp?: string | string[]
  signature?: string | string[]
}

/** Five minutes each way, the tolerance the specification recommends. */
export const STANDARD_WEBHOOK_TOLERANCE_SECONDS = 5 * 60

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function equalsConstantTime(a: string, b: string): boolean {
  const left = Buffer.from(a, 'base64')
  const right = Buffer.from(b, 'base64')
  // Length first: timingSafeEqual THROWS on a mismatch, and a throw is both a timing
  // signal and something a caller would misread as a plain "invalid".
  //
  // `left.length === 0` is UNREACHABLE from this file — `left` is always a 32-byte
  // HMAC digest — and a mutation test proved it: deleting it changed nothing. It is
  // kept as a guard for any future caller that passes an expectation from elsewhere,
  // where two empty buffers would otherwise compare equal and accept every forgery.
  // Recorded as unreachable rather than left looking load-bearing.
  if (left.length === 0 || left.length !== right.length) return false
  return crypto.timingSafeEqual(left, right)
}

/**
 * Verify one delivery. Never throws.
 *
 * `now` is injectable so the tolerance can be exercised in both directions by a test;
 * a clock that only ever moves forward cannot show that an OLD signature is refused.
 */
export function verifyStandardWebhook(input: {
  rawBody: Buffer | string | null | undefined
  headers: StandardWebhookHeaders
  secret: string | null | undefined
  now?: Date
  toleranceSeconds?: number
}): StandardWebhookVerdict {
  const id = first(input.headers.id)
  const timestamp = first(input.headers.timestamp)
  const signatureHeader = first(input.headers.signature)
  if (!id || !timestamp || !signatureHeader || input.rawBody === null || input.rawBody === undefined) {
    return { ok: false, reason: 'missing_headers' }
  }
  if (!input.secret) return { ok: false, reason: 'missing_secret' }

  // `whsec_` is a prefix on the secret, not part of the key.
  const rawSecret = input.secret.startsWith('whsec_') ? input.secret.slice('whsec_'.length) : input.secret
  const key = Buffer.from(rawSecret, 'base64')
  if (key.length === 0) return { ok: false, reason: 'bad_secret' }

  const seconds = Number(timestamp)
  if (!Number.isFinite(seconds) || !Number.isInteger(seconds)) return { ok: false, reason: 'bad_timestamp' }
  const tolerance = input.toleranceSeconds ?? STANDARD_WEBHOOK_TOLERANCE_SECONDS
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000)
  // Both directions. A future timestamp is as much a forgery signal as an old one, and
  // a one-sided check is a replay window the width of the sender's clock skew.
  if (Math.abs(nowSeconds - seconds) > tolerance) return { ok: false, reason: 'timestamp_out_of_tolerance' }

  const body = typeof input.rawBody === 'string' ? Buffer.from(input.rawBody, 'utf8') : input.rawBody
  const signed = Buffer.concat([Buffer.from(`${id}.${timestamp}.`, 'utf8'), body])
  const expected = crypto.createHmac('sha256', key).update(signed).digest('base64')

  const presented = signatureHeader.split(' ').filter(Boolean)
  const v1 = presented.filter((part) => part.startsWith('v1,')).map((part) => part.slice(3))
  if (v1.length === 0) return { ok: false, reason: 'no_v1_signature' }

  // Every candidate is compared, without an early return on the first match, so the
  // time taken does not reveal WHICH signature matched.
  let matched = false
  for (const candidate of v1) if (equalsConstantTime(expected, candidate)) matched = true
  return matched ? { ok: true, reason: 'ok', webhookId: id } : { ok: false, reason: 'signature_mismatch' }
}

/** Sign a body the same way, for tests and for a verify script. */
export function signStandardWebhook(id: string, timestamp: number, body: string, secret: string): string {
  const rawSecret = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret
  const key = Buffer.from(rawSecret, 'base64')
  return `v1,${crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`
}
