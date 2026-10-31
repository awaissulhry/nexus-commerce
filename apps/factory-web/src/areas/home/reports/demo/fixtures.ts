import { createElement, type ReactNode } from 'react'
import { permissionCheck } from '../../../../lib/session/session'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER, OWNER_PERMISSIONS } from '../../../../shell/design-data'
import { officeNavFor } from '../../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../../shell/office/view/OfficeShellView'
import type { Library, LibraryReport, ReportAbout, ReportColumn, ReportResults, ReportSchedule } from '../api'

/**
 * Made-up data for the design cases of Home › Reports (SCR-104 library, SCR-104-report a report, SCR-104-print): invented
 * orders ("SO-DEMO-0101"), customers ("Pista Demo Srl"), work orders, lines and figures worked out by hand. Nothing here is
 * a real company, person or number. Design-only (only fixtures import it); it exports no `designScreen`.
 */

export const PREFIX = '/w/DEMO'
const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
export const AS_OF = '2026-10-30T08:40:00.000Z'

export const ROLES = {
  owner: [...OWNER_PERMISSIONS, 'home.reports.view', 'orders.view', 'workorders.view', 'production.reports.view'],
  planner: ['home.view', 'home.reports.view', 'orders.view', 'workorders.view', 'planning.view', 'production.reports.view'],
  none: ['home.view'],
} as const
export type Role = keyof typeof ROLES

/** The Office shell around a page at this address (the role's navigation). */
export function inShell(path: string, page: ReactNode, role: Role = 'owner'): ReactNode {
  const shell: OfficeShellViewModel = {
    nav: officeNavFor(permissionCheck(ROLES[role])),
    path,
    switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: [], site: null, path },
    user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
    tenantTag: DEMO_TAG,
    banners: [],
  }
  return createElement(OfficeShellView, { model: shell }, page)
}

// ---- the library ----------------------------------------------------------------------------------------------------------

const entry = (key: string, permission: string, change: Partial<LibraryReport> = {}): LibraryReport => ({
  key,
  area: key.split('.')[0] as LibraryReport['area'],
  title: key,
  question: key,
  state: 'READY',
  grain: null,
  permission,
  formats: ['CSV', 'PDF'],
  mail: null,
  mailed: false,
  lastRunByMe: null,
  ...change,
})

/** B-W2b-24: when I last ran each report (the server's run log; made-up times). */
export const LAST_RUN: Record<string, string> = { 'sales.late-orders': '2026-10-29T15:10:00.000Z', 'production.daily': '2026-10-30T07:05:00.000Z' }

const PACK: LibraryReport[] = [
  entry('sales.late-orders', 'orders.view'),
  entry('sales.margin-by-order', 'costing.view'),
  entry('sales.open-orders', 'orders.view'),
  entry('sales.orders-in', 'orders.view'),
  entry('sales.shipments-on-time', 'orders.view'),
  entry('planning.shortages', 'planning.view'),
  entry('purchasing.receipts-due', 'purchasing.view'),
  entry('production.daily', 'production.reports.view', { mail: 'production.daily', mailed: true }),
  entry('production.scrap-by-reason', 'production.scrap.view'),
  entry('production.wip-by-stage', 'workorders.view'),
  entry('quality.open-ncrs', 'quality.ncr.view'),
  entry('compliance.certificates-expiring', 'compliance.certificates.view'),
  entry('finance.overdue-receivables', 'receivables.view'),
  entry('finance.stock-value', 'inventory.stock.view'),
]

const AREAS = (['sales', 'planning', 'purchasing', 'production', 'quality', 'compliance', 'finance'] as const).map((area) => ({ area, label: area }))

export const OWNER_LIBRARY: Library = { asOf: AS_OF, areas: AREAS, reports: PACK.map((report) => ({ ...report, lastRunByMe: LAST_RUN[report.key] ?? null })) }

/** A planner: no price, cost or margin; no costing, receivables, purchasing… lists. */
export const PLANNER_LIBRARY: Library = {
  asOf: AS_OF,
  areas: AREAS,
  reports: PACK.map((report) => {
    if (['sales.margin-by-order', 'quality.open-ncrs', 'finance.overdue-receivables'].includes(report.key)) return { ...report, state: 'NO_ACCESS' as const }
    if (report.key === 'finance.stock-value') return { ...report, state: 'NEEDS_GRAIN' as const, grain: 'cost' as const }
    if (report.key === 'production.daily') return { ...report, mailed: false }
    return report
  }),
}


// ---- a report: Open orders ----------------------------------------------------------------------------------------------

const col = (key: string, kind: ReportColumn['kind'], change: Partial<ReportColumn> = {}): ReportColumn => ({ key, label: key, kind, grain: null, people: false, sum: false, group: false, ...change })

const ORDER_COLUMNS: ReportColumn[] = [
  col('order', 'text'),
  col('customer', 'text', { group: true }),
  col('status', 'code', { group: true }),
  col('orderDate', 'day'),
  col('promiseDate', 'day'),
  col('daysLate', 'number'),
  col('units', 'number', { sum: true }),
  col('shipped', 'number', { sum: true }),
  col('netAmount', 'money', { grain: 'price', sum: true }),
]

const filters = (...entries: ReportAbout['filters']) => entries
const PERIODS = (values: string[]) => values.map((value) => ({ value, label: value }))

export const OPEN_ORDERS_ABOUT: ReportAbout = {
  key: 'sales.open-orders',
  area: 'sales',
  title: 'Open orders',
  question: 'Which orders are open, and when are they promised?',
  state: 'READY',
  grain: null,
  permission: 'orders.view',
  columns: ORDER_COLUMNS,
  leftOut: { grains: [], columns: [] },
  filters: filters(
    { key: 'status', label: 'Status', kind: 'choice', default: null, choices: PERIODS(['CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED']) },
    { key: 'promise', label: 'Promised', kind: 'period', default: null, choices: PERIODS(['THIS_WEEK', 'NEXT_7_DAYS', 'NEXT_30_DAYS', 'NEXT_90_DAYS']) },
  ),
  groupBy: null,
  sources: 'Sales orders and their lines',
  definition: '—',
  refresh: 'LIVE',
  numbers: [{ key: 'orders.promisedThisWeek', label: 'Promised this week' }],
  mail: null,
  formats: ['CSV', 'PDF'],
  lastRunByMe: '2026-10-29T15:10:00.000Z',
}

const order = (n: number, number: string, customer: string, status: string, orderDate: string, promise: string | null, daysLate: number | null, units: number, shipped: number, net: number) => ({
  id: uid('5151', n),
  record: { type: 'SalesOrder', id: uid('5151', n), label: number },
  currency: 'EUR',
  cells: { order: number, customer, status, orderDate, promiseDate: promise, daysLate, units, shipped, netAmount: net },
})

const ORDER_ROWS = [
  order(1, 'SO-DEMO-0107', 'Pista Demo Srl', 'IN_PRODUCTION', '2026-10-12', '2026-10-27', 3, 40, 0, 1_840_000),
  order(2, 'SO-DEMO-0106', 'Moto Club Esempio', 'CONFIRMED', '2026-10-20', '2026-11-12', 0, 12, 0, 504_000),
  order(3, 'SO-DEMO-0104', 'Pista Demo Srl', 'PARTLY_SHIPPED', '2026-10-02', '2026-10-30', 0, 25, 10, 1_125_000),
  order(4, 'SO-DEMO-0101', 'Racing Team Prova', 'READY', '2026-09-28', '2026-11-03', 0, 8, 0, 448_000),
]
// Sums: garments 40 + 12 + 25 + 8 = 85; shipped 10; net 1,840,000 + 504,000 + 1,125,000 + 448,000 = 3,917,000 cents.

export const OPEN_ORDERS: ReportResults = {
  key: 'sales.open-orders',
  asOf: AS_OF,
  today: '2026-10-30',
  applied: [
    { key: 'status', value: null, label: null },
    { key: 'promise', value: null, label: null },
  ],
  range: null,
  columns: ORDER_COLUMNS,
  rows: ORDER_ROWS,
  totals: { rows: 4, sums: { units: 85, shipped: 10, netAmount: 3_917_000 }, currency: 'EUR', mixedCurrencies: false },
  groupBy: null,
  groups: null,
  rights: null,
  complete: true,
  limit: 2000,
}

/** The same run grouped by status. */
export const OPEN_ORDERS_GROUPED: ReportResults = {
  ...OPEN_ORDERS,
  groupBy: 'status',
  groups: [
    { value: 'IN_PRODUCTION', rows: 1, sums: { units: 40, shipped: 0, netAmount: 1_840_000 }, currency: 'EUR' },
    { value: 'CONFIRMED', rows: 1, sums: { units: 12, shipped: 0, netAmount: 504_000 }, currency: 'EUR' },
    { value: 'PARTLY_SHIPPED', rows: 1, sums: { units: 25, shipped: 10, netAmount: 1_125_000 }, currency: 'EUR' },
    { value: 'READY', rows: 1, sums: { units: 8, shipped: 0, netAmount: 448_000 }, currency: 'EUR' },
  ],
}

/** A planner: no price grain, so the net value column is left out and said. */
const PLANNER_COLUMNS = ORDER_COLUMNS.filter((column) => column.grain !== 'price')
export const OPEN_ORDERS_PLANNER_ABOUT: ReportAbout = { ...OPEN_ORDERS_ABOUT, columns: PLANNER_COLUMNS, leftOut: { grains: ['price'], columns: [{ key: 'netAmount', label: 'Net value', grain: 'price' }] } }
export const OPEN_ORDERS_PLANNER: ReportResults = {
  ...OPEN_ORDERS,
  columns: PLANNER_COLUMNS,
  rows: ORDER_ROWS.map((row) => ({ ...row, currency: null, cells: Object.fromEntries(Object.entries(row.cells).filter(([key]) => key !== 'netAmount')) })),
  totals: { rows: 4, sums: { units: 85, shipped: 10 }, currency: null, mixedCurrencies: false },
  rights: { leftOut: ['price'], hiddenGroups: 0 },
}

/** Narrowed: confirmed only, promised in the next 30 days. */
export const OPEN_ORDERS_FILTERED: ReportResults = {
  ...OPEN_ORDERS,
  applied: [
    { key: 'status', value: 'CONFIRMED', label: 'Confirmed' },
    { key: 'promise', value: 'NEXT_30_DAYS', label: 'Next 30 days' },
  ],
  range: { from: '2026-10-30', to: '2026-11-28' },
  rows: [ORDER_ROWS[1]!],
  totals: { rows: 1, sums: { units: 12, shipped: 0, netAmount: 504_000 }, currency: 'EUR', mixedCurrencies: false },
}

export const EMPTY_RESULT: ReportResults = { ...OPEN_ORDERS, rows: [], totals: { rows: 0, sums: { units: 0, shipped: 0, netAmount: 0 }, currency: null, mixedCurrencies: false } }
export const CUT_RESULT: ReportResults = { ...OPEN_ORDERS, complete: false }

// ---- a report: Daily production (small groups) -------------------------------------------------------------------------

const DAILY_COLUMNS: ReportColumn[] = [col('lane', 'text'), col('kind', 'code', { group: true }), col('good', 'number', { sum: true }), col('scrap', 'number', { sum: true }), col('rework', 'number', { sum: true }), col('efficiencyPct', 'percent', { people: true })]
export const DAILY_ABOUT: ReportAbout = {
  ...OPEN_ORDERS_ABOUT,
  key: 'production.daily',
  area: 'production',
  title: 'Daily production',
  question: 'What did each line make on the last working day?',
  permission: 'production.reports.view',
  columns: DAILY_COLUMNS,
  filters: filters(
    { key: 'site', label: 'Site', kind: 'site', default: null, choices: [{ value: uid('2222', 1), label: 'STAB-N · Stabilimento Demo Nord' }] },
    { key: 'day', label: 'Day', kind: 'choice', default: 'LAST_WORKING_DAY', choices: PERIODS(['LAST_WORKING_DAY', 'TODAY']) },
  ),
  numbers: [{ key: 'production.goodLastDay', label: 'Good garments, last working day' }],
  mail: 'production.daily',
}
const lane = (n: number, label: string, kind: string, good: number, scrap: number, rework: number, efficiency: string | null) => ({ id: `${kind}:${uid('3131', n)}`, record: null, currency: null, cells: { lane: label, kind, good, scrap, rework, efficiencyPct: efficiency } })
// L1 has 12 people (its efficiency is shown); L2 has 3 (hidden: fewer than 5 people); QC is a work centre (no efficiency).
export const DAILY: ReportResults = {
  ...OPEN_ORDERS,
  key: 'production.daily',
  applied: [
    { key: 'site', value: uid('2222', 1), label: 'STAB-N · Stabilimento Demo Nord' },
    { key: 'day', value: 'LAST_WORKING_DAY', label: 'Last working day' },
  ],
  range: { from: '2026-10-29', to: '2026-10-29' },
  columns: DAILY_COLUMNS,
  rows: [lane(1, 'L1 · Linea cucito 1', 'LINE', 142, 3, 5, '87.5'), lane(2, 'L2 · Linea campionario', 'LINE', 18, 1, 0, null), lane(3, 'QC · Collaudo finale', 'WORK_CENTRE', 24, 0, 2, null)],
  totals: { rows: 3, sums: { good: 184, scrap: 4, rework: 7 }, currency: null, mixedCurrencies: false },
  rights: { leftOut: [], hiddenGroups: 1 },
}

export const DAILY_SCHEDULE: ReportSchedule = {
  key: 'production.daily',
  mail: 'production.daily',
  schedulable: true,
  subscriptions: [
    { id: uid('4141', 1), user: { id: uid('9191', 1), name: DEMO_USER.displayName }, mine: true, site: { id: uid('2222', 1), code: 'STAB-N', name: 'Stabilimento Demo Nord' }, sendTime: '07:00', weekdays: [1, 2, 3, 4, 5], locale: 'it', active: true, lastSentAt: '2026-10-30T06:00:00.000Z' },
    { id: uid('4141', 2), user: { id: uid('9191', 2), name: 'Bea Esempio' }, mine: false, site: { id: uid('2222', 1), code: 'STAB-N', name: 'Stabilimento Demo Nord' }, sendTime: '06:30', weekdays: [1, 2, 3, 4, 5, 6], locale: 'en', active: false, lastSentAt: null },
  ],
  manage: '/production/reports',
}
export const NO_SCHEDULE: ReportSchedule = { key: 'sales.open-orders', mail: null, schedulable: false, subscriptions: [], manage: null }

// ---- reports a person may not run ----------------------------------------------------------------------------------------

export const STOCK_VALUE_HELD: ReportAbout = {
  ...OPEN_ORDERS_ABOUT,
  key: 'finance.stock-value',
  area: 'finance',
  title: 'Stock value',
  question: 'What are our stock and work in progress worth at cost?',
  state: 'NEEDS_GRAIN',
  grain: 'cost',
  permission: 'inventory.stock.view',
  columns: [col('site', 'text', { group: true }), col('category', 'code', { group: true }), col('lines', 'number', { sum: true }), col('notValued', 'number', { sum: true })],
  leftOut: { grains: ['cost'], columns: [{ key: 'stockValue', label: 'Value at cost', grain: 'cost' }] },
  filters: [],
  numbers: [{ key: 'finance.stockValue', label: 'Stock value' }],
}
export const MARGIN_NO_ACCESS: ReportAbout = {
  ...OPEN_ORDERS_ABOUT,
  key: 'sales.margin-by-order',
  title: 'Margin by order',
  question: 'What margin do we make on each order?',
  state: 'NO_ACCESS',
  permission: 'costing.view',
  numbers: [{ key: 'orders.marginThisMonth', label: 'Margin this month' }],
}
