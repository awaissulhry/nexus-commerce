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

// ---- F-OM-fx3 (fix wave 3, the walk's W-07, W-08, W-12, W-13; B-OM-026, B-OM-028) ----
describe('F-OM-fx3: the rows say more — payment words for every reader, what is deducted and billed, a rejected invoice\'s next step', () => {
  it('W-12: the deposit invoice\'s and the credit note\'s word-codes reach Sales and Read-only — words, never an amount', () => {
    const coded = settlement({
      depositInvoices: settlement().depositInvoices!.map((entry) => ({ ...entry, paymentState: 'PAID' as const })),
      creditNotes: settlement().creditNotes!.map((entry) => ({ ...entry, paymentState: 'CREDITED' as const })),
    })
    const sales = model('sales', shipped(), coded)
    expect(rowOf(sales, TD02_ID).payment).toEqual({ word: { key: 'moneyTab.invoices.pay.paid' }, tone: 'success' })
    expect(rowOf(sales, 'cn-1').payment).toEqual({ word: { key: 'moneyTab.invoices.pay.credited' }, tone: 'neutral' })
    for (const row of sales.rows) expect([row.total, row.share, row.open], row.id).toEqual([null, null, null])
  })

  it('W-13: a goods invoice says the TD02 it deducts (its amount with the price grain) and the shipment it bills; a TD02 where it was deducted and for which payment', () => {
    const read = settlement({
      invoices: settlement().invoices.map((entry) => ({ ...entry, deducts: [{ id: TD02_ID, number: TD02.number, amount: 228384 }], forShipments: [{ id: 'sh-1', number: 'SH-2026-0041' }] })),
      depositInvoices: settlement().depositInvoices!.map((entry) => ({ ...entry, deductedOn: { id: GOODS_ID, number: 'FA-2026-00052' }, forPayment: { paymentId: 'p-1', receivedOn: '2026-10-29' } })),
    })
    const goods = rowOf(model('finance', shipped(), read), GOODS_ID)
    expect(goods.subs).toContainEqual({ key: 'moneyTab.invoices.sub.deducts', params: { number: TD02.number }, money: { amount: 228384 } })
    expect(goods.subs).toContainEqual({ key: 'moneyTab.invoices.sub.forShipment', params: { numbers: 'SH-2026-0041' } })
    const td02 = rowOf(model('finance', shipped(), read), TD02_ID)
    expect(td02.subs).toContainEqual({ key: 'moneyTab.invoices.sub.deductedOn', params: { number: 'FA-2026-00052' } })
    expect(td02.subs).not.toContainEqual({ key: 'moneyTab.invoices.sub.deducted' })
    expect(td02.subs).toContainEqual({ key: 'moneyTab.invoices.sub.forPayment', days: { date: '2026-10-29' } })
    // A deposit invoice has no Open cell (never "€ 0.00").
    expect(td02.open).toBeNull()
    // Sales: the same words without the amount.
    const sales = rowOf(model('sales', shipped(), read), GOODS_ID)
    expect(sales.subs).toContainEqual({ key: 'moneyTab.invoices.sub.deductsWords', params: { number: TD02.number } })
    expect(sales.subs.flatMap(amountsOf)).toEqual([])
  })

  it('W-13: a rejected invoice says "Rejected — fix and resend" (its own life or the SDI read)', () => {
    const value = shipped()
    const rejected = { ...value, chain: { ...value.chain, invoices: value.chain.invoices.map((invoice) => (invoice.id === GOODS_ID ? { ...invoice, status: 'REJECTED' } : invoice)) } }
    expect(rowOf(model('finance', rejected), GOODS_ID).state).toEqual({ word: { key: 'moneyTab.invoices.state.rejected' }, tone: 'danger' })
    expect(rowOf(model('finance', shipped(), settlement(), { [TD02_ID]: { value: sdi('REJECTED', 'SEND_AGAIN'), problem: null } }), TD02_ID).state.word).toEqual({ key: 'moneyTab.invoices.state.rejected' })
  })

  it('W-07 / W-08: nothing invoiced is the head\'s one line (no box); the head\'s ⋯ opens Finance › Invoices › (and the statement then)', () => {
    const view = readFileSync(new URL('./view/InvoicesSection.tsx', import.meta.url), 'utf8')
    expect(view).toContain('const empty = view.rows.length === 0 && !model.settlement?.problem')
    expect(view).toContain("{statement && !empty ? <p className=\"fw-om-il-foot\">{statement}</p> : null}")
    expect(view).toContain("{ id: 'finance', label: t('moneyTab.invoices.finance'), href: `${model.prefix}/finance/invoices` }")
  })
})

// ---- F-OM-fx5w (fix wave 4, the look-only walk 31-A on real data): N4 · N5 · N9 in Invoices & credit notes. Every name and number is
// made up. ----
describe('F-OM-fx5w: the walk\'s gaps in Invoices & credit notes', () => {
  it('N9: without the price grain the answer names the invoice still open by its Payment word — "3 documents · FA-… is part paid"', () => {
    const coded = (paymentState: 'OPEN' | 'PART_PAID') => settlement({ invoices: settlement().invoices.map((invoice) => ({ ...invoice, paymentState })) })
    expect(model('sales', shipped(), coded('PART_PAID')).answer).toEqual({ key: 'moneyTab.invoices.countPart', params: { count: 3, number: 'FA-2026-00052' } })
    expect(model('sales', shipped(), coded('OPEN')).answer).toEqual({ key: 'moneyTab.invoices.countUnpaid', params: { count: 3, number: 'FA-2026-00052' } })
    expect(amountsOf(model('sales', shipped(), coded('PART_PAID')).answer)).toEqual([])
    // The price grain keeps the amount open on it; a rejected invoice is never the one named.
    expect(model('finance', shipped(), coded('PART_PAID')).answer.key).toBe('moneyTab.invoices.countOpen')
    const value = shipped()
    const rejected = { ...value, chain: { ...value.chain, invoices: value.chain.invoices.map((invoice) => (invoice.id === GOODS_ID ? { ...invoice, status: 'REJECTED' } : invoice)) } }
    expect(model('sales', rejected, coded('OPEN')).answer.key).not.toBe('moneyTab.invoices.countUnpaid')
  })

  it('N4 / N5: "Also bills" keeps a gap before its links; a draft says "Draft" once (its State) and its row ends with its ⋯', () => {
    const view = readFileSync(new URL('./view/InvoicesSection.tsx', import.meta.url), 'utf8')
    expect(view).toContain('<span className="fw-pt-sub fw-om-ir-also">')
    expect(view).not.toContain('fw-pt-sub fw-pt-inline')
    expect(readFileSync(new URL('./view/money.css', import.meta.url), 'utf8')).toContain('.fw-om-ir-n > .fw-om-ir-also { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--nds-space-2) var(--nds-space-4); }')
    // The number's door names what a draft lacks; its sub-line has no "Draft"; every row's ⋯ copies a link to it.
    expect(view).toContain("{`${invoice.number ?? t('moneyTab.invoices.noNumber')} ›`")
    expect(view).not.toContain(": t('money.draft'), ...row.subs.map(say)]")
    expect(view).toContain("const sub = [...(invoice.issueDate ? [formatDate(dayInstant(invoice.issueDate), { locale })] : []), ...row.subs.map(say)].join(' · ')")
    expect(view).toContain("label: t('moneyTab.menu.copyLinkRow'),")
    expect(view).not.toContain('items.length > 0 ? <LineMenuButton')
  })
})

describe('F-OM-203: the words', () => {
  it('exist in both languages', () => {
    const keys = ['info', 'keys', 'shipped', 'col.payment', 'pay.open', 'pay.part', 'pay.paid', 'pay.credited', 'pay.refund', 'sub.credits', 'sub.deducted', 'door.record', 'door.credit', 'door.sendSdi', 'door.fixSdi', 'door.payments', 'door.pdf', 'held.creditNote', 'sdiFailed', 'copyNumber', 'more',
      /* F-OM-fx3 */ 'finance', 'headMore', 'state.rejected', 'sub.deducts', 'sub.deductsWords', 'sub.forShipment', 'sub.forShipments', 'sub.deductedOn', 'sub.forPayment', /* F-OM-fx5w (N5) */ 'noNumber']
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of keys) expect(t(`moneyTab.invoices.${key}`, { number: 'N', amount: 'A', numbers: 'S', date: 'D' }), `${locale} ${key}`).not.toMatch(/moneyTab\.|\{/)
      for (const count of [1, 3]) for (const key of ['count', 'countOpen', 'countPaid', /* F-OM-fx5w (N9) */ 'countPart', 'countUnpaid']) expect(t(`moneyTab.invoices.${key}`, { count, number: 'N', amount: 'A' }), `${locale} ${key} ${count}`).toContain(String(count))
    }
  })
})
