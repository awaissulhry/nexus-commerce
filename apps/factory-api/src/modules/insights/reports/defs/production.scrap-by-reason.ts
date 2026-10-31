import { plusDays } from '@nexus/factory-domain/calendars/dates'
import { businessDayStart } from '@nexus/factory-domain/core/time'
import { choiceFilter, periodFilter, SITE_FILTER } from '@nexus/factory-domain/insights/reports/definition'
import { PRODUCTION_SCRAP_VIEW } from '@nexus/factory-domain/production/scrap/permissions'
import { scrapList } from '../../../production/scrap/views'
import { rangeOf } from '../kit'
import { defineReport } from '../report'

/**
 * Production › Scrap by reason (design home.reports library "Production: Scrap by reason"): garments scrapped (or sent
 * to rework) in a period, one row per reason code, through the scrap list as the person (production.scrap.view: their
 * companies and sites). The value at cost only with the cost grain (the scrap list leaves it out otherwise). Per reason,
 * never per person or station.
 */

export default defineReport({
  key: 'production.scrap-by-reason',
  area: 'production',
  title: 'Scrap by reason',
  question: 'Why do we scrap garments, and how many?',
  permission: PRODUCTION_SCRAP_VIEW,
  needs: null,
  columns: [
    { key: 'reason', label: 'Reason', kind: 'text', group: true },
    { key: 'code', label: 'Code', kind: 'text' },
    { key: 'kind', label: 'Kind', kind: 'code', group: true, codes: ['SCRAP', 'REWORK'] },
    { key: 'pieces', label: 'Garments', kind: 'number', sum: true },
    { key: 'events', label: 'Times reported', kind: 'number', sum: true },
    { key: 'workOrders', label: 'Work orders', kind: 'number' },
    { key: 'scrapCost', label: 'Value at cost', kind: 'money', grain: 'cost', sum: true },
  ],
  filters: [SITE_FILTER, periodFilter(['THIS_WEEK', 'LAST_WEEK', 'THIS_MONTH', 'LAST_MONTH', 'LAST_8_WEEKS'], 'THIS_MONTH'), choiceFilter('kind', 'Kind', { SCRAP: 'Scrap', REWORK: 'Rework' }, 'SCRAP')],
  groupBy: null,
  sources: 'Floor scrap and rework scans, rework orders and the materials they used',
  definition:
    'Garments reported as scrap (or rework) at any operation in the period, per reason code, most garments first. Value at cost = the material of the scrapped pieces at its stock value. The list reads at most 500 reports per run.',
  numbers: [],
  mail: null,
  formats: ['CSV', 'PDF'],
  async read(run) {
    const range = rangeOf(run) ?? { from: run.today, to: run.today }
    const kind = run.filters.kind === 'REWORK' ? 'REWORK' : 'SCRAP'
    const answer = await scrapList(run.caller, {
      ...(run.filters.site ? { siteId: run.filters.site } : {}),
      from: businessDayStart(range.from),
      to: businessDayStart(plusDays(range.to, 1)),
      kind,
      limit: 500,
    })
    const byReason = new Map<string, { label: string; pieces: number; events: number; workOrders: Set<string>; cost: number | null; currency: string | null }>()
    for (const row of answer.rows) {
      const code = row.reasonCode ?? '-'
      const entry = byReason.get(code) ?? { label: row.reasonLabel ? row.reasonLabel[run.locale] : code, pieces: 0, events: 0, workOrders: new Set<string>(), cost: null, currency: null }
      entry.pieces += row.pieces
      entry.events += 1
      entry.workOrders.add(row.workOrder.id)
      const value = (row as { value?: number | null }).value
      if (typeof value === 'number') entry.cost = (entry.cost ?? 0) + value
      entry.currency ??= ((row as { currency?: string | null }).currency ?? null)
      byReason.set(code, entry)
    }
    const rows = [...byReason.entries()]
      .sort((a, b) => b[1].pieces - a[1].pieces || a[0].localeCompare(b[0]))
      .map(([code, entry]) => ({
        id: `${kind}:${code}`,
        record: null,
        currency: entry.currency,
        cells: { reason: entry.label, code, kind, pieces: entry.pieces, events: entry.events, workOrders: entry.workOrders.size, scrapCost: entry.cost },
      }))
    return { complete: answer.rows.length < 500, range, rows: rows.slice(0, run.limit) }
  },
})
