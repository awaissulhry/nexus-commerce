import { choiceFilter, SITE_FILTER } from '@nexus/factory-domain/insights/reports/definition'
import { PLANNING_VIEW } from '@nexus/factory-domain/planning/permissions'
import { shortages } from '../../../planning/readiness/readiness'
import { runSites } from '../kit'
import { defineReport } from '../report'

/**
 * Planning › Shortages (design home.reports library "Planning: Shortages"; Today's "Short of material"): what open work
 * orders miss, material by material, from the latest planning run of each site the person plans (planning.view), through
 * the planning module's own shortages read. No money.
 */

const STATUSES = ['DRAFT', 'RELEASED', 'IN_PROGRESS', 'ON_HOLD'] as const
const RELEASED = new Set(['RELEASED', 'IN_PROGRESS'])

/** "12.5000" → "12.5" (the list's decimals without trailing zeros). */
const decimal = (value: string): string => (value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value)

export default defineReport({
  key: 'planning.shortages',
  area: 'planning',
  title: 'Shortages',
  question: 'What material is short for our work orders?',
  permission: PLANNING_VIEW,
  needs: null,
  columns: [
    { key: 'workOrder', label: 'Work order', kind: 'text' },
    { key: 'style', label: 'Style', kind: 'text', group: true },
    { key: 'status', label: 'Status', kind: 'code', group: true, codes: STATUSES },
    { key: 'site', label: 'Site', kind: 'text', group: true },
    { key: 'material', label: 'Material', kind: 'text', group: true },
    { key: 'problem', label: 'Problem', kind: 'code', group: true, codes: ['NOT_ENOUGH', 'DELAYED'] },
    { key: 'short', label: 'Short', kind: 'text' },
    { key: 'neededBy', label: 'Needed by', kind: 'day' },
    { key: 'expected', label: 'Expected', kind: 'day' },
    { key: 'purchaseOrder', label: 'Purchase order', kind: 'text' },
  ],
  filters: [SITE_FILTER, choiceFilter('workOrders', 'Work orders', { RELEASED: 'Released or started', OPEN: 'Every open work order' }, 'RELEASED')],
  groupBy: null,
  sources: 'The latest planning run of each site, work orders, stock and purchase orders',
  definition:
    'Each material a work order still needs that the latest plan cannot cover in time: Not enough (no stock or order covers it) or Delayed (an order covers it but arrives after it is needed). Released or started work orders by default.',
  numbers: ['planning.shortages'],
  mail: null,
  formats: ['CSV', 'PDF'],
  async read(run) {
    const sites = await runSites(run, PLANNING_VIEW)
    const onlyReleased = run.filters.workOrders !== 'OPEN'
    const rows = []
    for (const site of sites) {
      const answer = await shortages(run.caller, { siteId: site.id })
      for (const [index, row] of answer.rows.entries()) {
        if (onlyReleased && !RELEASED.has(row.workOrder.status)) continue
        rows.push({
          id: `${site.id}:${row.workOrder.id}:${index}`,
          record: { type: 'WorkOrder', id: row.workOrder.id, label: row.workOrder.number },
          currency: null,
          cells: {
            workOrder: row.workOrder.number,
            style: `${row.workOrder.style.code} · ${row.workOrder.style.name}`,
            status: row.workOrder.status,
            site: site.code,
            material: row.material.label,
            problem: row.word,
            short: `${decimal(row.short)} ${row.material.uom}`,
            neededBy: row.neededBy,
            expected: row.expected?.date ?? null,
            purchaseOrder: row.expected?.purchaseOrderNumber ?? null,
          },
        })
      }
    }
    return { complete: rows.length <= run.limit, rows: rows.slice(0, run.limit) }
  },
})
