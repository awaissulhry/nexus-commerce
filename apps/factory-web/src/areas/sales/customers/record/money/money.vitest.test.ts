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
import type { Glance } from '../../depth/api'
import { balanceOf, moneyBadgeOf } from './balance'
import { collectOf, COLLECT_SHOWN, IN_PLACE_ACTS } from './collect'
import { moneyAnswerOf, type CustomerAnswer } from './head'
import { CM, MONEY_TAB_NAMESPACES, moneyChangeIsOurs, moneyTabCanOf, partFailed, partReady, READING, type MoneyTabInput } from './model'
import { sayOf } from './say'
import { CUSTOMER_MONEY_ANCHORS, CUSTOMER_MONEY_SECTIONS } from './sections'

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
    expect(view('BalanceSection.tsx')).toContain("<Section id={kitId('balance')}")
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
