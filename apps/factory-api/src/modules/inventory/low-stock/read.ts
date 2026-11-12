import { INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import type { CommandCaller } from '../../../core/command'
import { officeContextOf, siteFor } from '../ledger/access'
import { rulesOf } from '../posting/store'
import { readLowStock } from './store'

/**
 * GET /inventory/low-stock?siteId (B-W2b-314; SCM-281): the stock page's "Below minimum" tile (`count`) and its list — every
 * material (and colour) of the site whose planning parameters keep a minimum, below it first (most short first), with the
 * numbers in words — and whether the site's company raises alerts for it. Office, inventory.stock.view at the site.
 */
export async function lowStockList(caller: CommandCaller, query: { readonly siteId: string; readonly below?: boolean | undefined; readonly q?: string | undefined; readonly limit: number }) {
  const context = officeContextOf(caller)
  const site = await siteFor(caller, query.siteId, INVENTORY_STOCK_VIEW, 'siteId')
  return caller.withClient(async (db) => {
    const all = await readLowStock(db, { siteIds: [site.id] })
    const itemIds = [...new Set(all.map((row) => row.itemId))]
    const items = new Map((itemIds.length ? await db.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, code: true, name: true, kind: true, baseUom: true } }) : []).map((item) => [item.id, item]))
    const colourIds = [...new Set(all.flatMap((row) => (row.itemColourId ? [row.itemColourId] : [])))]
    const colours = new Map((colourIds.length ? await db.itemColour.findMany({ where: { id: { in: colourIds } }, select: { id: true, code: true, name: true } }) : []).map((colour) => [colour.id, colour]))
    const q = query.q?.toLowerCase()
    const wanted = all
      .filter((row) => (query.below ?? true ? row.below : true))
      .filter((row) => {
        const item = items.get(row.itemId)
        return !q || (item ? item.code.toLowerCase().includes(q) || item.name.toLowerCase().includes(q) : false)
      })
      .sort((a, b) => Number(b.below) - Number(a.below) || Number(b.short) - Number(a.short) || (items.get(a.itemId)?.code ?? '').localeCompare(items.get(b.itemId)?.code ?? '') || a.itemPlanningId.localeCompare(b.itemPlanningId))
    const { inForce } = await rulesOf(db, context.tenantId, site.companyId)
    return {
      count: all.filter((row) => row.below).length,
      rows: wanted.slice(0, query.limit).flatMap((row) => {
        const item = items.get(row.itemId)
        if (!item) return []
        const colour = row.itemColourId ? colours.get(row.itemColourId) : undefined
        return [
          {
            site: { id: site.id, code: site.code, name: site.name },
            item,
            colour: colour ?? null,
            itemPlanningId: row.itemPlanningId,
            basis: row.basis,
            minimum: row.minimum,
            onHand: row.onHand,
            onOrder: row.onOrder,
            reserved: row.reserved,
            position: row.position,
            below: row.below,
            short: row.short,
            words: row.words,
          },
        ]
      }),
      more: wanted.length > query.limit,
      alerts: { on: inForce.lowStockAlerts.value, source: inForce.lowStockAlerts.source },
    }
  })
}
