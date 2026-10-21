/**
 * Meta ads step 30 (2026-10-21) — the two checks a Meta webhook delivery passes before Nexus reads a byte of it.
 *
 *   - Verification (GET): Meta sends `hub.mode=subscribe`, `hub.challenge` and `hub.verify_token`; Nexus answers 200 with
 *     exactly `hub.challenge` when the token is the one it gave Meta (META_WEBHOOK_VERIFY_TOKEN), otherwise 403
 *     (ads-webhooks/setup/get-started: "respond with a 200 OK whose body is the exact hub.challenge value"). Compared in
 *     constant time, whatever the lengths.
 *   - Notifications (POST): header `X-Hub-Signature-256: sha256=<hex>`, the HMAC-SHA256 of the RAW request body keyed
 *     with the app secret. Meta signs the bytes it sends (its Messenger page: the signature is over the escaped-unicode
 *     payload, so a body re-serialised after parsing does not match) — so the check runs on the bytes as received,
 *     before any parse, and compares the 32 digest bytes in constant time.
 *
 * Checked 2026-10-21: developers.facebook.com/documentation/ads-commerce/marketing-api/ads-webhooks/setup/get-started.md,
 * /docs/graph-api/webhooks/getting-started/, /documentation/business-messaging/messenger-platform/webhooks.md.
 * Pure: the app secret is passed in by the token service (metaWebhookSignatureCheck), which alone reads it.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

const SIGNATURE = /^sha256=([0-9a-fA-F]{64})$/

/** True when `header` is `sha256=<hex>` and the hex is the HMAC-SHA256 of exactly `rawBody` under `appSecret`. */
export function metaWebhookSignatureOk(rawBody: Buffer, header: string | string[] | undefined, appSecret: string): boolean {
  if (!Buffer.isBuffer(rawBody) || !appSecret) return false
  const value = Array.isArray(header) ? (header.length === 1 ? header[0] : undefined) : header
  const match = typeof value === 'string' ? SIGNATURE.exec(value.trim()) : null
  if (!match) return false
  const given = Buffer.from(match[1], 'hex')
  const expected = createHmac('sha256', appSecret).update(rawBody).digest()
  return given.length === expected.length && timingSafeEqual(given, expected)
}

/** The verify token Meta echoes back equals the one Nexus gave it; constant time (both hashed first). */
export function metaVerifyTokenOk(given: unknown, expected: string | undefined | null): boolean {
  if (typeof given !== 'string' || !given || typeof expected !== 'string' || !expected.trim()) return false
  const a = createHash('sha256').update(given).digest()
  const b = createHash('sha256').update(expected.trim()).digest()
  return timingSafeEqual(a, b)
}

/**
 * A challenge Nexus may echo: Meta's pages call it "an int" (Graph getting started) and "a random string" (ads webhooks
 * get started). Echoed only after the verify token matched, as text/plain; anything with spaces, controls or over 512
 * characters is refused.
 */
export function metaChallengeOf(value: unknown): string | null {
  return typeof value === 'string' && /^[\x21-\x7e]{1,512}$/.test(value) ? value : null
}
