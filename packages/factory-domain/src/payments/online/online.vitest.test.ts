import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { PARTNER_ROLE_TEMPLATES } from '../../auth/roles/templates'
import { PORTAL_PAYMENTS_PAY, PORTAL_PAYMENTS_VIEW } from './permissions'
import { accountRefusal, failureCodeOf, failureWords, LIVE_CARD_PAYMENTS_ALLOWED, mayMove, paymentLinkMail, pickAccount, providerTextOk, receiptMail, statusOfEvent, statusOfProviderState } from './rules'
import { readIntentEvent, stripeSignature, stripeSignatureProblem } from './webhook'

const C1 = '00000000-0000-7000-8000-0000000000c1'
const account = (over: Partial<{ id: string; companyId: string | null; provider: string; mode: 'LIVE' | 'SANDBOX' | 'FAKE'; status: string; createdAt: Date }>) => ({
  id: over.id ?? 'a',
  companyId: over.companyId === undefined ? C1 : over.companyId,
  provider: over.provider ?? 'PAYMENT_FAKE',
  mode: over.mode ?? 'FAKE',
  status: over.status ?? 'ACTIVE',
  createdAt: over.createdAt ?? new Date('2026-01-01T00:00:00Z'),
})

describe('paying online: the rules (B-W2b-185)', () => {
  it('an intent moves forward only, and a final state never moves again', () => {
    expect(mayMove('CREATED', 'WAITING')).toBe(true)
    expect(mayMove('WAITING', 'SUCCEEDED')).toBe(true)
    expect(mayMove('WAITING', 'CREATED')).toBe(false)
    for (const final of ['SUCCEEDED', 'FAILED', 'CANCELLED'] as const) for (const to of ['CREATED', 'WAITING', 'SUCCEEDED', 'FAILED', 'CANCELLED'] as const) expect(mayMove(final, to)).toBe(false)
  })

  it('keeps no card number: the provider’s words are letters, digits, _ and - without a run of twelve digits', () => {
    expect(providerTextOk('pi_3MtwBwLkdIwHu7ix28a3tqPa')).toBe(true)
    expect(providerTextOk('card_declined')).toBe(true)
    expect(providerTextOk('pi_4242424242424242')).toBe(false)
    expect(providerTextOk('a b')).toBe(false)
    expect(failureCodeOf('card declined!')).toBe('card_declined_')
    expect(failureCodeOf('4000000000000002')).toBe('failed')
    expect(failureCodeOf(null)).toBe('failed')
  })

  it('GATE-SPEND: a LIVE Stripe account is not offered until the Owner’s yes; FAKE never in production', () => {
    expect(LIVE_CARD_PAYMENTS_ALLOWED).toBe(false)
    expect(accountRefusal(account({ provider: 'STRIPE', mode: 'LIVE' }), 'production')).toBe('GATE_SPEND')
    expect(accountRefusal(account({ provider: 'STRIPE', mode: 'SANDBOX' }), 'staging')).toBe(null)
    expect(accountRefusal(account({ mode: 'FAKE' }), 'production')).toBe('FAKE_IN_PRODUCTION')
    expect(accountRefusal(account({ mode: 'LIVE' }), 'local')).toBe('FAKE_PROVIDER_LIVE')
    expect(accountRefusal(account({ status: 'PAUSED' }), 'local')).toBe('NOT_ACTIVE')
    expect(accountRefusal(account({ provider: 'SES' }), 'local')).toBe('NOT_A_PAYMENT_ACCOUNT')
  })

  it('picks the company’s own usable account first, else a tenant-wide one, else says why there is none', () => {
    const tenantWide = account({ id: 't', companyId: null, createdAt: new Date('2025-01-01T00:00:00Z') })
    const own = account({ id: 'o' })
    expect(pickAccount([tenantWide, own], C1, 'local').account?.id).toBe('o')
    expect(pickAccount([tenantWide], C1, 'local').account?.id).toBe('t')
    expect(pickAccount([account({ id: 'x', companyId: 'other' })], C1, 'local')).toEqual({ account: null, refusal: 'NO_ACCOUNT' })
    expect(pickAccount([account({ provider: 'STRIPE', mode: 'LIVE' })], C1, 'production')).toEqual({ account: null, refusal: 'GATE_SPEND' })
  })

  it('reads the provider’s states and events as our statuses', () => {
    expect(statusOfProviderState('processing')).toBe('WAITING')
    expect(statusOfProviderState('succeeded')).toBe('SUCCEEDED')
    expect(statusOfEvent('payment_intent.succeeded', 'succeeded')).toBe('SUCCEEDED')
    expect(statusOfEvent('payment_intent.payment_failed', 'requires_payment_method')).toBe('FAILED')
    expect(statusOfEvent('payment_intent.canceled', 'canceled')).toBe('CANCELLED')
    expect(statusOfEvent('payment_intent.processing', 'processing')).toBe('WAITING')
    expect(statusOfEvent('payment_intent.created', 'requires_payment_method')).toBe(null)
    expect(statusOfEvent('charge.refunded', null)).toBe(null)
  })

  it('says the provider’s reason in our words, in Italian and English', () => {
    expect(failureWords('card_declined', 'en')).toBe('Your bank declined the card. Try another card or pay by transfer.')
    expect(failureWords('card_declined', 'it')).toContain('rifiutato la carta')
    expect(failureWords('something_new', 'en')).toBe('The payment did not go through. Try again or pay by transfer.')
  })

  it('writes the receipt and the payment page’s mail without any link in the stored text', () => {
    const receipt = receiptMail({ locale: 'en', what: 'Invoice FT-2026-00001', amount: '410.00 EUR', method: 'CARD', paidOn: '2026-11-07', reference: 'pi_fake_abc', companyName: 'Made-up S.r.l.', depositInvoiceFollows: false })
    expect(receipt.subject).toBe('Payment received: Invoice FT-2026-00001')
    expect(receipt.body).toContain('410.00 EUR by card for Invoice FT-2026-00001 on 2026-11-07')
    expect(receiptMail({ locale: 'it', what: 'Acconto', amount: '1.00 EUR', method: 'SEPA_DEBIT', paidOn: '07/11/2026', reference: 'x', companyName: 'X', depositInvoiceFollows: true }).body).toContain('La fattura di acconto segue per e-mail.')
    const stored = paymentLinkMail({ locale: 'en', what: 'Invoice FT-2026-00001', amount: '410.00 EUR', dueDate: '2026-12-01', expiresOn: '7/12/2026', message: null }, null)
    expect(stored.body).toContain('[A personal link, sent by e-mail only: it is not kept here.]')
    expect(paymentLinkMail({ locale: 'it', what: 'Fattura 1', amount: '1.00 EUR', dueDate: null, expiresOn: 'x', message: 'Grazie' }, 'https://example.invalid/l#token=t').body).toContain('https://example.invalid/l#token=t')
  })

  it('the portal’s pay permissions are partner-only and go to the customer’s Finance (its Admin follows), nobody else', () => {
    for (const permission of [PORTAL_PAYMENTS_VIEW, PORTAL_PAYMENTS_PAY]) expect(FACTORY_PERMISSIONS.get(permission)?.partner).toBe(true)
    const holders = PARTNER_ROLE_TEMPLATES.filter((template) => template.permissions.includes(PORTAL_PAYMENTS_PAY)).map((template) => template.key).sort()
    expect(holders).toEqual(['customer-admin', 'customer-finance'])
  })
})

describe('the provider’s webhook (Stripe’s shape, the fake’s too)', () => {
  const body = JSON.stringify({
    id: 'evt_1',
    type: 'payment_intent.payment_failed',
    data: { object: { id: 'pi_1', object: 'payment_intent', status: 'requires_payment_method', amount: 41000, amount_received: 0, currency: 'eur', metadata: { intentId: '0196F000-0000-7000-8000-000000000001' }, last_payment_error: { code: 'card_declined', decline_code: 'insufficient_funds' } } },
  })

  it('reads the event: ids, state, amount, currency, the decline code', () => {
    expect(readIntentEvent(body)).toEqual({ eventId: 'evt_1', type: 'payment_intent.payment_failed', providerRef: 'pi_1', intentId: '0196f000-0000-7000-8000-000000000001', state: 'requires_payment_method', amount: 41000, currency: 'EUR', failureCode: 'insufficient_funds' })
    expect(readIntentEvent('{"id":"evt_2","type":"charge.succeeded","data":{"object":{"id":"ch_1","object":"charge"}}}')).toBe(null)
    expect(readIntentEvent('not json')).toBe(null)
  })

  it('checks Stripe-Signature: the right secret within five minutes, never a stale or forged one', () => {
    const now = new Date('2026-11-07T10:00:00Z')
    const raw = new TextEncoder().encode(body)
    const header = stripeSignature('made-up-hook-secret-test', body, now)
    expect(stripeSignatureProblem(header, 'made-up-hook-secret-test', raw, now)).toBe(null)
    expect(stripeSignatureProblem(header, 'made-up-hook-secret-other', raw, now)).toBe('signature_mismatch')
    expect(stripeSignatureProblem(header, 'made-up-hook-secret-test', raw, new Date(now.getTime() + 6 * 60_000))).toBe('stale_timestamp')
    expect(stripeSignatureProblem(undefined, 'made-up-hook-secret-test', raw, now)).toBe('missing_signature')
    expect(stripeSignatureProblem(header, null, raw, now)).toBe('no_webhook_secret')
    expect(stripeSignatureProblem('t=1', 'made-up-hook-secret-test', raw, now)).toBe('malformed_signature')
  })
})
