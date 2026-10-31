import { COSTING_VIEW } from '@nexus/factory-domain/costing/permissions'
import { periodFilter } from '@nexus/factory-domain/insights/reports/definition'
import { orderMargins } from '../../../costing/margins/margins'
import { numberOf, rangeOf, readPages } from '../kit'
import { defineReport } from '../report'

/**
 * Sales › Margin by order (design home.reports library "Sales: Margin by order"): each order's margin quoted, estimated
 * now and so far, through the margins read as the person (costing.view over the order's company and customer). The
 * report is about margins: without the margin grain it stays listed and says "Needs margin rights" (S2: sales see the
 * margin %, never cost amounts — the cost column is left out for them and named).
 */

const STATUSES = ['CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED', 'SHIPPED', 'CLOSED'] as const

export default defineReport({
  key: 'sales.margin-by-order',
  area: 'sales',
  title: 'Margin by order',
  question: 'What margin do we make on each order?',
  permission: COSTING_VIEW,
  needs: 'margin',
  columns: [
    { key: 'order', label: 'Order', kind: 'text' },
    { key: 'customer', label: 'Customer', kind: 'text', group: true },
    { key: 'status', label: 'Status', kind: 'code', group: true, codes: STATUSES },
    { key: 'orderDate', label: 'Order date', kind: 'day' },
    { key: 'netAmount', label: 'Net value', kind: 'money', grain: 'price', sum: true },
    { key: 'estimateCost', label: 'Cost now', kind: 'money', grain: 'cost', sum: true },
    { key: 'quotedMarginPct', label: 'Margin quoted', kind: 'percent', grain: 'margin' },
    { key: 'estimateMarginPct', label: 'Margin now', kind: 'percent', grain: 'margin' },
    { key: 'actualMarginPct', label: 'Margin so far', kind: 'percent', grain: 'margin' },
    { key: 'stage', label: 'Cost', kind: 'code', group: true, codes: ['FINAL', 'STARTED', 'NOT_STARTED'] },
  ],
  filters: [periodFilter(['THIS_MONTH', 'LAST_MONTH', 'THIS_WEEK', 'LAST_WEEK', 'LAST_8_WEEKS'], 'THIS_MONTH', 'Order date')],
  groupBy: null,
  sources: 'Sales orders, their quotes, work orders and cost entries',
  definition:
    'Every order (cancelled ones left out) with an order date in the period. Margin quoted = net value less the quoted cost; margin now = net value less the estimate now (work orders done at their actual cost, the rest at the larger of plan and actual); margin so far = the cost booked until today. A blank margin: no cost is known yet.',
  numbers: ['orders.marginThisMonth'],
  mail: null,
  formats: ['CSV', 'PDF'],
  async read(run) {
    const range = rangeOf(run)
    const { rows, complete } = await readPages(run.limit, async (cursor) => {
      const page = await orderMargins(run.caller, { status: [...STATUSES], ...(range ? { from: range.from, to: range.to } : {}), cursor, limit: 100 })
      return { rows: page.rows, next: page.nextCursor }
    })
    return {
      complete,
      range,
      rows: rows.map((row) => ({
        id: row.order.id,
        record: { type: 'SalesOrder', id: row.order.id, label: row.order.number },
        currency: row.currency,
        cells: {
          order: row.order.number,
          customer: row.order.party.name,
          status: row.order.status,
          orderDate: row.order.orderDate,
          netAmount: numberOf(row.value),
          estimateCost: numberOf(row.estimateCost),
          quotedMarginPct: row.quotedMarginPct ?? null,
          estimateMarginPct: row.estimateMarginPct ?? null,
          actualMarginPct: row.actualMarginPct ?? null,
          stage: row.final ? 'FINAL' : row.started ? 'STARTED' : 'NOT_STARTED',
        },
      })),
    }
  },
})
