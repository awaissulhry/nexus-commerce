import { DEMO_COMPANIES } from '../../../../../shell/design-data'
import type { AgeingRow } from '../../../../finance/receivables/api'
import { CUSTOMERS, PREFIX } from '../../../../parties/_shared/fixtures'
import { failed, loaded, loading } from '../../../../parties/_shared/model'
import type { CustomerComplaint, CustomerReturn } from '../api'
import type { OverdueListModel } from '../columns'
import { customerMoneyCanOf, overdueByParty, type CustomerMoneyCan } from '../model'
import type { CustomerMoneyModel } from '../overview'

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
  /** Sales after B-W2a-81: receivables.view (read), the price grain, returns and complaints. */
  sales: customerMoneyCanOf(['receivables.view', 'money.price', 'sales.returns.view', 'quality.complaints.view']),
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
