import { describe, expect, it } from 'vitest'
import type { PaymentCall } from '@nexus/factory-domain/payments/online/port'
import { providerTextOk } from '@nexus/factory-domain/payments/online/rules'
import { readIntentEvent, stripeSignatureProblem } from '@nexus/factory-domain/payments/online/webhook'
import { fakeVerifier } from '../../platform/inbound/verifiers'
import { fakeClientSecret, fakeProviderRef, FakePaymentProvider, intentIdOfFakeRef, readFakeClientSecret } from './fake'

/** B-W2b-185: the FAKE payment provider (no network, Stripe's words). */

const TENANT = '0196f000-0000-7000-8000-0000000000aa'
const ACCOUNT = '0196f000-0000-7000-8000-0000000000bb'
const INTENT = '0196f000-1234-7000-8000-000000000001'
const NOW = new Date('2026-11-07T10:00:00Z')

const call = (mode: 'FAKE' | 'LIVE' = 'FAKE'): PaymentCall & { answers: unknown[] } => {
  const answers: unknown[] = []
  return { account: { id: ACCOUNT, tenantId: TENANT, companyId: null, provider: 'PAYMENT_FAKE', mode, settings: {} }, attempt: 1, signal: new AbortController().signal, idempotencyKey: INTENT, credentials: async () => null, answer: (details) => void answers.push(details), answers }
}

describe('the FAKE payment provider (B-W2b-185)', () => {
  it('its ids hold no digit (never a run of twelve) and give the intent back; its client secret names tenant and account', () => {
    const ref = fakeProviderRef(INTENT)
    expect(ref).toMatch(/^pi_fake_[a-p]{32}$/)
    expect(providerTextOk(ref)).toBe(true)
    expect(intentIdOfFakeRef(ref)).toBe(INTENT)
    const secret = fakeClientSecret(ref, TENANT, ACCOUNT)
    expect(readFakeClientSecret(secret)).toEqual({ providerRef: ref, tenantId: TENANT, accountId: ACCOUNT })
    expect(readFakeClientSecret(secret.replace(/.$/, (last) => (last === '0' ? '1' : '0')))).toBe(null)
    expect(readFakeClientSecret('pi_live_x')).toBe(null)
  })

  it('makes an intent for a FAKE account only, the same one again for the same id; the ledger never sees the client secret', async () => {
    const fake = new FakePaymentProvider({ now: () => NOW })
    const made = call()
    const first = await fake.createIntent(made, { intentId: INTENT, tenantId: TENANT, method: 'CARD', amount: 41_000, currency: 'EUR', description: 'Invoice FT-2026-00001' })
    expect(first).toMatchObject({ providerRef: fakeProviderRef(INTENT), state: 'requires_payment_method' })
    expect(made.answers).toHaveLength(1)
    expect(JSON.stringify(made.answers)).not.toContain('secret')
    expect((await fake.createIntent(call(), { intentId: INTENT, tenantId: TENANT, method: 'CARD', amount: 41_000, currency: 'EUR', description: 'x' })).providerRef).toBe(first.providerRef)
    await expect(fake.createIntent(call('LIVE'), { intentId: INTENT, tenantId: TENANT, method: 'CARD', amount: 1, currency: 'EUR', description: 'x' })).rejects.toThrow(/FAKE/)
    fake.failNext(1, 503)
    await expect(fake.retrieveIntent(call(), first.providerRef)).rejects.toMatchObject({ httpStatus: 503 })
    await expect(fake.cancelIntent(call(), first.providerRef)).resolves.toEqual({ state: 'canceled' })
    expect((await fake.retrieveIntent(call(), first.providerRef)).state).toBe('canceled')
  })

  it('confirms by scenario and posts Stripe-shaped webhooks the fake verifier and Stripe’s check both accept', () => {
    const fake = new FakePaymentProvider({ now: () => NOW })
    const facts = { intentId: INTENT, tenantId: TENANT, providerRef: fakeProviderRef(INTENT), method: 'CARD' as const, amount: 41_000, currency: 'EUR' }
    const paid = fake.confirm(facts, 'succeed', 'made-up-hook-secret-fake')
    expect(paid.state).toBe('succeeded')
    expect(paid.webhooks).toHaveLength(1)
    const [webhook] = paid.webhooks
    const raw = new TextEncoder().encode(webhook!.body)
    expect(fakeVerifier.verify({ rawBody: raw, headers: webhook!.headers, secret: 'made-up-hook-secret-fake', now: NOW })).toMatchObject({ ok: true, dedupeKey: webhook!.eventId, eventType: 'payment_intent.succeeded' })
    expect(stripeSignatureProblem(webhook!.headers['stripe-signature'], 'made-up-hook-secret-fake', raw, NOW)).toBe(null)
    expect(readIntentEvent(webhook!.body)).toMatchObject({ providerRef: facts.providerRef, intentId: INTENT, state: 'succeeded', amount: 41_000, currency: 'EUR' })
    expect(fake.confirm(facts, 'decline', 'made-up-hook-secret-fake')).toMatchObject({ state: 'requires_payment_method', errorCode: 'card_declined' })
    expect(readIntentEvent(fake.confirm(facts, 'decline', 'made-up-hook-secret-fake').webhooks[0]!.body)?.failureCode).toBe('card_declined')
    expect(fake.confirm(facts, 'authenticate', 'made-up-hook-secret-fake').state).toBe('requires_action')
    expect(() => fake.confirm(facts, 'settle', 'made-up-hook-secret-fake')).toThrow(/not one of a CARD/)
    const sepa = { ...facts, method: 'SEPA_DEBIT' as const }
    expect(fake.confirm(sepa, 'succeed', 'made-up-hook-secret-fake').state).toBe('processing')
    expect(fake.confirm(sepa, 'settle', 'made-up-hook-secret-fake').state).toBe('succeeded')
    expect(fake.confirm(sepa, 'return', 'made-up-hook-secret-fake').errorCode).toBe('debit_not_authorized')
  })
})
