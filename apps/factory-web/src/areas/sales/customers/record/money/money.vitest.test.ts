import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { OpenItem } from '../../../../finance/_shared/api'
import type { OpenRefunds } from '../../../../finance/payments/refunds/api'
import type { AgeingRow, Reminder } from '../../../../finance/receivables/api'
import type { ReminderStop } from '../../../../finance/receivables/reminder-stops/api'
import { formatDate } from '../../../../../lib/i18n/format'
import { LOCALES, type Locale } from '../../../../../lib/i18n/locales'
import { createScopedTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import { dayInstant } from '../../../orders/model'
import { money } from '../../../quotes/model'
import { sentenceOf } from '../../../orders/record/money/view/say'
import { amountsOf, type MoneyWord } from '../../../orders/record/money/word'
import type { CompanyTerms, Glance } from '../../depth/api'
import { balanceOf, moneyBadgeOf } from './balance'
import { collectOf, COLLECT_SHOWN, IN_PLACE_ACTS } from './collect'
import { documentQueryOf, documentsOf, DOCUMENTS_SHOWN, paymentWordOf } from './documents' // F-CM-202
import type { InvoiceRow } from '../../../../finance/_shared/api'
import type { PaymentRow } from '../../../../finance/_shared/api' // F-CM-203
import { PAYMENTS_SHOWN, receivedOf, refundsMadeOf } from './received' // F-CM-203
import { moneyAnswerOf, type CustomerAnswer } from './head'
import { CM, MONEY_TAB_NAMESPACES, moneyChangeIsOurs, moneyTabCanOf, partFailed, partReady, READING, type MoneyTabInput } from './model'
import { sayOf } from './say'
import { CUSTOMER_MONEY_ANCHORS, CUSTOMER_MONEY_SECTIONS } from './sections'
import { recordPaymentForCustomerHref } from './doors' // F-CM-204
import { creditOf } from './credit' // F-CM-301
import { chaseOf } from './chase' // F-CM-302
import { marginOf, priceCheckOf } from './worth' // F-CM-303
import { returnsCreditOf } from './received' // F-CM-303 (E52)
import type { LimitRow } from '../../../../finance/receivables/credit/api'
import type { CommercialTerms } from '../../terms/api'
import type { Margins } from '../../../../finance/margins/api'
import type { OrderRow } from '../../../orders/api'
import type { CustomerReturn } from '../../money/api'
import { createElement } from 'react' // F-CM T.2
import { render, textOf } from '../../../../../lib/record-thread/parts/testing' // F-CM T.2
import { CM_CASES, cmTabOf, CmMoneyDesign, type CmCaseModel, type CmRole } from './_demo/fixtures' // F-CM T.2
import { inShell } from '../../../../parties/_shared/fixtures' // F-CM T.2: the tab drawn in the office shell, as the gallery draws it

/**
 * F-CM-101…105 (customer page › MONEY tab, cm-w1 W1.1; 10-design §4–§5.2; 18-lead-settles Z3–Z11, Z20, Z21, Z26) — the pure rules of
 * the tab: the answer line in EN + IT with and without the price grain, the drop order, the late deposit said and never dropped, a
 * part left out (never 0) without its read or its right, Balance's figures and needs, the badge, To collect's rows and acts per role,
 * and the walls (no amount without the price grain; no rule filters a list by customer). Every name and number is made up.
 */

const TODAY = '2026-11-24'
const PREFIX = '/w/SEED-A'
const COMPANY_A = { id: 'co-a', code: 'SEED-A', name: 'Seed Company A' }
const COMPANY_B = { id: 'co-b', code: 'SEED-B', name: 'Seed Company B' }
const CUSTOMER = { id: 'p-1', code: 'C-0001', name: 'Seed Customer One S.r.l.' }

const VIEWS = ['receivables.view', 'payments.view', 'invoices.view', 'orders.view', 'sales.credit.view', 'parties.view']
const ROLES = {
  owner: [...VIEWS, 'money.price', 'money.margin', 'payments.record', 'payments.refund', 'payments.void', 'invoices.manage', 'invoices.issue', 'orders.moneyPlan', 'orders.waive', 'sales.credit.limits', 'receivables.reminders.manage', 'receivables.statements.send', 'parties.hold'],
  finance: [...VIEWS, 'money.price', 'money.margin', 'payments.record', 'payments.refund', 'payments.void', 'invoices.manage', 'invoices.issue', 'orders.moneyPlan', 'sales.credit.limits', 'receivables.reminders.manage', 'receivables.statements.send', 'parties.hold'],
  sales: [...VIEWS, 'parties.hold'],
  readonly: [...VIEWS],
} as const
type Role = keyof typeof ROLES

const ageingRow = (over: Partial<AgeingRow> = {}): AgeingRow => ({
  company: COMPANY_A,
  customer: CUSTOMER,
  currency: 'EUR',
  open: 842000,
  overdue: 244000,
  buckets: { NOT_DUE: 598000, D1_30: 244000, D31_60: 0, D61_90: 0, OVER_90: 0 },
  invoices: 3,
  oldestDueDate: '2026-11-12',
  daysLate: 12,
  lastPaymentOn: '2026-11-14',
  remindersSent: 1,
  lastReminderAt: null,
  remindersWaiting: 1,
  creditLimitUsed: null,
  ...over,
})
const invoiceItem = (id: string, dueDate: string, open: number, over: Partial<OpenItem> = {}): OpenItem => ({ target: 'INVOICE', id, number: `FT-2026-0000${id.slice(-1)}`, docType: 'TD01', fiscalDocument: null, stepKind: null, orderId: 'o-2', orderNumber: 'SEED-SO-0002', date: '2026-10-01', dueDate, currency: 'EUR', amount: open, openAmount: open, ...over })
const requestItem = (id: string, dueDate: string, open: number, over: Partial<OpenItem> = {}): OpenItem => ({ target: 'DEPOSIT_REQUEST', id, number: null, docType: null, fiscalDocument: 'TD02', stepKind: 'DEPOSIT', orderId: `o-${id}`, orderNumber: `SEED-SO-00${id.slice(-2)}`, date: '2026-11-01', dueDate, currency: 'EUR', amount: open, openAmount: open, ...over })
const ITEMS: OpenItem[] = [
  invoiceItem('inv-1', '2026-11-12', 244000),
  invoiceItem('inv-2', '2026-12-10', 300000),
  invoiceItem('inv-3', '2026-12-20', 298000),
  requestItem('rq-11', '2026-11-20', 300000),
  requestItem('rq-12', '2026-11-26', 400000, { stepKind: 'BEFORE_SHIPPING' }),
  requestItem('rq-13', '2026-12-01', 222320),
]
const REFUNDS: OpenRefunds = {
  counts: { refundsDue: 1, creditNotesToRefund: 0 },
  refundsDue: [
    { id: 'rf-1', version: 1, companyId: COMPANY_A.id, partyId: CUSTOMER.id, party: { code: CUSTOMER.code, legalName: CUSTOMER.name }, source: 'CREDIT_NOTE', creditNote: { id: 'cn-1', number: 'NC-2026-00001', issueDate: '2026-11-10', creditOfId: 'inv-0', creditOfNumber: 'FT-2026-00000', creditOfDocType: 'TD01' }, payment: null, method: 'BANK_TRANSFER', amount: 61000, currency: 'EUR', dueDate: '2026-11-28', status: 'DUE', paidOn: null, externalRef: null, cancelReason: null, voidReason: null, internalNote: null, createdAt: '2026-11-10T09:00:00Z' },
  ],
  creditNotesToRefund: [],
  asOf: TODAY,
}
const glanceOf = (over: { onHold?: boolean; over?: boolean } = {}): Glance => ({
  party: { id: CUSTOMER.id, code: CUSTOMER.code, name: CUSTOMER.name, kind: 'ORGANISATION', status: 'ACTIVE' },
  company: COMPANY_A,
  hold: { onHold: !!over.onHold, holds: over.onHold ? [{ id: 'h-1', reason: 'CREDIT', words: 'Credit check', everyCompany: false, placedAt: '2026-11-15T08:00:00Z', placedBy: null }] : [] },
  team: null,
  requirements: { count: 0, rows: [] },
  promises: null,
  credit: { state: over.over ? 'OVER' : 'WITHIN', currency: 'EUR', limit: 2000000, used: over.over ? 2420000 : 1688000, available: over.over ? null : 312000, overLimitBy: over.over ? 420000 : null, overdue: 244000, usedPct: null, onHold: !!over.onHold },
  samples: null,
  profiles: null,
  riders: null,
  repairs: null,
  withheld: [],
  readAt: '2026-11-24T09:44:00Z',
})

/** The busy customer as each role reads it: the server drops every amount without the price grain (the tests do the same). */
function input(role: Role = 'owner', over: Partial<MoneyTabInput> = {}): MoneyTabInput {
  const can = moneyTabCanOf(ROLES[role])
  const strip = <T extends object>(value: T, keys: readonly string[]): T => (can.price ? value : (Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key))) as T))
  return {
    party: { id: CUSTOMER.id, name: CUSTOMER.name, currency: 'EUR', paymentTerms: '30 days end of month' },
    company: { id: COMPANY_A.id, name: COMPANY_A.name },
    companies: 1,
    can,
    today: TODAY,
    ageing: partReady([strip(ageingRow(), ['open', 'overdue', 'buckets'])]),
    ageingElsewhere: partReady([]),
    openItems: partReady({ items: ITEMS.map((item) => strip(item, ['amount', 'openAmount'])), creditBalance: [can.price ? { currency: 'EUR', amount: 120000 } : { currency: 'EUR' }] }),
    refunds: partReady({ ...REFUNDS, refundsDue: REFUNDS.refundsDue.map((refund) => strip(refund, ['amount'])) }),
    stops: partReady([]),
    reminders: partReady([]),
    summary: null,
    shipped: null,
    glance: { status: 'ready', value: glanceOf() },
    openOrders: null,
    priceDiffer: null,
    ...over,
  }
}

const sayIn = (locale: Locale, currency = 'EUR') => sayOf(createScopedTranslator(locale, messagesFor(locale, MONEY_TAB_NAMESPACES), CM), locale, currency)
const lineOf = (answer: CustomerAnswer, locale: Locale, at = 0) => sentenceOf(answer.lines[at]!.parts.map(sayIn(locale, answer.lines[at]!.currency ?? 'EUR')))
const m = (minor: number, locale: Locale, currency = 'EUR') => money(minor, currency, locale)
const d = (day: string, locale: Locale) => formatDate(dayInstant(day), { locale })
const everyWord = (answer: CustomerAnswer): MoneyWord[] => [...answer.lines.flatMap((line) => line.parts), ...answer.elsewhere.flatMap((also) => [also.words, also.door]), ...(answer.nothing ? [answer.nothing] : [])]

describe('F-CM-102: the answer line (10-design §4; Z3, Z20)', () => {
  it('the busy customer, with the price grain: four parts — on account steps back; the late deposit is said inside the deposits part (EN + IT)', () => {
    const answer = moneyAnswerOf(input('owner'))
    expect(answer.reading).toBe(false)
    expect(answer.tone).toBe('danger')
    expect(answer.lines).toHaveLength(1)
    expect(answer.lines[0]!.parts.map((part) => part.key)).toEqual(['cm.answer.owes', 'cm.answer.late', 'cm.answer.pair', 'cm.answer.giveBack'])
    expect(lineOf(answer, 'en')).toBe(`Owes ${m(842000, 'en')} on 3 invoices · ${m(244000, 'en')} late, oldest 12 days · ${m(922320, 'en')} in deposits asked, 1 late since ${d('2026-11-20', 'en')} · ${m(61000, 'en')} to give back.`)
    expect(lineOf(answer, 'it')).toBe(`Deve ${m(842000, 'it')} su 3 fatture · ${m(244000, 'it')} scaduti, la più vecchia da 12 giorni · ${m(922320, 'it')} di acconti richiesti, 1 scaduto dal ${d('2026-11-20', 'it')} · ${m(61000, 'it')} da restituire.`)
    expect(answer.wall).toEqual([])
  })

  it('the busy customer without the price grain (Sales, Read-only): the same parts in words, no amount, the wall said once (EN + IT)', () => {
    for (const role of ['sales', 'readonly'] as const) {
      const answer = moneyAnswerOf(input(role))
      expect(lineOf(answer, 'en'), role).toBe(`Owes on 3 invoices · 1 invoice late, oldest 12 days · 3 deposits asked, 1 late since ${d('2026-11-20', 'en')} · 1 refund to make.`)
      expect(lineOf(answer, 'it'), role).toBe(`Ha 3 fatture da pagare · 1 fattura scaduta, la più vecchia da 12 giorni · 3 acconti richiesti, 1 scaduto dal ${d('2026-11-20', 'it')} · 1 rimborso da fare.`)
      expect(answer.wall.map((part) => part.key)).toEqual(['orders:moneyTab.head.wallPrice'])
      for (const said of everyWord(answer)) expect(amountsOf(said), `${role} ${said.key}`).toEqual([])
    }
  })

  it('the drop order: on account, then to give back, then deposits with none late — never owes, late, a late deposit or the standing', () => {
    const held = { status: 'ready' as const, value: glanceOf({ onHold: true, over: true }) }
    const keys = moneyAnswerOf(input('owner', { glance: held })).lines[0]!.parts.map((part) => part.key)
    // Six true: owes · late · deposits (one late) · on account · give back · standing → on account and give back step back.
    expect(keys).toEqual(['cm.answer.owes', 'cm.answer.late', 'cm.answer.pair', 'cm.answer.pair'])
    expect(lineOf(moneyAnswerOf(input('owner', { glance: held })), 'en')).toContain(`on hold (Credit), over the credit limit by ${m(420000, 'en')}.`)
    // No deposit late: on account and to give back step back first; the calm deposits part then fits (four of six).
    const calm = ITEMS.map((item) => (item.target === 'DEPOSIT_REQUEST' ? { ...item, dueDate: '2026-12-15' } : item))
    const five = moneyAnswerOf(input('owner', { glance: held, openItems: partReady({ items: calm, creditBalance: [{ currency: 'EUR', amount: 120000 }] }) }))
    expect(five.lines[0]!.parts.map((part) => part.key)).toEqual(['cm.answer.owes', 'cm.answer.late', 'cm.answer.deposits', 'cm.answer.pair'])
  })

  it('left out, never 0: no payments.view → no deposits and no on-account part; a read not in → reading; a failed read → the order tab\'s line', () => {
    const noPayments = moneyAnswerOf(input('owner', { can: { ...moneyTabCanOf(ROLES.owner), payments: false }, openItems: null, refunds: null }))
    expect(noPayments.lines[0]!.parts.map((part) => part.key)).toEqual(['cm.answer.owes', 'cm.answer.late'])
    expect(moneyAnswerOf(input('owner', { ageing: READING })).reading).toBe(true)
    expect(moneyAnswerOf(input('owner', { openItems: READING })).reading).toBe(true)
    const failed = moneyAnswerOf(input('owner', { refunds: partFailed('problem.read.unavailable') }))
    expect(failed.failed?.key).toBe('orders:moneyTab.head.partFailed')
    expect(failed.lines[0]!.parts.map((part) => part.key)).not.toContain('cm.answer.giveBack')
  })

  it('nothing true: "Nothing open with {customer}." (info); two currencies: one sentence each, never added; the company line and another company', () => {
    const nothing = moneyAnswerOf(input('owner', { ageing: partReady([]), openItems: partReady({ items: [], creditBalance: [] }), refunds: partReady({ ...REFUNDS, refundsDue: [] }) }))
    expect(nothing.tone).toBe('info')
    // A name that ends with its own full stop never gets a second one (the view ends the line with sentenceOf).
    expect(sentenceOf([sayIn('en')(nothing.nothing!)])).toBe('Nothing open with Seed Customer One S.r.l.')
    expect(sentenceOf([sayIn('it')(nothing.nothing!)])).toBe('Niente di aperto con Seed Customer One S.r.l.')
    const two = moneyAnswerOf(input('owner', { ageing: partReady([ageingRow({ invoices: 2, open: 610000, overdue: 122000, daysLate: 6 }), ageingRow({ currency: 'CHF', invoices: 1, open: 435000, overdue: 0, daysLate: null })]), openItems: partReady({ items: [], creditBalance: [] }), refunds: partReady({ ...REFUNDS, refundsDue: [] }) }))
    expect(two.lines.map((line) => line.currency)).toEqual(['EUR', 'CHF'])
    expect(lineOf(two, 'en', 1)).toBe(`Owes ${m(435000, 'en', 'CHF')} on 1 invoice.`)
    const elsewhere = moneyAnswerOf(input('owner', { companies: 2, ageingElsewhere: partReady([ageingRow({ company: COMPANY_B, invoices: 2, daysLate: 19 })]) }))
    expect(sentenceOf([sayIn('en')(elsewhere.company!)])).toBe('With Seed Company A.')
    expect(elsewhere.elsewhere).toHaveLength(1)
    expect(sayIn('en')(elsewhere.elsewhere[0]!.words)).toBe('Seed Customer One S.r.l. also owes Seed Company B: 2 invoices, some late')
    expect(sayIn('it')(elsewhere.elsewhere[0]!.door)).toBe('Apri con Seed Company B ›')
  })
})

describe('F-CM-104: Balance (10-design §5.1; Z4, Z11, Z24)', () => {
  it('the figures in two groups (owner): Open to pay · Overdue · Deposits asked | To give back; the ageing in five cells; no figure without the price grain', () => {
    const model = balanceOf(input('owner'), PREFIX)
    expect(model.blocks).toHaveLength(1)
    const [owes, holds] = model.blocks![0]!.groups
    expect(owes!.tiles.map((tile) => tile.key)).toEqual(['open', 'overdue', 'deposits'])
    expect(holds!.tiles.map((tile) => tile.key)).toEqual(['onAccount', 'giveBack'])
    expect(model.blocks![0]!.ageing?.map((cell) => cell.amount)).toEqual([598000, 244000, 0, 0, 0])
    for (const role of ['sales', 'readonly'] as const) {
      const words = balanceOf(input(role), PREFIX)
      expect(words.blocks, role).toBeNull()
      for (const said of [...words.answer, ...words.needs.map((need) => need.words), ...words.facts.map((fact) => fact.value)]) expect(amountsOf(said), `${role} ${said.key}`).toEqual([])
    }
  })

  it('"Not invoiced yet" is a COUNT that is a door (the open orders not invoiced in full); a fact for a reader without prices', () => {
    const summary = partReady({ all: { orders: { count: 5, filter: null }, pieces: { ordered: { count: 0, filter: null }, shipped: { count: 0, filter: null }, open: { count: 0, filter: null } }, late: { count: 0, filter: null }, atRisk: { count: 0, filter: null }, invoiced: { NONE: { count: 2, filter: null }, PART: { count: 1, filter: null }, ALL: { count: 2, filter: null } } }, groups: null, limited: false, asOf: '2026-11-24T09:44:00Z' })
    const tile = balanceOf(input('owner', { summary }), PREFIX).blocks![0]!.groups[0]!.tiles.find((entry) => entry.key === 'notInvoiced')
    expect(tile?.value).toEqual({ words: { key: 'cm.balance.orders', params: { count: 3 } } })
    expect(tile?.door).toEqual({ href: `${PREFIX}/sales/customers/p-1?tab=work&rows=open` })
    expect(balanceOf(input('sales', { summary }), PREFIX).facts.find((fact) => fact.key === 'notInvoiced')?.href).toBe(`${PREFIX}/sales/customers/p-1?tab=work&rows=open`)
  })

  it('What needs you: most blocking first, each with its ONE door; the answer counts them; nothing: one calm row', () => {
    const model = balanceOf(input('owner', { glance: { status: 'ready', value: glanceOf({ onHold: true }) } }), PREFIX)
    expect(model.needs.map((need) => need.code)).toEqual(['depositLate', 'invoicesLate', 'onHold', 'onAccount', 'giveBack'])
    expect(sayIn('en')(model.needs[0]!.words)).toBe(`A deposit is late since ${d('2026-11-20', 'en')}: SEED-SO-0011`)
    expect(model.needs[2]!.fallback).toMatchObject({ kind: 'href', href: `${PREFIX}/sales/customers/p-1?tab=terms#party-hold` })
    expect(model.answer[0]).toEqual({ key: 'cm.balance.needs', params: { count: 5 } })
    const calm = balanceOf(input('owner', { ageing: partReady([]), openItems: partReady({ items: [], creditBalance: [] }), refunds: partReady({ ...REFUNDS, refundsDue: [] }) }), PREFIX)
    expect(calm.needs).toEqual([])
    expect(calm.calm?.key).toBe('cm.balance.calm')
  })

  it('the tab\'s count (Z11): late invoices + late deposit requests; null while read; never "0"', () => {
    const base = { can: { receivables: true, payments: true, price: true }, today: TODAY, currency: 'EUR' }
    const busy = input('owner')
    expect(moneyBadgeOf({ ...base, ageing: busy.ageing, openItems: busy.openItems })).toBe(2)
    expect(moneyBadgeOf({ ...base, ageing: READING, openItems: busy.openItems })).toBeNull()
    expect(moneyBadgeOf({ ...base, ageing: partReady([]), openItems: partReady({ items: [], creditBalance: [] }) })).toBeUndefined()
    // The server's count (S7) wins over the open items' due days when every row has it.
    expect(moneyBadgeOf({ ...base, ageing: partReady([ageingRow({ lateInvoices: 2 })]), openItems: busy.openItems })).toBe(3)
  })
})

describe('F-CM-105: To collect (10-design §5.2; Z5, Z21, Z25, Z26)', () => {
  it('oldest due first; ten rows at first; the head answers what is open, what is late and the next due day', () => {
    const model = collectOf(input('owner'), PREFIX)!
    expect(model.rows.map((row) => row.id)).toEqual(['inv-1', 'rq-11', 'rq-12', 'rq-13', 'inv-2', 'inv-3'])
    expect(COLLECT_SHOWN).toBe(10)
    expect(model.answer.map(sayIn('en'))).toEqual(['6 open: 3 invoices and 3 deposit and before-shipping requests', '2 late', `next due ${d('2026-11-26', 'en')}`])
    expect(model.rows[1]!.order?.href).toBe(`${PREFIX}/sales/orders/o-rq-11?tab=money#about-DepositRequest-rq-11`)
    expect(model.rows[0]!.order?.href).toBe(`${PREFIX}/sales/orders/o-2?tab=money#invoices`)
  })

  it('what the step holds comes from its kind (Z26 b); an extra deposit only when the order read says so (Z26 a)', () => {
    const rows = collectOf(input('owner'), PREFIX)!.rows
    expect(rows.find((row) => row.id === 'rq-11')!.notes.map((note) => note.word.key)).toEqual(['orders:moneyTab.plan.note.productionWaits'])
    expect(rows.find((row) => row.id === 'rq-12')!.notes.map((note) => note.word.key)).toEqual(['orders:moneyTab.plan.note.holdsShipment'])
    const extra = requestItem('rq-14', '2026-11-30', 100000, { stepKind: null })
    const openOrders = [{ id: 'o-rq-14', number: 'SEED-SO-0014', currency: 'EUR', deposit: { state: 'NOT_NEEDED' as const, dueDate: '2026-11-30', extraOpenDue: '2026-11-30' } }]
    const model = collectOf(input('owner', { openItems: partReady({ items: [extra], creditBalance: [] }), openOrders }), PREFIX)!
    expect(model.rows[0]!.kind).toBe('EXTRA')
    expect(model.rows[0]!.notes).toEqual([])
    expect(collectOf(input('owner', { openItems: partReady({ items: [extra], creditBalance: [] }) }), PREFIX)!.rows[0]!.kind).toBe('DEPOSIT')
  })

  it('the acts per role: ONE act per row; Waive only for the Owner; Sales and Read-only: no act, only doors; never Open for payment, Ask again, Undo or Stop the page', () => {
    const owner = collectOf(input('owner'), PREFIX)!.rows.find((row) => row.id === 'rq-11')!
    expect(owner.act?.id).toBe('record')
    expect(owner.more.map((item) => item.id)).toEqual(['send', 'MOVE_DUE', 'REPLACE_DEPOSIT', 'waive', 'openOrder', 'show', 'link'])
    const finance = collectOf(input('finance'), PREFIX)!.rows.find((row) => row.id === 'rq-12')!
    expect(finance.more.map((item) => item.id)).toEqual(['send', 'MOVE_DUE', 'openOrder', 'show', 'link'])
    for (const role of ['sales', 'readonly'] as const) {
      for (const row of collectOf(input(role), PREFIX)!.rows) {
        expect(row.act, `${role} ${row.id}`).toBeNull()
        expect(row.amount, `${role} ${row.id}`).toBeNull()
        expect(row.more.filter((item) => (IN_PLACE_ACTS as readonly string[]).includes(item.id)).map((item) => item.id), `${role} ${row.id}`).toEqual([])
        for (const note of row.notes) expect(amountsOf(note.word), `${role} ${row.id}`).toEqual([])
      }
    }
    for (const role of ['owner', 'finance', 'sales', 'readonly'] as const)
      for (const row of collectOf(input(role), PREFIX)!.rows) expect(row.more.map((item) => item.id).join(' '), role).not.toMatch(/open\b|ASK_AGAIN|undo|stopPage/)
    // Accept short only on a row the server's figures call short (part paid: Z26 f).
    const short = requestItem('rq-15', '2026-11-30', 99000, { amount: 100000, openAmount: 1000 })
    const part = collectOf(input('owner', { openItems: partReady({ items: [short], creditBalance: [] }) }), PREFIX)!.rows[0]!
    expect(part.more.map((item) => item.id)).toContain('ACCEPT_SHORT')
    expect(part.of).toBe(100000)
  })

  it('an invoice: Record payment… is Finance\'s door (euro only — Z21: a CHF row has no act, its ⋯ says why); its stop or reminder said on the row (Z26 c)', () => {
    const rows = collectOf(input('owner'), PREFIX)!.rows
    expect(rows[0]!.act).toMatchObject({ id: 'payInvoice', href: `${PREFIX}/finance/payments?new=1&invoice=inv-1` })
    const chf = invoiceItem('inv-9', '2026-12-01', 435000, { currency: 'CHF' })
    const row = collectOf(input('owner', { openItems: partReady({ items: [chf], creditBalance: [] }) }), PREFIX)!.rows[0]!
    expect(row.act).toBeNull()
    expect(row.more[0]).toMatchObject({ id: 'payInvoice', held: { key: 'cm.collect.euroOnly', params: { currency: 'CHF' } } })
    const stop: ReminderStop = { id: 's-1', company: COMPANY_A, customer: CUSTOMER, invoice: { id: 'inv-1', number: 'FT-2026-00001' }, reason: 'PROMISE_TO_PAY', until: '2026-11-30', note: null, state: 'holding', holdsReminders: [], createdAt: '2026-11-20T09:00:00Z', createdBy: null, liftedAt: null, liftedBy: null, liftReason: null, can: { change: true, lift: true }, version: 1 }
    const reminder = { id: 'r-1', level: 2, status: 'SENT', sentAt: '2026-11-18T09:00:00Z', preparedAt: '2026-11-17T09:00:00Z', invoices: [{ id: 'inv-2', number: 'FT-2026-00002', issueDate: null, dueDate: null }] } as unknown as Reminder
    const joined = collectOf(input('owner', { stops: partReady([stop]), reminders: partReady([reminder]) }), PREFIX)!.rows
    expect(sayIn('en')(joined.find((entry) => entry.id === 'inv-1')!.notes[0]!.word)).toBe(`Promise to pay until ${d('2026-11-30', 'en')}: reminders are stopped`)
    expect(sayIn('en')(joined.find((entry) => entry.id === 'inv-2')!.notes[0]!.word)).toBe(`Reminder level 2 sent ${formatDate('2026-11-18T09:00:00Z', { locale: 'en' })}`)
  })

  it('left out without payments.view; reading; failed with its own problem', () => {
    expect(collectOf(input('owner', { can: { ...moneyTabCanOf(ROLES.owner), payments: false }, openItems: null }), PREFIX)).toBeNull()
    expect(collectOf(input('owner', { openItems: READING }), PREFIX)?.reading).toBe(true)
    expect(collectOf(input('owner', { openItems: partFailed('problem.read.unavailable') }), PREFIX)?.problem).toBe('problem.read.unavailable')
  })
})

describe('F-CM-101: the walls, the sections, the words', () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

  it('eight sections and their addresses (Z18): #collect, #credit, #invoices land; #on-account and #give-back inside Payments & refunds', () => {
    expect(CUSTOMER_MONEY_SECTIONS).toEqual(['balance', 'collect', 'invoices', 'received', 'credit', 'statement', 'price-check', 'margin'])
    for (const id of ['collect', 'credit', 'invoices', 'received', 'on-account', 'give-back']) expect(CUSTOMER_MONEY_ANCHORS).toContain(id)
  })

  it('customer B sees nothing of customer A: no rule filters a list by customer; the other company\'s line reads only this customer\'s own rows', () => {
    for (const file of readdirSync(new URL('./', import.meta.url)).filter((name) => name.endsWith('.ts') && !name.includes('vitest'))) {
      expect(source(`./${file}`), file).not.toMatch(/customer\.id\s*[!=]==|partyId\s*[!=]==|\.filter\([^)]*partyId/)
    }
  })

  it('every new word exists in both languages with the same keys', () => {
    const [en, it_] = LOCALES.map((locale) => Object.keys(messagesFor(locale, [CM])[CM] ?? {}).filter((key) => key.startsWith('cm.')).sort())
    expect(en).toEqual(it_)
    expect(en!.length).toBeGreaterThan(100)
  })
})

describe('F-CM-103: the reads (cm-w1 W1.2; 13-backend §1.3, §1.4, §5.2)', () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

  it('every read names THIS customer, and no hook filters a list by customer (the ageing is split by COMPANY only)', () => {
    const tab = source('./use-customer-money-tab.ts')
    const page = source('../../money/hooks.ts')
    for (const call of ['openRefunds(api', 'listStops(api', 'listReminders(api', 'getOrderSummary(api', 'shippedOfCustomer(api']) {
      const line = tab.split('\n').find((text) => text.includes(call))
      expect(line, call).toBeDefined()
      expect(line, call).toContain('partyId')
    }
    for (const call of ['getCustomerAgeing(api, partyId, null', 'openItemsFor(api, { companyId, partyId }']) expect(page, call).toContain(call)
    for (const [name, text] of [['use-customer-money-tab.ts', tab], ['hooks.ts', page], ['api.ts', source('./api.ts')]] as const) expect(text, name).not.toMatch(/customer\.id\s*[!=]==|partyId\s*[!=]==/)
    // The ageing keeps its shape for the Overview: this company's rows; the others go to `ageingElsewhere` ("Also owes …", 0 requests).
    expect(page).toContain('const here = companyId ? value.customers.filter((row) => row.company.id === companyId) : value.customers')
  })

  it('the live rule: this customer\'s money event → ours; another customer\'s → not; an event that never names one → by the ids the tab holds', () => {
    const held = new Set(['inv-1', 'rf-1'])
    expect(moneyChangeIsOurs({ type: 'payment.recorded', fields: { partyId: 'p-1', paymentId: 'pay-1' } }, 'p-1', held)).toBe(true)
    expect(moneyChangeIsOurs({ type: 'payment.recorded', fields: { partyId: 'p-2', paymentId: 'pay-1' } }, 'p-1', held)).toBe(false)
    expect(moneyChangeIsOurs({ type: 'sales_order.updated', fields: { partyId: 'p-1' } }, 'p-1', held)).toBe(true)
    expect(moneyChangeIsOurs({ type: 'sales_order.updated', fields: {} }, 'p-1', held)).toBe(false)
    expect(moneyChangeIsOurs({ type: 'payment.allocated', fields: { paymentId: 'pay-9', target: 'INVOICE', targetId: 'inv-1' } }, 'p-1', held)).toBe(true)
    expect(moneyChangeIsOurs({ type: 'payment.allocated', fields: { paymentId: 'pay-9', target: 'INVOICE', targetId: 'inv-7' } }, 'p-1', held)).toBe(false)
    expect(moneyChangeIsOurs({ type: 'refund.changed', fields: { refundId: 'rf-1' } }, 'p-1', held)).toBe(true)
    // Until cm-s (S1) lands, a money event that names no customer may be ours: one coalesced re-read.
    expect(moneyChangeIsOurs({ type: 'deposit_request.created', fields: { depositRequestId: 'rq-new' } }, 'p-1', held)).toBe(true)
    expect(moneyChangeIsOurs({ type: 'quote.sent', fields: {} }, 'p-1', held)).toBe(false)
  })
})

describe('F-CM-101: the views (cm-w1 W1.3; 10-design §1, §2; 18-lead-settles L2, Z2, Z15)', () => {
  const view = (name: string) => readFileSync(new URL(`../view/money/${name}`, import.meta.url), 'utf8')
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

  it('our stylesheet holds only `.fw-cm` rules: no rule on a kit or order Money class, the room never the viewport, tokens only', () => {
    const css = view('customer-money.css')
    expect(css).not.toMatch(/\.fw-(om|pt)-/)
    expect(css).not.toMatch(/@media/)
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/)
    for (const selector of css.replace(/\/\*[\s\S]*?\*\//g, '').match(/^[^@{}\n][^{}]*(?=\{)/gm) ?? []) for (const part of selector.split(',')) expect(part.trim(), part).toMatch(/^\.fw-cm/)
    expect(css).toContain('.fw-cm-list { container: cmls / inline-size;')
  })

  it('the views draw their models and fetch nothing (no API client, no fetching hook); the container is the one caller of the tab\'s reads', () => {
    for (const file of readdirSync(new URL('../view/money/', import.meta.url)).filter((name) => /\.tsx?$/.test(name))) {
      expect(view(file), file).not.toMatch(/lib\/api|use-customer-money-tab|useCustomerMoney\b|useOfficeApi|fetch\(|use-money-acts/)
    }
    expect(source('./CustomerMoney.tsx')).toContain('useCustomerMoneyTab({ partyId: party.id')
  })

  it('the layout: the kit\'s room with the order Money\'s class and ours, the ONE shared answer, Balance then To collect, the shared parts imported, never copied', () => {
    const tab = view('CustomerMoneyTab.tsx')
    expect(tab).toContain('<div className="fw-pt fw-om fw-cm">')
    const order = ['<MoneyAnswer', '<BalanceSection', '<CollectSection']
    for (let index = 1; index < order.length; index += 1) expect(tab.indexOf(order[index]!), order[index]).toBeGreaterThan(tab.indexOf(order[index - 1]!))
    expect(tab).toContain("import { MoneyAnswer } from '../../../../orders/record/money/view/parts'")
    expect(view('BalanceSection.tsx')).toContain("import { Facts, GapRow } from '../../../../orders/record/money/view/parts'")
    // cm-fx2: the kit's Section with the balance's id, its props on lines of their own (the head's buttons grew in cm-w2/cm-w3).
    expect(view('BalanceSection.tsx')).toMatch(/<Section\s+id=\{kitId\('balance'\)\}/)
    expect(view('CollectSection.tsx')).toContain("const head = { id: kitId('collect')")
    // A shared part is never redrawn here (no copy of its markup), and the kit is used in place.
    for (const file of ['CustomerMoneyTab.tsx', 'BalanceSection.tsx', 'CollectSection.tsx']) expect(view(file), file).not.toMatch(/className="fw-om-(head|gap|facts|fold|il)\b/)
  })

  it('Z29: the wrapper loads EVERY catalogue the rules, the views and the shared parts name — a raw key can never show', () => {
    expect(view('CustomerMoneyTab.tsx')).toContain('<WithMessages namespaces={MONEY_TAB_NAMESPACES}>')
    const named = new Set<string>(['orders' /* the kit, the shared parts, the line menu */])
    const files = [
      ...readdirSync(new URL('./', import.meta.url)).filter((name) => /\.tsx?$/.test(name) && !name.includes('vitest')).map((name) => source(`./${name}`)),
      ...readdirSync(new URL('../view/money/', import.meta.url)).filter((name) => /\.tsx?$/.test(name)).map(view),
    ]
    const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '') // the words in comments are not keys
    for (const text of files) for (const match of code(text).matchAll(/['`]([a-z][a-z-]*):[a-zA-Z]/g)) named.add(match[1]!)
    for (const namespace of named) expect(MONEY_TAB_NAMESPACES as readonly string[], namespace).toContain(namespace)
    // Z30: the day tags are the catalogue's own words, never a second word.
    expect(source('./collect.ts')).toContain("word('cell.daysLate', { params: { count: late } })")
    expect(source('./collect.ts')).toContain("word('customers-list:prom.in', { params: { days: -late } })")
  })

  it('the tab says its own words from customer-money and names the catalogue of every word it reuses (Z15: never a customer word of `orders`)', () => {
    for (const file of ['CustomerMoneyTab.tsx', 'BalanceSection.tsx', 'CollectSection.tsx']) expect(view(file), file).not.toMatch(/useT\('orders'\)|useSay\(/)
    expect(view('say.ts')).toContain('useScopedT(CM)')
  })
})

describe('F-CM-201: To collect\'s acts in place (cm-w2 W2.1; 13-backend §4.1, §4.2; Z5)', () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

  it('a request row\'s acts are the money door\'s ONE rule (cm-k2 rowActsOf), hidden without the right; Finance\'s stopsCanOf decides the stop', () => {
    expect(source('./collect.ts')).toContain('rowActsOf({ stepKind: item.stepKind ?? null')
    expect(source('./model.ts')).toContain('door: doorCanOf(permissions)')
    expect(source('./model.ts')).toContain('remindersManage: stopsCanOf(permissions).manage')
    const invoice = (role: Role) => collectOf(input(role), PREFIX)!.rows.find((row) => row.id === 'inv-1')!.more.map((item) => item.id)
    expect(invoice('owner')).toContain('stop')
    expect(invoice('finance')).toContain('stop')
    for (const role of ['sales', 'readonly'] as const) expect(invoice(role), role).not.toContain('stop')
  })

  it('the windows are the owners\' own, mounted in place, never copied: the order\'s through the door, Finance\'s stop container in ONE centred window', () => {
    const container = source('./CustomerMoney.tsx')
    expect(container).toContain('<OrderMoneyWindow model={windows.door.model} actions={windows.door.actions} />')
    expect(container).toContain('<StopWindow partyId={party.id} ask={windows.stop}')
    const stop = source('./StopWindow.tsx')
    expect(stop).toContain('<ReminderDepth reminder={{ customer: { id: partyId }')
    expect(stop).not.toMatch(/<form|<Field|<Select|<DateInput/)
    expect(source('./use-money-windows.ts')).toContain('useOrderMoneyDoor(api, {')
    // Finance's container: ONE type line (the fields it reads), nothing else.
    expect(source('../../../../finance/receivables/reminder-stops/ReminderDepth.tsx')).toContain("reminder: Pick<Reminder, 'status' | 'invoices' | 'trusted'> & { readonly customer: { readonly id: string } }")
    // The door is opened only for a request row with its order; the stop only for an invoice row.
    const windows = source('./use-money-windows.ts')
    expect(windows).toContain("if (row.target === 'INVOICE') setStop(")
    expect(windows).toContain("if (row.target === 'DEPOSIT_REQUEST' && row.order) open(")
  })
})

describe('F-CM-202: Invoices & credit notes (cm-w2 W2.2; 10-design §5.3; Z6, Z25)', () => {
  const doc = (id: string, over: Partial<InvoiceRow> = {}): InvoiceRow => ({ id, docType: 'TD01', status: 'SENT', number: `FT-2026-0001${id.slice(-1)}`, issueDate: '2026-10-01', companyId: COMPANY_A.id, buyerPartyId: CUSTOMER.id, partyName: CUSTOMER.name, currency: 'EUR', netTotal: 200000, vatTotal: 44000, grossTotal: 244000, depositRequestId: null, creditOfId: null, salesOrderId: 'o-2', filesPending: false, paidAmount: 0, creditedAmount: 0, openAmount: 244000, dueDate: '2026-11-12', version: 1, createdAt: '2026-10-01T09:00:00Z', ...over })
  const read = (rows: InvoiceRow[], next: string | null = null) => partReady({ rows, next })

  it('the chips are the read\'s own terms: All · Credit notes (TD04) · Drafts (DRAFT); no "open" chip', () => {
    expect(documentQueryOf('all')).toEqual({ docType: null, status: null })
    expect(documentQueryOf('creditNotes')).toEqual({ docType: 'TD04', status: null })
    expect(documentQueryOf('drafts')).toEqual({ docType: null, status: 'DRAFT' })
    expect(DOCUMENTS_SHOWN).toBe(5)
  })

  it('an invoice NOT in the open items is never "Open" or "Part paid" (the list\'s own open amount ignores write-offs and refunds); one a credit note gives money back from: Refund due', () => {
    const owner = input('owner')
    expect(paymentWordOf(doc('inv-1'), owner)?.word.key).toBe('moneyTab.invoices.pay.open')
    expect(paymentWordOf(doc('inv-8', { openAmount: 120000, paidAmount: 50000 }), owner)?.word.key).toBe('moneyTab.invoices.pay.paid')
    const refundOf = input('owner', { refunds: partReady({ ...REFUNDS, refundsDue: REFUNDS.refundsDue.map((refund) => ({ ...refund, creditNote: { ...refund.creditNote!, creditOfId: 'inv-1' } })) }) })
    expect(paymentWordOf(doc('inv-1'), refundOf)?.word.key).toBe('moneyTab.invoices.pay.refund')
    expect(paymentWordOf(doc('cn-1', { docType: 'TD04' }), owner)?.word.key).toBe('moneyTab.invoices.pay.credited')
    const model = documentsOf(owner, read([doc('inv-1'), doc('inv-8')]), 'all', PREFIX)!
    expect(model.rows.map((row) => row.list.open)).toEqual([244000, 0])
  })

  it('no Payment word and no amount without the price grain (the part then leaves the column out, never blank); the words are ORDER words, said by the part', () => {
    for (const role of ['sales', 'readonly'] as const) {
      const model = documentsOf(input(role), read([doc('inv-1', { grossTotal: undefined, openAmount: undefined, paidAmount: undefined })]), 'all', PREFIX)!
      expect(model.rows[0]!.list.payment, role).toBeNull()
      expect(model.rows[0]!.list.total, role).toBeNull()
      for (const said of [model.rows[0]!.list.kind, model.rows[0]!.list.state.word, ...model.rows[0]!.list.subs, ...model.answer]) expect(amountsOf(said), role).toEqual([])
    }
    const row = documentsOf(input('owner'), read([doc('inv-1')]), 'all', PREFIX)!.rows[0]!
    expect(row.list.kind.key).toBe('docType.TD01')
    expect(row.list.state.word.key).toBe('invoiceStatus.SENT')
  })

  it('its order is the sixth column: the number when the server sends it (S8), else "Order ›"; a door to that order\'s Invoices', () => {
    const [named, plain] = documentsOf(input('owner'), read([doc('inv-1', { orderNumber: 'SEED-SO-0002' }), doc('inv-2')]), 'all', PREFIX)!.rows
    expect(named!.order).toEqual({ id: 'o-2', number: 'SEED-SO-0002', href: `${PREFIX}/sales/orders/o-2?tab=money#invoices` })
    expect(plain!.order?.number).toBeNull()
  })

  it('the five doors into Finance, each with its right; a credit note\'s Credit note… held with the order page\'s words; none for Read-only', () => {
    const owner = documentsOf(input('owner'), read([doc('inv-1'), doc('cn-1', { docType: 'TD04', status: 'ISSUED' })]), 'all', PREFIX)!.rows
    expect(owner[0]!.doors.map((door) => door.id)).toEqual(['record', 'credit', 'payments', 'pdf'])
    expect(owner[1]!.doors.find((door) => door.id === 'credit')?.held?.key).toBe('orders:moneyTab.invoices.held.creditNote')
    expect(owner[1]!.doors.map((door) => door.id)).toContain('sdi')
    expect(documentsOf(input('readonly'), read([doc('inv-1')]), 'all', PREFIX)!.rows[0]!.doors).toEqual([])
    expect(documentsOf(input('owner', { can: { ...moneyTabCanOf(ROLES.owner), invoices: false } }), read([doc('inv-1')]), 'all', PREFIX)).toBeNull()
  })

  it('the head: "n documents · n invoices open · drafts · rejected"; the open count is the ageing\'s, never a sum of the rows (Z6); more pages say "+"', () => {
    const model = documentsOf(input('owner'), read([doc('inv-1'), doc('d-1', { status: 'DRAFT', number: null }), doc('r-1', { status: 'REJECTED' })], 'cursor-2'), 'all', PREFIX)!
    expect(model.answer.map((said) => said.key)).toEqual(['cm.invoices.countMore', 'finance-receivables:tiles.invoices', 'cm.invoices.drafts', 'cm.invoices.rejected'])
    expect(model.answer[1]).toEqual({ key: 'finance-receivables:tiles.invoices', params: { count: 3 } })
    expect(model.more).toBe(true)
  })
})

describe('F-CM-104: the page (cm-w1 W1.4; 13-backend §5.3–§5.6; Z11, Z27, D2)', () => {
  const page = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

  it('the container builds the tab only on Money; the view mounts it, counts what is late, docks a third, says why a role is sent to Work', () => {
    const container = page('../CustomerRecord.tsx')
    expect(container).toContain("const moneyTab = named && record.party && tab === 'money' ? <CustomerMoney party={record.party} prefix={prefix} money={money}")
    expect(container).toContain("if (record.model.tab === 'money' && tab !== 'money') setMoneyTabNote(true)")
    const view = page('../view/CustomerRecordView.tsx')
    expect(view).toContain("{tab === 'money' && moneyTab}")
    expect(view).toContain("{tab === 'work' && moneyTabNote && <MoneyTabNote />}")
    expect(view).toContain('moneyBadgeOf({ can: { receivables: moneyModel.can.receivables, payments: !!moneyModel.can.payments, price: moneyModel.can.price }')
    expect(view).toContain("id === 'money' ? moneyCount : undefined")
    // The old tab is no longer mounted (it goes in cm-w3 W3.4, after a grep on main).
    expect(view).not.toContain('<MoneyTab ')
  })

  it('the order\'s one planned change: its Invoices foot link lands on the customer\'s #invoices, "All money of <customer> ›"', () => {
    expect(page('../../../orders/record/money/view/InvoicesSection.tsx')).toContain('?tab=money#invoices`')
    for (const locale of LOCALES) {
      const words = messagesFor(locale, ['orders']).orders!
      expect(words['money.allMoney'], locale).toBeTruthy()
      expect(words['money.statement'], locale).toBeUndefined()
    }
  })
})

describe('F-CM-203: Payments & refunds (cm-w2 W2.3; 10-design §5.4; Z7, Z18, Z22, Z25)', () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
  const pay = (id: string, receivedOn: string, over: Partial<PaymentRow> = {}): PaymentRow => ({ id, companyId: COMPANY_A.id, partyId: CUSTOMER.id, partyName: CUSTOMER.name, method: 'BANK_TRANSFER', amount: 120000, allocated: 120000, unallocated: 0, currency: 'EUR', receivedOn, externalRef: `CRO-${id}`, status: 'RECEIVED', placedOn: [{ target: 'INVOICE', targetId: 'inv-0', amount: 120000, number: 'FT-2026-00009', docType: 'TD01', orderNumber: 'SEED-SO-0009' }], refunded: 0, createdAt: `${receivedOn}T09:00:00Z`, ...over })
  const payments = (rows: PaymentRow[], next: string | null = null) => partReady({ rows, next })
  const credit = partReady({ balances: [{ currency: 'EUR', amount: 120000 }], payments: [{ id: 'pay-7', receivedOn: '2026-11-15', externalRef: 'CRO-7', currency: 'EUR', amount: 300000, unplacedAmount: 120000 }] })

  it('On account: from the page\'s open items, the payment that holds it and how long it waits; Refund… only with payments.refund and prices', () => {
    const model = receivedOf(input('owner'), payments([pay('p-1', '2026-11-14')]), credit, PREFIX)!
    expect(model.onAccount).toHaveLength(1)
    expect(model.onAccount[0]).toMatchObject({ currency: 'EUR', amount: 120000, waits: 9, refundable: true, from: { paymentId: 'pay-7', receivedOn: '2026-11-15' } })
    expect(receivedOf(input('finance'), payments([]), credit, PREFIX)!.onAccount[0]!.refundable).toBe(true)
    const sales = receivedOf(input('sales'), payments([]), credit, PREFIX)!
    expect(sales.onAccount[0]).toMatchObject({ amount: null, refundable: false })
    expect(sales.refundable).toBe(false)
  })

  it('To give back: a refund to make (Mark made… · ⋯ Cancel…), a credit note with money left (Refund…) — Finance\'s windows; no "Change…" (Z7)', () => {
    const notes = { ...REFUNDS, creditNotesToRefund: [{ creditNoteId: 'cn-2', number: 'NC-2026-00008', issueDate: '2026-11-01', companyId: COMPANY_A.id, partyId: CUSTOMER.id, party: { code: CUSTOMER.code, legalName: CUSTOMER.name }, currency: 'EUR', grossTotal: 50000, creditOfId: 'inv-3', creditOfNumber: 'FT-2026-00003', creditOfDocType: 'TD01', orderNumber: null, refundedAmount: 0, refundableAmount: 50000 }] }
    const rows = receivedOf(input('owner', { refunds: partReady(notes) }), payments([]), null, PREFIX)!.giveBack
    expect(rows.map((row) => [row.kind, row.act?.id ?? null, row.more.map((item) => item.id)])).toEqual([
      ['refund', 'paid', ['cancel', 'openNote']],
      ['note', 'refund', ['openNote']],
    ])
    for (const row of rows) expect(JSON.stringify(row.more)).not.toContain('change')
    const sales = receivedOf(input('sales', { refunds: partReady({ ...notes, refundsDue: notes.refundsDue.map((refund) => ({ ...refund, amount: undefined })), creditNotesToRefund: notes.creditNotesToRefund.map((note) => ({ ...note, refundableAmount: undefined, grossTotal: undefined })) }) }), payments([]), null, PREFIX)!.giveBack
    for (const row of sales) {
      expect(row.act).toBeNull()
      expect(row.amount).toBeNull()
      expect(row.more.map((item) => item.id)).toEqual(['openNote'])
    }
  })

  it('Payments received: newest first, the first 3 then more (Z25); what each was placed on; no amount without prices; the head\'s answer', () => {
    expect(PAYMENTS_SHOWN).toBe(3)
    const rows = [pay('p-1', '2026-10-01'), pay('p-2', '2026-11-14', { placedOn: [{ target: 'DEPOSIT_REQUEST', targetId: 'rq-11', amount: 120000, number: null, docType: null, orderNumber: 'SEED-SO-0011' }] }), pay('p-3', '2026-11-02', { unallocated: 30000, allocated: 90000 })]
    const model = receivedOf(input('owner'), payments(rows), credit, PREFIX)!
    expect(model.payments.map((row) => row.id)).toEqual(['p-2', 'p-3', 'p-1'])
    expect(model.payments[0]!.placed.map((chip) => chip.word.key)).toEqual(['cm.received.depositOf'])
    expect(model.payments[1]!.placed.map((chip) => chip.word.key)).toEqual(['cm.received.placedOn', 'cm.received.notPlaced'])
    expect(model.answer.map((said) => said.key)).toEqual(['cm.received.count', 'cm.received.last', 'cm.answer.onAccount', 'cm.answer.pair'])
    const sales = receivedOf(input('sales'), payments(rows.map((row) => ({ ...row, amount: undefined, allocated: undefined, unallocated: undefined, placedOn: row.placedOn.map((entry) => ({ ...entry, amount: undefined })) }))), credit, PREFIX)!
    for (const row of sales.payments) {
      expect(row.amount).toBeNull()
      for (const chip of row.placed) expect(amountsOf(chip.word)).toEqual([])
    }
    for (const said of sales.answer) expect(amountsOf(said)).toEqual([])
  })

  it('Refunds made (folded): made, cancelled or voided; Void… only on a made one with payments.void and prices; the section left out without payments.view', () => {
    const made = [{ ...REFUNDS.refundsDue[0]!, id: 'rf-2', status: 'PAID' as const, paidOn: '2026-11-20' }, { ...REFUNDS.refundsDue[0]!, id: 'rf-3', status: 'CANCELLED' as const }, REFUNDS.refundsDue[0]!]
    expect(refundsMadeOf(made, input('owner')).map((row) => [row.refund.id, row.voidable])).toEqual([['rf-2', true], ['rf-3', false]])
    expect(refundsMadeOf(made, input('sales')).every((row) => !row.voidable && row.amount === null)).toBe(true)
    expect(receivedOf(input('owner', { can: { ...moneyTabCanOf(ROLES.owner), payments: false } }), payments([]), null, PREFIX)).toBeNull()
  })

  it('Finance\'s refund windows are opened as they are (never copied); the ⓘ says Finance\'s word for the money on account (Z22)', () => {
    const windows = source('./RefundWindowsView.tsx')
    expect(windows).toContain("import { RefundDialog, RefundMoveDialog } from '../../../../finance/payments/refunds/view/RefundDialogs'")
    expect(windows).not.toMatch(/<DialogFrame|<form/)
    expect(source('./use-money-windows.ts')).toContain('recordRefund(api, refundAskOf(target, draft), key)')
    for (const locale of LOCALES) expect(messagesFor(locale, [CM])[CM]!['cm.received.info'], locale).toMatch(locale === 'en' ? /Finance calls this money the customer’s credit balance\./ : /credito del cliente/)
    // The section is the fourth: Invoices & credit notes first, then Payments & refunds.
    const tab = readFileSync(new URL('../view/money/CustomerMoneyTab.tsx', import.meta.url), 'utf8')
    expect(tab.indexOf('<ReceivedSection')).toBeGreaterThan(tab.indexOf('<DocumentsSection'))
  })
})

describe('F-CM-204: "Record a payment ›" — Finance\'s window with this customer chosen (cm-w2 W2.4; 13-backend §4.3; S3)', () => {
  it('the door names THIS customer; Balance draws it only with payments.record and prices (hidden, never held)', () => {
    expect(recordPaymentForCustomerHref(PREFIX, 'p-1')).toBe(`${PREFIX}/finance/payments?new=1&party=p-1`)
    const tab = readFileSync(new URL('../view/money/CustomerMoneyTab.tsx', import.meta.url), 'utf8')
    expect(tab).toContain('recordPaymentHref={can.paymentsRecord && can.price ? recordPaymentForCustomerHref(prefix, partyId) : null')
    const balance = readFileSync(new URL('../view/money/BalanceSection.tsx', import.meta.url), 'utf8')
    expect(balance).toContain("<Link href={recordPaymentHref}>{`${say(word('finance:recordPay.title'))} ›`}</Link>")
    expect(balance).not.toMatch(/heldReason/)
  })
})

// ---- F-CM-301…304 (customer page › MONEY tab, cm-w3; 10-design §5.5–§5.8; 13-backend §4.2, §5.10, §5.11; Z31, Z32, E52) ----
describe('F-CM-301…304: the account sections, Finance\'s windows in place, the old code out (cm-w3)', () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
  const view = (name: string) => source(`../view/money/${name}`)
  const terms = partReady({ currency: 'EUR', defaultDepositPct: '30', invoiceTiming: 'ON_SHIPMENT' } as unknown as CommercialTerms)
  const limitRow = (held = { orders: 0, shipments: 0, releases: 0 }): LimitRow => ({ company: COMPANY_A, currency: 'EUR', limit: 2000000, used: 1688000, available: 312000, overLimitBy: null, overdue: 244000, held: { firstOrders: [], ...held } /* cm-fx4: the row's own list, as the API sends it */, version: 3 }) as unknown as LimitRow
  const glanced = (credit: Partial<NonNullable<Glance['credit']>>, hold = false) => ({ status: 'ready' as const, value: { ...glanceOf({ onHold: hold }), credit: { ...glanceOf().credit!, ...credit } } })
  const can = (role: Role, more: readonly string[] = []) => moneyTabCanOf([...ROLES[role], ...more])

  it('W3.1 Credit & terms: no row → no "held" line (never "0 held"); a row says only what waits', () => {
    expect(creditOf(input('owner'), partReady(null), terms, PREFIX).waiting).toBeNull()
    expect(creditOf(input('owner'), partReady(limitRow()), terms, PREFIX).waiting).toBeNull()
    const held = creditOf(input('owner'), partReady(limitRow({ orders: 2, shipments: 0, releases: 1 })), terms, PREFIX)
    expect(held.waiting!.map((said) => said.key)).toEqual(['cm.credit.waitOrders', 'cm.credit.waitReleases'])
    expect(sayIn('en')(held.waiting![0]!)).toBe('2 orders wait for a yes')
    expect(sayIn('it')(held.waiting![1]!)).toBe('1 rilascio rifiutato')
  })

  it('W3.1 Change limit… only with sales.credit.limits and prices (hidden, never held); Set a limit… without a limit; the hold with Release…', () => {
    expect(creditOf(input('owner'), null, terms, PREFIX).change).toBe('change')
    for (const role of ['sales', 'readonly'] as const) expect(creditOf(input(role), null, terms, PREFIX).change, role).toBeNull()
    expect(creditOf(input('owner', { glance: glanced({ state: 'NONE', limit: null, used: null, available: null }) }), null, terms, PREFIX).change).toBe('set')
    const onHold = creditOf(input('owner', { glance: glanced({}, true) }), null, terms, PREFIX)
    expect(onHold.hold).not.toBeNull()
    expect(onHold.mayHold).toBe(true)
    expect(onHold.answer.map((said) => said.key)).toContain('cm.credit.holdSince')
    expect(creditOf(input('readonly'), null, terms, PREFIX).mayHold).toBe(false)
    const section = view('CreditSection.tsx')
    expect(section).toContain('const buttons = model.change && onChangeLimit ?')
    expect(section).not.toMatch(/heldReason|disabled=/)
  })

  it('W3.1 the cells, the share used and the terms\' door with prices; no amount without them', () => {
    const owner = creditOf(input('owner'), partReady(limitRow()), terms, PREFIX)
    expect(owner.cells!.map((cell) => cell.key)).toEqual(['limit', 'used', 'free'])
    expect(owner.usedPct).toBe(84)
    expect(owner.termsHref).toBe(`${PREFIX}/sales/customers/p-1?tab=terms#party-commercial`)
    expect(owner.facts.map((fact) => fact.key)).toEqual(['paymentTerms', 'deposit', 'invoicing', 'currency'])
    const over = creditOf(input('owner', { glance: glanced({ state: 'OVER', used: 2420000, available: null, overLimitBy: 420000 }) }), null, terms, PREFIX)
    expect(over.cells!.find((cell) => cell.key === 'over')).toMatchObject({ amount: 420000, danger: true })
    const sales = creditOf(input('sales'), partReady(limitRow()), terms, PREFIX)
    expect([sales.cells, sales.usedPct, sales.overdue]).toEqual([null, null, null])
    for (const said of [...sales.answer, ...sales.facts.map((fact) => fact.value)]) expect(amountsOf(said), said.key).toEqual([])
  })

  it('W3.2 Statement & reminders: OFF said once; a held reminder says why; a waiting one waits for a person; the door ?reminder=<id>', () => {
    const reminder = (id: string, status: string, held: readonly string[], preparedAt: string) => ({ id, level: 1, action: 'EMAIL', status, held: held.map((code) => ({ code })), preparedAt, sentAt: status === 'SENT' ? preparedAt : null, invoices: [{ id: 'inv-1', number: 'FT-2026-00001' }], amountDue: 244000, interestAmount: 0, currency: 'EUR' }) as unknown as Reminder
    const reminders = partReady([reminder('r-1', 'PREPARED', ['STOP_DISPUTE'], '2026-11-20T09:00:00Z'), reminder('r-2', 'PREPARED', [], '2026-11-21T09:00:00Z'), reminder('r-3', 'CANCELLED', [], '2026-11-19T09:00:00Z')])
    const off = partReady({ switch: { on: false } } as never)
    const model = chaseOf(input('owner', { reminders }), null, off, PREFIX, true)!
    expect(model.off).toEqual({ key: 'finance-receivables:switch.offTitle' })
    expect(model.reminders.map((row) => row.id)).toEqual(['r-2', 'r-1'])
    expect(model.reminders[0]!.notes.map((note) => note.key)).toEqual(['cm.chase.waits'])
    expect(model.reminders[1]!.notes.map((note) => note.key)).toEqual(['finance-receivables:heldReason.STOP_DISPUTE'])
    expect(model.reminders[0]!.href).toBe(`${PREFIX}/finance/receivables?reminder=r-2`)
    expect(model.answer.map((said) => said.key)).toEqual(['cm.needs.reminders', 'cm.chase.heldCount', 'cm.chase.noStop']) // cm-fx4 (M-7): the held one counted too
    expect(chaseOf(input('owner', { reminders }), null, partReady({ switch: { on: true } } as never), PREFIX, true)!.off).toBeNull()
  })

  it('W3.2 Statement… only with prices and something to state; a stop is lifted only with its right and its own verdict', () => {
    expect(chaseOf(input('owner'), null, null, PREFIX, true)!.statement).toBe(true)
    expect(chaseOf(input('owner'), null, null, PREFIX, false)!.statement).toBe(false)
    expect(chaseOf(input('sales'), null, null, PREFIX, true)!.statement).toBe(false)
    const stop: ReminderStop = { id: 's-1', company: COMPANY_A, customer: CUSTOMER, invoice: { id: 'inv-1', number: 'FT-2026-00001' }, reason: 'PROMISE_TO_PAY', until: '2026-11-30', note: null, state: 'holding', holdsReminders: [], createdAt: '2026-11-20T09:00:00Z', createdBy: null, liftedAt: null, liftedBy: null, liftReason: null, can: { change: true, lift: true }, version: 1 }
    expect(chaseOf(input('owner', { stops: partReady([stop]) }), null, null, PREFIX, true)!.stops.map((row) => row.liftable)).toEqual([true])
    expect(chaseOf(input('sales', { stops: partReady([stop]) }), null, null, PREFIX, true)!.stops.map((row) => row.liftable)).toEqual([false])
    expect(chaseOf(input('owner', { stops: partReady([{ ...stop, can: { change: true, lift: false } }]) }), null, null, PREFIX, true)!.stops.map((row) => row.liftable)).toEqual([false])
    expect(chaseOf(input('owner', { can: { ...can('owner'), receivables: false } }), null, null, PREFIX, true)).toBeNull()
  })

  it('W3.3 the grains: no Price check without prices, no Margin & cost without the margin grain and costing.view — and their reads are not made', () => {
    expect(priceCheckOf(input('sales', { priceDiffer: 2 }), null, PREFIX)).toBeNull()
    expect(marginOf(input('owner'), READING, PREFIX)).toBeNull() // the owner of this file holds no costing.view
    expect(marginOf(input('owner', { can: can('owner', ['costing.view']) }), READING, PREFIX)!.reading).toBe(true)
    expect(marginOf(input('sales', { can: can('sales', ['costing.view']) }), READING, PREFIX)).toBeNull()
    const hook = source('./use-customer-money-tab.ts')
    expect(hook).toContain("const priceRows = useLazyRead(wanted.has('priceRows'), can.orders && can.price,")
    expect(hook).toContain("const margin = useLazyRead(wanted.has('margin'), can.margin && can.costing,")
    expect(hook).toContain('// Margin & cost is never read again on a burst')
    expect(hook).not.toMatch(/margin\.load\(true\)/)
    // W3.5 (13-backend §1.4, a burst ≤ 13): the terms and the reminders' switch are not read again on a burst.
    expect(hook).not.toMatch(/now\.terms\.load\(true\)|now\.settings\.load\(true\)/)
  })

  it('W3.3 Price check: one row per order with the door to its own #price-check; the orders with no customer price; calm when none differs', () => {
    const order = { id: 'o-2', number: 'SEED-SO-0002', currency: 'EUR', netAmount: 520000, brandPrice: 500000, priceDiff: 20000, priceNotEqualLines: 2, priceAccepted: false } as unknown as OrderRow
    const model = priceCheckOf(input('owner', { priceDiffer: 1, priceMissing: 3 }), partReady([order]), PREFIX)!
    expect(model.rows.map((row) => [row.number, row.href, row.diff])).toEqual([['SEED-SO-0002', `${PREFIX}/sales/orders/o-2?tab=money#price-check`, 20000]])
    expect(model.differ!.href).toBe(`${PREFIX}/sales/customers/p-1?tab=work&rows=all&priceMatch=NOT_EQUAL`)
    expect(model.missing).toEqual({ count: 3, href: `${PREFIX}/sales/customers/p-1?tab=work&rows=all&priceMatch=NO_BRAND_PRICE` })
    expect(priceCheckOf(input('owner', { priceDiffer: 0 }), null, PREFIX)!.calm).toEqual({ key: 'cm.price.calm' })
  })

  it('W3.3 Margin & cost: the tiles in one currency, danger below the floor, its door; the cost only with its grain; no supplier total', () => {
    const margins = (estimateCost: number | undefined, currency: string | null = 'EUR') => partReady({ tiles: { currency, orders: 4, belowFloor: 1 }, byCustomer: [{ value: 1200000, estimateCost, marginPct: '18.0', orders: 4 }], rows: [{ floor: { pct: '20.0' } }] } as unknown as Margins)
    const owner = marginOf(input('owner', { can: can('owner', ['costing.view', 'money.cost']) }), margins(984000), PREFIX)!
    expect(owner.tiles).toEqual({ value: 1200000, cost: 984000, pct: '18.0', currency: 'EUR', danger: true })
    expect(owner.below).toEqual({ count: 1, href: `${PREFIX}/finance/margins?party=p-1&floor=below` })
    expect(owner.answer.map((said) => said.key)).toEqual(['cm.margin.now', 'cm.margin.belowFloor'])
    expect(marginOf(input('owner', { can: can('owner', ['costing.view']) }), margins(984000), PREFIX)!.tiles!.cost).toBeNull()
    expect(marginOf(input('owner', { can: can('owner', ['costing.view']) }), margins(undefined, null), PREFIX)!).toMatchObject({ tiles: null, twoCurrencies: true })
    const tab = readdirSync(new URL('../view/money/', import.meta.url)).map((name) => view(name)).join('\n') + source('./worth.ts')
    expect(tab).not.toMatch(/finance\/payables|\/payables\//)
  })

  it('Z31: every need of "What needs you" points ↓ to its own section; no Finance or Terms stand-in where the section exists', () => {
    const busy = balanceOf(input('owner', { priceDiffer: 2, glance: glanced({ state: 'OVER', used: 2420000, available: null, overLimitBy: 420000 }, true) }), PREFIX)
    expect(busy.needs.map((need) => [need.code, need.down])).toEqual([
      ['depositLate', 'collect'],
      ['invoicesLate', 'collect'],
      ['onHold', 'credit'],
      ['overLimit', 'credit'],
      ['onAccount', 'on-account'],
      ['giveBack', 'give-back'],
      ['priceDiffer', 'price-check'],
    ])
    expect(sayIn('en')(busy.needs.at(-1)!.words)).toBe('Prices differ on 2 orders')
    const balance = view('BalanceSection.tsx')
    expect(balance).toContain("credit: 'cm.credit.title', statement: 'cm.chase.title', 'price-check': 'orders:moneyTab.price.title'")
    const tab = view('CustomerMoneyTab.tsx')
    expect(tab).not.toMatch(/tab\.openStatement|statementOf\(|id: 'changeLimit'/)
    expect(tab).toContain("const LAZY_OF: Readonly<Record<string, LazyRead>> = { balance: 'terms' /* M-2 (cm-fx4): its payment terms */, invoices: 'documents', received: 'received' /* F-CM-203 */, credit: 'credit', statement: 'statement', 'price-check': 'priceRows', margin: 'margin' /* F-CM-301…303 */ }")
  })

  it('Z32: "Can\'t be invoiced yet" from the party read (the Overview strip\'s source), its home on Terms', () => {
    const blocked = balanceOf(input('owner', { party: { ...input().party, invoiceBlocked: true, blocking: ['NO_TAX_IDENTITY'] } }), PREFIX)
    const need = blocked.needs.find((entry) => entry.code === 'cantInvoice')!
    expect(need).toMatchObject({ tone: 'danger', down: null, fallback: { kind: 'href', href: `${PREFIX}/sales/customers/p-1?tab=terms#party-identity` } })
    for (const locale of LOCALES) expect(sayIn(locale)(need.words), locale).not.toMatch(/cm\.|parties:|warning\./)
    expect(balanceOf(input('owner', { party: { ...input().party, invoiceBlocked: true } }), PREFIX).needs.find((entry) => entry.code === 'cantInvoice')!.words).toEqual({ key: 'parties:list.cannotInvoice' })
    expect(balanceOf(input('owner'), PREFIX).needs.map((entry) => entry.code)).not.toContain('cantInvoice')
    expect(source('./CustomerMoney.tsx')).toContain('blocking: party.warnings.filter((warning) => warning.blocksInvoice).map((warning) => warning.code),')
  })

  it('E52: the credit value of this year\'s returns (price grain, one currency); nothing without prices or in two currencies', () => {
    const ret = (id: string, requestedAt: string, creditTotal: number | undefined, currency = 'EUR'): CustomerReturn => ({ id, number: `RMA-${id}`, companyId: COMPANY_A.id, status: 'CLOSED', units: 1, requestedAt, late: false, ...(creditTotal === undefined ? {} : { creditTotal }), currency })
    const rows = [ret('1', '2026-03-02T09:00:00Z', 12000), ret('2', '2026-10-02T09:00:00Z', 8000), ret('3', '2025-12-30T09:00:00Z', 50000), ret('4', '2026-11-02T09:00:00Z', 0)]
    const returns = { rows, year: '2026', href: `${PREFIX}/sales/returns?party=p-1` }
    expect(returnsCreditOf(input('owner', { returns }))).toEqual({ year: '2026', amount: 20000, count: 2, currency: 'EUR', href: returns.href })
    expect(returnsCreditOf(input('sales', { returns }))).toBeNull()
    expect(returnsCreditOf(input('owner', { returns: { ...returns, rows: [...rows, ret('5', '2026-11-10T09:00:00Z', 3000, 'CHF')] } }))).toBeNull()
    expect(returnsCreditOf(input('owner'))).toBeNull()
    expect(sayIn('en')({ key: 'cm.received.returns', params: { year: '2026', count: 2 }, money: { amount: 20000 } })).toBe(`Credit value of its returns in 2026: ${m(20000, 'en')} on 2 returns`)
  })

  it('Finance\'s windows opened as they are (never copied); the hold is the Terms tab\'s own window, one state with Terms', () => {
    const windows = source('./AccountWindowsView.tsx')
    expect(windows).toContain("import { ChangeLimitDialog } from '../../../../finance/receivables/credit/view/ChangeLimitDialog'")
    expect(windows).toContain("import { StatementDialog } from '../../../../finance/receivables/view/StatementDialog'")
    expect(windows).not.toMatch(/<DialogFrame|<form|<Modal/)
    const drivers = source('./use-account-windows.ts')
    expect(drivers).toContain('await setCreditLimit(api, change.partyId, change.companyId,')
    expect(drivers).toContain('await sendStatement(api, statement.ref.partyId,')
    expect(MONEY_TAB_NAMESPACES).toEqual(expect.arrayContaining(['sales-credit', 'customer-terms', 'finance-receivables', 'sales-customers-depth']))
    const depth = source('../../depth/CustomerDepth.tsx')
    expect(depth).toContain('export function useCustomerHold(party: Party)')
    expect(depth).toContain('window: <HoldDialogView model={{ read: state.holds.read, can: state.can, status: party.status, prefix, dialog: state.holds.dialog, companies: state.companies }} actions={state.holds} />,')
    expect(source('../../depth/view/HoldCard.tsx')).toContain('export function HoldDialogView(')
    expect(source('../../depth/use-depth.ts')).toContain("else if (tab === 'money') void Promise.all([loadGlance(), loadHolds()])")
    expect(source('./CustomerMoney.tsx')).toContain('const hold = useCustomerHold(party) // F-CM-301')
  })

  it('W3.4: the 200 newest orders are no longer read for a customer; the supplier\'s purchase orders as before; the dead reads went', () => {
    const hook = source('../../../../parties/_shared/PartyRecord.tsx')
    expect(hook).not.toContain('listSalesOrdersOf')
    expect(hook).toContain('const [orders] = useState<Loaded<SalesOrderRow>>(loading())')
    expect(hook).toContain("if (side === 'suppliers' && can.purchaseOrders)")
    expect(hook).toContain('listPurchaseOrdersOf(api, partyId).then(')
    const api = source('../../../../parties/_shared/api.ts')
    expect(api).not.toMatch(/listQuotesOf|listSalesOrdersOf/)
    expect(api).toContain('export async function listPurchaseOrdersOf(')
  })
})
// ---- end F-CM-301…304

// ---- F-CM T.2 (customer page › MONEY tab, cm-t; 15-steps "The wall tests, by name") — the web's walls, each under its own name ----
describe('the wall tests, by name (15-steps; cm-t T.2)', () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
  /** Every file of the tab: its rules and container (record/money) and its views (record/view/money); the tests left out. */
  const tabFiles = (): (readonly [string, string])[] => [
    ...readdirSync(new URL('./', import.meta.url)).filter((name) => /\.tsx?$/.test(name) && !name.includes('vitest')).map((name) => [`money/${name}`, source(`./${name}`)] as const),
    ...readdirSync(new URL('../view/money/', import.meta.url)).filter((name) => /\.tsx?$/.test(name)).map((name) => [`view/money/${name}`, source(`../view/money/${name}`)] as const),
  ]
  /** The tab of a case as a role reads it (the container's reads made up; the server's money wall applied). */
  const tabAs = (cm: CmCaseModel, role: CmRole, locale: (typeof LOCALES)[number] = 'en') => render(inShell('/sales/customers/moda?tab=money', createElement(CmMoneyDesign, { cm: { role, ...(cm.input ? { input: cm.input } : {}), ...(cm.lazy ? { lazy: cm.lazy } : {}), ...(cm.room ? { room: cm.room } : {}) } })), locale)
  const TAB_CASES = CM_CASES.filter((item) => !item.cm.window)
  /** An amount on screen: a currency sign or a figure with cents. */
  const AMOUNT = /€|\d[.,]\d{2}\b/

  it('customer B sees nothing of customer A', () => {
    // Every read of the tab names THIS customer (the reminders' switch is the company's: no customer in it).
    const hook = source('./use-customer-money-tab.ts')
    for (const call of ['openRefunds(api', 'listStops(api', 'listReminders(api', 'getOrderSummary(api', 'shippedOfCustomer(api', 'listInvoices(api', 'listPayments(api', 'creditBalanceOf(api', 'listRefunds(api', 'getCreditLimits(api', 'getCommercialTerms(api', 'customerTrust(api', 'listOrders(api', 'getMargins(api']) {
      const line = hook.split('\n').find((text) => text.includes(call))
      expect(line, call).toBeDefined()
      expect(line, call).toContain('partyId')
    }
    expect(hook).toContain('getReceivablesSettings(api, companyId, signal)')
    // No rule, container or view filters a list by customer.
    for (const [name, text] of tabFiles()) expect(text, name).not.toMatch(/customer\.id\s*[!=]==|partyId\s*[!=]==|\.filter\([^)]*partyId/)
    // The other company's line names only this customer's own rows (the read without the company term, split by COMPANY).
    const { input } = cmTabOf(CM_CASES.find((item) => item.id === 'cm-elsewhere')!.cm)
    const also = moneyAnswerOf(input).elsewhere
    expect(also).toHaveLength(1)
    for (const said of [also[0]!.words, also[0]!.door]) expect(JSON.stringify(said)).not.toMatch(/MARCHIO|BEISPIEL/)
  })

  for (const locale of LOCALES) {
    it(`no digit of an amount for Sales and Read-only (${locale})`, () => {
      for (const role of ['sales', 'read_only'] as const) {
        for (const item of TAB_CASES) {
          const text = textOf(tabAs(item.cm, role, locale))
          expect(text, `${item.id} as ${role} (${locale})`).not.toMatch(AMOUNT)
        }
      }
    })
  }

  it('no digit of an amount for Sales and Read-only: amountsOf of every word is empty', () => {
    for (const role of ['sales', 'read_only'] as const) {
      for (const item of TAB_CASES) {
        const { input, lazy } = cmTabOf({ ...item.cm, role, held: undefined })
        const balance = balanceOf(input, PREFIX)
        const credit = creditOf(input, lazy.creditRow, lazy.terms, PREFIX)
        const said: MoneyWord[] = [
          ...everyWord(moneyAnswerOf(input)),
          ...balance.answer,
          ...balance.needs.map((need) => need.words),
          ...credit.answer,
          ...credit.facts.map((fact) => fact.value),
          ...(credit.waiting ?? []),
          ...(credit.overdue ? [credit.overdue] : []),
          ...(chaseOf(input, lazy.trust, lazy.settings, PREFIX, true)?.answer ?? []),
          ...(receivedOf(input, lazy.payments, lazy.credit, PREFIX)?.answer ?? []),
        ]
        for (const one of said) expect(amountsOf(one), `${item.id} as ${role}: ${one.key}`).toEqual([])
      }
    }
  })

  it('no Margin & cost without the margin grain; no Price check without the price grain', () => {
    const busy = CM_CASES.find((item) => item.id === 'cm-busy')!.cm
    const owner = tabAs(busy, 'owner')
    expect(owner).toContain('id="price-check"')
    expect(owner).toContain('id="margin"')
    for (const role of ['sales', 'read_only'] as const) {
      const html = tabAs(busy, role)
      expect(html, role).not.toContain('id="price-check"')
      expect(html, role).not.toContain('id="margin"')
      // … and their reads are not made: the container hands none, and the hook reads them only with their grains.
      const { lazy } = cmTabOf({ ...busy, role })
      expect([lazy.priceRows, lazy.margin], role).toEqual([null, null])
    }
    const hook = source('./use-customer-money-tab.ts')
    expect(hook).toContain("const priceRows = useLazyRead(wanted.has('priceRows'), can.orders && can.price,")
    expect(hook).toContain("const margin = useLazyRead(wanted.has('margin'), can.margin && can.costing,")
    expect(hook).toContain('priceRows: can.orders && can.price ? priceRows.part : null,')
    expect(hook).toContain('margin: can.margin && can.costing ? margin.part : null,')
  })

  it('no supplier total', () => {
    const demo = readdirSync(new URL('./_demo/', import.meta.url)).map((name) => [`money/_demo/${name}`, source(`./_demo/${name}`)] as const)
    for (const [name, text] of [...tabFiles(), ...demo]) {
      expect(text, name).not.toMatch(/areas\/finance\/payables|finance\/payables|\/payables\//)
    }
    // Margin & cost reads GET /costing/margins only (Finance's getMargins), never a supplier's invoices.
    expect(source('./use-customer-money-tab.ts')).toContain("import { getMargins, type Margins } from '../../../../finance/margins/api'")
    expect(source('../../../../finance/margins/api.ts')).toContain("api.get('/costing/margins', {")
  })

  it('hidden, never held for a right', () => {
    const busy = CM_CASES.find((item) => item.id === 'cm-busy')!.cm
    const buttons = ['Change limit…', 'Statement…', 'Record a payment ›']
    const owner = textOf(tabAs(busy, 'owner'))
    for (const name of buttons) expect(owner, name).toContain(name)
    for (const role of ['sales', 'read_only'] as const) {
      const html = tabAs(busy, role)
      const text = textOf(html)
      for (const name of buttons) expect(text, `${role}: ${name}`).not.toContain(name)
      // Nothing drawn held with a right's name, and no money act held (disabled) in its place.
      expect(text, role).not.toMatch(/\b(?:payments|receivables|invoices|orders|sales|money|parties|costing)\.[a-z]+/)
      expect(html, role).not.toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>).)*(?:Change limit|Statement…|Record a payment|Refund…)/)
    }
    // Statement… only with the price grain (in the rule), whatever else the reader holds.
    const { input } = cmTabOf({ ...busy, role: 'owner', held: [...ROLES.owner].filter((right) => right !== 'money.price') })
    expect(chaseOf(input, null, null, PREFIX, true)!.statement).toBe(false)
  })

  it('the portal imports none of it', () => {
    const walk = (url: URL): string[] =>
      readdirSync(url, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(new URL(`${entry.name}/`, url)) : /\.tsx?$/.test(entry.name) ? [new URL(entry.name, url).pathname] : []))
    const files = walk(new URL('../../../../../portal/', import.meta.url))
    expect(files.length).toBeGreaterThan(50)
    for (const file of files) expect(readFileSync(file, 'utf8'), file).not.toMatch(/customers\/record\/money|orders\/record\/money\/door/)
  })
})
// ---- end F-CM T.2

// ---- cm-fx4 (the walk's gaps, 30-walk.md §3): each fixed, each held here ----
describe('cm-fx4: the walk\'s gaps', () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
  const view = (name: string) => source(`../view/money/${name}`)
  const reminder = (id: string, status: string, held: readonly string[]) => ({ id, level: 1, action: 'EMAIL', status, held: held.map((code) => ({ code })), preparedAt: '2026-11-20T09:00:00Z', sentAt: status === 'SENT' ? '2026-11-20T10:00:00Z' : null, invoices: [{ id: 'inv-1', number: 'FT-2026-00001' }], amountDue: 244000, interestAmount: 0, currency: 'EUR' }) as unknown as Reminder

  it('M-1: "Review in Finance ›" only for who decides reminders (receivables.reminders.manage) — hidden, never held', () => {
    const reminders = partReady([reminder('r-1', 'PREPARED', [])])
    expect(chaseOf(input('owner', { reminders }), null, null, PREFIX, true)!.reminders[0]!.href).toBe(`${PREFIX}/finance/receivables?reminder=r-1`)
    for (const role of ['sales', 'readonly'] as const) expect(chaseOf(input(role, { reminders }), null, null, PREFIX, true)!.reminders[0]!.href, role).toBeNull()
    const section = view('ChaseSection.tsx')
    expect(section).toContain('{row.href ? (')
    expect(section).not.toMatch(/disabled=|heldReason/)
  })

  it('M-2: "Payment terms" is ONE fact from ONE helper — the commercial terms first, the party\'s field the fallback', () => {
    const terms = partReady({ paymentTerms: { name: 'Deposit 30% at acceptance, balance at delivery' }, paymentTermsText: null, currency: 'EUR', defaultDepositPct: '30', invoiceTiming: 'ON_SHIPMENT' } as unknown as CommercialTerms)
    const balanceFact = balanceOf(input('owner', { terms }), PREFIX).facts.find((fact) => fact.key === 'paymentTerms')!
    const creditFact = creditOf(input('owner'), null, terms, PREFIX).facts.find((fact) => fact.key === 'paymentTerms')!
    expect(balanceFact.value).toEqual(creditFact.value)
    expect(balanceFact.value).toEqual({ key: 'cm.text', params: { text: 'Deposit 30% at acceptance, balance at delivery' } })
    // While the terms are read Balance says none (never one text, then another); without a read, the party's own field.
    expect(balanceOf(input('owner', { terms: READING }), PREFIX).facts.map((fact) => fact.key)).not.toContain('paymentTerms')
    expect(balanceOf(input('owner'), PREFIX).facts.find((fact) => fact.key === 'paymentTerms')!.value).toEqual({ key: 'cm.text', params: { text: '30 days end of month' } })
    for (const file of ['./balance.ts', './credit.ts']) expect(source(file), file).toContain('paymentTermsOf(')
    expect(source('./balance.ts')).not.toContain('input.party.paymentTerms ?')
  })

  // F-CT-523 (customer Terms & requirements, ct-w2 W2.3; 13-backend §4, Z32): the ONE helper of the three tabs — a company's own row wins.
  it('a company\'s own terms win: Balance and Credit & terms say this company\'s payment terms and deposit, in the page\'s language', () => {
    const terms = partReady({ paymentTerms: { name: 'Deposit 30% at acceptance, balance at delivery' }, paymentTermsText: null, currency: 'EUR', defaultDepositPct: '30', invoiceTiming: 'ON_SHIPMENT' } as unknown as CommercialTerms)
    const named = { id: 'pt-60', code: 'NET60', name: 'Net 60 days', nameI18n: { en: 'Net 60 days', it: 'Netto 60 giorni' }, summary: { en: 'Paid 60 days after the invoice', it: 'Pagato 60 giorni dopo la fattura' }, deposit: null }
    const own = (companyId: string) => ({
      company: { id: companyId, code: 'SEED-X', name: 'Seed Company X' },
      terms: { paymentTermsLabel: { code: 'NET60', name: 'Net 60 days' }, priceListLabel: null },
      inForce: { paymentTermsId: 'pt-60', paymentTermsText: null, priceListId: null, depositPct: '50', poNumberRequired: false, source: { paymentTerms: 'COMPANY', priceList: 'PARTY', deposit: 'COMPANY' }, paymentTerms: named, priceList: null },
    })
    const companyTerms = partReady({ tenantWide: false, companies: [own(COMPANY_A.id), own('co-b')] } as unknown as CompanyTerms)
    for (const locale of ['en', 'it'] as const) {
      const ruled = input('owner', { terms, companyTerms, locale })
      const balanceFact = balanceOf(ruled, PREFIX).facts.find((fact) => fact.key === 'paymentTerms')!
      const credit = creditOf(ruled, null, terms, PREFIX)
      expect(balanceFact.value, locale).toEqual(credit.facts.find((fact) => fact.key === 'paymentTerms')!.value)
      expect(balanceFact.value, locale).toEqual({ key: 'cm.text', params: { text: locale === 'en' ? 'Net 60 days' : 'Netto 60 giorni' } })
      expect(sayIn(locale)(credit.facts.find((fact) => fact.key === 'deposit')!.value), locale).toBe(sayIn(locale)({ key: 'cm.credit.pct', pcts: { pct: '50' } }))
    }
    // Another company's own row never answers for this one: without this company's row, the customer's own terms.
    const elsewhere = partReady({ tenantWide: false, companies: [own('co-b'), { ...own(COMPANY_A.id), terms: null, inForce: { ...own(COMPANY_A.id).inForce, source: { paymentTerms: 'PARTY', priceList: 'PARTY', deposit: 'PARTY' }, depositPct: '30', paymentTerms: null } }] } as unknown as CompanyTerms)
    expect(balanceOf(input('owner', { terms, companyTerms: elsewhere }), PREFIX).facts.find((fact) => fact.key === 'paymentTerms')!.value).toEqual({ key: 'cm.text', params: { text: 'Deposit 30% at acceptance, balance at delivery' } })
    // While the company terms are read Balance says none (never one text, then another).
    expect(balanceOf(input('owner', { terms, companyTerms: READING }), PREFIX).facts.map((fact) => fact.key)).not.toContain('paymentTerms')
    expect(source('./model.ts')).toContain("from '../terms/in-force'")
    expect(source('./use-customer-money-tab.ts')).toContain('readCompanyTerms(api, partyId, signal)')
  })

  // F-CT-601 (customer Terms & requirements, ct-t T.5; 18-lead-settles Z41, Z42): the terms per company could not be read — never quietly
  // shown as if in force: the customer's own terms, said so in ONE quiet line with Try again (Terms' own words).
  it('the terms per company could not be read: Credit & terms says the customer\'s own are shown, once, with Try again', () => {
    const terms = partReady({ paymentTerms: { name: 'Deposit 30% at acceptance, balance at delivery' }, paymentTermsText: null, currency: 'EUR', defaultDepositPct: '30', invoiceTiming: 'ON_SHIPMENT' } as unknown as CommercialTerms)
    const failed = creditOf(input('owner', { terms, companyTerms: partFailed('problem.read.unavailable') }), null, terms, PREFIX)
    expect(failed.termsFallback).toEqual({ key: 'customer-terms:ct.answer.fallback' })
    expect(failed.facts.find((fact) => fact.key === 'paymentTerms')!.value).toEqual({ key: 'cm.text', params: { text: 'Deposit 30% at acceptance, balance at delivery' } })
    for (const locale of LOCALES) expect(sayIn(locale)(failed.termsFallback!), locale).toBe(locale === 'en' ? "The terms with each company could not be read: these are the customer's own terms." : 'Le condizioni con ciascuna azienda non si sono potute leggere: queste sono le condizioni proprie del cliente.')
    // read, still reading, or not asked: no line
    for (const companyTerms of [partReady({ tenantWide: false, companies: [] } as unknown as CompanyTerms), READING, null]) expect(creditOf(input('owner', { terms, companyTerms }), null, terms, PREFIX).termsFallback).toBeNull()
    const section = view('CreditSection.tsx')
    expect(section).toContain('{model.termsFallback ? (')
    expect(section).toMatch(/<Quiet>\s*\{say\(model\.termsFallback\)\}[\s\S]*?onClick=\{onRetry\}/)
  })

  it('ct-fx3 G-W01 (walk W-01): Credit & terms waits while the terms per company are read (as Balance does) — never the customer\'s own as if in force', () => {
    const terms = partReady({ paymentTerms: { name: 'Deposit 30% at acceptance, balance at delivery' }, paymentTermsText: null, currency: 'EUR', defaultDepositPct: '30', invoiceTiming: 'ON_SHIPMENT' } as unknown as CommercialTerms)
    expect(creditOf(input('owner', { terms, companyTerms: READING }), null, terms, PREFIX).reading).toBe(true)
    expect(creditOf(input('owner', { terms, companyTerms: partReady({ tenantWide: false, companies: [] } as unknown as CompanyTerms) }), null, terms, PREFIX).reading).toBe(false)
    expect(creditOf(input('owner', { terms }), null, terms, PREFIX).reading).toBe(false) // not asked (the gallery's cm-* cases): as before
  })

  it('ct-fx3 G-W11 (walk W-11): Balance says it too when the terms per company could not be read — once, with Try again', () => {
    const terms = partReady({ paymentTerms: { name: 'Deposit 30% at acceptance, balance at delivery' }, paymentTermsText: null, currency: 'EUR', defaultDepositPct: '30', invoiceTiming: 'ON_SHIPMENT' } as unknown as CommercialTerms)
    const failed = balanceOf(input('owner', { terms, companyTerms: partFailed('problem.read.unavailable') }), PREFIX)
    expect(failed.facts.find((fact) => fact.key === 'paymentTerms')!.value).toEqual({ key: 'cm.text', params: { text: 'Deposit 30% at acceptance, balance at delivery' } })
    expect(failed.termsFallback).toEqual({ key: 'customer-terms:ct.answer.fallback' })
    for (const companyTerms of [partReady({ tenantWide: false, companies: [] } as unknown as CompanyTerms), READING, null]) expect(balanceOf(input('owner', { terms, companyTerms }), PREFIX).termsFallback ?? null).toBeNull()
    const section = view('BalanceSection.tsx')
    expect(section).toMatch(/\{!model\.reading && model\.termsFallback \? \(\s*<Quiet>\s*\{say\(model\.termsFallback\)\}[\s\S]*?onClick=\{onRetryTerms\}/)
    expect(source('../view/money/CustomerMoneyTab.tsx')).toContain("onRetryTerms={() => onRetry('terms') /* ct-fx3 G-W11 */}")
  })

  it('T.6 (Z41): the deposit word nothing says any more went, in both languages; the words it sits beside stay', () => {
    for (const locale of LOCALES) {
      const flat = messagesFor(locale, ['customer-money'])['customer-money'] ?? {}
      expect('cm.credit.deposit' in flat, locale).toBe(true)
      expect('cm.credit.noDeposit' in flat, locale).toBe(false)
    }
  })

  it('M-3: a late need is drawn in danger (the shared line\'s optional tone); the order page passes none', () => {
    expect(view('BalanceSection.tsx')).toContain("{...(need.tone === 'danger' ? { tone: 'danger' as const } : {})")
    expect(view('customer-money.css')).toContain('.fw-cm-needs > .is-danger > svg { color: var(--nds-danger); }')
    // The order page's own lines pass no tone (its markup stays as it was).
    for (const name of readdirSync(new URL('../../../orders/record/money/view/', import.meta.url)).filter((file) => file.endsWith('.tsx'))) {
      expect(readFileSync(new URL(`../../../orders/record/money/view/${name}`, import.meta.url), 'utf8'), name).not.toMatch(/<GapRow[^>]*\btone=/)
    }
  })

  it('M-4, M-5, M-8: no empty ⋯, no head door repeated on a row, each row\'s ⋯ its own name', () => {
    const documents = view('DocumentsSection.tsx')
    expect(documents).toContain("items.push({ id: 'link', label: say(word('orders:moneyTab.menu.copyLinkRow')), onSelect: () => copyLinkTo(row.list.anchor) })")
    expect(documents).toContain('name: [`${say(word(\'orders:money.draft\'))} ${(drafts += 1)}`')
    const chase = view('ChaseSection.tsx')
    expect(chase).not.toContain('[...menu, { id: \'link\', label: say(word(\'orders:moneyTab.menu.copyLinkRow\'))')
    expect(chase).toContain('<ReminderRowView key={row.anchor} row={row} say={sayIn(row.currency)} />')
    expect(view('ReceivedSection.tsx')).toContain('· ${row.reference}')
    expect(view('CollectSection.tsx')).toContain('`${what} · ${row.order.number}`')
  })

  it('M-6: without prices the refund is said once, with its day', () => {
    const answer = receivedOf(input('sales'), partReady({ rows: [], next: null }), null, PREFIX)!.answer
    expect(answer.map((said) => said.key)).toContain('cm.answer.refundsWordsBy')
    expect(answer.map((said) => said.key)).not.toContain('cm.answer.pair')
    expect(sayIn('en')(answer.find((said) => said.key === 'cm.answer.refundsWordsBy')!)).toBe(`1 refund to make by ${d('2026-11-28', 'en')}`)
  })

  it('M-7: the Statement & reminders answer counts every reminder it lists (waiting, held, approved, sent)', () => {
    const reminders = partReady([reminder('r-1', 'PREPARED', ['STOP_DISPUTE']), reminder('r-2', 'APPROVED', []), reminder('r-3', 'SENT', [])])
    const keys = chaseOf(input('owner', { reminders }), null, null, PREFIX, true)!.answer.map((said) => said.key)
    expect(keys).toEqual(['cm.chase.heldCount', 'cm.chase.approvedCount', 'cm.chase.sentCount', 'cm.chase.noStop'])
  })

  it('M-9: what is late is said for what it is — a late deposit is never read as a late invoice', () => {
    const model = balanceOf(input('owner', { ageing: partReady([ageingRow({ overdue: 0, daysLate: null, lateInvoices: 0, buckets: { NOT_DUE: 842000, D1_30: 0, D31_60: 0, D61_90: 0, OVER_90: 0 } } as Partial<AgeingRow>)]) }), PREFIX)
    const keys = model.answer.map((said) => said.key)
    expect(keys).toContain('cm.answer.depositsLate')
    expect(keys).not.toContain('cm.answer.lateCount')
    expect(keys.indexOf('cm.answer.depositsLate')).toBe(keys.indexOf('cm.answer.depositsWords') + 1)
  })

  it('M-11: an "invoice by" day already past is said as past, and is danger', () => {
    const shipped = partReady({ shipments: 1, value: 120000, invoiceBy: '2026-11-11', ddtIds: ['ddt-1'] } as never)
    const need = balanceOf(input('owner', { shipped }), PREFIX).needs.find((entry) => entry.code === 'shipped')!
    expect(need.tone).toBe('danger')
    expect(sayIn('en')(need.words)).toBe(`1 shipment is not invoiced yet (invoice by ${d('2026-11-11', 'en')} — 13 days ago)`)
    const calm = balanceOf(input('owner', { shipped: partReady({ shipments: 1, value: 120000, invoiceBy: '2026-11-30', ddtIds: ['ddt-1'] } as never) }), PREFIX).needs.find((entry) => entry.code === 'shipped')!
    expect(calm.tone).toBe('warning')
    const documents = documentsOf(input('owner', { shipped }), partReady({ rows: [], next: null }), 'all', PREFIX)!
    expect(documents.shippedLate).toBe(true)
    expect(sayIn('en')(documents.shipped!)).toContain('13 days ago')
  })

  it('M-12: what waits for credit names its orders (each a door) and where a person says yes', () => {
    const row = { held: { orders: 2, releases: 0, shipments: 0, firstOrders: [{ id: 'o-7', number: 'SEED-SO-0007' }] }, limit: 2000000, used: 1688000, available: 312000, overLimitBy: null, overdue: 244000, currency: 'EUR' } as unknown as LimitRow
    const model = creditOf(input('owner'), partReady(row), null, PREFIX)
    expect(model.waitingOrders).toEqual([{ id: 'o-7', number: 'SEED-SO-0007', href: `${PREFIX}/sales/orders/o-7` }])
    expect(model.waitingDoor).toBe(`${PREFIX}/finance/receivables?party=p-1`)
    expect(creditOf(input('owner'), partReady(null), null, PREFIX).waitingDoor).toBeNull()
  })

  it('M-13, M-14: On account said once without prices; a list without amount or act closes its columns up (no dead space)', () => {
    expect(view('ReceivedSection.tsx')).toContain('{box.amount !== null ? <b>{amount(box.amount, box.currency)}</b> : null}')
    const css = view('customer-money.css')
    expect(css).toContain('.fw-cm-list.is-np.is-na .fw-cm-row-g { grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr) 214px var(--m) var(--a) 44px; grid-template-areas: "k n d m a o"; }')
    expect(css).toContain('@container cmls (min-width: 1000px) {\n  .fw-cm-list.is-np.is-na')
  })

  // ---- cm-fx5: the re-walk's gaps R-2, R-3 (30-walk.md §6)
  it('R-2: an invoice row of To collect is named by its kind and number — never the same ⋯ name as its row in Invoices', () => {
    const collect = view('CollectSection.tsx')
    expect(collect).toContain('const name = row.invoice?.number ? `${what} · ${row.invoice.number}` : row.order?.number ? `${what} · ${row.order.number}` : what')
    expect(collect).not.toContain('const name = row.invoice?.number ??')
  })

  it('R-3, S-1: a list where no row has words gives the words column back, and "when" keeps the 214px column of the lists beside it', () => {
    const css = view('customer-money.css')
    const none = ':not(:has(.fw-cm-row-n:not(:empty)))'
    const cols = '{ grid-template-columns: minmax(0, 1fr) 0 214px var(--m) var(--a) 44px; }'
    // Each three-column room of M-14 and of 1500 px is mirrored: the same selector + "no words", only the words track 0.
    expect(css).toContain(`@container cmls (min-width: 1000px) {\n  .fw-cm-list.is-np.is-na${none} .fw-cm-row-g ${cols}`)
    expect(css).toContain(`@container cmls (min-width: 1300px) {\n  .fw-cm-list.is-np${none} .fw-cm-row-g, .fw-cm-list.is-na${none} .fw-cm-row-g ${cols}`)
    expect(css).toContain(`@container cmls (min-width: 1500px) {\n  .fw-cm-list${none} .fw-cm-row-g ${cols}`)
    // After the rules it narrows, so it wins at equal weight; the old 204px two-column form is gone.
    expect(css.indexOf(`.fw-cm-list${none} .fw-cm-row-g ${cols}`)).toBeGreaterThan(css.lastIndexOf('.fw-cm-list.is-np .fw-cm-row-g, .fw-cm-list.is-na .fw-cm-row-g'))
    expect(css).not.toContain(`${none} .fw-cm-row-g { grid-template-columns: minmax(0, 1fr) 204px`)
  })
})
// ---- end cm-fx4 + cm-fx5
