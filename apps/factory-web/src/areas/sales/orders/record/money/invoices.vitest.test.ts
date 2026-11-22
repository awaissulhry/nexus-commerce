import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import { canOf, order, PAID, sdi, SETTLEMENT_SHIPPED, TD02, TD02_ID } from '../../_demo/fixtures'
import { INVOICE_PAYMENT_STATES as DOMAIN_PAYMENT_STATES } from '@nexus/factory-domain/invoicing/from-shipment/settlement'
import { INVOICE_PAYMENT_STATES, type ChainInvoice, type Order, type Settlement } from '../../api'
import { invoicesOf } from './invoices'
import { amountsOf } from './word'

/**
 * F-OM-203 (order MONEY tab, 10-design §6; M5-B1 … B9) — Invoices & credit notes: ONE State column (the SDI life; a failed SDI read
 * with its own Retry), the Payment in words, the deposit invoices' and credit notes' amounts (B-OM-003), the doors into Finance's own
 * windows (each only with its right; a credit note's held in words), "Invoice shipped goods…" from Finance's own preset. Every name
 * and number is made up.
 */

const PREFIX = '/w/DEMO'
const href = (invoice: ChainInvoice) => `${PREFIX}/finance/invoices/${invoice.id}`
const GOODS_ID = '0190f0e2-2121-7000-8000-000000000002'
const CREDIT: ChainInvoice = { id: 'cn-1', number: 'NC-2026-00002', docType: 'TD04', status: 'DELIVERED', issueDate: '2026-11-20', depositRequestId: null }
const shipped = (over: Partial<Order> = {}): Order => {
  const value = order('SHIPPED', over)
  return { ...value, chain: { ...value.chain, depositRequests: [PAID], invoices: [...value.chain.invoices, CREDIT] } }
}
const settlement = (over: Partial<Settlement> = {}): Settlement => ({
  ...SETTLEMENT_SHIPPED,
  invoices: SETTLEMENT_SHIPPED.invoices.filter((invoice) => invoice.docType !== 'TD02').map((invoice) => ({ ...invoice, paidAmount: 300000, openAmount: 232896, share: 532896 })),
  depositInvoices: [{ id: TD02_ID, number: TD02.number, status: 'DELIVERED', issueDate: '2026-10-29', gross: 228384, credited: 0, deductedNet: 187200, depositRequestId: PAID.id }],
  creditNotes: [{ id: 'cn-1', number: 'NC-2026-00002', status: 'DELIVERED', issueDate: '2026-11-20', gross: 12200, creditOfId: GOODS_ID }],
  ...over,
})
const model = (role: Parameters<typeof canOf>[0], value = shipped(), read: Settlement | null = settlement(), sdiParts: Parameters<typeof invoicesOf>[0]['sdi'] = {}) => invoicesOf({ order: value, settlement: read, sdi: sdiParts, can: canOf(role), invoiceHref: href, prefix: PREFIX })
const rowOf = (view: ReturnType<typeof invoicesOf>, id: string) => view.rows.find((row) => row.id === id)!

describe('F-OM-203: one row per document — its state, its payment in words, its amounts', () => {
  it('the goods invoice part paid: Total · This order · Open; the TD02 paid, deducted; the credit note credits the invoice', () => {
    const view = model('finance')
    const goods = rowOf(view, GOODS_ID)
    expect(goods).toMatchObject({ total: 532896, share: 532896, open: 232896, payment: { word: { key: 'moneyTab.invoices.pay.part' }, tone: 'warning' } })
    const td02 = rowOf(view, TD02_ID)
    expect(td02).toMatchObject({ total: 228384, payment: { word: { key: 'moneyTab.invoices.pay.paid' } } })
    expect(td02.subs).toContainEqual({ key: 'moneyTab.invoices.sub.deducted' })
    const credit = rowOf(view, 'cn-1')
    expect(credit).toMatchObject({ total: 12200, payment: { word: { key: 'moneyTab.invoices.pay.credited' } } })
    expect(credit.subs).toContainEqual({ key: 'moneyTab.invoices.sub.credits', params: { number: 'FA-2026-00052' } })
    expect(view.answer).toEqual({ key: 'moneyTab.invoices.countOpen', params: { count: 3, number: 'FA-2026-00052' }, money: { amount: 232896 } })
  })

  it('ONE State column: the invoice\'s own life, the SDI read\'s words where read; a failed read says so with its own Retry', () => {
    expect(rowOf(model('finance'), GOODS_ID).state).toEqual({ word: { key: 'invoiceStatus.DELIVERED' }, tone: 'success' })
    const read = { [TD02_ID]: { value: sdi('AT_SDI', 'WAIT'), problem: null } }
    expect(rowOf(model('finance', shipped(), settlement(), read), TD02_ID).state.word).toEqual({ key: 'sdi.state.AT_SDI' })
    expect(rowOf(model('finance', shipped(), settlement(), { [TD02_ID]: { value: null, problem: 'problem.read.unavailable' } }), TD02_ID).sdi).toBe('failed')
    expect(rowOf(model('finance', shipped(), settlement(), { [TD02_ID]: { value: null, problem: null } }), TD02_ID).sdi).toBe('reading')
  })

  it('paid in full, a refund due, all paid; without the price grain no amount (and, without the word-code, no payment word)', () => {
    const paid = settlement({ invoices: [{ id: GOODS_ID, docType: 'TD01', number: 'FA-2026-00052', status: 'DELIVERED', grossTotal: 532896, paidAmount: 532896, openAmount: 0 }] })
    expect(rowOf(model('finance', shipped(), paid), GOODS_ID).payment!.word.key).toBe('moneyTab.invoices.pay.paid')
    expect(model('finance', shipped(), paid).answer).toEqual({ key: 'moneyTab.invoices.countPaid', params: { count: 3 } })
    const refund = settlement({ invoices: [{ id: GOODS_ID, docType: 'TD01', number: 'FA-2026-00052', status: 'DELIVERED', grossTotal: 532896, paidAmount: 532896, openAmount: 0, refundDueAmount: 12200 }] })
    expect(rowOf(model('finance', shipped(), refund), GOODS_ID).payment!.word.key).toBe('moneyTab.invoices.pay.refund')
    const sales = model('sales')
    for (const row of sales.rows) {
      expect([row.total, row.share, row.open, row.payment], row.id).toEqual([null, null, null, null])
      expect(row.subs.flatMap(amountsOf), row.id).toEqual([])
    }
    expect(sales.answer).toEqual({ key: 'moneyTab.invoices.count', params: { count: 3 } })
  })

  // F-OM-203 (B-OM-023, S3 #1857): the settlement names each goods invoice's payment in a word-code, for every invoices.view reader.
  it('Sales reads the Payment words from the settlement\'s word-code — never an amount; "all paid" said in words too', () => {
    expect(INVOICE_PAYMENT_STATES).toEqual(DOMAIN_PAYMENT_STATES)
    const coded = (paymentState: (typeof INVOICE_PAYMENT_STATES)[number]) => settlement({ invoices: settlement().invoices.map((invoice) => ({ ...invoice, paymentState })) })
    const sales = model('sales', shipped(), coded('PART_PAID'))
    const goods = rowOf(sales, GOODS_ID)
    expect(goods.payment).toEqual({ word: { key: 'moneyTab.invoices.pay.part' }, tone: 'warning' })
    expect([goods.total, goods.share, goods.open]).toEqual([null, null, null])
    // The deposit invoice and the credit note carry no word-code: their payment stays the price grain's.
    expect(rowOf(sales, TD02_ID).payment).toBeNull()
    for (const [state, key] of [['OPEN', 'open'], ['PAID', 'paid'], ['CREDITED', 'credited'], ['REFUND_DUE', 'refund']] as const) expect(rowOf(model('sales', shipped(), coded(state)), GOODS_ID).payment!.word.key).toBe(`moneyTab.invoices.pay.${key}`)
    expect(model('sales', shipped(), coded('PAID')).answer).toEqual({ key: 'moneyTab.invoices.countPaid', params: { count: 3 } })
    // The word-code wins over the amounts for a price holder too (one rule with the server).
    expect(rowOf(model('finance', shipped(), coded('REFUND_DUE')), GOODS_ID).payment!.word.key).toBe('moneyTab.invoices.pay.refund')
    // The view draws the Payment column for Sales once a row carries the words (has-pay), never an amount column.
    const view = readFileSync(new URL('./view/InvoicesSection.tsx', import.meta.url), 'utf8')
    expect(view).toContain("const words = !price && view.rows.some((row) => row.payment !== null)")
    expect(view).toContain("is-np${words ? ' has-pay' : ''}")
  })
})

describe('F-OM-203: the doors — Finance\'s own windows, each only with its right', () => {
  const ids = (role: Parameters<typeof canOf>[0], id: string, value = shipped()) => rowOf(model(role, value), id).doors.map((door) => door.id)

  it('Finance on the goods invoice: Record payment… (?new=1&invoice=), Credit note… (?do=credit), Payments and write-off, Documents and PDF', () => {
    const doors = rowOf(model('finance'), GOODS_ID).doors
    expect(doors.map((door) => door.id)).toEqual(['record', 'credit', 'payments', 'pdf'])
    expect(doors.find((door) => door.id === 'record')!.href).toBe(`${PREFIX}/finance/payments?new=1&invoice=${encodeURIComponent(GOODS_ID)}`)
    expect(doors.find((door) => door.id === 'credit')!.href).toBe(`${PREFIX}/finance/invoices/${GOODS_ID}?do=credit`)
  })

  it('a credit note\'s Credit note… is held in words; an issued invoice not sent: Send to SDI ›; a rejected one: Fix and resend ›', () => {
    expect(rowOf(model('finance'), 'cn-1').doors.find((door) => door.id === 'credit')).toEqual({ id: 'credit', label: { key: 'moneyTab.invoices.door.credit' }, href: null, held: { key: 'moneyTab.invoices.held.creditNote' } })
    const value = shipped()
    const issued = { ...value, chain: { ...value.chain, invoices: value.chain.invoices.map((invoice) => (invoice.id === GOODS_ID ? { ...invoice, status: 'ISSUED' } : invoice.id === 'cn-1' ? { ...invoice, status: 'REJECTED' } : invoice)) } }
    expect(rowOf(model('finance', issued), GOODS_ID).doors.find((door) => door.id === 'sdi')!.label).toEqual({ key: 'moneyTab.invoices.door.sendSdi' })
    expect(rowOf(model('finance', issued), 'cn-1').doors.find((door) => door.id === 'sdi')!.label).toEqual({ key: 'moneyTab.invoices.door.fixSdi' })
  })

  it('Sales (invoices.view, no payments.record, no invoices.manage, no grain): no door into Finance at all; a closed order: no Record payment', () => {
    expect(ids('sales', GOODS_ID)).toEqual([])
    expect(ids('finance', GOODS_ID, shipped({ status: 'CLOSED' }))).not.toContain('record')
  })

  it('"Invoice shipped goods…": Finance\'s own From-DDTs window with this order\'s DDTs chosen (the existing preset, invoices.manage)', () => {
    const acts = readFileSync(new URL('../use-money-acts.ts', import.meta.url), 'utf8')
    expect(acts).toContain("const mayInvoice = permissions.includes('invoices.manage')")
    expect(acts).toContain("order.settlement.missing.some((gap) => gap.code === 'NOT_INVOICED')")
    expect(acts).toContain('fromDdtsCandidates(api, [order.id], abort.signal)')
    expect(acts).toContain('setInvoiceShipped(draft ? { href: fromDdtsHref(prefix, draft) } : null)')
    expect(readFileSync(new URL('./view/InvoicesSection.tsx', import.meta.url), 'utf8')).toContain('<Link href={shipped.href}>{t(\'moneyTab.invoices.shipped\')}</Link>')
  })
})

describe('F-OM-203: the words', () => {
  it('exist in both languages', () => {
    const keys = ['info', 'keys', 'shipped', 'col.payment', 'pay.open', 'pay.part', 'pay.paid', 'pay.credited', 'pay.refund', 'sub.credits', 'sub.deducted', 'door.record', 'door.credit', 'door.sendSdi', 'door.fixSdi', 'door.payments', 'door.pdf', 'held.creditNote', 'sdiFailed', 'copyNumber', 'more']
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of keys) expect(t(`moneyTab.invoices.${key}`, { number: 'N' }), `${locale} ${key}`).not.toMatch(/moneyTab\.|\{/)
      for (const count of [1, 3]) for (const key of ['count', 'countOpen', 'countPaid']) expect(t(`moneyTab.invoices.${key}`, { count, number: 'N', amount: 'A' }), `${locale} ${key} ${count}`).toContain(String(count))
    }
  })
})
