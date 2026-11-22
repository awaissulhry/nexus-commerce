import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { canOf, order } from '../_demo/fixtures'
import { alsoBillsOf, freightOf, sharedInvoice } from './money-share'
import { totalsOf } from './money/totals' // F-OM-102

/**
 * F-OP-118 (order page plan N3; 10-order-page §7; B-OP-022) — Money = this order's share: the totals by the order's own share (never the
 * invoice's whole, never the customer's), a shared invoice's whole beside its share, the other orders it bills (named or counted) and its
 * freight in no order. F-OM-102: "Settled when …" became Totals' gaps with their doors (money/totals.vitest.test.ts). Every name and
 * number is made up.
 */

const invoice = (over: Record<string, unknown> = {}) => ({ id: 'i1', docType: 'TD24', number: '12/2026', status: 'DELIVERED', grossTotal: 120_000, paidAmount: 20_000, openAmount: 100_000, share: 70_000, openShare: 58_000, freight: 4_000, otherOrders: [{ id: 'o2', number: 'SO-DEMO-0151' }], otherOrdersHidden: 0, ...over })
const settlement = (over: Record<string, unknown> = {}) => ({ settled: false, gaps: ['NOT_PAID'], invoices: [invoice()], invoicedAmount: 120_000, creditedAmount: 0, paidAmount: 20_000, balanceDueAmount: 100_000, thisOrder: { paid: 12_000, stillToPay: 58_000, invoicedShare: 70_000, depositsPaid: 0 }, ...over })

describe('F-OP-118: Money = this order\'s share', () => {
  const value = order('PARTLY_SHIPPED')

  // F-OM-102: the totals are this order's share by the server's ONE rule (money/totals.ts: the order's `money`, else the settlement's
  // `thisOrder`), never the shared invoice's whole and never the web's gross − deposits (its own tests: money/totals.vitest.test.ts).
  it('the totals are this order\'s share (the API\'s thisOrder), never the shared invoice\'s whole', () => {
    const tiles = totalsOf({ order: value, settlement: settlement() as never, can: canOf('owner'), today: '2026-11-20' }).tiles!
    expect(tiles.find((tile) => tile.id === 'invoiced')!.amount).toBe(70_000)
    expect(tiles.find((tile) => tile.id === 'paid')!.amount).toBe(12_000)
    expect(tiles.find((tile) => tile.id === 'still')!.amount).toBe(58_000)
    // The invoice's whole (120 000) is never a total of the order.
    expect(tiles.some((tile) => tile.amount === 120_000)).toBe(false)
  })

  it('a shared invoice: the other orders it bills (the same customer\'s, named when reached), the rest counted; its freight in no order', () => {
    expect(sharedInvoice(invoice())).toBe(true)
    expect(sharedInvoice(invoice({ otherOrders: [], otherOrdersHidden: 0 }))).toBe(false)
    expect(alsoBillsOf(invoice({ otherOrdersHidden: 2 }))).toEqual({ orders: [{ id: 'o2', number: 'SO-DEMO-0151' }], hidden: 2 })
    expect(alsoBillsOf(invoice({ otherOrders: [], otherOrdersHidden: 1 }))).toEqual({ orders: [], hidden: 1 })
    expect(alsoBillsOf(invoice({ otherOrders: [], otherOrdersHidden: 0 }))).toBeNull()
    expect(freightOf(invoice())).toBe(4_000)
    expect(freightOf(invoice({ freight: 0 }))).toBeNull()
    expect(freightOf(invoice({ freight: undefined }))).toBeNull()
  })

  // F-OM-101 / 102: the pins moved with the code — the invoices are Invoices & credit notes' own file, the totals Totals' own.
  it('the tab: invoice total beside this order\'s share, the also-bills links, one statement link — no customer-wide figure', () => {
    // F-OM-203: the section draws its model (money/invoices.ts): Total · This order · Open, the statement one link.
    const invoices = readFileSync(new URL('./money/view/InvoicesSection.tsx', import.meta.url), 'utf8')
    expect(invoices).toContain("<div className=\"fw-om-ir-am fw-om-ir-share\">{t('money.share')}</div>")
    expect(invoices).toContain("t('money.statement', { customer: order.party.legalName })")
    const totals = readFileSync(new URL('./money/view/TotalsSection.tsx', import.meta.url), 'utf8')
    expect(totals).toContain('const totals = totalsOf({ order, settlement: settlementPart?.value ?? null, can: model.can,')
    for (const file of [invoices, totals]) expect(file).not.toMatch(/customerBalance|partyBalance|openCredit|creditLimit/)
  })

  // Lane agreement (the Owner: "Sales = no price"): a reader without the money.price grain reads no figure, no empty zero; the invoices
  // keep their numbers and states, their amounts, share and freight stay away. F-OM-101: the money wall is said ONCE, in the tab's head.
  it('without the price grain: no tile, no amount column, no freight — the money wall said once in the head', () => {
    // F-OM-203: the amounts and the freight by the price grain (money/invoices.ts); without it no amount column at all.
    const invoices = readFileSync(new URL('./money/invoices.ts', import.meta.url), 'utf8')
    expect(invoices).toContain('const freight = amounts && price ? freightOf(amounts) : null')
    expect(invoices).toContain("const total = !price ? null :")
    // F-OM-203 (B-OM-023): without the price grain no amount column; the Payment words only (has-pay) once the settlement names them.
    expect(readFileSync(new URL('./money/view/InvoicesSection.tsx', import.meta.url), 'utf8')).toContain("<div className={`fw-om-il${price ? '' : ` is-np${words ? ' has-pay' : ''}`}`}>")
    expect(totalsOf({ order: value, settlement: settlement() as never, can: canOf('sales'), today: '2026-11-20' }).tiles).toBeNull()
    expect(readFileSync(new URL('./money/head.ts', import.meta.url), 'utf8')).toContain("...(price ? [] : [word('moneyTab.head.wallPrice')])")
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      expect(t('moneyTab.head.wallPrice'), locale).not.toBe('moneyTab.head.wallPrice')
    }
  })

  it('the words exist in both languages', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of ['money.share', 'money.alsoBills']) expect(t(key), `${locale} ${key}`).not.toBe(key) // F-OM-303: money.invoiceWhole left (no screen read it)
      for (const [key, params] of [['money.freight', { amount: '€ 40' }], ['money.statement', { customer: 'Brand Alpha' }], ['money.alsoBillsHidden', { count: 2 }]] as const) expect(t(key, params), `${locale} ${key}`).not.toBe(key)
    }
  })
})
