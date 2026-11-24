import { createElement, type CSSProperties, type ReactNode } from 'react'
import { grantOf } from '@nexus/factory-domain/auth/roles/roles'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { DEMO_COMPANIES } from '../../../../../../shell/design-data'
import type { InvoiceRow, OpenItem, PaymentRow } from '../../../../../finance/_shared/api'
import { MARGINS } from '../../../../../finance/margins/demo/fixtures'
import type { Margins } from '../../../../../finance/margins/api'
import type { Refund, ToRefund } from '../../../../../finance/payments/refunds/api'
import { refundAbilitiesOf, targetOfNote } from '../../../../../finance/payments/refunds/model'
import type { AgeingRow, Reminder, ReceivablesSettings } from '../../../../../finance/receivables/api'
import type { LimitRow } from '../../../../../finance/receivables/credit/api'
import { REMINDERS, STATEMENT, SWITCH_OFF, SWITCH_ON } from '../../../../../finance/receivables/demo/fixtures'
import { receivablesCanOf } from '../../../../../finance/receivables/model'
import type { CustomerTrust, ReminderStop } from '../../../../../finance/receivables/reminder-stops/api'
import { CUSTOMERS } from '../../../../../parties/_shared/fixtures'
import type { OrderRow } from '../../../../orders/api'
import type { Order } from '../../../../orders/api'
import { OrderMoneyWindow } from '../../../../orders/record/money/door/OrderMoneyWindow'
import type { OrderMoneyDoorModel } from '../../../../orders/record/money/door/model'
import { word } from '../../../../orders/record/money/word'
import type { MoneyDialogModel } from '../../../../orders/record/view/Dialogs'
import { TERMS } from '../../../_demo/fixtures'
import type { Glance, Holds } from '../../../depth/api'
import { ALL_CAN, glanceOf, HELD_GLANCE, HOLDS, withoutPrices } from '../../../depth/_demo/fixtures'
import type { HoldDialog } from '../../../depth/model'
import { HoldDialogView } from '../../../depth/view/HoldCard'
import type { CustomerReturn } from '../../../money/api'
import { MONEY_OPEN_ITEMS, MONEY_OPEN_REFUNDS, MONEY_ORDER_SUMMARY, MONEY_TAB_TODAY, OVERDUE_ROWS } from '../../../money/_demo/fixtures'
import { CustomerMoneyTab, type LazyParts } from '../../view/money/CustomerMoneyTab'
import { AccountWindowsView } from '../AccountWindowsView'
import type { CreditBalanceRead } from '../api'
import type { DocumentsRead } from '../documents'
import { moneyTabCanOf, partFailed, partReady, READING, type MoneyTabInput, type Part } from '../model'
import type { PaymentsRead } from '../received'
import { RefundWindowsView } from '../RefundWindowsView'
import type { LimitWindow, StatementWindow } from '../use-account-windows'
import type { RefundWindows } from '../use-money-windows'

/**
 * F-CM T.1 (customer page › MONEY tab, cm-t; 15-steps T.1; 13-backend §5.8) — the gallery's `cm-*` cases for SCR-033: the nine customers
 * of the picture (20-preview-money.html), reminders off, each read reading and failed, no payments.view, the four office roles by their
 * template's REAL grant, the rooms 343 / 865 / 1314, and each window opened in place on the tab as its own case (a DS Modal draws only
 * once hydrated: never on the server render). All of it on the record's own customer (Moda Demo), the server's money wall applied as the
 * API applies it (no amount without the price grain). Every name, number and reference is made up. Design-only.
 */

const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const moda = CUSTOMERS.find((party) => party.code === 'MODA-DEMO')!
const NAME = moda.tradeName ?? moda.legalName
const COMPANY = { id: DEMO_COMPANIES[0].id, code: DEMO_COMPANIES[0].code, name: DEMO_COMPANIES[0].name }
const OTHER = { id: DEMO_COMPANIES[1].id, code: DEMO_COMPANIES[1].code, name: DEMO_COMPANIES[1].name }
const PREFIX = '/w/DEMO'
const TODAY = MONEY_TAB_TODAY

// ── the readers: the office roles' templates, their REAL grant on every company (permissions + grains as money.*) ──
export const CM_ROLES = ['owner', 'finance', 'sales', 'read_only'] as const
export type CmRole = (typeof CM_ROLES)[number]
export const cmHeld = (role: CmRole): readonly string[] => grantOf(templateOf(role)!, { allCompanies: true, companyIds: [], siteIds: [], partyIds: [] }).permissions

// ── the server's money wall, as the API applies it: no amount without the price grain ──
const AMOUNT_KEYS = new Set(['amount', 'openAmount', 'open', 'overdue', 'buckets', 'netTotal', 'vatTotal', 'grossTotal', 'paidAmount', 'creditedAmount', 'allocated', 'unallocated', 'refunded', 'amountDue', 'interestAmount', 'limit', 'used', 'available', 'overLimitBy', 'openOrders', 'openInvoices', 'creditTotal', 'unplacedAmount', 'refundedAmount', 'refundableAmount', 'openNow'])
function stripAmounts<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => stripAmounts(item)) as T
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !AMOUNT_KEYS.has(key)).map(([key, item]) => [key, key === 'usedPct' ? null : stripAmounts(item)])) as T
  return value
}

// ── the reads, made up ──
const ageing = (over: Partial<AgeingRow> = {}): AgeingRow => ({ ...OVERDUE_ROWS.find((row) => row.customer.id === moda.id)!, ...over })
const AGEING = [ageing()]
const openItem = (n: number, over: Partial<OpenItem>): OpenItem => ({ ...MONEY_OPEN_ITEMS[0]!, id: uid('7272', n), orderId: uid('6262', n), orderNumber: `MODA-SO-00${20 + n}`, ...over })
const STOP_PROMISE: ReminderStop = { id: uid('8181', 1), company: COMPANY, customer: { id: moda.id, code: moda.code, name: NAME }, invoice: { id: MONEY_OPEN_ITEMS[0]!.id, number: MONEY_OPEN_ITEMS[0]!.number }, reason: 'PROMISE_TO_PAY', until: '2026-11-10', note: 'Pays on the 10th: the bank transfer is booked (made-up).', state: 'holding', holdsReminders: [], createdAt: '2026-10-29T10:12:00.000Z', createdBy: { id: uid('9191', 1), name: 'Franca Finance' }, liftedAt: null, liftedBy: null, liftReason: null, can: { change: true, lift: true }, version: 1 }
const STOP_DISPUTE: ReminderStop = { ...STOP_PROMISE, id: uid('8181', 2), invoice: { id: MONEY_OPEN_ITEMS[1]!.id, number: MONEY_OPEN_ITEMS[1]!.number }, reason: 'DISPUTE', until: null, note: 'Two jackets came back with a wrong size label (made-up).', createdAt: '2026-10-30T15:40:00.000Z' }
const reminder = (n: number, over: Partial<Reminder>): Reminder => ({ ...REMINDERS[1]!, id: uid('8282', n), customer: { id: moda.id, code: moda.code, name: NAME }, invoices: [{ id: MONEY_OPEN_ITEMS[0]!.id, number: MONEY_OPEN_ITEMS[0]!.number, issueDate: '2026-08-24', dueDate: '2026-09-23', openNow: 427000 }], amountDue: 427000, ...over })
const REMINDER_WAITING = reminder(1, { status: 'PREPARED', level: 2, action: 'EMAIL', held: [], preparedAt: '2026-10-31T05:00:00.000Z' })
const REMINDER_SENT = reminder(2, { status: 'SENT', level: 1, action: 'EMAIL', held: [], preparedAt: '2026-10-08T05:00:00.000Z', sentAt: '2026-10-08T08:30:00.000Z' })
const REMINDER_HELD = reminder(3, { status: 'PREPARED', level: 2, action: 'LETTER', held: [{ code: 'STOP_DISPUTE', words: 'A dispute holds this invoice.' }], invoices: [{ id: MONEY_OPEN_ITEMS[1]!.id, number: MONEY_OPEN_ITEMS[1]!.number, issueDate: '2026-10-16', dueDate: '2026-11-15', openNow: 122000 }], amountDue: 122000 })

const invoice = (n: number, over: Partial<InvoiceRow> = {}): InvoiceRow => ({ id: uid('9292', n), docType: 'TD01', status: 'DELIVERED', number: `FT-2026-000${40 + n}`, issueDate: '2026-09-01', companyId: COMPANY.id, buyerPartyId: moda.id, partyName: NAME, currency: 'EUR', netTotal: 350000, vatTotal: 77000, grossTotal: 427000, depositRequestId: null, creditOfId: null, salesOrderId: uid('6161', n), filesPending: false, paidAmount: 0, creditedAmount: 0, openAmount: 427000, dueDate: '2026-09-23', version: 1, createdAt: '2026-09-01T09:00:00.000Z', orderNumber: `MODA-SO-00${10 + n}`, ...over })
const DOCUMENTS: DocumentsRead = {
  rows: [
    invoice(1, { id: MONEY_OPEN_ITEMS[0]!.id, number: MONEY_OPEN_ITEMS[0]!.number }),
    invoice(12, { id: MONEY_OPEN_ITEMS[1]!.id, number: MONEY_OPEN_ITEMS[1]!.number, issueDate: '2026-10-16', dueDate: '2026-11-15', netTotal: 100000, vatTotal: 22000, grossTotal: 122000, openAmount: 122000 }),
    invoice(7, { docType: 'TD04', number: 'NC-2026-00007', issueDate: '2026-10-24', creditOfId: uid('5353', 1), netTotal: 50000, vatTotal: 11000, grossTotal: 61000, openAmount: 0, dueDate: null }),
    invoice(3, { number: 'FT-2026-00033', issueDate: '2026-08-02', paidAmount: 427000, openAmount: 0, dueDate: '2026-09-01' }),
  ],
  next: null,
}
const payment = (n: number, over: Partial<PaymentRow> = {}): PaymentRow => ({ id: uid('9393', n), companyId: COMPANY.id, partyId: moda.id, partyName: NAME, method: 'BANK_TRANSFER', amount: 427000, allocated: 427000, unallocated: 0, currency: 'EUR', receivedOn: '2026-09-02', externalRef: `CRO-0000-ESEMPIO-${40 + n}`, status: 'RECEIVED', placedOn: [{ target: 'INVOICE', targetId: uid('9292', 3), amount: 427000, number: 'FT-2026-00033', docType: 'TD01', orderNumber: 'MODA-SO-0013' }], refunded: 0, createdAt: '2026-09-02T09:00:00.000Z', ...over })
const PAYMENTS: PaymentsRead = {
  rows: [
    payment(2, { amount: 300000, allocated: 180000, unallocated: 120000, receivedOn: '2026-10-27', placedOn: [{ target: 'DEPOSIT_REQUEST', targetId: MONEY_OPEN_ITEMS[3]!.id, amount: 180000, number: null, docType: null, orderNumber: MONEY_OPEN_ITEMS[3]!.orderNumber }], createdAt: '2026-10-27T09:00:00.000Z' }),
    payment(1),
  ],
  next: null,
}
const ON_ACCOUNT: CreditBalanceRead = { balances: [{ currency: 'EUR', amount: 120000 }], payments: [{ id: uid('9393', 2), receivedOn: '2026-10-27', externalRef: 'CRO-0000-ESEMPIO-42', currency: 'EUR', amount: 300000, unplacedAmount: 120000 }] }
const REFUND_MADE: Refund = { ...MONEY_OPEN_REFUNDS.refundsDue[0]!, id: uid('5151', 9), status: 'PAID', paidOn: '2026-10-02', externalRef: 'CRO-0000-ESEMPIO-07', dueDate: '2026-10-02' }
const LIMIT_ROW: LimitRow = { termsId: uid('a1a1', 1), version: 3, party: { id: moda.id, code: moda.code, name: NAME }, company: { id: COMPANY.id, code: COMPANY.code }, currency: 'EUR', limit: 5_000_000, used: 3_120_000, openOrders: 2_449_000, openInvoices: 671_000, overdue: 427_000, available: 1_880_000, overLimitBy: null, usedPct: 62, onHold: false, findings: [], held: { orders: 0, releases: 0, shipments: 0, firstOrders: [] } } as LimitRow
const TRUST: CustomerTrust = { customer: { id: moda.id, code: moda.code, name: NAME, version: 2 }, level: 2, companies: [{ id: COMPANY.id, code: COMPANY.code, remindersEnabled: true, steps: [{ level: 1, offsetDays: 0, action: 'EMAIL' }, { level: 2, offsetDays: 7, action: 'EMAIL' }] }], mayChange: true }
const priceRow = (n: number, ours: number, theirs: number, lines: number, accepted = false): OrderRow => ({ id: uid('6161', n), number: `MODA-SO-00${10 + n}`, currency: 'EUR', netAmount: ours, brandPrice: theirs, priceDiff: ours - theirs, priceNotEqualLines: lines, priceAccepted: accepted, priceMatch: 'NOT_EQUAL' }) as unknown as OrderRow
const PRICE_ROWS = [priceRow(4, 1_224_000, 1_200_000, 2), priceRow(5, 980_000, 992_000, 1, true)]
const marginsOf = (over: { pct: string; value: number; cost: number | null; below: number; orders: number; currency?: string | null }): Margins => ({
  ...MARGINS,
  rows: MARGINS.rows.slice(0, 1),
  tiles: { ...MARGINS.tiles, orders: over.orders, belowFloor: over.below, currency: over.currency === undefined ? 'EUR' : over.currency },
  byCustomer: [{ party: { id: moda.id, name: NAME }, orders: over.orders, value: over.value, estimateCost: over.cost, marginPct: over.pct }],
})
const MARGIN_OK = marginsOf({ pct: '41.2000', value: 4_120_000, cost: 2_422_560, below: 0, orders: 5 })
const RETURNS: readonly CustomerReturn[] = [
  { id: uid('a2a2', 1), number: 'RMA-2026-0007', companyId: COMPANY.id, status: 'CLOSED', units: 2, requestedAt: '2026-10-20T09:00:00.000Z', late: false, creditTotal: 61000, currency: 'EUR' },
  { id: uid('a2a2', 2), number: 'RMA-2026-0003', companyId: COMPANY.id, status: 'CLOSED', units: 1, requestedAt: '2026-05-12T09:00:00.000Z', late: false, creditTotal: 30500, currency: 'EUR' },
]

// ── one case: the tab's input, its lazy reads, the room, the window opened in place ──
export interface CmCaseModel {
  readonly role: CmRole
  /** The rights held; absent: the role's grant. */
  readonly held?: readonly string[]
  readonly input?: Partial<MoneyTabInput>
  readonly lazy?: Partial<LazyParts>
  /** The tab's room in px (the kit lays each section out by it). */
  readonly room?: 343 | 865 | 1314
  readonly window?: CmWindow
}
export type CmWindow = 'door-reading' | 'door-held' | 'limit-change' | 'limit-set' | 'statement' | 'statement-send' | 'refund' | 'refund-move' | 'hold-place' | 'hold-release'

const noop = () => undefined
/** The tab as the container builds it for a case (the money wall applied by the grains the role holds). */
export function cmTabOf(model: CmCaseModel): { readonly input: MoneyTabInput; readonly lazy: LazyParts } {
  const held = model.held ?? cmHeld(model.role)
  const can = moneyTabCanOf(held)
  const wall = <T,>(part: Part<T> | null): Part<T> | null => (part && !can.price && part.value !== null ? partReady(stripAmounts(part.value)) : part)
  const glance = model.input?.glance ?? { status: 'ready' as const, value: glanceOf('MODA-DEMO') }
  const base: MoneyTabInput = {
    party: { id: moda.id, name: NAME, currency: 'EUR', paymentTerms: '30 days end of month' },
    company: { id: COMPANY.id, name: COMPANY.name },
    companies: 2,
    can,
    today: TODAY,
    ageing: partReady(AGEING),
    ageingElsewhere: partReady([]),
    openItems: partReady({ items: MONEY_OPEN_ITEMS, creditBalance: [{ currency: 'EUR', amount: 120000 }] }),
    refunds: partReady(MONEY_OPEN_REFUNDS),
    stops: partReady([STOP_PROMISE]),
    reminders: partReady([REMINDER_WAITING, REMINDER_SENT]),
    summary: partReady(MONEY_ORDER_SUMMARY),
    shipped: partReady(null),
    glance,
    openOrders: null,
    priceDiffer: 2,
    priceMissing: 1,
    returns: { rows: RETURNS, year: '2026', href: `${PREFIX}/sales/returns?party=${moda.id}` },
    ...model.input,
  }
  const priced = (value: Partial<MoneyTabInput>): Partial<MoneyTabInput> => ({ ...value, priceDiffer: can.price ? value.priceDiffer ?? null : null, priceMissing: can.price ? value.priceMissing ?? null : null })
  const ready = { ...base, ...priced(base) }
  const input: MoneyTabInput = {
    ...ready,
    ageing: can.receivables ? wall(ready.ageing) : null,
    ageingElsewhere: can.receivables ? wall(ready.ageingElsewhere) : null,
    openItems: can.payments ? wall(ready.openItems) : null,
    refunds: can.payments ? wall(ready.refunds) : null,
    stops: can.receivables ? ready.stops : null,
    reminders: can.receivables ? wall(ready.reminders) : null,
    summary: can.orders ? ready.summary : null,
    shipped: can.invoices ? ready.shipped : null,
    glance: ready.glance?.status === 'ready' && !can.price ? { status: 'ready', value: withoutPrices(ready.glance.value) } : ready.glance,
    returns: ready.returns ? { ...ready.returns, rows: can.price ? ready.returns.rows : stripAmounts(ready.returns.rows) } : null,
  }
  const lazyBase: LazyParts = {
    want: noop,
    documents: partReady(DOCUMENTS),
    chip: 'all',
    onChip: noop,
    onMoreDocuments: noop,
    payments: partReady(PAYMENTS),
    credit: partReady(ON_ACCOUNT),
    refundsMade: partReady([REFUND_MADE]),
    onMorePayments: noop,
    onRefund: noop,
    onMoveRefund: noop,
    creditRow: partReady(LIMIT_ROW),
    terms: partReady(TERMS),
    trust: partReady(TRUST),
    settings: partReady(SWITCH_ON),
    priceRows: partReady(PRICE_ROWS),
    margin: partReady(MARGIN_OK),
    onChangeLimit: noop,
    onPlaceHold: noop,
    onStatement: noop,
    onLift: noop,
    ...model.lazy,
  }
  const lazy: LazyParts = {
    ...lazyBase,
    documents: can.invoices ? wall(lazyBase.documents) : null,
    payments: can.payments ? wall(lazyBase.payments) : null,
    credit: can.payments ? wall(lazyBase.credit) : null,
    refundsMade: can.payments ? wall(lazyBase.refundsMade) : null,
    creditRow: can.credit ? wall(lazyBase.creditRow) : null,
    trust: can.receivables ? lazyBase.trust : null,
    settings: can.receivables ? lazyBase.settings : null,
    priceRows: can.orders && can.price ? lazyBase.priceRows : null,
    margin: can.margin && can.costing ? lazyBase.margin : null,
  }
  return { input, lazy }
}

// ── the windows, each opened in place on the tab (their insides: a DS Modal draws once hydrated) ──
const limitWindow = (open: boolean, row: LimitRow | null): LimitWindow => ({
  state: open ? (row ? { row, problem: null, draft: { amountText: '60.000,00', currency: 'EUR', clear: false, reason: 'Two years without a late payment (made-up).' } } : { row: null, problem: null, draft: { amountText: '', currency: 'EUR', clear: false, reason: '', partyId: moda.id } }) : null,
  customers: [{ id: moda.id, code: moda.code, legalName: moda.legalName, tradeName: moda.tradeName ?? null, currency: 'EUR', companyId: COMPANY.id }],
  busy: false,
  onOpen: noop,
  onSubmit: () => Promise.resolve(false),
  onClose: noop,
})
const statementWindow = (held: readonly string[], open: boolean, sending: boolean): StatementWindow => ({
  state: open ? { ref: { partyId: moda.id, companyId: COMPANY.id, currency: 'EUR' }, period: { from: null, to: null }, value: { ...STATEMENT, customer: { ...STATEMENT.customer, id: moda.id, code: moda.code, name: NAME } }, problem: null, sending } : null,
  can: receivablesCanOf(held),
  busy: false,
  onOpen: noop,
  onPeriod: noop,
  onPrint: noop,
  onSend: () => Promise.resolve(false),
  onCurrency: noop,
  onRetry: noop,
  onClose: noop,
})
const refundWindows = (held: readonly string[], kind: 'refund' | 'move'): RefundWindows => ({
  can: refundAbilitiesOf(held),
  dialog: kind === 'refund' ? { start: null } : null,
  move: kind === 'move' ? { refund: MONEY_OPEN_REFUNDS.refundsDue[0]!, move: 'paid' } : null,
  busy: false,
  problem: null,
  onOpen: noop,
  onMove: noop,
  onRecord: noop,
  onDoMove: noop,
  onClose: noop,
})
const TO_REFUND: ToRefund = { creditNoteId: uid('5252', 2), number: 'NC-2026-00011', issueDate: '2026-10-28', companyId: COMPANY.id, partyId: moda.id, party: { code: moda.code, legalName: moda.legalName }, currency: 'EUR', grossTotal: 48800, creditOfId: uid('5353', 2), creditOfNumber: 'FT-2026-00038', creditOfDocType: 'TD01', orderNumber: 'MODA-SO-0014', refundedAmount: 0, refundableAmount: 48800 }
const doorModel = (held: boolean): OrderMoneyDoorModel => ({
  target: { id: MONEY_OPEN_ITEMS[3]!.orderId!, number: MONEY_OPEN_ITEMS[3]!.orderNumber! },
  ask: { act: 'MOVE_DUE', requestId: MONEY_OPEN_ITEMS[3]!.id },
  // The order as read (held: only its number and currency are said); its plan's rule.
  order: held ? ({ id: MONEY_OPEN_ITEMS[3]!.orderId!, number: MONEY_OPEN_ITEMS[3]!.orderNumber!, currency: 'EUR' } as unknown as Order) : null,
  problem: null,
  schedule: held ? null : READING,
  settlement: null,
  ruling: held ? { held: word('moneyTab.refusal.MOVED'), start: null } : null,
  dialogs: {} as MoneyDialogModel,
  stepUp: { open: false, busy: false, sentence: '', problem: null },
})
const HOLD_STATE: Holds = HOLDS
const holdDialog = (kind: 'place' | 'release'): HoldDialog =>
  kind === 'place' ? { kind: 'place', draft: { companyId: COMPANY.id, reason: 'CREDIT', words: 'Over the limit: two invoices late (made-up).' }, busy: false, failed: null, tried: false } : { kind: 'release', hold: HOLDS.holds[0]!, draft: { holdId: HOLDS.holds[0]!.id, words: 'The answer on the claim came (made-up).' }, busy: false, failed: null, tried: false }

function windowOf(window: CmWindow, held: readonly string[], glance: Glance): ReactNode {
  switch (window) {
    case 'door-reading':
    case 'door-held':
      return createElement(OrderMoneyWindow, { model: doorModel(window === 'door-held') })
    case 'limit-change':
    case 'limit-set':
      return createElement(AccountWindowsView, { limit: limitWindow(true, window === 'limit-change' ? LIMIT_ROW : null), statement: statementWindow(held, false, false), companyCode: COMPANY.code, prefix: PREFIX })
    case 'statement':
    case 'statement-send':
      return createElement(AccountWindowsView, { limit: limitWindow(false, null), statement: statementWindow(held, true, window === 'statement-send'), companyCode: COMPANY.code, prefix: PREFIX })
    case 'refund':
    case 'refund-move':
      return createElement(RefundWindowsView, { windows: refundWindows(held, window === 'refund' ? 'refund' : 'move'), targets: [targetOfNote(TO_REFUND)], today: TODAY })
    case 'hold-place':
    case 'hold-release':
      return createElement(HoldDialogView, { model: { read: { status: 'ready', value: HOLD_STATE }, can: ALL_CAN, status: glance.party.status, prefix: PREFIX, dialog: holdDialog(window === 'hold-place' ? 'place' : 'release'), companies: [COMPANY, OTHER] } })
  }
}

/** The design's Money tab for a case: the tab in its room, and the window opened in place. */
export function CmMoneyDesign({ cm }: { cm: CmCaseModel }) {
  const { input, lazy } = cmTabOf(cm)
  const held = cm.held ?? cmHeld(cm.role)
  const tab = createElement(CustomerMoneyTab, { input, lazy, prefix: PREFIX, asOf: '2026-10-31T09:44:00.000Z', onRetry: noop })
  const glance = input.glance?.status === 'ready' ? input.glance.value : glanceOf('MODA-DEMO')
  const room: CSSProperties | null = cm.room ? { width: `${cm.room}px`, maxWidth: '100%' } : null
  return (
    <div data-cm-room={cm.room} style={room ?? undefined}>
      {tab}
      {cm.window ? windowOf(cm.window, held, glance) : null}
    </div>
  )
}

// ── the cases (ids `cm-*`; the labels say what each shows) ──
const twoCurrencyItems: OpenItem[] = [...MONEY_OPEN_ITEMS.slice(0, 2), openItem(31, { number: 'FT-2026-00061', docType: 'TD01', currency: 'CHF', dueDate: '2026-10-15', amount: 280000, openAmount: 280000 })]
const reading: Partial<MoneyTabInput> = { ageing: READING, ageingElsewhere: READING, openItems: READING }
const readingTab: Partial<MoneyTabInput> = { refunds: READING, stops: READING, reminders: READING, summary: READING, shipped: READING, glance: { status: 'loading' } }
const readingLazy: Partial<LazyParts> = { documents: READING, payments: READING, credit: READING, refundsMade: READING, creditRow: READING, terms: READING, trust: READING, settings: READING, priceRows: READING, margin: READING }
const FAIL = 'problem.read.unavailable'

export const CM_CASES: readonly { readonly id: string; readonly label: string; readonly cm: CmCaseModel }[] = [
  // The nine customers of the picture (as the Owner reads them).
  { id: 'cm-busy', label: 'cm · Busy: something in every section (the Owner)', cm: { role: 'owner' } },
  {
    id: 'cm-late-hold',
    label: 'cm · Late invoices · a late deposit · over the limit · on hold (What needs you points ↓ to each section)',
    cm: {
      role: 'owner',
      input: { ageing: partReady([ageing({ open: 1_098_000, overdue: 854_000, daysLate: 52, invoices: 4 })]), glance: { status: 'ready', value: glanceOf('MODA-DEMO', HELD_GLANCE) }, priceDiffer: 0, priceMissing: 0 },
      lazy: { creditRow: partReady({ ...LIMIT_ROW, used: 5_310_000, available: null, overLimitBy: 310_000, usedPct: 106, onHold: true, held: { orders: 2, releases: 1, shipments: 1, firstOrders: [] } }) },
    },
  },
  {
    id: 'cm-on-account',
    label: 'cm · Money on account · a refund due · a credit note to refund',
    cm: { role: 'owner', input: { refunds: partReady({ ...MONEY_OPEN_REFUNDS, counts: { refundsDue: 1, creditNotesToRefund: 1 }, creditNotesToRefund: [TO_REFUND] }), stops: partReady([]), reminders: partReady([]), priceDiffer: 0, priceMissing: 0 } },
  },
  {
    id: 'cm-nothing',
    label: 'cm · Nothing open: everything is paid (the quiet sections share one card)',
    cm: {
      role: 'owner',
      input: { ageing: partReady([]), openItems: partReady({ items: [], creditBalance: [] }), refunds: partReady({ ...MONEY_OPEN_REFUNDS, counts: { refundsDue: 0, creditNotesToRefund: 0 }, refundsDue: [] }), stops: partReady([]), reminders: partReady([]), priceDiffer: 0, priceMissing: 0 },
      lazy: { documents: partReady({ rows: [DOCUMENTS.rows[3]!], next: null }), payments: partReady({ rows: [PAYMENTS.rows[1]!], next: null }), credit: null, refundsMade: partReady([]), creditRow: partReady({ ...LIMIT_ROW, used: 0, openOrders: 0, openInvoices: 0, overdue: 0, available: 5_000_000, usedPct: 0 }) },
    },
  },
  {
    id: 'cm-new',
    label: 'cm · A new customer: no order yet (no limit, nothing to state)',
    cm: {
      role: 'owner',
      input: { ageing: partReady([]), openItems: partReady({ items: [], creditBalance: [] }), refunds: partReady({ ...MONEY_OPEN_REFUNDS, counts: { refundsDue: 0, creditNotesToRefund: 0 }, refundsDue: [] }), stops: partReady([]), reminders: partReady([]), summary: partReady({ ...MONEY_ORDER_SUMMARY, all: { ...MONEY_ORDER_SUMMARY.all, orders: { count: 0, filter: null }, invoiced: { NONE: { count: 0, filter: null }, PART: { count: 0, filter: null }, ALL: { count: 0, filter: null } } } }), glance: { status: 'ready', value: glanceOf('PILOTA-DEMO', { party: glanceOf('MODA-DEMO').party }) }, priceDiffer: null, priceMissing: null, returns: null },
      lazy: { documents: partReady({ rows: [], next: null }), payments: partReady({ rows: [], next: null }), credit: null, refundsMade: partReady([]), creditRow: partReady(null), margin: partReady(marginsOf({ pct: '0', value: 0, cost: null, below: 0, orders: 0 })) },
    },
  },
  {
    id: 'cm-two-currencies',
    label: 'cm · Two currencies: EUR and CHF, never added (one answer line per currency)',
    cm: {
      role: 'owner',
      input: { ageing: partReady([ageing(), ageing({ currency: 'CHF', open: 280000, overdue: 280000, buckets: { NOT_DUE: 0, D1_30: 280000, D31_60: 0, D61_90: 0, OVER_90: 0 }, invoices: 1, oldestDueDate: '2026-10-15', daysLate: 16 })]), openItems: partReady({ items: twoCurrencyItems, creditBalance: [] }) },
      lazy: { margin: partReady(marginsOf({ pct: '40.1000', value: 3_200_000, cost: 1_916_800, below: 0, orders: 4, currency: null })) },
    },
  },
  {
    id: 'cm-prices-margin',
    label: 'cm · Prices differ on 3 orders · the margin below the floor',
    cm: { role: 'owner', input: { priceDiffer: 3, priceMissing: 2 }, lazy: { priceRows: partReady([...PRICE_ROWS, priceRow(6, 640_000, 610_000, 3)]), margin: partReady(marginsOf({ pct: '34.8000', value: 4_120_000, cost: 2_686_240, below: 2, orders: 5 })) } },
  },
  {
    id: 'cm-stops',
    label: 'cm · Reminders stopped: a promise to pay and a dispute (a held reminder says why)',
    cm: { role: 'owner', input: { stops: partReady([STOP_PROMISE, STOP_DISPUTE]), reminders: partReady([REMINDER_HELD, REMINDER_SENT]) } },
  },
  {
    id: 'cm-elsewhere',
    label: 'cm · Also owes another company of the group (one quiet line, its door)',
    cm: { role: 'owner', input: { ageingElsewhere: partReady([ageing({ company: { id: OTHER.id, code: OTHER.code, name: OTHER.name }, open: 183000, overdue: 61000, invoices: 2 })]) } },
  },
  // Reminders switched off for the company.
  { id: 'cm-reminders-off', label: 'cm · Reminders switched off for this company (said once)', cm: { role: 'owner', lazy: { settings: partReady(SWITCH_OFF as ReceivablesSettings) } } },
  // Each read reading, each read failed.
  { id: 'cm-reading-page', label: 'cm · Reading: the page\'s money (ageing, open items)', cm: { role: 'owner', input: reading } },
  { id: 'cm-reading-tab', label: 'cm · Reading: the tab\'s first reads (refunds, stops, reminders, orders, shipped) and the glance', cm: { role: 'owner', input: readingTab } },
  { id: 'cm-reading-sections', label: 'cm · Reading: the sections read when reached (invoices, payments, credit, terms, reminders, prices, margin)', cm: { role: 'owner', lazy: readingLazy } },
  { id: 'cm-failed-page', label: 'cm · Failed: the page\'s money (Try again)', cm: { role: 'owner', input: { ageing: partFailed(FAIL), openItems: partFailed(FAIL) } } },
  { id: 'cm-failed-tab', label: 'cm · Failed: the tab\'s first reads (each part says what it could not read)', cm: { role: 'owner', input: { refunds: partFailed(FAIL), stops: partFailed(FAIL), reminders: partFailed(FAIL), summary: partFailed(FAIL), shipped: partFailed(FAIL) } } },
  { id: 'cm-failed-invoices', label: 'cm · Failed: Invoices & credit notes', cm: { role: 'owner', lazy: { documents: partFailed(FAIL) } } },
  { id: 'cm-failed-payments', label: 'cm · Failed: Payments & refunds', cm: { role: 'owner', lazy: { payments: partFailed(FAIL), credit: partFailed(FAIL), refundsMade: partFailed(FAIL) } } },
  { id: 'cm-failed-credit', label: 'cm · Failed: Credit & terms', cm: { role: 'owner', lazy: { creditRow: partFailed(FAIL), terms: partFailed(FAIL) } } },
  { id: 'cm-failed-statement', label: 'cm · Failed: Statement & reminders', cm: { role: 'owner', input: { reminders: partFailed(FAIL) } } },
  { id: 'cm-failed-price', label: 'cm · Failed: Price check\'s orders', cm: { role: 'owner', lazy: { priceRows: partFailed(FAIL) } } },
  { id: 'cm-failed-margin', label: 'cm · Failed: Margin & cost', cm: { role: 'owner', lazy: { margin: partFailed(FAIL) } } },
  // No payments.view: To collect, Payments & refunds and the deposit parts left out (never 0).
  { id: 'cm-no-payments', label: 'cm · Without payments.view: To collect and Payments & refunds left out, no deposit part', cm: { role: 'owner', held: cmHeld('owner').filter((right) => right !== 'payments.view') } },
  // The four office roles on the busy customer (their template's REAL grant).
  { id: 'cm-role-owner', label: 'cm · The Owner: every amount, every act', cm: { role: 'owner' } },
  { id: 'cm-role-finance', label: 'cm · Finance: every amount; the acts of its rights', cm: { role: 'finance' } },
  { id: 'cm-role-sales', label: 'cm · Sales: words only — no amount, no Price check, no Margin, no money act', cm: { role: 'sales' } },
  { id: 'cm-role-readonly', label: 'cm · Read-only: words only, no act', cm: { role: 'read_only' } },
  // The rooms (the kit lays every section out by the room the tab has).
  { id: 'cm-room-343', label: 'cm · The room of a phone (343 px): every section stacks', cm: { role: 'owner', room: 343 } },
  { id: 'cm-room-865', label: 'cm · 865 px (the tab beside a docked thread)', cm: { role: 'owner', room: 865 } },
  { id: 'cm-room-1314', label: 'cm · 1314 px: Credit | Terms and Reminders | Stops side by side', cm: { role: 'owner', room: 1314 } },
  // The windows opened in place, each its own case.
  { id: 'cm-win-door-reading', label: 'cm · Window: the order\'s Move due day… while the order is read', cm: { role: 'finance', window: 'door-reading' } },
  { id: 'cm-win-door-held', label: 'cm · Window: the order\'s act held — the plan changed meanwhile', cm: { role: 'finance', window: 'door-held' } },
  { id: 'cm-win-limit-change', label: 'cm · Window: Change limit… (Finance\'s editor) on the customer\'s row', cm: { role: 'finance', window: 'limit-change' } },
  { id: 'cm-win-limit-set', label: 'cm · Window: Set a limit… (no limit yet: this one customer chosen)', cm: { role: 'finance', window: 'limit-set' } },
  { id: 'cm-win-statement', label: 'cm · Window: Statement… (Finance\'s statement of the customer)', cm: { role: 'finance', window: 'statement' } },
  { id: 'cm-win-statement-send', label: 'cm · Window: Send statement… (its send step)', cm: { role: 'finance', window: 'statement-send' } },
  { id: 'cm-win-refund', label: 'cm · Window: Refund… (Finance\'s window; a credit note to refund)', cm: { role: 'finance', window: 'refund' } },
  { id: 'cm-win-refund-move', label: 'cm · Window: Mark made… on a refund due', cm: { role: 'finance', window: 'refund-move' } },
  { id: 'cm-win-hold-place', label: 'cm · Window: Put on hold… (the Terms tab\'s own window)', cm: { role: 'owner', window: 'hold-place' } },
  { id: 'cm-win-hold-release', label: 'cm · Window: Release… the hold in force', cm: { role: 'owner', input: { glance: { status: 'ready', value: glanceOf('MODA-DEMO', HELD_GLANCE) } }, window: 'hold-release' } },
]
