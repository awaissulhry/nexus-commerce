import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { order } from '../_demo/fixtures'
import { alsoBillsOf, depositsReceivedOf, freightOf, settledWhenOf, sharedInvoice, shareTotalsOf } from './money-share'

/**
 * F-OP-118 (order page plan N3; 10-order-page §7; B-OP-022) — Money = this order's share: the totals by the order's own share (never the
 * invoice's whole, never the customer's), a shared invoice's whole beside its share, the other orders it bills (named or counted), its
 * freight in no order, and "Settled when …" said once. Every name and number is made up.
 */

const invoice = (over: Record<string, unknown> = {}) => ({ id: 'i1', docType: 'TD24', number: '12/2026', status: 'DELIVERED', grossTotal: 120_000, paidAmount: 20_000, openAmount: 100_000, share: 70_000, openShare: 58_000, freight: 4_000, otherOrders: [{ id: 'o2', number: 'SO-DEMO-0151' }], otherOrdersHidden: 0, ...over })
const settlement = (over: Record<string, unknown> = {}) => ({ settled: false, gaps: ['NOT_PAID'], invoices: [invoice()], invoicedAmount: 120_000, creditedAmount: 0, paidAmount: 20_000, balanceDueAmount: 100_000, thisOrder: { paid: 12_000, stillToPay: 58_000, invoicedShare: 70_000, depositsPaid: 0 }, ...over })

describe('F-OP-118: Money = this order\'s share', () => {
  const value = order('PARTLY_SHIPPED')

  it('the totals are this order\'s share (the API\'s thisOrder), never the shared invoice\'s whole', () => {
    const totals = shareTotalsOf(value, settlement() as never, { viewInvoices: true })
    expect(totals.map((total) => total.key)).toEqual(['money.gross', 'money.invoicedShare', 'money.paidHere', 'money.toPayHere', 'money.depositPaid'])
    expect(totals.find((total) => total.key === 'money.invoicedShare')!.amount).toBe(70_000)
    expect(totals.find((total) => total.key === 'money.paidHere')!.amount).toBe(12_000)
    expect(totals.find((total) => total.key === 'money.toPayHere')!.amount).toBe(58_000)
    // The invoice's whole (120 000) is never a total of the order.
    expect(totals.some((total) => total.amount === 120_000)).toBe(false)
  })

  it('still to pay exists before the first invoice too; without invoices.view no invoiced or paid figure is drawn', () => {
    const deposits = depositsReceivedOf(value)
    const plain = shareTotalsOf(value, null, { viewInvoices: false })
    expect(plain.map((total) => total.key)).toEqual(['money.gross', 'money.toPayHere', 'money.depositPaid'])
    expect(plain[1]!.amount).toBe(Math.max(0, (value.grossAmount ?? 0) - deposits))
    // An older answer (no thisOrder): its invoice-wide figures, said as before.
    const older = shareTotalsOf(value, settlement({ thisOrder: undefined }) as never, { viewInvoices: true })
    expect(older.find((total) => total.key === 'money.toPayHere')!.amount).toBe(100_000)
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

  it('settled is invoice-wide and said once: "Settled when 12/2026 is paid in full (it also bills SO-0151)"', () => {
    expect(settledWhenOf(settlement() as never)).toEqual({ key: 'money.settledWhenShared', params: { invoice: '12/2026', numbers: 'SO-DEMO-0151' } })
    expect(settledWhenOf(settlement({ invoices: [invoice({ otherOrders: [] })] }) as never)).toEqual({ key: 'money.settledWhen', params: { invoice: '12/2026' } })
    expect(settledWhenOf(settlement({ settled: true }) as never)).toBeNull()
    expect(settledWhenOf(settlement({ invoices: [invoice({ openAmount: 0 })] }) as never)).toBeNull()
    expect(settledWhenOf(null)).toBeNull()
  })

  it('the tab: invoice total beside this order\'s share, the also-bills links, one statement link — no customer-wide figure', () => {
    const tab = readFileSync(new URL('./view/MoneyTab.tsx', import.meta.url), 'utf8')
    expect(tab).toContain("t('money.invoiceWhole'), t('money.share'), t('money.col.open')")
    expect(tab).toContain('shareTotalsOf(order, settlement, { viewInvoices: model.can.viewInvoices })')
    expect(tab).toContain("t('money.statement', { customer: order.party.legalName })")
    expect(tab).not.toMatch(/customerBalance|partyBalance|openCredit|creditLimit/)
  })

  // Lane agreement (the Owner: "Sales = no price"): a reader without the money.price grain reads the app's held words — no figure,
  // no empty zero; the invoices keep their numbers and states, their amounts, share, freight and "settled when" stay away.
  it('without the price grain: the held words in place of every figure (summary.noPrice), no amount column, no freight, no settled line', () => {
    const tab = readFileSync(new URL('./view/MoneyTab.tsx', import.meta.url), 'utf8')
    expect(tab).toContain("<p className=\"fw-so-hint\">{t('summary.noPrice')}</p>")
    expect(tab).toContain('const showMoney = model.can.price && !!settlement')
    expect(tab).toContain('const freight = amounts && model.can.price ? freightOf(amounts) : null')
    // Without the grain the API drops openAmount (money.price): "Settled when …" is not said either.
    expect(settledWhenOf(settlement({ invoices: [invoice({ openAmount: undefined, grossTotal: undefined, share: undefined })] }) as never)).toBeNull()
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      expect(t('summary.noPrice'), locale).not.toBe('summary.noPrice')
    }
  })

  it('the words exist in both languages', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of ['money.invoicedShare', 'money.paidHere', 'money.toPayHere', 'money.share', 'money.invoiceWhole', 'money.alsoBills']) expect(t(key), `${locale} ${key}`).not.toBe(key)
      for (const [key, params] of [['money.freight', { amount: '€ 40' }], ['money.settledWhen', { invoice: '12/2026' }], ['money.settledWhenShared', { invoice: '12/2026', numbers: 'SO-1' }], ['money.statement', { customer: 'Brand Alpha' }], ['money.alsoBillsHidden', { count: 2 }]] as const) expect(t(key, params), `${locale} ${key}`).not.toBe(key)
    }
  })
})
