import { readFileSync } from 'node:fs'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FAILURE_CODES, fakeScenariosFor, FAKE_SCENARIOS, failureKeyOf, isFinal, paymentStateOf, providerRuns, START_REFUSALS, startRefusalOf, UNAVAILABLE_CODES, unavailableKeyOf } from '../../lib/payments/online'
import { ApiError } from '../../lib/api/errors'
import type { DesignScreen } from '../../lib/design/design-screen'
import { LOCALES } from '../../lib/i18n/locales'
import { messagesFor } from '../../lib/i18n/messages'
import { I18nProvider } from '../../lib/i18n/provider'
import { linkTaskOf } from '../_nav/link-types'
import { designScreen as acceptScreen } from '../quote-accept/fixtures'
import { payPageSchema, type PayPage } from './api'
import { designScreen } from './fixtures'
import { cardFromPage, cardHeld, cardState, fakeButtons, failureKey, forOf, groupedIban, IDLE_CARD, paidOnline, titleOf, underWay } from './model'

const catalogue = (locale: 'it' | 'en') => JSON.parse(readFileSync(new URL(`../../../messages/${locale}/link-pay.json`, import.meta.url), 'utf8')) as Record<string, unknown>
const flat = (tree: Record<string, unknown>, prefix = ''): Record<string, string> =>
  Object.fromEntries(Object.entries(tree).flatMap(([key, value]) => (typeof value === 'string' ? [[`${prefix}${key}`, value]] : Object.entries(flat(value as Record<string, unknown>, `${prefix}${key}.`)))))

const page = (over: Partial<PayPage> = {}): PayPage => ({ ...(designScreen.cases[0]!.model.page as PayPage), ...over })
const intent = { id: 'i1', method: 'CARD' as const, amount: 100, currency: 'EUR', status: 'WAITING' as const, providerRef: 'pi_fake_x', failureCode: null, finishedAt: null, createdAt: '2026-11-03T09:00:00.000Z' }

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

const LEFT_KEY = /\b(?:title|loading|problem|status|what|kind|bank|card|done|quoteCard|copy)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/

describe('SCR-199 Pay online — the link page', () => {
  it('a PAYMENT link of an invoice or a deposit request opens it; W1’s DEPOSIT_INFO link opens it as deposit-pay', () => {
    expect(linkTaskOf({ purpose: 'PAYMENT', record: { type: 'Invoice' } })).toBe('pay')
    expect(linkTaskOf({ purpose: 'PAYMENT', record: { type: 'DepositRequest' } })).toBe('pay')
    expect(linkTaskOf({ purpose: 'DEPOSIT_INFO', record: { type: 'DepositRequest' } })).toBe('deposit-pay')
  })

  it('reads the API’s page and keeps nothing it does not need (the bank text, the card words, the live hint stay out)', () => {
    const read = payPageSchema.parse({ ...page(), language: 'it', live: { poll: 'x' }, card: { ...page().card, publishableKey: null, words: 'English words' }, bank: { ...page().bank!, text: 'Bank transfer of …' } })
    expect(read).not.toHaveProperty('live')
    expect(read.card).not.toHaveProperty('words')
    expect(read.bank).not.toHaveProperty('text')
  })

  it('names what is paid: the invoice, the deposit of an order (and its quote) or of a quote', () => {
    expect(titleOf(page())).toEqual({ key: 'title.depositOrder', params: { order: 'SO-2026-0088' } })
    expect(titleOf(page({ what: { ...page().what, orderNumber: null } }))).toEqual({ key: 'title.depositQuote', params: { quote: 'Q-2026-0188 v2' } })
    expect(titleOf(page({ what: { ...page().what, orderNumber: null, quoteDocument: null } }))).toEqual({ key: 'title.deposit' })
    expect(titleOf(page({ what: { ...page().what, target: 'INVOICE', number: 'FT-1' } }))).toEqual({ key: 'title.invoice', params: { number: 'FT-1' } })
    expect(forOf(page())?.key).toBe('what.forOrderQuote')
    expect(forOf(page({ what: { ...page().what, orderNumber: null, quoteDocument: null } }))).toBeNull()
    expect(groupedIban('IT60X0542811101000000123456')).toBe('IT60 X054 2811 1010 0000 0123 456')
  })

  it('card and SEPA are held with the reason: not offered (by its code), a live provider (GATE-SPEND), not euro, nothing open, offline', () => {
    expect(cardHeld(page(), false)).toBeNull()
    expect(cardHeld(page({ card: { available: false, methods: [], provider: null, mode: null, reason: 'NOT_ACTIVE' } }), false)).toBe('card.unavailable.NOT_ACTIVE')
    expect(cardHeld(page({ card: { available: false, methods: [], provider: null, mode: null, reason: 'SOMETHING_NEW' } }), false)).toBe('card.unavailable.NO_ACCOUNT')
    // Only the FAKE provider runs: a Stripe account (any mode) waits for the Owner's yes with the cost.
    expect(cardHeld(page({ card: { available: true, methods: ['CARD'], provider: 'STRIPE', mode: 'SANDBOX', reason: null } }), false)).toBe('card.unavailable.GATE_SPEND')
    expect(cardHeld(page({ card: { available: true, methods: ['CARD'], provider: 'STRIPE', mode: 'FAKE', reason: null } }), false)).toBe('card.unavailable.GATE_SPEND')
    expect(providerRuns({ name: 'PAYMENT_FAKE', mode: 'FAKE' })).toBe(true)
    expect(providerRuns({ provider: 'PAYMENT_FAKE', mode: 'LIVE' })).toBe(false)
    expect(cardHeld(page({ what: { ...page().what, currency: 'USD' } }), false)).toBe('card.refusal.CURRENCY')
    expect(cardHeld(page({ what: { ...page().what, open: 0 } }), false)).toBe('card.refusal.NOT_OPEN')
    expect(cardHeld(page(), true)).toBe('card.offline')
  })

  it('the FAKE provider’s buttons follow the step: a card, the bank’s confirmation, a SEPA mandate, the bank’s later answer', () => {
    expect(fakeScenariosFor('CARD', 'first')).toEqual(['succeed', 'decline', 'insufficient_funds', 'authenticate'])
    expect(fakeScenariosFor('CARD', 'confirm')).toEqual(['succeed', 'fail_authentication'])
    expect(fakeScenariosFor('SEPA_DEBIT', 'first')).toEqual(['succeed'])
    expect(fakeScenariosFor('SEPA_DEBIT', 'processing')).toEqual(['settle', 'return'])
    const ready = { ...IDLE_CARD, method: 'CARD' as const, phase: 'ready' as const, intent, fields: true }
    expect(fakeButtons(ready)).toEqual(['succeed', 'decline', 'insufficient_funds', 'authenticate'])
    expect(fakeButtons({ ...ready, confirming: true })).toEqual(['succeed', 'fail_authentication'])
    // A card the bank decides shows no button; a SEPA debit on its way shows the bank's later answer.
    expect(fakeButtons({ ...ready, phase: 'paying' })).toEqual([])
    expect(fakeButtons({ ...ready, method: 'SEPA_DEBIT', phase: 'paying', intent: { ...intent, method: 'SEPA_DEBIT' } })).toEqual(['settle', 'return'])
    // No client secret (the page reopened): no button.
    expect(fakeButtons({ ...ready, fields: false })).toEqual([])
    expect(fakeButtons({ ...ready, intent: { ...intent, status: 'FAILED' } })).toEqual([])
  })

  it('the payment’s state for the panel: the intent’s end wins; sent and still decided is waiting', () => {
    expect(paymentStateOf('ready', intent)).toBe('ready')
    expect(paymentStateOf('paying', intent)).toBe('waiting')
    expect(paymentStateOf('paying', { status: 'SUCCEEDED' })).toBe('succeeded')
    expect(paymentStateOf('ready', { status: 'CANCELLED' })).toBe('failed')
    expect(cardState({ ...IDLE_CARD, phase: 'starting' })).toBe('starting')
    expect(isFinal(null)).toBe(false)
    expect(isFinal({ status: 'FAILED' })).toBe(true)
  })

  it('a page opened while a payment of this link is under way follows it; a final one starts idle; paid or closed has no card step', () => {
    const waiting = page({ intent: { ...intent, method: 'SEPA_DEBIT' } })
    expect(underWay(waiting.intent)).toBe(true)
    expect(cardFromPage(waiting)).toMatchObject({ method: 'SEPA_DEBIT', phase: 'paying', fields: false })
    expect(cardFromPage(page({ intent: { ...intent, status: 'FAILED' } }))).toEqual(IDLE_CARD)
    expect(cardFromPage(page({ status: 'PAID' }), { ...IDLE_CARD, method: 'CARD', phase: 'ready', intent, fields: true })).toEqual(IDLE_CARD)
    // The same payment read again keeps the provider's fields and the bank's confirmation open.
    expect(cardFromPage(page({ intent }), { ...IDLE_CARD, method: 'CARD', phase: 'ready', intent, fields: true, confirming: true })).toMatchObject({ phase: 'ready', fields: true, confirming: true })
    // A failed payment shown on the page stays shown when the page is read again.
    const failed = { ...IDLE_CARD, method: 'CARD' as const, phase: 'paying' as const, intent: { ...intent, status: 'FAILED' as const } }
    expect(cardFromPage(page(), failed)).toBe(failed)
    expect(paidOnline(page({ intent: { ...intent, status: 'SUCCEEDED' } }))?.id).toBe('i1')
    expect(paidOnline(page())).toBeNull()
  })

  it('the provider’s reason and a refused start are worded from their codes, never from the API’s text', () => {
    expect(failureKey({ ...intent, status: 'FAILED', failureCode: 'card_declined' })).toBe('card.failure.card_declined')
    expect(failureKeyOf('something_else')).toBe('default')
    expect(unavailableKeyOf(null)).toBe('NO_ACCOUNT')
    expect(startRefusalOf(new ApiError('conflict', 409, 'conflict', 'A payment …', null, [{ path: 'payment/IN_PROGRESS' }]))).toBe('IN_PROGRESS')
    expect(startRefusalOf(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'payment/WHATEVER' }]))).toBeNull()
    expect(startRefusalOf(new Error('boom'))).toBeNull()
  })

  it('every code and scenario has its words in it and en (the same keys in both)', () => {
    const it_ = flat(catalogue('it'))
    const en = flat(catalogue('en'))
    expect(Object.keys(it_).sort()).toEqual(Object.keys(en).sort())
    const needed = [
      ...FAILURE_CODES.map((code) => `card.failure.${code}`),
      'card.failure.default',
      ...UNAVAILABLE_CODES.map((code) => `card.unavailable.${code}`),
      ...START_REFUSALS.map((code) => `card.refusal.${code}`),
      ...FAKE_SCENARIOS.map((scenario) => `card.scenario.${scenario}`),
      ...(['TO_PAY', 'PAID', 'CLOSED'] as const).map((status) => `status.${status}`),
    ]
    for (const key of needed) for (const [locale, words] of [['it', it_], ['en', en]] as const) expect(words[key], `${locale} ${key}`).toBeTruthy()
  })

  for (const locale of LOCALES) {
    it(`${designScreen.cases.length} cases draw in ${locale}: no key on screen, no field for card or bank data`, () => {
      for (const item of designScreen.cases) {
        const html = render(designScreen as unknown as DesignScreen<unknown>, item.model, locale)
        expect(html.length, item.id).toBeGreaterThan(200)
        expect(html.match(LEFT_KEY)?.[0] ?? null, `SCR-199/${item.id} (${locale})`).toBeNull()
        // The provider's own fields only: never an input that could take a card number, a CVC or an IBAN.
        expect(html, item.id).not.toMatch(/<input(?![^>]*type="radio")[^>]*>/)
        expect(html, item.id).not.toMatch(/autocomplete="cc-/)
      }
      const toPay = render(designScreen as unknown as DesignScreen<unknown>, designScreen.cases[0]!.model, locale)
      expect(toPay).toContain('IT60 X054 2811 1010 0000 0123 456')
    })
  }

  it('Italian words on the Italian page: the declined card, the SEPA debit on its way, paid', () => {
    const html = (id: string) => render(designScreen as unknown as DesignScreen<unknown>, designScreen.cases.find((item) => item.id === id)!.model, 'it')
    expect(html('card-declined')).toContain('La banca ha rifiutato la carta')
    expect(html('sepa-on-its-way')).toContain('Il denaro arriva')
    expect(html('paid')).toContain('Pagato — grazie')
    expect(html('card-held-live')).toContain('non è ancora attivo')
    expect(html('to-pay')).toContain('Acconto, 30')
  })
})

describe('SCR-099 — the quote’s deposit (B-W2b-199)', () => {
  it('after the acceptance: the bank transfer stays and card or SEPA is held with the reason (the accept used the link)', () => {
    const accepted = acceptScreen.cases.find((item) => item.id === 'accepted')!
    for (const locale of LOCALES) {
      const html = render(acceptScreen as unknown as DesignScreen<unknown>, accepted.model, locale)
      expect(html).toContain('IT60 X054 2811 1010 0000 0123 456')
      expect(html).toContain(locale === 'it' ? 'Paga con carta o addebito diretto SEPA' : 'Pay by card or SEPA Direct Debit')
      expect(html).toContain(locale === 'it' ? 'chiedi a Officina Demo' : 'ask Officina Demo')
      expect(html.match(/\bquoteCard\.[a-zA-Z]+/)?.[0] ?? null).toBeNull()
    }
  })

  it('a deposit received says so instead of the ways to pay', () => {
    const paid = acceptScreen.cases.find((item) => item.id === 'accepted-deposit-paid')!
    const html = render(acceptScreen as unknown as DesignScreen<unknown>, paid.model, 'en')
    expect(html).toContain('The deposit is received')
    expect(html).not.toContain('IT60 X054')
  })
})
