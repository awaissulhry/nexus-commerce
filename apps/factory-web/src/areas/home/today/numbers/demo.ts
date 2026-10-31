import type { KeyNumber, KeyNumbers } from './api'

/**
 * Made-up numbers for the design cases of My numbers on Today (SCR-029, B-W2a-79): an invented week (Friday 30 October
 * 2026), invented amounts in euro cents and counts. Nothing here is a real company or figure. Design-only (Today's
 * fixtures import it); it exports no `designScreen`.
 */

const explain = (definition: string, formula: string, sources: string, period: string, target = false) => ({
  definition,
  formula,
  sources,
  period,
  cutOff: 'Days run from midnight to midnight at the site (Europe/Rome); weeks start on Monday.',
  setBy: target ? 'The standard report pack (targets become editable with the KPI library).' : null,
})

const number = (key: string, label: string, change: Partial<KeyNumber>): KeyNumber => ({
  key,
  label,
  unit: 'COUNT',
  grain: null,
  value: 0,
  currency: null,
  target: null,
  targetWord: null,
  history: false,
  spark: null,
  complete: true,
  problem: null,
  list: null,
  report: null,
  explain: explain('—', '—', '—', '—'),
  ...change,
})

export const ORDER_NUMBERS: KeyNumber[] = [
  number('orders.inThisWeek', 'Orders in this week', {
    unit: 'MONEY',
    grain: 'price',
    value: 8_412_000,
    currency: 'EUR',
    history: true,
    spark: [5_120_000, 6_300_000, 4_980_000, 7_450_000, 6_010_000, 9_230_000, 7_800_000, 8_412_000],
    report: { key: 'sales.orders-in', filters: { period: 'THIS_WEEK' } },
  }),
  number('orders.late', 'Late orders', { value: 6, target: { value: 0, direction: 'AT_MOST' }, targetWord: 'ABOVE_TARGET', list: { api: '/sales/orders', query: { late: 'true' } }, report: { key: 'sales.late-orders', filters: {} } }),
  number('orders.promisedThisWeek', 'Promised this week', { value: 11, report: { key: 'sales.open-orders', filters: { promise: 'THIS_WEEK' } } }),
  number('orders.shippedOnTime', 'Shipped on time', {
    unit: 'PERCENT',
    value: 91.4,
    target: { value: 95, direction: 'AT_LEAST' },
    targetWord: 'BELOW_TARGET',
    history: true,
    spark: [88, 93.5, 96, 90, 92.3, 89, 94, 91.4],
    report: { key: 'sales.shipments-on-time', filters: { period: 'LAST_8_WEEKS' } },
  }),
  number('orders.marginThisMonth', 'Margin this month', { unit: 'PERCENT', grain: 'margin', value: 31.2, list: { api: '/costing/margins', query: {} }, report: { key: 'sales.margin-by-order', filters: { period: 'THIS_MONTH' } } }),
]

export const WORK_ORDER_NUMBERS: KeyNumber[] = [
  number('workorders.late', 'Work orders late', { value: 0, target: { value: 0, direction: 'AT_MOST' }, targetWord: 'ON_TARGET', list: { api: '/production/work-orders', query: { view: 'late' } } }),
  number('planning.shortages', 'Short of material', { value: 3, target: { value: 0, direction: 'AT_MOST' }, targetWord: 'ABOVE_TARGET', report: { key: 'planning.shortages', filters: { workOrders: 'RELEASED' } } }),
  number('planning.loadNextWeek', 'Load next week', { unit: 'PERCENT', value: 92, list: { api: '/planning/capacity', query: {} } }),
  number('production.goodLastDay', 'Good garments, last working day', { value: 184, report: { key: 'production.daily', filters: {} } }),
]

/** The owner: sales orders and work orders. */
export const OWNER_NUMBERS: KeyNumbers = {
  asOf: '2026-10-30T08:40:00.000Z',
  today: '2026-10-30',
  lenses: [
    { lens: 'ORDERS', numbers: ORDER_NUMBERS },
    { lens: 'WORK_ORDERS', numbers: WORK_ORDER_NUMBERS },
  ],
}

/** Numbers that cannot be said now: one not readable, one with no data yet, one in several currencies, one cut short. */
export const PROBLEM_NUMBERS: KeyNumbers = {
  ...OWNER_NUMBERS,
  lenses: [
    {
      lens: 'ORDERS',
      numbers: [
        { ...ORDER_NUMBERS[0]!, value: null, spark: null, problem: 'MIXED_CURRENCIES' },
        { ...ORDER_NUMBERS[1]!, value: null, targetWord: null, problem: 'UNAVAILABLE' },
        { ...ORDER_NUMBERS[2]!, complete: false },
        { ...ORDER_NUMBERS[3]!, value: null, targetWord: null, spark: [null, null, null, null, null, null, null, null], problem: 'NO_DATA' },
      ],
    },
  ],
}
