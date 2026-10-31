import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { COMPLAINT_STATUSES as DOMAIN_COMPLAINTS } from '@nexus/factory-domain/quality/complaints/rules'
import { OPEN_RETURN_STATUSES as DOMAIN_OPEN, RETURN_STATUSES as DOMAIN_RETURNS } from '@nexus/factory-domain/sales/returns/rules'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { designScreen as customersScreen } from '../fixtures'
import { designScreen as customerScreen } from '../record/fixtures'
import { COMPLAINT_STATUSES, OPEN_RETURN_STATUSES, RETURN_STATUSES } from './api'
import { COMPLAINTS, OVERDUE_ROWS, RETURNS } from './_demo/fixtures'
import { customerMoneyCanOf, openAfterSales, overdueByParty, overdueOf, receivablesOfCustomer, returnsThisYear } from './model'

/**
 * The customer's Overdue and Returns numbers (B-W2a-81): the lists equal factory-domain's, what a customer owes late per
 * currency, the returns of the year and what is open, the link to Finance › Receivables, and the SCR-032 / SCR-033 W2a
 * cases drawn in both languages with no key on screen — the Overdue column absent without the price grain.
 */

describe('the lists mirror factory-domain', () => {
  it('return and complaint states', () => {
    expect(RETURN_STATUSES).toEqual(DOMAIN_RETURNS)
    expect(OPEN_RETURN_STATUSES).toEqual(DOMAIN_OPEN)
    expect(COMPLAINT_STATUSES).toEqual(DOMAIN_COMPLAINTS)
  })
})

describe('the numbers', () => {
  it('who sees what', () => {
    expect(customerMoneyCanOf(['receivables.view', 'money.price'])).toEqual({ receivables: true, price: true, returns: false, complaints: false })
  })

  it('overdue per customer and currency; a customer owing nothing late is absent', () => {
    const map = overdueByParty(OVERDUE_ROWS)
    const beispiel = OVERDUE_ROWS[2]!.customer.id
    expect(map.get(beispiel)).toEqual({
      amounts: [
        { currency: 'CHF', amount: 30000 },
        { currency: 'EUR', amount: 122000 },
      ],
      daysLate: 21,
      invoices: 2,
    })
    expect(overdueOf(OVERDUE_ROWS, OVERDUE_ROWS[0]!.customer.id)).toEqual({ amounts: [{ currency: 'EUR', amount: 427000 }], daysLate: 38, invoices: 3 })
    expect(overdueOf([{ ...OVERDUE_ROWS[0]!, overdue: 0, daysLate: null }], OVERDUE_ROWS[0]!.customer.id)).toBeNull()
    const bare = overdueByParty(OVERDUE_ROWS.map(({ overdue: _drop, ...row }) => row))
    expect(bare.get(beispiel)!.amounts.every((amount) => amount.amount === null)).toBe(true)
  })

  it('returns this year, what is open, newest first; the receivables link', () => {
    expect(returnsThisYear(RETURNS, '2026')).toEqual({ count: 3, units: 6, open: 2 })
    const open = openAfterSales(RETURNS, COMPLAINTS)
    expect(open.returns.map((entry) => entry.number)).toEqual(['RMA-2026-0012', 'RMA-2026-0007'])
    expect(open.complaints).toHaveLength(1)
    expect(receivablesOfCustomer('/w/DEMO', 'abc')).toBe('/w/DEMO/finance/receivables?party=abc')
  })
})

const LEFT_KEY = /\b(?:col|cell|money|now|returnStatus|complaintStatus|problem)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('the W2a design cases draw in both languages with no key on screen', () => {
  for (const screen of [customersScreen, customerScreen] as unknown as DesignScreen<unknown>[]) {
    it(`${screen.screen}: the w2a- cases × it, en`, () => {
      const cases = screen.cases.filter((entry) => entry.id.startsWith('w2a-') && /overdue|numbers/.test(entry.id))
      expect(cases.length).toBeGreaterThan(3)
      for (const item of cases) {
        for (const locale of LOCALES) {
          const html = render(screen, item.model, locale)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${item.id} (${locale})`).toBeNull()
          expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${item.id} (${locale}) placeholder`).toBeNull()
        }
      }
    })
  }

  it('the record shows Overdue and Returns this year; without receivables.view no Overdue tile', () => {
    const screen = customerScreen as unknown as DesignScreen<unknown>
    const full = render(screen, screen.cases.find((entry) => entry.id === 'w2a-numbers')!.model, 'en')
    expect(full).toContain('Overdue')
    expect(full).toContain('€4,270.00')
    expect(full).toContain('Returns in 2026')
    expect(full).toContain('Open returns and claims')
    expect(full).toContain('/finance/receivables?party=')
    const none = render(screen, screen.cases.find((entry) => entry.id === 'w2a-numbers-no-receivables')!.model, 'en')
    expect(none).not.toContain('€4,270.00')
    expect(none).not.toContain('/finance/receivables?party=')
  })

  it('the dynamic words exist in both languages', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['customer-money'])['customer-money']!)
      const has = (key: string, params?: Record<string, string | number>) => expect(t(key, params), `${locale}: ${key}`).not.toBe(key)
      for (const status of RETURN_STATUSES) has(`returnStatus.${status}`)
      for (const status of COMPLAINT_STATUSES) has(`complaintStatus.${status}`)
      for (const kind of ['conflict', 'signed_out', 'forbidden', 'not_found', 'unavailable', 'rate_limited', 'invalid', 'internal']) has(`problem.${kind}`)
      for (const key of ['cell.daysLate', 'cell.invoices', 'money.lateInvoices', 'money.oldestLate', 'now.more']) has(key, { count: 2 })
    }
  })
})
