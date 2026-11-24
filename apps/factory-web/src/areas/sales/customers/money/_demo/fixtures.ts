import { DEMO_COMPANIES, rolePermissions } from '../../../../../shell/design-data'
import type { AgeingRow } from '../../../../finance/receivables/api'
import { CUSTOMERS, PREFIX } from '../../../../parties/_shared/fixtures'
import { failed, loaded, loading } from '../../../../parties/_shared/model'
import type { CustomerComplaint, CustomerReturn } from '../api'
import type { OverdueListModel } from '../columns'
import { customerMoneyCanOf, overdueByParty, type CustomerMoneyCan } from '../model'
import type { CustomerMoneyModel } from '../overview'
import type { OpenItem } from '../../../../finance/_shared/api' // F-CM-104
import type { OpenRefunds } from '../../../../finance/payments/refunds/api' // F-CM-104
import type { OrderSummary } from '../../../orders/api' // F-CM-104
import { moneyTabCanOf, partReady, type MoneyTabInput } from '../../record/money/model' // F-CM-104

/**
 * Made-up money and after-sales data for the customers' design cases of B-W2a-81 (SCR-032 Overdue column, SCR-033
 * Overview tiles and "Open returns and claims"): the demo customers of the parties fixtures, invented invoices, returns
 * and complaints. Nothing here is real. Design-only.
 */

const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const COMPANY = { id: DEMO_COMPANIES[0].id, code: 'DEMO', name: DEMO_COMPANIES[0].name }
const by = (code: string) => CUSTOMERS.find((party) => party.code === code)!

export const MONEY_CAN = {
  finance: customerMoneyCanOf(['receivables.view', 'money.price', 'sales.returns.view', 'quality.complaints.view']),
  /**
   * B-CP-011 (the money wall, Owner O1): the real Sales role — receivables.view, returns, complaints, orders and credit read, no
   * price grain (no amount, no currency) and no sales.credit.limits. A case that shows amounts is Finance's.
   */
  sales: customerMoneyCanOf(rolePermissions('sales')),
  /** A role without the price grain: the Overdue column is not drawn; the tile counts late invoices. */
  noPrice: customerMoneyCanOf(['receivables.view', 'sales.returns.view']),
  /** No receivables.view: no Overdue anywhere. */
  none: customerMoneyCanOf(['sales.returns.view']),
} satisfies Record<string, CustomerMoneyCan>

const ageing = (code: string, over: Partial<AgeingRow>): AgeingRow => {
  const party = by(code)
  return {
    company: COMPANY,
    customer: { id: party.id, code: party.code, name: party.legalName },
    currency: 'EUR',
    open: 0,
    overdue: 0,
    buckets: { NOT_DUE: 0, D1_30: 0, D31_60: 0, D61_90: 0, OVER_90: 0 },
    invoices: 1,
    oldestDueDate: null,
    daysLate: null,
    lastPaymentOn: null,
    remindersSent: 0,
    lastReminderAt: null,
    remindersWaiting: 0,
    creditLimitUsed: null,
    ...over,
  }
}

/** Moda Demo owes 4,270.00 late (oldest 38 days); Marchio Esempio 610.00 (12 days); Beispiel 1,220.00 in EUR and 300.00 in CHF. */
export const OVERDUE_ROWS: AgeingRow[] = [
  ageing('MODA-DEMO', { open: 671000, overdue: 427000, buckets: { NOT_DUE: 244000, D1_30: 0, D31_60: 427000, D61_90: 0, OVER_90: 0 }, invoices: 3, oldestDueDate: '2026-09-23', daysLate: 38 }),
  ageing('MARCHIO-ESEMPIO', { open: 61000, overdue: 61000, buckets: { NOT_DUE: 0, D1_30: 61000, D31_60: 0, D61_90: 0, OVER_90: 0 }, oldestDueDate: '2026-10-19', daysLate: 12 }),
  ageing('DE-BEISPIEL', { open: 122000, overdue: 122000, buckets: { NOT_DUE: 0, D1_30: 122000, D31_60: 0, D61_90: 0, OVER_90: 0 }, oldestDueDate: '2026-10-10', daysLate: 21 }),
  ageing('DE-BEISPIEL', { currency: 'CHF', open: 30000, overdue: 30000, buckets: { NOT_DUE: 0, D1_30: 30000, D31_60: 0, D61_90: 0, OVER_90: 0 }, oldestDueDate: '2026-10-25', daysLate: 6 }),
]

export const overdueList = (can: CustomerMoneyCan, over: Partial<OverdueListModel> = {}): OverdueListModel => ({ can, byParty: overdueByParty(OVERDUE_ROWS), problem: null, ...over })

const moda = by('MODA-DEMO')
export const RETURNS: CustomerReturn[] = [
  { id: uid('8181', 1), number: 'RMA-2026-0012', companyId: COMPANY.id, status: 'AUTHORISED', units: 3, requestedAt: '2026-10-20T09:00:00.000Z', late: false },
  { id: uid('8181', 2), number: 'RMA-2026-0007', companyId: COMPANY.id, status: 'RECEIVED', units: 1, requestedAt: '2026-09-12T09:00:00.000Z', late: true },
  { id: uid('8181', 3), number: 'RMA-2026-0003', companyId: COMPANY.id, status: 'CLOSED', units: 2, requestedAt: '2026-04-02T09:00:00.000Z', late: false },
  { id: uid('8181', 4), number: 'RMA-2025-0041', companyId: COMPANY.id, status: 'CLOSED', units: 5, requestedAt: '2025-11-30T09:00:00.000Z', late: false },
]
export const COMPLAINTS: CustomerComplaint[] = [
  {
    id: uid('9191', 1),
    number: 'CMP-2026-0004',
    companyId: COMPANY.id,
    status: 'INVESTIGATING',
    receivedAt: '2026-10-22T10:00:00.000Z',
    answerDueOn: '2026-11-05',
    summary: 'Seam opened on a jacket sleeve',
  },
]

/** Moda Demo: overdue 4,270.00 (38 days); 3 returns in 2026 (6 units, 2 open); one complaint being investigated. */
export const moneyModel = (can: CustomerMoneyCan, over: Partial<CustomerMoneyModel> = {}): CustomerMoneyModel => ({
  can,
  prefix: PREFIX,
  partyId: moda.id,
  year: '2026',
  ageing: loaded(OVERDUE_ROWS.filter((row) => row.customer.id === moda.id)),
  returns: loaded(RETURNS),
  complaints: loaded(COMPLAINTS),
  returnsHref: null,
  ...over,
})

export const MONEY_STATES = {
  loading: { ageing: loading<AgeingRow>(), returns: loading<CustomerReturn>(), complaints: loading<CustomerComplaint>() },
  failed: { ageing: failed<AgeingRow>('problem.unavailable'), returns: failed<CustomerReturn>('problem.unavailable'), complaints: loaded<CustomerComplaint>([]) },
}

// ── F-CM-104 (customer MONEY tab, cm-w1 W1.4; 13-backend §5.8): made-up answers of the Money tab's reads for Moda Demo — the page's
// ageing (above), its open items and money on account, refunds to make, the open orders' figures; the server's money wall is applied
// here as the API applies it (no amount without the price grain). Every name and number is made up. ──

/** The day the made-up money is counted at (Moda Demo's oldest invoice is 38 days late on it). */
export const MONEY_TAB_TODAY = '2026-10-31'

const VIEWS = ['receivables.view', 'payments.view', 'invoices.view', 'orders.view', 'sales.credit.view', 'parties.view', 'sales.returns.view', 'quality.complaints.view']
/** The rights of the gallery's Money cases: Finance (every amount and act but Waive…) and Sales (words only, no act). */
export const MONEY_TAB_ROLES = {
  finance: [...VIEWS, 'money.price', 'money.margin', 'payments.record', 'payments.refund', 'payments.void', 'invoices.manage', 'invoices.issue', 'orders.moneyPlan', 'sales.credit.limits', 'receivables.reminders.manage', 'receivables.statements.send', 'parties.hold'],
  sales: [...VIEWS, 'parties.hold'],
} as const

const openItem = (n: number, over: Partial<OpenItem>): OpenItem => ({ target: 'INVOICE', id: uid('7171', n), number: null, docType: null, fiscalDocument: null, stepKind: null, orderId: uid('6161', n), orderNumber: `MODA-SO-00${10 + n}`, date: '2026-09-01', dueDate: null, currency: 'EUR', amount: 0, openAmount: 0, ...over })

/** Three open invoices (4,270.00 of them 38 days late) and two deposit requests (one 3 days late), as GET /payments/open-items. */
export const MONEY_OPEN_ITEMS: OpenItem[] = [
  openItem(1, { number: 'FT-2026-00041', docType: 'TD01', dueDate: '2026-09-23', amount: 427000, openAmount: 427000 }),
  openItem(2, { number: 'FT-2026-00052', docType: 'TD01', dueDate: '2026-11-15', amount: 122000, openAmount: 122000 }),
  openItem(3, { number: 'FT-2026-00057', docType: 'TD01', dueDate: '2026-11-30', amount: 122000, openAmount: 122000 }),
  openItem(4, { target: 'DEPOSIT_REQUEST', fiscalDocument: 'TD02', stepKind: 'DEPOSIT', date: '2026-10-20', dueDate: '2026-10-28', amount: 183000, openAmount: 183000 }),
  openItem(5, { target: 'DEPOSIT_REQUEST', fiscalDocument: 'TD02', stepKind: 'BEFORE_SHIPPING', date: '2026-10-25', dueDate: '2026-11-06', amount: 244000, openAmount: 244000 }),
]

/** One refund to make (a credit note of 610.00, by 7 November), as GET /payments/refunds/open. */
export const MONEY_OPEN_REFUNDS: OpenRefunds = {
  counts: { refundsDue: 1, creditNotesToRefund: 0 },
  refundsDue: [
    { id: uid('5151', 1), version: 1, companyId: COMPANY.id, partyId: moda.id, party: { code: moda.code, legalName: moda.legalName }, source: 'CREDIT_NOTE', creditNote: { id: uid('5252', 1), number: 'NC-2026-00007', issueDate: '2026-10-24', creditOfId: uid('5353', 1), creditOfNumber: 'FT-2026-00033', creditOfDocType: 'TD01' }, payment: null, method: 'BANK_TRANSFER', amount: 61000, currency: 'EUR', dueDate: '2026-11-07', status: 'DUE', paidOn: null, externalRef: null, cancelReason: null, voidReason: null, internalNote: null, createdAt: '2026-10-24T09:00:00.000Z' },
  ],
  creditNotesToRefund: [],
  asOf: MONEY_TAB_TODAY,
}

const door = (count: number) => ({ count, filter: null })
/** The open orders' figures (GET /sales/orders/summary?open): 5 open, 2 not invoiced at all, 1 in part. */
export const MONEY_ORDER_SUMMARY: OrderSummary = { all: { orders: door(5), pieces: { ordered: door(0), shipped: door(0), open: door(0) }, late: door(1), atRisk: door(0), invoiced: { NONE: door(2), PART: door(1), ALL: door(2) } }, groups: null, limited: false, asOf: '2026-10-31T09:44:00.000Z' }

/** The Money tab's whole input for Moda Demo as a role reads it (the server's wall applied: no amount without the price grain). */
export function moneyTabDemo(role: keyof typeof MONEY_TAB_ROLES, over: Partial<MoneyTabInput> = {}): MoneyTabInput {
  const can = moneyTabCanOf(MONEY_TAB_ROLES[role])
  const strip = <T extends object>(value: T, keys: readonly string[]): T => (can.price ? value : (Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key))) as T))
  return {
    party: { id: moda.id, name: moda.tradeName ?? moda.legalName, currency: 'EUR', paymentTerms: '30 days end of month' },
    company: { id: COMPANY.id, name: COMPANY.name },
    companies: 1,
    can,
    today: MONEY_TAB_TODAY,
    ageing: partReady(OVERDUE_ROWS.filter((row) => row.customer.id === moda.id).map((row) => strip(row, ['open', 'overdue', 'buckets']))),
    ageingElsewhere: partReady([]),
    openItems: partReady({ items: MONEY_OPEN_ITEMS.map((item) => strip(item, ['amount', 'openAmount'])), creditBalance: [] }),
    refunds: partReady({ ...MONEY_OPEN_REFUNDS, refundsDue: MONEY_OPEN_REFUNDS.refundsDue.map((refund) => strip(refund, ['amount'])) }),
    stops: partReady([]),
    reminders: partReady([]),
    summary: partReady(MONEY_ORDER_SUMMARY),
    shipped: partReady(null),
    glance: null,
    openOrders: null,
    priceDiffer: null,
    ...over,
  }
}
// ── end F-CM-104 ──
