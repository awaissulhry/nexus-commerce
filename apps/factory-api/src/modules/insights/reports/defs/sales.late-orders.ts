import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import { listOrders } from '../../../sales/orders/orders'
import { numberOf, OPEN_ORDER_STATUSES, readPages } from '../kit'
import { defineReport } from '../report'

/**
 * Sales › Late orders (design home.reports library "Sales: Late orders"; Today's "Late orders"): open orders past their
 * promise date, through the orders list's own `late` filter as the person (orders.view).
 */
export default defineReport({
  key: 'sales.late-orders',
  area: 'sales',
  title: 'Late orders',
  question: 'Which orders are late against their promise date?',
  permission: ORDERS_VIEW,
  needs: null,
  columns: [
    { key: 'order', label: 'Order', kind: 'text' },
    { key: 'customer', label: 'Customer', kind: 'text', group: true },
    { key: 'status', label: 'Status', kind: 'code', group: true, codes: OPEN_ORDER_STATUSES },
    { key: 'promiseDate', label: 'Promised', kind: 'day' },
    { key: 'daysLate', label: 'Days late', kind: 'number' },
    { key: 'units', label: 'Garments', kind: 'number', sum: true },
    { key: 'shipped', label: 'Shipped', kind: 'number', sum: true },
    { key: 'netAmount', label: 'Net value', kind: 'money', grain: 'price', sum: true },
  ],
  filters: [],
  groupBy: null,
  sources: 'Sales orders',
  definition: 'Orders confirmed, in production, ready to ship or partly shipped whose promise date is before today. Days late counts from the promise date to today.',
  numbers: ['orders.late'],
  mail: null,
  formats: ['CSV', 'PDF'],
  async read(run) {
    const { rows, complete } = await readPages(run.limit, async (cursor) => {
      const page = await listOrders(run.caller, { late: 'true', cursor, limit: 200 })
      return { rows: page.orders, next: page.nextCursor }
    })
    return {
      complete,
      rows: [...rows]
        .sort((a, b) => (b.daysLate ?? 0) - (a.daysLate ?? 0))
        .map((row) => ({
          id: row.id,
          record: { type: 'SalesOrder', id: row.id, label: row.number },
          currency: row.currency,
          cells: { order: row.number, customer: row.partyName, status: row.status, promiseDate: row.promiseDate, daysLate: row.daysLate, units: row.units, shipped: row.shippedUnits, netAmount: numberOf(row.netAmount) },
        })),
    }
  },
})
