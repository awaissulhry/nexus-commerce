import { createHmac, timingSafeEqual } from 'node:crypto'
import type { SignatureVerifier, VerifyInput, VerifyResult } from '@nexus/factory-domain/ports/signature'

/**
 * The signature of the factory's own FAKE providers (plan A1 §4: "a fake … posts a signed fake event"): every account in
 * FAKE mode is verified with it, whatever its provider, so the fakes, the golden flow and the tests exercise the same
 * path as a real webhook (verify → receipt → job). LIVE and SANDBOX accounts use their provider's verifier
 * (providers.ts).
 *
 *   x-factory-event-id     the event's id: the dedupe key (1-200 printable characters)
 *   x-factory-event-type   optional, the event type
 *   x-factory-signature    `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<event id>.<raw body>")>`
 *
 * The event id is inside the signature, so a captured delivery cannot be replayed under a new id, and the timestamp
 * must be within 5 minutes of the server clock. The secret is the account's webhook secret (SecretValue, purpose
 * integration.webhook); without one nothing verifies.
 */

export const FAKE_SIGNATURE_HEADER = 'x-factory-signature'
export const FAKE_EVENT_ID_HEADER = 'x-factory-event-id'
export const FAKE_EVENT_TYPE_HEADER = 'x-factory-event-type'
export const FAKE_TOLERANCE_MS = 5 * 60_000

const EVENT_ID = /^[\x21-\x7e]{1,200}$/
const SIGNATURE = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/

const mac = (secret: string, timestamp: string, eventId: string, body: Uint8Array): Buffer =>
  createHmac('sha256', secret).update(`${timestamp}.${eventId}.`, 'utf8').update(body).digest()

/** The headers a fake provider sends with `body` (the signing side, for the FAKE adapters and the tests). */
export function fakeSignatureHeaders(secret: string, body: Uint8Array | string, now: Date, event: { readonly id: string; readonly type?: string }): Record<string, string> {
  const raw = typeof body === 'string' ? Buffer.from(body, 'utf8') : body
  const timestamp = String(Math.floor(now.getTime() / 1000))
  return {
    [FAKE_EVENT_ID_HEADER]: event.id,
    ...(event.type ? { [FAKE_EVENT_TYPE_HEADER]: event.type } : {}),
    [FAKE_SIGNATURE_HEADER]: `t=${timestamp},v1=${mac(secret, timestamp, event.id, raw).toString('hex')}`,
  }
}

export const fakeVerifier: SignatureVerifier = {
  verify({ rawBody, headers, secret, now }: VerifyInput): VerifyResult {
    if (!secret) return { ok: false, reason: 'no_webhook_secret' }
    const signature = headers[FAKE_SIGNATURE_HEADER]
    if (!signature) return { ok: false, reason: 'missing_signature' }
    const parsed = SIGNATURE.exec(signature)
    if (!parsed) return { ok: false, reason: 'malformed_signature' }
    const eventId = headers[FAKE_EVENT_ID_HEADER]
    if (!eventId || !EVENT_ID.test(eventId)) return { ok: false, reason: 'missing_event_id' }
    const [, timestamp, given] = parsed as unknown as [string, string, string]
    if (Math.abs(now.getTime() - Number(timestamp) * 1000) > FAKE_TOLERANCE_MS) return { ok: false, reason: 'stale_timestamp' }
    if (!timingSafeEqual(mac(secret, timestamp, eventId, rawBody), Buffer.from(given, 'hex'))) return { ok: false, reason: 'signature_mismatch' }
    const eventType = headers[FAKE_EVENT_TYPE_HEADER]
    return { ok: true, dedupeKey: eventId, ...(eventType ? { eventType: eventType.slice(0, 200) } : {}) }
  },
}
