import type { Prisma } from '@nexus/factory-db'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { periodFilter } from '@nexus/factory-domain/insights/reports/definition'
import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import { actorOfRun, dayOf, partyName, rangeOf } from '../kit'
import { defineReport } from '../report'

/**
 * Sales › Orders in (Today's "Orders in this week"): the orders taken in a period, by their order date, cancelled ones
 * left out. Read in the orders' own scope (orders.view over their company and customer, scopeWhere), as the flow strip
 * reads them; the net value only with the price grain.
 */

const STATUSES = ['CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED', 'SHIPPED', 'CLOSED'] as const

export default defineReport({
  key: 'sales.orders-in',
  area: 'sales',
  title: 'Orders in',
  question: 'Which orders came in, and for how much?',
  permission: ORDERS_VIEW,
  needs: null,
  columns: [
    { key: 'order', label: 'Order', kind: 'text' },
    { key: 'customer', label: 'Customer', kind: 'text', group: true },
    { key: 'status', label: 'Status', kind: 'code', group: true, codes: STATUSES },
    { key: 'orderDate', label: 'Order date', kind: 'day' },
    { key: 'promiseDate', label: 'Promised', kind: 'day' },
    { key: 'netAmount', label: 'Net value', kind: 'money', grain: 'price', sum: true },
  ],
  filters: [periodFilter(['THIS_WEEK', 'LAST_WEEK', 'THIS_MONTH', 'LAST_MONTH', 'LAST_8_WEEKS'], 'THIS_WEEK')],
  groupBy: null,
  sources: 'Sales orders',
  definition: 'Every order with an order date in the period, newest first; cancelled orders are left out. The net value is before VAT.',
  numbers: ['orders.inThisWeek'],
  mail: null,
  formats: ['CSV', 'PDF'],
  async read(run) {
    const range = rangeOf(run) ?? { from: run.today, to: run.today }
    const found = await run.caller.withClient((db) =>
      db.salesOrder.findMany({
        where: {
          AND: [
            scopeWhere(actorOfRun(run), ORDERS_VIEW, { company: 'companyId', party: 'partyId' }) as Prisma.SalesOrderWhereInput,
            { status: { not: 'CANCELLED' }, orderDate: { gte: new Date(`${range.from}T00:00:00Z`), lte: new Date(`${range.to}T00:00:00Z`) } },
          ],
        },
        select: { id: true, number: true, status: true, orderDate: true, promiseDate: true, currency: true, netAmount: true, party: { select: { tradeName: true, legalName: true } } },
        orderBy: [{ orderDate: 'desc' }, { number: 'desc' }],
        take: run.limit + 1,
      }),
    )
    return {
      complete: found.length <= run.limit,
      range,
      rows: found.slice(0, run.limit).map((row) => ({
        id: row.id,
        record: { type: 'SalesOrder', id: row.id, label: row.number },
        currency: row.currency,
        cells: { order: row.number, customer: partyName(row.party), status: row.status, orderDate: dayOf(row.orderDate), promiseDate: dayOf(row.promiseDate), netAmount: row.netAmount },
      })),
    }
  },
})
