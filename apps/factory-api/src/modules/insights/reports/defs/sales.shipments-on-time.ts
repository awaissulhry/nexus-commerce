import type { Prisma } from '@nexus/factory-db'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { periodFilter } from '@nexus/factory-domain/insights/reports/definition'
import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import { daysFrom } from '@nexus/factory-domain/calendars/dates'
import { actorOfRun, dayOf, partyName, rangeOf } from '../kit'
import { defineReport } from '../report'

/**
 * Sales › Shipped on time (Today's "Shipped on time", target 95 %): every shipment that left in the period, against its
 * order's promise date (a shipment shipped on the promise day is on time). Read in the orders' scope (orders.view over
 * the shipment's company and customer): a sales person sees the shipments of the orders they see. No money.
 */

const ON_TIME_WORDS = ['ON_TIME', 'LATE', 'NO_PROMISE'] as const

export default defineReport({
  key: 'sales.shipments-on-time',
  area: 'sales',
  title: 'Shipped on time',
  question: 'Which shipments left on time against the order’s promise date?',
  permission: ORDERS_VIEW,
  needs: null,
  columns: [
    { key: 'shipment', label: 'Shipment', kind: 'text' },
    { key: 'order', label: 'Order', kind: 'text' },
    { key: 'customer', label: 'Customer', kind: 'text', group: true },
    { key: 'shippedOn', label: 'Shipped', kind: 'day' },
    { key: 'promiseDate', label: 'Promised', kind: 'day' },
    { key: 'onTime', label: 'On time', kind: 'code', group: true, codes: ON_TIME_WORDS },
    { key: 'daysLate', label: 'Days late', kind: 'number' },
  ],
  filters: [periodFilter(['THIS_WEEK', 'LAST_WEEK', 'THIS_MONTH', 'LAST_MONTH', 'LAST_8_WEEKS'], 'LAST_8_WEEKS')],
  groupBy: 'onTime',
  sources: 'Shipments and their sales orders',
  definition: 'Every shipment shipped or delivered with a ship date in the period (site days). On time: shipped on or before the order’s promise date; an order without a promise date is said apart and not counted either way.',
  numbers: ['orders.shippedOnTime'],
  mail: null,
  formats: ['CSV', 'PDF'],
  async read(run) {
    const range = rangeOf(run) ?? { from: run.today, to: run.today }
    const found = await run.caller.withClient((db) =>
      db.shipment.findMany({
        where: {
          AND: [
            scopeWhere(actorOfRun(run), ORDERS_VIEW, { company: 'companyId', party: 'partyId' }) as Prisma.ShipmentWhereInput,
            // A day's slack on each side of the UTC instants; the site's day decides below.
            { status: { in: ['SHIPPED', 'DELIVERED'] }, shippedAt: { gte: new Date(Date.parse(`${range.from}T00:00:00Z`) - 86_400_000), lt: new Date(Date.parse(`${range.to}T00:00:00Z`) + 2 * 86_400_000) } },
          ],
        },
        select: { id: true, number: true, shippedAt: true, salesOrder: { select: { id: true, number: true, promiseDate: true, party: { select: { tradeName: true, legalName: true } } } } },
        orderBy: [{ shippedAt: 'desc' }, { id: 'desc' }],
        take: run.limit + 1,
      }),
    )
    const rows = found
      .map((row) => ({ row, shippedOn: row.shippedAt ? businessDate(row.shippedAt) : null }))
      .filter(({ shippedOn }) => shippedOn !== null && shippedOn >= range.from && shippedOn <= range.to)
      .slice(0, run.limit)
      .map(({ row, shippedOn }) => {
        const promise = dayOf(row.salesOrder.promiseDate)
        const late = promise && shippedOn ? Math.max(0, daysFrom(promise, shippedOn)) : null
        return {
          id: row.id,
          record: { type: 'Shipment', id: row.id, label: row.number },
          currency: null,
          cells: {
            shipment: row.number,
            order: row.salesOrder.number,
            customer: partyName(row.salesOrder.party),
            shippedOn,
            promiseDate: promise,
            onTime: promise === null ? 'NO_PROMISE' : late === 0 ? 'ON_TIME' : 'LATE',
            daysLate: late,
          },
        }
      })
    return { complete: found.length <= run.limit, range, rows }
  },
})
