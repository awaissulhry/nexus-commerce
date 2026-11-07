import type { SignatureVerifier, VerifyInput, VerifyResult } from '@nexus/factory-domain/ports/signature'
import { readIntentEvent, STRIPE_SIGNATURE_HEADER, stripeSignatureProblem } from '@nexus/factory-domain/payments/online/webhook'

/**
 * Stripe's webhook signature (B-W2b-185): the `Stripe-Signature` header over the raw body with the endpoint's signing
 * secret (the account's webhook secret, SecretValue purpose integration.webhook), five minutes of tolerance. The event id
 * (`evt_…`) is the receipt's dedupe key, so Stripe's retries of one event are stored once; the payment intent's id is its
 * external id. A FAKE account's deliveries are checked by the factory's fake verifier instead (platform/inbound).
 */
export const stripeVerifier: SignatureVerifier = {
  verify({ rawBody, headers, secret, now }: VerifyInput): VerifyResult {
    const problem = stripeSignatureProblem(headers[STRIPE_SIGNATURE_HEADER], secret, rawBody, now)
    if (problem) return { ok: false, reason: problem }
    let event: ReturnType<typeof readIntentEvent> = null
    try {
      event = readIntentEvent(new TextDecoder('utf-8', { fatal: true }).decode(rawBody))
    } catch {
      return { ok: false, reason: 'body_not_utf8' }
    }
    if (event) return { ok: true, dedupeKey: event.eventId, externalId: event.providerRef, eventType: event.type }
    // A signed event about another object (a charge, a customer): kept by its id, processed as nothing to do.
    try {
      const parsed = JSON.parse(new TextDecoder().decode(rawBody)) as { id?: unknown; type?: unknown }
      if (typeof parsed.id === 'string' && parsed.id.length > 0) return { ok: true, dedupeKey: parsed.id.slice(0, 255), ...(typeof parsed.type === 'string' ? { eventType: parsed.type.slice(0, 200) } : {}) }
    } catch {
      // not JSON
    }
    return { ok: false, reason: 'not_an_event' }
  },
}
