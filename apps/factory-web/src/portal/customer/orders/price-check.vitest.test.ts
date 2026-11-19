import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { partnerTemplateOf } from '@nexus/factory-domain/auth/roles/templates'
import { PRICE_MATCHES as DOMAIN_MATCHES } from '@nexus/factory-domain/sales/brand-prices/match'
import type { ApiClient } from '../../../lib/api/client'
import { CATALOGUE, createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { scanText } from '../../../lib/testing/brand-scan'
import { BRAND_ALPHA, BRAND_BETA } from '../../../lib/testing/two-brands'
import { NS } from './model'
import {
  BRAND_PRICE_SOURCES,
  diffText,
  fetchPriceCheck,
  matchKey,
  PRICE_MATCHES,
  priceBodyOf,
  priceCardOf,
  priceCheckAccessOf,
  priceDraftOf,
  priceDraftProblems,
  priceHeldKeyOf,
  priceCheckSchema,
  saveBrandPrices,
  sourceKey,
  yourPriceOf,
  type PortalPriceCheck,
} from './price-check'
import { usePortalPriceCheck } from './use-price-check'
import { PriceCheckCard, type PriceCheckModel } from './view/PriceCheck'

/**
 * F-CP-143 (customer page plan C3, D2, D3; Owner O4; 11 §3.4; review B2, C3; picture 21): the portal order's price check, by role —
 * the customer's Buyer and Admin read it and give their price ("Your prices…" with a note), Finance reads it only, the Designer,
 * Production and Viewer never see a price ("Prices are not part of your access.", no call). Brand Alpha's made-up order only (its
 * office numbers are in the data, never drawn); nothing of Brand Beta on any of it.
 */

const t = (locale: 'it' | 'en') => createTranslator(locale, CATALOGUE[locale][NS] ?? {})
const ORDER = BRAND_ALPHA.ids.order
const lineId = (n: number) => `a1a1a1a1-0000-4000-8000-0000000002${String(n).padStart(2, '0')}`
const rowId = (n: number) => `a1a1a1a1-0000-4000-8000-0000000003${String(n).padStart(2, '0')}`

type Row = NonNullable<PortalPriceCheck['lines'][number]['row']>
const row = (n: number, over: Partial<Row> = {}): Row => ({ id: rowId(n), unitPrice: '92.00', netAmount: null, currency: 'EUR', source: 'PORTAL', note: null, enteredAt: '2026-11-19T09:00:00.000Z', version: 1, ...over })

/** Brand Alpha's made-up order: line 1 equal, line 2 one of theirs lower, line 3 typed by the factory from their PO. */
function alphaCheck(over: Partial<PortalPriceCheck> = {}): PortalPriceCheck {
  return {
    orderId: ORDER,
    currency: 'EUR',
    lines: [
      { lineId: lineId(1), seq: 10, label: `${BRAND_ALPHA.numbers.style} YEL`, pieces: 120, ourUnitPrice: '92.00', ourAmount: 1_104_000, brandAmount: 1_104_000, priceMatch: 'EQUAL', priceDiff: 0, row: row(1) },
      { lineId: lineId(2), seq: 20, label: `${BRAND_ALPHA.numbers.style} NAV`, pieces: 100, ourUnitPrice: '96.00', ourAmount: 960_000, brandAmount: 955_000, priceMatch: 'NOT_EQUAL', priceDiff: 5_000, row: row(2, { unitPrice: '95.50', note: 'As our PO says.' }) },
      // The API nulls an office note; the page never shows one either (review C3).
      { lineId: lineId(3), seq: 30, label: 'AX-500 Patch set', pieces: 40, ourUnitPrice: '16.00', ourAmount: 64_000, brandAmount: 63_000, priceMatch: 'NOT_EQUAL', priceDiff: 1_000, row: row(3, { unitPrice: '15.75', source: 'CUSTOMER_PO', note: 'office words never shown', version: 4 }) },
    ],
    total: { ourPrice: 2_128_000, brandPrice: 2_122_000, priceMatch: 'NOT_EQUAL', priceDiff: 6_000, priceNotEqualLines: 2, priceMissingLines: 0, priceOtherCurrency: 0, row: null },
    mayWrite: { allowed: true, why: null },
    ...over,
  }
}

const ROLES = ['customer-buyer', 'customer-finance', 'customer-admin', 'customer-designer', 'customer-production', 'customer-viewer'] as const
const seesPricesOf = (key: string) => partnerTemplateOf(key)!.grains.includes('price')
const mayAskOf = (key: string) => partnerTemplateOf(key)!.permissions.includes('portal.salesOrders.ask')
/** The API's mayWrite for an open order: the price grain AND portal.salesOrders.ask (B-CP-019). */
const mayWriteOf = (key: string) => seesPricesOf(key) && mayAskOf(key)

const cardModel = (over: Partial<PriceCheckModel> = {}): PriceCheckModel => ({ state: 'ready', check: alphaCheck(), access: 'write', held: null, dialog: null, notice: null, ...over })
const draw = (locale: 'it' | 'en', model: PriceCheckModel) => renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'portal', 'ds-words', NS]) }, createElement(PriceCheckCard, { model })))

describe('F-CP-143 — the portal order’s price check by role', () => {
  it('the codes are the domain’s; the answer parses (every key the price grain on the API side)', () => {
    expect([...PRICE_MATCHES]).toEqual([...DOMAIN_MATCHES])
    expect([...BRAND_PRICE_SOURCES]).toEqual(['PORTAL', 'CUSTOMER_PO', 'OFFICE'])
    expect(priceCheckSchema.parse(alphaCheck()).lines).toHaveLength(3)
  })

  it('by role: Buyer and Admin give their price, Finance reads only, Designer / Production / Viewer get nothing (no call)', () => {
    const expected = { 'customer-buyer': 'write', 'customer-finance': 'read', 'customer-admin': 'write', 'customer-designer': 'none', 'customer-production': 'none', 'customer-viewer': 'none' } as const
    for (const key of ROLES) {
      const access = priceCheckAccessOf(seesPricesOf(key), { mayWrite: { allowed: mayWriteOf(key), why: null } })
      expect(access, key).toBe(expected[key])
    }
    // Without the grain no check is read at all: the hook gives the page nothing to draw (the Lines tab says prices.none).
    const models: (PriceCheckModel | null)[] = []
    const Probe = ({ seesPrices }: { seesPrices: boolean }) => {
      models.push(usePortalPriceCheck({ api: {} as ApiClient, orderId: ORDER, seesPrices, status: 'IN_PRODUCTION', mayAsk: false, preview: false, offline: false, refreshKey: '', t: t('en'), locale: 'en' }).model)
      return null
    }
    for (const key of ROLES) renderToStaticMarkup(createElement(Probe, { seesPrices: seesPricesOf(key) }))
    expect(models.map((model) => model === null)).toEqual(ROLES.map((key) => !seesPricesOf(key)))
    expect(t('en')('prices.none')).toBe('Prices are not part of your access.')
  })

  it('the card’s words: agree · differ on {count} lines — change your price (you can add a note), never “write to us” · not given yet', () => {
    expect(priceCardOf(alphaCheck())).toEqual({ key: 'priceCheck.differ', tone: 'danger', count: 2, missing: 0 })
    expect(t('en')('priceCheck.differ', { count: 2 })).toBe('Our prices differ on 2 lines: change your price (you can add a note)')
    expect(t('it')('priceCheck.differ', { count: 2 })).toBe('I prezzi non coincidono su 2 righe: cambiate il vostro prezzo (potete aggiungere una nota)')
    expect(priceCardOf(alphaCheck({ total: { ...alphaCheck().total, priceMatch: 'EQUAL', priceDiff: 0, priceNotEqualLines: 0 } })).key).toBe('priceCheck.agree')
    expect(priceCardOf(alphaCheck({ total: { ...alphaCheck().total, priceMatch: 'NO_BRAND_PRICE', brandPrice: null, priceDiff: null, priceNotEqualLines: 0, priceMissingLines: 3 } }))).toEqual({ key: 'priceCheck.none', tone: 'neutral', missing: 3 })
    expect(priceCardOf(alphaCheck({ total: { ...alphaCheck().total, priceNotEqualLines: 0 } })).key).toBe('priceCheck.differTotal')
    expect(t('en')('priceCheck.agree')).toBe('Our prices agree')
    expect(t('en')('priceCheck.none')).toBe('You have not given your price yet')
    for (const locale of ['it', 'en'] as const) {
      for (const key of ['priceCheck.differ', 'priceCheck.differTotal', 'priceCheck.agree', 'priceCheck.none']) expect(t(locale)(key, { count: 2 }), `${key} ${locale}`).not.toMatch(/write to us|scriveteci|scrivici|^priceCheck\.|\{/i)
      const html = draw(locale, cardModel())
      expect(html, locale).toContain(t(locale)('priceCheck.differ', { count: 2 }).replace(/'/g, '&#x27;'))
      expect(html, locale).not.toMatch(/write to us|scriveteci/i)
    }
  })

  it('Buyer / Admin: “Your prices…” on the card; Finance: no button, it says who gives the price; a closed order keeps its prices', () => {
    for (const locale of ['it', 'en'] as const) {
      expect(draw(locale, cardModel()), locale).toContain(t(locale)('priceCheck.edit'))
      const finance = draw(locale, cardModel({ access: 'read', held: t(locale)('priceCheck.readsOnly'), check: alphaCheck({ mayWrite: { allowed: false, why: { it: 'x', en: 'x' } } }) }))
      expect(finance, locale).not.toContain(t(locale)('priceCheck.edit'))
      expect(finance, locale).toContain(t(locale)('priceCheck.readsOnly'))
    }
    expect(priceHeldKeyOf({ allowed: true, closed: false, preview: false, offline: false })).toBeNull()
    expect(priceHeldKeyOf({ allowed: false, closed: false, preview: false, offline: false })).toBe('priceCheck.readsOnly')
    expect(priceHeldKeyOf({ allowed: false, closed: true, preview: false, offline: false })).toBe('priceCheck.closed')
    expect(priceHeldKeyOf({ allowed: true, closed: false, preview: true, offline: false })).toBe('held.preview')
    expect(priceHeldKeyOf({ allowed: true, closed: false, preview: false, offline: true })).toBe('held.offline')
    expect(t('en')('priceCheck.closed')).toBe('A closed or cancelled order keeps its prices.')
  })

  it('review C3: a row the factory typed reads “Typed by the factory” — never the office’s note, never who typed it', () => {
    const [own, , factory] = alphaCheck().lines
    expect(yourPriceOf(factory!)).toEqual({ unit: '15.75', amount: 63_000, source: 'CUSTOMER_PO', note: null })
    expect(yourPriceOf(own!)).toEqual({ unit: '92.00', amount: 1_104_000, source: 'PORTAL', note: null })
    expect(yourPriceOf(alphaCheck().lines[1]!).note).toBe('As our PO says.')
    expect(yourPriceOf({ row: null, brandAmount: null })).toEqual({ unit: null, amount: null, source: null, note: null })
    expect(t('en')(sourceKey('OFFICE'))).toBe('Typed by the factory')
    expect(t('en')(sourceKey('CUSTOMER_PO'))).toContain('typed by the factory')
    expect(t('it')(sourceKey('OFFICE'))).toBe('Inserito dalla fabbrica')
    expect(t('en')(sourceKey('PORTAL'))).toBe('Typed by you')
    for (const locale of ['it', 'en'] as const) expect(draw(locale, cardModel()), locale).not.toContain('office words never shown')
  })

  it('the check and the difference in words: Equal · Not equal · No price of yours yet; + we ask more, − we ask less', () => {
    expect(PRICE_MATCHES.map((match) => t('en')(matchKey(match)))).toEqual(['Equal', 'Not equal', 'No price of yours yet'])
    expect(t('en')(matchKey(null))).toBe('No price of yours yet')
    const money = (minor: number) => `€${(minor / 100).toFixed(2)}`
    expect(diffText(5_000, money)).toBe('+€50.00')
    expect(diffText(-1_000, money)).toBe('−€10.00')
    expect(diffText(0, money)).toBe('€0.00')
    expect(diffText(null, money)).toBeNull()
    expect(t('en')('priceCheck.diffHint')).toBe('Difference = our price minus yours: + we ask more, − we ask less.')
  })

  it('“Your prices…”: what changed goes at the version read with the note; an own price emptied is taken away; a factory row is replaced, never only removed', () => {
    const check = alphaCheck()
    const draft = priceDraftOf(check, 'it')
    expect(draft.prices[lineId(2)]).toBe('95,50')
    expect(priceBodyOf(check, draft)).toBeNull()
    // Line 2 raised to our price, with a note; line 1 emptied (their own: removed); line 3 emptied (the factory's: stays).
    const body = priceBodyOf(check, { prices: { ...draft.prices, [lineId(2)]: '96,00', [lineId(1)]: '', [lineId(3)]: '' }, note: ' Agreed on the phone. ' })
    expect(body).toEqual({ currency: 'EUR', rows: [{ lineId: lineId(2), unitPrice: '96.00', note: 'Agreed on the phone.', version: 1 }], remove: [{ id: rowId(1), version: 1 }] })
    // Typing over the factory's price replaces it with theirs (its version read).
    expect(priceBodyOf(check, { prices: { ...draft.prices, [lineId(3)]: '16' }, note: '' })).toEqual({ currency: 'EUR', rows: [{ lineId: lineId(3), unitPrice: '16', version: 4 }], remove: [] })
    // A line with no price yet: its first price, no version.
    const fresh = alphaCheck({ lines: [{ ...check.lines[0]!, row: null, brandAmount: null, priceMatch: null, priceDiff: null }] })
    expect(priceBodyOf(fresh, { prices: { [lineId(1)]: '91.5' }, note: '' })).toEqual({ currency: 'EUR', rows: [{ lineId: lineId(1), unitPrice: '91.5' }], remove: [] })
    expect(priceDraftProblems({ prices: { [lineId(1)]: 'abc', [lineId(2)]: '12,5' }, note: '' })).toEqual({ lines: { [lineId(1)]: 'priceCheck.problem' }, note: null })
    expect(priceDraftProblems({ prices: {}, note: 'x'.repeat(1001) }).note).toBe('priceCheck.noteLong')
    expect(JSON.stringify(body)).not.toMatch(/party|company/i)
  })

  it('W-CP-1: the calls name the customer’s own order by id only, at /portal/sales-orders (never /portal/orders)', async () => {
    const calls: { method: string; path: string; body?: unknown }[] = []
    const api = {
      get: async (path: string) => {
        calls.push({ method: 'GET', path })
        return alphaCheck()
      },
      request: async (method: string, path: string, options: { body?: unknown }) => {
        calls.push({ method, path, body: options.body })
        return alphaCheck()
      },
    } as unknown as ApiClient
    await fetchPriceCheck(api, ORDER)
    await saveBrandPrices(api, ORDER, { currency: 'EUR', rows: [{ lineId: lineId(2), unitPrice: '96.00', version: 1 }], remove: [] })
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([`GET /portal/sales-orders/${ORDER}/price-check`, `PUT /portal/sales-orders/${ORDER}/brand-prices`])
    expect(calls.some((call) => call.path.startsWith('/portal/orders/'))).toBe(false)
  })

  it('brand wall: Brand Alpha’s card shows nothing of Brand Beta and no office series, in it and en', () => {
    for (const locale of ['it', 'en'] as const) {
      for (const model of [cardModel(), cardModel({ access: 'read', held: t(locale)('priceCheck.readsOnly') }), cardModel({ state: 'loading', check: null }), cardModel({ state: 'error', check: null })]) {
        const html = draw(locale, model)
        expect(scanText(html, BRAND_BETA), locale).toEqual([])
        expect(html, locale).not.toContain(BRAND_ALPHA.numbers.order)
        expect(html.match(/\bpriceCheck\.[a-zA-Z_.]+/)?.[0] ?? null, locale).toBeNull()
      }
    }
  })
})
