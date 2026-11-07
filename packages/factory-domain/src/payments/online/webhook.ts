import { createHmac, timingSafeEqual } from 'node:crypto'
import { PROVIDER_STATES, type ProviderIntentEvent, type ProviderState } from './port'

/**
 * The payment provider's webhook, read (B-W2b-185): Stripe's event shape (`{ id: 'evt_…', type: 'payment_intent.<what>',
 * data: { object: { id: 'pi_…', status, amount, currency, metadata: { intentId }, last_payment_error } } }`), which the
 * fake provider posts too, and Stripe's `Stripe-Signature` header (`t=<unix seconds>,v1=<hex HMAC-SHA256(secret,
 * "<t>.<raw body>")>`, five minutes of tolerance). Pure: the API's inbound ledger verifies and stores the receipt, its
 * processor reads it with `readIntentEvent`.
 */

export const STRIPE_SIGNATURE_HEADER = 'stripe-signature'
export const STRIPE_TOLERANCE_MS = 5 * 60_000

const isState = (value: unknown): value is ProviderState => typeof value === 'string' && (PROVIDER_STATES as readonly string[]).includes(value)
const text = (value: unknown, max = 255): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : null)
const record = (value: unknown): Record<string, unknown> | null => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** One event of the body, or null when it is not about a payment intent (another object, a malformed body). */
export function readIntentEvent(body: string): ProviderIntentEvent | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  const event = record(parsed)
  const object = record(record(event?.data)?.object)
  const eventId = text(event?.id)
  const type = text(event?.type, 100)
  const providerRef = text(object?.id)
  if (!event || !object || !eventId || !type || !providerRef || object.object !== 'payment_intent') return null
  const metadata = record(object.metadata)
  const intentId = text(metadata?.intentId)
  const error = record(object.last_payment_error)
  const amount = typeof object.amount_received === 'number' && object.amount_received > 0 ? object.amount_received : typeof object.amount === 'number' ? object.amount : null
  return {
    eventId,
    type,
    providerRef,
    intentId: intentId && UUID.test(intentId) ? intentId.toLowerCase() : null,
    state: isState(object.status) ? object.status : null,
    amount: amount !== null && Number.isSafeInteger(amount) ? amount : null,
    currency: text(object.currency, 3)?.toUpperCase() ?? null,
    failureCode: text(error?.decline_code, 64) ?? text(error?.code, 64),
  }
}

const SIGNATURE_PART = /^([a-z0-9]+)=(.+)$/

/** The Stripe-Signature header for a body (the signing side: the fake provider and the tests). */
export function stripeSignature(secret: string, body: string, now: Date): string {
  const timestamp = String(Math.floor(now.getTime() / 1000))
  return `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex')}`
}

/** Checks a Stripe-Signature header: one of its v1 signatures matches, within the tolerance. A reason when it does not. */
export function stripeSignatureProblem(header: string | undefined, secret: string | null, rawBody: Uint8Array, now: Date): string | null {
  if (!secret) return 'no_webhook_secret'
  if (!header) return 'missing_signature'
  let timestamp: string | null = null
  const signatures: string[] = []
  for (const part of header.split(',')) {
    const match = SIGNATURE_PART.exec(part.trim())
    if (!match) continue
    if (match[1] === 't') timestamp = match[2]!
    else if (match[1] === 'v1') signatures.push(match[2]!)
  }
  if (!timestamp || !/^\d{1,12}$/.test(timestamp) || signatures.length === 0) return 'malformed_signature'
  if (Math.abs(now.getTime() - Number(timestamp) * 1000) > STRIPE_TOLERANCE_MS) return 'stale_timestamp'
  const expected = createHmac('sha256', secret).update(`${timestamp}.`, 'utf8').update(rawBody).digest()
  const matches = signatures.some((given) => /^[0-9a-f]{64}$/.test(given) && timingSafeEqual(expected, Buffer.from(given, 'hex')))
  return matches ? null : 'signature_mismatch'
}
