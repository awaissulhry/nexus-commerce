import { choiceFilter, SITE_FILTER } from '@nexus/factory-domain/insights/reports/definition'
import { WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import { listWorkOrders } from '../../../production/work-orders/work-orders'
import { readPages } from '../kit'
import { defineReport } from '../report'

/**
 * Production › WIP by stage (design home.reports library "Production: WIP by stage"; Today's "Work orders late"): every
 * open work order with its garments and how far they got (cut, sewn, finished), grouped by stage, through the work
 * orders list as the person (workorders.view: their companies and sites). Per work order only, never per person.
 */

const STATUSES = ['DRAFT', 'RELEASED', 'IN_PROGRESS', 'ON_HOLD'] as const

export default defineReport({
  key: 'production.wip-by-stage',
  area: 'production',
  title: 'WIP by stage',
  question: 'How much work is in progress at each stage?',
  permission: WORKORDERS_VIEW,
  needs: null,
  columns: [
    { key: 'workOrder', label: 'Work order', kind: 'text' },
    { key: 'style', label: 'Style', kind: 'text', group: true },
    { key: 'site', label: 'Site', kind: 'text', group: true },
    { key: 'status', label: 'Stage', kind: 'code', group: true, codes: STATUSES },
    { key: 'pieces', label: 'Garments', kind: 'number', sum: true },
    { key: 'cut', label: 'Cut', kind: 'number', sum: true },
    { key: 'sewn', label: 'Sewn', kind: 'number', sum: true },
    { key: 'finished', label: 'Finished', kind: 'number', sum: true },
    { key: 'dueDate', label: 'Due', kind: 'day' },
    { key: 'daysLate', label: 'Days late', kind: 'number' },
  ],
  filters: [SITE_FILTER, choiceFilter('late', 'Due', { LATE: 'Late only' })],
  groupBy: 'status',
  sources: 'Work orders, their cells and the floor scans',
  definition:
    'Every work order in draft, released, in progress or on hold. Garments = ordered in its cells; cut, sewn and finished = garments through those steps so far (none for a draft). Late = due date before today.',
  numbers: ['workorders.late'],
  mail: null,
  formats: ['CSV', 'PDF'],
  async read(run) {
    const late = run.filters.late === 'LATE'
    const { rows, complete } = await readPages(run.limit, async (cursor) => {
      const page = await listWorkOrders(run.caller, { ...(late ? { late: true } : { open: true }), ...(run.filters.site ? { siteId: run.filters.site } : {}), cursor, limit: 200 })
      return { rows: page.workOrders, next: page.nextCursor }
    })
    return {
      complete,
      rows: rows.map((row) => ({
        id: row.id,
        record: { type: 'WorkOrder', id: row.id, label: row.number },
        currency: null,
        cells: {
          workOrder: row.number,
          style: `${row.styleCode} · ${row.styleName}`,
          site: row.siteCode,
          status: row.status,
          pieces: row.pieces,
          cut: row.progress?.cut ?? null,
          sewn: row.progress?.sewn ?? null,
          finished: row.progress?.finished ?? null,
          dueDate: row.dueDate,
          daysLate: row.daysLate,
        },
      })),
    }
  },
})
