import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CREDIT_FINDINGS as DOMAIN_FINDINGS } from '@nexus/factory-domain/sales/credit/credit'
import { ApiError } from '../../../../lib/api/errors'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { CREDIT_FINDINGS, LIMIT_VIEWS, type LimitRow } from './api'
import { designScreen } from './fixtures'
import { changeProblems, creditCanOf, creditCsv, creditLiveTouches, creditViewOf, heldPhrases, parseLimit, readProblem, usedTone } from './model'

/**
 * Finance › Receivables › Credit limits (SCR-151-credit, B-W2b-304): the lists equal factory-domain's and the API's, the
 * pure rules (who may do what, the view in the address, the bar's tone, what waits, the typed limit and the change's
 * problems, the refusals by kind, the live events, the CSV by grain), and every design case drawn in Italian and English
 * with no key or placeholder left on screen — and no amount for a person without the price grain.
 */

const row = (over: Partial<LimitRow>): LimitRow => ({
  termsId: 't',
  version: 1,
  party: { id: 'p', code: 'C-1', name: 'Demo; "quoted"' },
  company: { id: 'c', code: 'DEMO' },
  currency: 'EUR',
  limit: 1_000_000,
  used: 500_000,
  openOrders: 0,
  openInvoices: 500_000,
  overdue: 0,
  available: 500_000,
  overLimitBy: 0,
  usedPct: 50,
  onHold: false,
  findings: [],
  held: { orders: 0, releases: 0, shipments: 0, firstOrders: [] },
  changedAt: '2026-10-20T09:15:00.000Z',
  mayChange: true,
  ...over,
})

describe('credit limits (SCR-151-credit)', () => {
  it('mirrors the lists of factory-domain and the API', () => {
    expect(CREDIT_FINDINGS).toEqual(DOMAIN_FINDINGS)
    expect(LIMIT_VIEWS).toEqual(['ALL', 'OVER', 'HELD'])
  })

  it('says who may do what, the view of the address, the bar and what waits', () => {
    expect(creditCanOf(['sales.credit.view'])).toEqual({ view: true, price: false, change: false })
    expect(creditCanOf(['sales.credit.view', 'sales.credit.limits', 'money.price'])).toEqual({ view: true, price: true, change: true })
    expect(creditViewOf(new URLSearchParams('credit=OVER'))).toBe('OVER')
    expect(creditViewOf(new URLSearchParams('credit=nope'))).toBe('ALL')
    expect(usedTone(row({ usedPct: 40 }))).toBe('complete')
    expect(usedTone(row({ usedPct: 85 }))).toBe('partial')
    expect(usedTone(row({ usedPct: 106, findings: ['OVER_LIMIT'] }))).toBe('missing')
    expect(usedTone(row({ usedPct: null }))).toBe('unknown')
    expect(heldPhrases(row({ held: { orders: 2, releases: 0, shipments: 1, firstOrders: [] } }))).toEqual([
      { key: 'row.orders', count: 2 },
      { key: 'row.shipments', count: 1 },
    ])
  })

  it('reads a typed limit and refuses a change that is not one', () => {
    expect(parseLimit('25.000,00')).toBe(2_500_000)
    expect(parseLimit('25000')).toBe(2_500_000)
    expect(parseLimit('0')).toBe(0)
    expect(parseLimit('abc')).toBeNull()
    const current = { limit: 1_000_000, currency: 'EUR' }
    expect(changeProblems({ amountText: '12.000,00', currency: 'EUR', clear: false, reason: 'More orders' }, current)).toEqual([])
    expect(changeProblems({ amountText: '', currency: 'EUR', clear: false, reason: '' }, current)).toEqual(['amount', 'reason'])
    expect(changeProblems({ amountText: '10.000,00', currency: 'EUR', clear: false, reason: 'x' }, current)).toEqual(['same'])
    expect(changeProblems({ amountText: '', currency: 'EUR', clear: true, reason: 'Prepaid now' }, current)).toEqual([])
    expect(changeProblems({ amountText: '5', currency: 'EUR', clear: false, reason: 'x' }, null, false)).toEqual(['customer'])
  })

  it('names refusals by kind and the live events that touch credit', () => {
    expect(readProblem(new ApiError('conflict', 409, 'conflict', 'x'))).toBe('problem.conflict')
    expect(readProblem(new Error('x'))).toBe('problem.internal')
    expect(creditLiveTouches({ type: 'credit_check.recorded' })).toBe(true)
    expect(creditLiveTouches({ type: 'payment.allocated' })).toBe(true)
    expect(creditLiveTouches({ type: 'lot.lifecycle_changed' })).toBe(false)
  })

  it('exports the chosen rows; amounts only where the API sent them', () => {
    const csv = creditCsv([row({}), { ...row({}), limit: undefined, used: undefined, available: undefined, overdue: undefined }], (column) => column, 'it')
    const lines = csv.trim().split('\n')
    expect(lines[0]).toBe('customer;code;company;currency;limit;used;available;overdue;orders;releases;shipments')
    expect(lines[1]).toBe('"Demo; ""quoted""";C-1;DEMO;EUR;10000,00;5000,00;5000,00;0,00;0;0;0')
    expect(lines[2]).toBe('"Demo; ""quoted""";C-1;DEMO;EUR;;;;;0;0;0')
  })
})

const LEFT_KEY = /\b(?:noAccess|view|viewCount|col|row|finding|action|held|change|csv|keys|problem|common|empty|noMatch)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
const SAID = /\b(?:sales\.credit\.view|sales\.credit\.limits|sales\.credit\.checks|money\.price)\b/g
const EURO = /€\s?\d|\d\s?€/

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key or placeholder left on screen', () => {
  const screen = designScreen as unknown as DesignScreen<unknown>
  it(`${screen.screen}: ${screen.cases.length} cases × it, en`, () => {
    for (const item of screen.cases) {
      for (const locale of LOCALES) {
        const html = render(screen, item.model, locale).replace(SAID, '')
        expect(html.length, item.id).toBeGreaterThan(200)
        expect(html.match(LEFT_KEY)?.[0] ?? null, `${item.id} (${locale})`).toBeNull()
        expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${item.id} (${locale}) placeholder`).toBeNull()
      }
    }
  })

  it('read-only: no amount in the section; finance sees them', () => {
    const bare = render(screen, screen.cases.find((entry) => entry.id === 'read-only')!.model, 'en')
    expect(bare.slice(bare.indexOf('fw-frc-title'))).not.toMatch(EURO)
    const full = render(screen, screen.cases.find((entry) => entry.id === 'finance')!.model, 'en')
    expect(full).toContain('€15,000.00')
  })

  it('the dynamic words exist in both languages', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['sales-credit'])['sales-credit']!)
      const has = (key: string, params?: Record<string, string | number>) => expect(t(key, params), `${locale}: ${key}`).not.toBe(key)
      for (const view of LIMIT_VIEWS) {
        has(`view.${view}`)
        has(`viewCount.${view}`, { count: 1 })
      }
      for (const finding of CREDIT_FINDINGS) has(`finding.${finding}`)
      for (const kind of ['conflict', 'signed_out', 'forbidden', 'not_found', 'unavailable', 'rate_limited', 'invalid', 'internal']) has(`problem.${kind}`)
      for (const key of ['amount', 'reason', 'same', 'customer']) has(`change.problem.${key}`)
    }
  })
})
