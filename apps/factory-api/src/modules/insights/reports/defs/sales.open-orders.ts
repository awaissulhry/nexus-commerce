import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import { choiceFilter, periodFilter } from '@nexus/factory-domain/insights/reports/definition'
import { listOrders } from '../../../sales/orders/orders'
import { numberOf, OPEN_ORDER_STATUSES, rangeOf, readPages } from '../kit'
import { defineReport } from '../report'

/**
 * Sales › Open orders (design home.reports library "Sales: Open orders"): every open order (confirmed, in production,
 * ready, partly shipped) with its promise, read through the orders list as the person (orders.view: their companies
 * and customers). The net value only with the price grain.
 */

export default defineReport({
  key: 'sales.open-orders',
  area: 'sales',
  title: 'Open orders',
  question: 'Which orders are open, and when are they promised?',
  permission: ORDERS_VIEW,
  needs: null,
  columns: [
    { key: 'order', label: 'Order', kind: 'text' },
    { key: 'customer', label: 'Customer', kind: 'text', group: true },
    { key: 'status', label: 'Status', kind: 'code', group: true, codes: OPEN_ORDER_STATUSES },
    { key: 'orderDate', label: 'Order date', kind: 'day' },
    { key: 'promiseDate', label: 'Promised', kind: 'day' },
    { key: 'daysLate', label: 'Days late', kind: 'number' },
    { key: 'units', label: 'Garments', kind: 'number', sum: true },
    { key: 'shipped', label: 'Shipped', kind: 'number', sum: true },
    { key: 'netAmount', label: 'Net value', kind: 'money', grain: 'price', sum: true },
  ],
  filters: [
    choiceFilter('status', 'Status', { CONFIRMED: 'Confirmed', IN_PRODUCTION: 'In production', READY: 'Ready to ship', PARTLY_SHIPPED: 'Partly shipped' }),
    periodFilter(['THIS_WEEK', 'NEXT_7_DAYS', 'NEXT_30_DAYS', 'NEXT_90_DAYS'], null, 'Promised', 'promise'),
  ],
  groupBy: null,
  sources: 'Sales orders and their lines',
  definition: 'Every order confirmed, in production, ready to ship or partly shipped, newest first. Days late counts from the promise date to today.',
  numbers: ['orders.promisedThisWeek'],
  mail: null,
  formats: ['CSV', 'PDF'],
  async read(run) {
    const status = run.filters.status as (typeof OPEN_ORDER_STATUSES)[number] | null
    const promise = rangeOf(run, 'promise')
    const { rows, complete } = await readPages(run.limit, async (cursor) => {
      const page = await listOrders(run.caller, { ...(status ? { status } : { open: 'true' }), ...(promise ? { promiseFrom: promise.from, promiseTo: promise.to } : {}), cursor, limit: 200 })
      return { rows: page.orders, next: page.nextCursor }
    })
    return {
      complete,
      range: promise,
      rows: rows.map((row) => ({
        id: row.id,
        record: { type: 'SalesOrder', id: row.id, label: row.number },
        currency: row.currency,
        cells: {
          order: row.number,
          customer: row.partyName,
          status: row.status,
          orderDate: row.orderDate,
          promiseDate: row.promiseDate,
          daysLate: row.daysLate,
          units: row.units,
          shipped: row.shippedUnits,
          netAmount: numberOf(row.netAmount),
        },
      })),
    }
  },
})
