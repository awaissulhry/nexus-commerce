import { choiceFilter, SITE_FILTER } from '@nexus/factory-domain/insights/reports/definition'
import { PURCHASING_VIEW } from '@nexus/factory-domain/purchasing/permissions'
import { expectedDeliveries } from '../../../purchasing/orders'
import { runSites } from '../kit'
import { defineReport } from '../report'

/**
 * Purchasing › Receipts due (design home.reports library "Purchasing: Receipts due"; Today's "Deliveries late" and "due
 * this week"): every purchase order line with goods still to come, by the date the supplier confirmed (else the date we
 * asked), through the purchasing module's expected deliveries as the person (purchasing.view). No money.
 */

const decimal = (value: string): string => (value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value)

export default defineReport({
  key: 'purchasing.receipts-due',
  area: 'purchasing',
  title: 'Receipts due',
  question: 'Which deliveries are due from suppliers, and which are late?',
  permission: PURCHASING_VIEW,
  needs: null,
  columns: [
    { key: 'order', label: 'Purchase order', kind: 'text' },
    { key: 'supplier', label: 'Supplier', kind: 'text', group: true },
    { key: 'site', label: 'Site', kind: 'text', group: true },
    { key: 'item', label: 'Material', kind: 'text', group: true },
    { key: 'colour', label: 'Colour', kind: 'text' },
    { key: 'expectedDate', label: 'Expected', kind: 'day' },
    { key: 'dateFrom', label: 'Date from', kind: 'code', codes: ['CONFIRMED', 'ASKED'] },
    { key: 'state', label: 'When', kind: 'code', group: true, codes: ['LATE', 'THIS_WEEK', 'LATER'] },
    { key: 'daysLate', label: 'Days late', kind: 'number' },
    { key: 'outstanding', label: 'Still to come', kind: 'text' },
  ],
  filters: [SITE_FILTER, choiceFilter('state', 'When', { LATE: 'Late', THIS_WEEK: 'This week', LATER: 'Later' })],
  groupBy: 'state',
  sources: 'Purchase orders, their lines and goods receipts',
  definition:
    'Each line of a sent, confirmed, partly received or changed purchase order with goods still to come. Expected = the date the supplier confirmed, else the date we asked; late = expected before today; this week = today to Sunday.',
  numbers: ['purchasing.lateDeliveries', 'purchasing.dueThisWeek'],
  mail: null,
  formats: ['CSV', 'PDF'],
  async read(run) {
    const sites = await runSites(run, PURCHASING_VIEW)
    const codeOf = new Map(sites.map((site) => [site.id, site.code]))
    const state = run.filters.state as 'LATE' | 'THIS_WEEK' | 'LATER' | null
    const answer = await expectedDeliveries(run.caller, { ...(run.filters.site ? { siteId: run.filters.site } : {}), ...(state ? { state } : {}), limit: 500 })
    const lines = answer.lines.filter((line) => codeOf.has(line.siteId))
    return {
      complete: answer.complete && !answer.more && lines.length <= run.limit,
      rows: lines.slice(0, run.limit).map((line) => ({
        id: line.lineId,
        record: { type: 'PurchaseOrder', id: line.purchaseOrderId, label: line.number },
        currency: null,
        cells: {
          order: line.number,
          supplier: line.supplierName,
          site: codeOf.get(line.siteId) ?? null,
          item: `${line.item.code} · ${line.item.name}`,
          colour: line.colour ? `${line.colour.code} · ${line.colour.name}` : null,
          expectedDate: line.expectedDate,
          dateFrom: line.dateFrom,
          state: line.state,
          daysLate: line.state === 'LATE' ? line.daysLate : null,
          outstanding: `${decimal(line.outstandingBase)} ${line.baseUom ?? line.uom}`,
        },
      })),
    }
  },
})
