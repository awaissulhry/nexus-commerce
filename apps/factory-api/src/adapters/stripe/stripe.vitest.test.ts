import { describe, expect, it } from 'vitest'
import type { PaymentCall } from '@nexus/factory-domain/payments/online/port'
import { stripeSignature } from '@nexus/factory-domain/payments/online/webhook'
import { stripeAdapter } from './stripe'
import { stripeVerifier } from './webhook'

/** B-W2b-185: the Stripe adapter on a fake transport (no network, no key: GATE-SPEND), and Stripe's webhook signature. */

const INTENT = '0196f000-1234-7000-8000-000000000001'
// Made-up keys, built from parts so no scanner mistakes them for real ones.
const TEST_KEY = ['sk', 'test', 'abcdefgh1'].join('_')
const LIVE_KEY = ['sk', 'live', 'abcdefgh1'].join('_')
const sent: { url: string; method: string; headers: Record<string, string>; body?: string }[] = []
const answers: { status: number; body: unknown }[] = []
const transport = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
  sent.push({ url, ...init })
  const next = answers.shift() ?? { status: 500, body: {} }
  return { status: next.status, json: async () => next.body }
}

const call = (credentials: Record<string, unknown> | null, mode: 'LIVE' | 'SANDBOX' | 'FAKE' = 'SANDBOX'): PaymentCall & { ledger: unknown[] } => {
  const ledger: unknown[] = []
  return { account: { id: 'acc', tenantId: 't', companyId: null, provider: 'STRIPE', mode, settings: {} }, attempt: 1, signal: new AbortController().signal, idempotencyKey: INTENT, credentials: async <T>() => credentials as T, answer: (details) => void ledger.push(details), ledger }
}

describe('the Stripe adapter (B-W2b-185)', () => {
  const stripe = stripeAdapter({ fetch: transport, baseUrl: 'https://stripe.invalid' })

  it('makes a payment intent with our id as the idempotency key and in metadata; the ledger keeps id and state, never the client secret', async () => {
    answers.push({ status: 200, body: { id: 'pi_test_1', status: 'requires_payment_method', client_secret: 'pi_test_1_secret_abc' } })
    const ledgerCall = call({ secretKey: TEST_KEY })
    const intent = await stripe.createIntent(ledgerCall, { intentId: INTENT, tenantId: 't', method: 'SEPA_DEBIT', amount: 41_000, currency: 'EUR', description: 'Invoice FT-2026-00001' })
    expect(intent).toEqual({ providerRef: 'pi_test_1', state: 'requires_payment_method', clientSecret: 'pi_test_1_secret_abc' })
    const request = sent.at(-1)!
    expect(request.url).toBe('https://stripe.invalid/v1/payment_intents')
    expect(request.headers).toMatchObject({ authorization: `Bearer ${TEST_KEY}`, 'idempotency-key': INTENT, 'content-type': 'application/x-www-form-urlencoded' })
    expect(new URLSearchParams(request.body)).toEqual(new URLSearchParams({ amount: '41000', currency: 'eur', 'payment_method_types[0]': 'sepa_debit', description: 'Invoice FT-2026-00001', 'metadata[intentId]': INTENT, 'metadata[tenantId]': 't' }))
    expect(JSON.stringify(ledgerCall.ledger)).not.toContain('secret_abc')
  })

  it('refuses without a key, a live key on a sandbox, a FAKE account; says Stripe’s error code', async () => {
    await expect(stripe.retrieveIntent(call(null), 'pi_1')).rejects.toThrow(/no secret key/)
    await expect(stripe.retrieveIntent(call({ secretKey: LIVE_KEY }), 'pi_1')).rejects.toThrow(/test key only/)
    await expect(stripe.retrieveIntent(call({ secretKey: TEST_KEY }, 'FAKE'), 'pi_1')).rejects.toThrow(/LIVE or SANDBOX/)
    answers.push({ status: 402, body: { error: { code: 'card_declined', message: 'Your card was declined.' } } })
    await expect(stripe.retrieveIntent(call({ secretKey: TEST_KEY }), 'pi_1')).rejects.toMatchObject({ httpStatus: 402, message: 'Stripe answered 402: card_declined' })
  })

  it('cancels; an intent that cannot be cancelled any more answers its state', async () => {
    answers.push({ status: 200, body: { id: 'pi_1', status: 'canceled' } })
    await expect(stripe.cancelIntent(call({ secretKey: TEST_KEY }), 'pi_1')).resolves.toEqual({ state: 'canceled' })
    answers.push({ status: 400, body: { error: { code: 'payment_intent_unexpected_state' } } }, { status: 200, body: { id: 'pi_1', status: 'succeeded', client_secret: 'x' } })
    await expect(stripe.cancelIntent(call({ secretKey: TEST_KEY }), 'pi_1')).resolves.toEqual({ state: 'succeeded' })
  })
})

describe('Stripe’s webhook signature (B-W2b-185)', () => {
  const now = new Date('2026-11-07T10:00:00Z')
  const body = JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded', data: { object: { id: 'pi_1', object: 'payment_intent', status: 'succeeded', amount: 100, currency: 'eur', metadata: {} } } })
  const raw = new TextEncoder().encode(body)

  it('verifies with the account’s secret; the event id is the dedupe key, the intent its external id', () => {
    expect(stripeVerifier.verify({ rawBody: raw, headers: { 'stripe-signature': stripeSignature('made-up-hook-secret-1', body, now) }, secret: 'made-up-hook-secret-1', now })).toEqual({ ok: true, dedupeKey: 'evt_1', externalId: 'pi_1', eventType: 'payment_intent.succeeded' })
    expect(stripeVerifier.verify({ rawBody: raw, headers: { 'stripe-signature': stripeSignature('made-up-hook-secret-2', body, now) }, secret: 'made-up-hook-secret-1', now })).toEqual({ ok: false, reason: 'signature_mismatch' })
    const other = JSON.stringify({ id: 'evt_2', type: 'customer.created', data: { object: { id: 'cus_1', object: 'customer' } } })
    expect(stripeVerifier.verify({ rawBody: new TextEncoder().encode(other), headers: { 'stripe-signature': stripeSignature('made-up-hook-secret-1', other, now) }, secret: 'made-up-hook-secret-1', now })).toEqual({ ok: true, dedupeKey: 'evt_2', eventType: 'customer.created' })
  })
})
