import { INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import { SITE_FILTER } from '@nexus/factory-domain/insights/reports/definition'
import { stockValuation } from '../../../costing/valuation/valuation'
import { numberOf } from '../kit'
import { defineReport } from '../report'

/**
 * Finance › Stock value (Today's "Stock value"; B-W2a-29): what the stock and the work in progress are worth at cost
 * now, per site and category, through the stock valuation as the person (inventory.stock.view over their sites). The
 * report is about values at cost: without the cost grain it stays listed and says "Needs cost rights".
 */

const CATEGORIES = ['LEATHER', 'MATERIALS', 'TRIMS', 'PACKAGING', 'FINISHED_GOODS', 'WIP'] as const

export default defineReport({
  key: 'finance.stock-value',
  area: 'finance',
  title: 'Stock value',
  question: 'What are our stock and work in progress worth at cost?',
  permission: INVENTORY_STOCK_VIEW,
  needs: 'cost',
  columns: [
    { key: 'site', label: 'Site', kind: 'text', group: true },
    { key: 'category', label: 'Category', kind: 'code', group: true, codes: CATEGORIES },
    { key: 'lines', label: 'Stock lines', kind: 'number', sum: true },
    { key: 'notValued', label: 'Lines not fully valued', kind: 'number', sum: true },
    { key: 'stockValue', label: 'Value at cost', kind: 'money', grain: 'cost', sum: true },
  ],
  filters: [SITE_FILTER],
  groupBy: null,
  sources: 'Stock moves and their valuation, work order cost entries',
  definition:
    'Every stock line (item, colour, lot) of each site with stock now, and each open work order’s cost booked so far (WIP), summed per site and category. A line not fully valued has moves the valuation could not price yet (Finance › Reports says which).',
  numbers: ['finance.stockValue'],
  mail: null,
  formats: ['CSV', 'PDF'],
  async read(run) {
    const answer = await stockValuation(run.caller, run.filters.site ? { siteId: run.filters.site } : {})
    const groups = new Map<string, { site: string; category: string; lines: number; notValued: number; value: number; currency: string | null }>()
    for (const row of answer.rows) {
      const key = `${row.site.id}:${row.category}:${row.currency ?? ''}`
      const entry = groups.get(key) ?? { site: row.site.code, category: row.category, lines: 0, notValued: 0, value: 0, currency: row.currency ?? null }
      entry.lines += 1
      if (row.valued !== 'FULL') entry.notValued += 1
      entry.value += numberOf(row.value) ?? 0
      groups.set(key, entry)
    }
    const order = (category: string) => CATEGORIES.indexOf(category as (typeof CATEGORIES)[number])
    const rows = [...groups.entries()]
      .sort((a, b) => a[1].site.localeCompare(b[1].site) || order(a[1].category) - order(b[1].category))
      .map(([key, entry]) => ({ id: key, record: null, currency: entry.currency, cells: { site: entry.site, category: entry.category, lines: entry.lines, notValued: entry.notValued, stockValue: entry.value } }))
    return { complete: !answer.truncated, asOf: answer.asOf ? new Date(answer.asOf) : undefined, rows: rows.slice(0, run.limit) }
  },
})
