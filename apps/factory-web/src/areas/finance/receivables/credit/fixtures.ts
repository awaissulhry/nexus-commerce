import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { GAMMA, inShell, PREFIX, TODAY, type Role } from '../demo/fixtures'
import type { CreditLimits, CustomerOption, LimitRow } from './api'
import { creditCanOf } from './model'
import { CreditLimitsView, type CreditLimitsModel } from './view/CreditLimitsView'

/**
 * SCR-151-credit — Finance › Receivables & credit › Credit limits (design finance.receivables sec:credit, B-W2b-304) with
 * made-up data only: the customers with a limit (limit, used with its bar, available or over by, overdue, what waits for
 * credit with the first orders), the views All · Over the limit · Something waits, rows chosen → Export N, "Change limit"
 * (the reason, then the DS ActionConfirm review; a refusal in words), "Set a limit" for a new customer, the notice after a
 * save that let a held order go on, and the states (loading with "Still loading…", error, empty, nothing matching, live
 * updates, the keys panel) and roles: Finance and Owner (everything), Sales (reads; Change limit held with the permission
 * in words), Read-only (no price grain: who has a limit and what waits, no figure), Warehouse (no access). Every name and
 * figure is invented (sums in the comments); none is a real customer.
 */

interface Case {
  role: Role
  page: CreditLimitsModel
}

const uid = (n: number) => `0190f0e2-3131-7000-8000-${String(n).padStart(12, '0')}`
const COMPANY = { id: '0190f0e2-0000-7000-8000-000000000001', code: 'DEMO' }

const PERMISSIONS: Record<Role, string[]> = {
  owner: ['sales.credit.view', 'sales.credit.limits', 'sales.credit.checks', 'money.price'],
  finance: ['sales.credit.view', 'sales.credit.limits', 'sales.credit.checks', 'money.price'],
  sales: ['sales.credit.view', 'sales.credit.checks', 'money.price'],
  readOnly: ['sales.credit.view'],
  warehouse: [],
}

const limitRow = (n: number, party: { id: string; code: string; name: string }, over: Partial<LimitRow>): LimitRow => ({
  termsId: uid(n),
  version: 2,
  party,
  company: COMPANY,
  currency: 'EUR',
  limit: 0,
  used: 0,
  openOrders: 0,
  openInvoices: 0,
  overdue: 0,
  available: 0,
  overLimitBy: 0,
  usedPct: 0,
  onHold: false,
  findings: [],
  held: { orders: 0, releases: 0, shipments: 0, firstOrders: [] },
  changedAt: '2026-10-20T09:15:00.000Z',
  mayChange: true,
  ...over,
})

/**
 * Gamma Demo: limit 15,000.00; used 15,950.00 = 3,750.00 orders not invoiced + 12,200.00 invoices open; over by 950.00;
 * overdue 9,760.00; two orders wait for a yes (SO-0041, SO-0044) and one shipment is held.
 * Moto Demo: limit 20,000.00; used 12,380.00 = 3,840.00 + 8,540.00 (62 %); available 7,620.00; overdue 3,660.00.
 * Pista Demo: limit 2,000.00; used 1,830.00 (91 %); available 170.00; overdue 1,830.00; on credit hold; one release held.
 * Club Demo: limit 5,000.00; used 610.00 (12 %); available 4,390.00.
 */
const ROWS: LimitRow[] = [
  limitRow(1, GAMMA, {
    limit: 1_500_000,
    used: 1_595_000,
    openOrders: 375_000,
    openInvoices: 1_220_000,
    overdue: 976_000,
    available: -95_000,
    overLimitBy: 95_000,
    usedPct: 106,
    findings: ['OVER_LIMIT', 'OVERDUE'],
    held: { orders: 2, releases: 0, shipments: 1, firstOrders: [{ id: uid(41), number: 'SO-0041' }, { id: uid(44), number: 'SO-0044' }] },
  }),
  limitRow(2, { id: uid(102), code: 'C-0002', name: 'Pista Demo S.p.A.' }, {
    limit: 200_000,
    used: 183_000,
    openInvoices: 183_000,
    overdue: 183_000,
    available: 17_000,
    usedPct: 91,
    onHold: true,
    findings: ['OVERDUE', 'ON_HOLD'],
    held: { orders: 0, releases: 1, shipments: 0, firstOrders: [] },
  }),
  limitRow(3, { id: uid(101), code: 'C-0001', name: 'Moto Demo S.r.l.' }, {
    limit: 2_000_000,
    used: 1_238_000,
    openOrders: 384_000,
    openInvoices: 854_000,
    overdue: 366_000,
    available: 762_000,
    usedPct: 61,
    findings: ['OVERDUE'],
  }),
  limitRow(4, { id: uid(103), code: 'C-0003', name: 'Club Demo' }, {
    limit: 500_000,
    used: 61_000,
    openInvoices: 61_000,
    available: 439_000,
    usedPct: 12,
  }),
]

const LIMITS: CreditLimits = { readAt: '2026-10-31T08:39:00.000Z', tiles: { customers: 4, over: 1, held: 2, heldOrders: 2 }, rows: ROWS, count: 4, next: null }

const PRICE_FIELDS = ['limit', 'used', 'openOrders', 'openInvoices', 'overdue', 'available', 'overLimitBy'] as const
/** What the API sends without the price grain: no amount, no share of the limit. */
const unpriced = (row: LimitRow): LimitRow => {
  const copy: Record<string, unknown> = { ...row, usedPct: null }
  for (const field of PRICE_FIELDS) delete copy[field]
  return copy as unknown as LimitRow
}

const CUSTOMERS: CustomerOption[] = [
  { id: uid(201), code: 'C-0005', legalName: 'Sella Demo S.r.l.', tradeName: null, currency: 'EUR', companyId: null },
  { id: uid(202), code: 'C-0006', legalName: 'Curva Demo S.a.s.', tradeName: 'Curva Demo', currency: 'EUR', companyId: null },
  { id: uid(203), code: 'C-0007', legalName: 'Track Demo Ltd', tradeName: null, currency: 'GBP', companyId: null },
]

const base = (role: Case['role'], over: Partial<CreditLimitsModel> = {}): Case => {
  const can = creditCanOf(PERMISSIONS[role])
  const rows = can.price ? ROWS : ROWS.map(unpriced)
  return {
    role,
    page: {
      prefix: PREFIX,
      can,
      today: TODAY,
      view: 'ALL',
      q: null,
      limits: { ...LIMITS, rows },
      rows,
      problem: null,
      slow: false,
      updates: 0,
      change: null,
      customers: null,
      companyId: COMPANY.id,
      companyCode: COMPANY.code,
      notice: null,
      busy: false,
      ...over,
    },
  }
}

function CreditDesign({ model }: { model: Case }) {
  return inShell('/finance/receivables', createElement('div', { className: 'fw-frv' }, createElement(CreditLimitsView, { model: model.page })), model.role)
}

const gamma = ROWS[0]!
const moto = ROWS[2]!
const draft = { amountText: '18.000,00', currency: 'EUR', clear: false, reason: 'Paid on time for two years; the winter order book is bigger (made-up).' }

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-151-credit',
  title: 'Receivables & credit › Credit limits: limit, used, available, what waits for credit, Change limit',
  view: CreditDesign,
  cases: [
    { id: 'finance', label: 'Finance · four customers with a limit; Gamma over it with two orders and a shipment waiting', model: base('finance'), note: 'Gamma: used 15,950.00 = 3,750.00 + 12,200.00 of 15,000.00 (106 %), over by 950.00.' },
    { id: 'owner', label: 'Owner · the same section', model: base('owner') },
    { id: 'view-over', label: 'View "Over the limit"', model: base('finance', { view: 'OVER', rows: [gamma], limits: { ...LIMITS, rows: [gamma], count: 1 } }) },
    { id: 'view-held', label: 'View "Something waits"', model: base('finance', { view: 'HELD', rows: [gamma, ROWS[1]!], limits: { ...LIMITS, rows: [gamma, ROWS[1]!], count: 2 } }) },
    { id: 'selected', label: 'Two customers chosen · Export 2', model: base('finance', { selected: [gamma.termsId, moto.termsId] }) },
    { id: 'change', label: 'Change limit · Moto Demo: the new limit and why', model: base('finance', { change: { row: moto, problem: null, draft } }) },
    { id: 'change-missing', label: 'Change limit · Review pressed with nothing typed: the problems in words', model: base('finance', { change: { row: moto, problem: null, step: 'review', draft: { amountText: '', currency: 'EUR', clear: false, reason: '' } } }) },
    { id: 'change-review', label: 'Change limit · the review (ActionConfirm): 20,000.00 → 18,000.00, what follows', model: base('finance', { change: { row: moto, problem: null, step: 'review', draft } }) },
    { id: 'change-refused', label: 'Change limit · refused: someone changed it meanwhile (409, read again)', model: base('finance', { change: { row: moto, problem: 'problem.conflict', step: 'review', draft } }) },
    { id: 'change-clear', label: 'Change limit · clear Club Demo\'s limit (nothing is checked any more)', model: base('finance', { change: { row: ROWS[3]!, problem: null, step: 'review', draft: { amountText: '', currency: 'EUR', clear: true, reason: 'The club pays in advance from now on (made-up).' } } }) },
    { id: 'add', label: 'Set a limit · a new customer picked from the company\'s customers', model: base('finance', { change: { row: null, problem: null, draft: { ...draft, partyId: CUSTOMERS[0]!.id } }, customers: CUSTOMERS }) },
    { id: 'add-reading', label: 'Set a limit · the customers still reading', model: base('finance', { change: { row: null, problem: null }, customers: null }) },
    { id: 'saved', label: 'Saved · Gamma\'s limit raised: one waiting order went on', model: base('finance', { notice: { tone: 'success', key: 'change.doneRechecked_one', params: { name: gamma.party.name, count: 1 } } }) },
    { id: 'sales', label: 'Sales · reads the limits; Change limit and Set a limit held with the permission in words', model: base('sales', { rows: ROWS.map((row) => ({ ...row, mayChange: false })) }) },
    { id: 'read-only', label: 'Read-only · no price grain: who has a limit and what waits, no figure', model: base('readOnly', { rows: ROWS.map((row) => ({ ...unpriced(row), mayChange: false })) }) },
    { id: 'no-access', label: 'Warehouse · no sales.credit.view: the section says so', model: base('warehouse') },
    { id: 'loading', label: 'Loading', model: base('finance', { limits: null, rows: null }) },
    { id: 'slow', label: 'Loading · "Still loading…" after about a second', model: base('finance', { limits: null, rows: null, slow: true }) },
    { id: 'error', label: "Error · couldn't load (server unreachable), Try again", model: base('finance', { limits: null, rows: null, problem: 'problem.unavailable' }) },
    { id: 'empty', label: 'Empty · no credit limits set (nothing is checked, as before)', model: base('finance', { limits: { ...LIMITS, rows: [], count: 0, tiles: { customers: 0, over: 0, held: 0, heldOrders: 0 } }, rows: [] }) },
    { id: 'no-match', label: 'Nothing matches the search', model: base('finance', { q: 'zeta', rows: [], limits: { ...LIMITS, rows: [], count: 0 } }) },
    { id: 'updates', label: 'Live · 2 updates · Show', model: base('finance', { updates: 2 }) },
    { id: 'focus', label: 'Keyboard · the second row focused (Enter: Change limit)', model: base('finance', { focusRow: 1 }) },
    { id: 'keys', label: 'Keyboard · the keys panel (footer info icon)', model: base('finance', { keysOpen: true }) },
  ],
})
