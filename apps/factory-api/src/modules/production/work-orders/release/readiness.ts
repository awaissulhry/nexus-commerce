import { ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import type { CommandCaller } from '../../../../core/command'
import { livePlanOf, readinessFor } from '../../../planning/readiness/service'
// B-PT-014 (order production tab R14): what is missing, how much, by when, and the purchase orders it waits on (purchasing.view).
import { can } from '@nexus/factory-domain/core/permissions'
import type { MaterialReadiness } from '@nexus/factory-domain/planning/readiness/readiness'
import { PURCHASING_VIEW } from '@nexus/factory-domain/purchasing/permissions'
import { actorOf } from '../../../../core/context'
import { purchaseOrdersOf, type LivePlan } from '../../../planning/readiness/service'
import { SITE_COLUMNS as PLANNING_SITE_COLUMNS } from '../../../planning/store'
import { mayOn, officeContextOf } from '../access'

/**
 * GET /production/work-orders/readiness?ids= (B-W2a-46; design wo-grid "Readiness (W2a word)"; workorders.view over each
 * work order): the plan's readiness word of up to 100 work orders, for the list's column. One live plan per site (the
 * planning readiness service nets the whole site once), read only. Work orders the caller may not see are left out.
 * B-PT-014 (order production tab R14): each material also says its name and unit, how much is needed and short, by when it is
 * needed, and the purchase orders it counts on — as picking's popover reads them (inventory/issue/kits readinessView; the ONE
 * purchaseOrdersOf). A work order shared with other customers says no quantity (its need covers other customers' pieces) and no
 * purchase order; the purchase orders only for a reader with purchasing.view over its company and customer (else none) — never
 * a PO total, its other work orders or a pooled late quantity.
 */

/** B-PT-014: one material of a work order's readiness, as this list sends it (see the head). */
export function readinessMaterialOf(material: MaterialReadiness, live: LivePlan | undefined, options: { readonly shared: boolean; readonly purchases: boolean }) {
  return {
    itemId: material.itemId,
    itemColourId: material.itemColourId,
    word: material.word,
    date: material.date,
    // ── B-PT-014 ──
    label: material.label,
    uom: material.uom,
    needed: options.shared ? null : material.needed,
    short: options.shared ? null : material.short,
    neededOn: material.neededOn,
    purchaseOrders: options.shared || !options.purchases ? [] : purchaseOrdersOf(live, material.purchaseOrderLineIds),
    // ── end B-PT-014 ──
  }
}

const NOT_THERE = new Set(['NOT_ENOUGH', 'DELAYED', 'REQUESTED', 'NOT_BOOKED'])

export async function listReadiness(caller: CommandCaller, query: { readonly ids: string }) {
  const context = officeContextOf(caller)
  const actor = actorOf(context) // B-PT-014
  const ids = [...new Set(query.ids.split(',').map((value) => value.trim()).filter((value) => value !== ''))]
  if (ids.length > 100 || ids.some((value) => !isUuid(value))) throw new ValidationError('Name at most 100 work orders by their ids.', [{ path: 'querystring/ids', message: 'Comma-separated work order ids, at most 100.' }])
  return caller.withClient(async (db) => {
    // B-PR-03: with its customer (another customer's work order is left out, as one the caller may not see).
    const rows = (await db.workOrder.findMany({ where: { id: { in: ids } }, select: { id: true, companyId: true, siteId: true, partyId: true } })).filter((row) => mayOn(context, WORKORDERS_VIEW, row))
    const bySite = new Map<string, string[]>()
    for (const row of rows) bySite.set(row.siteId, [...(bySite.get(row.siteId) ?? []), row.id])
    const rowOf = new Map(rows.map((row) => [row.id, row])) // B-PT-014
    const answers = []
    // One site after another (one connection runs one query at a time).
    for (const [siteId, siteIds] of [...bySite.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const site = await db.site.findUnique({ where: { id: siteId }, select: PLANNING_SITE_COLUMNS })
      if (!site) continue
      const live = await livePlanOf(db, site)
      for (const answer of await readinessFor(db, site, siteIds, live)) {
        // B-PT-014: a shared work order (made before the one-customer rule) says no quantity and no purchase order.
        const row = rowOf.get(answer.workOrderId)
        const shared = !row || row.partyId === null
        const purchases = row !== undefined && row.partyId !== null && can(actor, PURCHASING_VIEW, { companyId: row.companyId, partyId: row.partyId })
        answers.push({ workOrderId: answer.workOrderId, word: answer.word, date: answer.date, open: answer.materials.filter((material) => NOT_THERE.has(material.word)).length, materials: answer.materials.map((material) => readinessMaterialOf(material, live, { shared, purchases })), asOf: live.today })
      }
    }
    const order = new Map(ids.map((value, index) => [value, index]))
    return { workOrders: answers.sort((a, b) => (order.get(a.workOrderId) ?? 0) - (order.get(b.workOrderId) ?? 0)) }
  })
}
