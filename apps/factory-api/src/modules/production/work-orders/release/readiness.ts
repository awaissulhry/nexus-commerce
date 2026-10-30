import { ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import type { CommandCaller } from '../../../../core/command'
import { livePlanOf, readinessFor } from '../../../planning/readiness/service'
import { SITE_COLUMNS as PLANNING_SITE_COLUMNS } from '../../../planning/store'
import { mayOn, officeContextOf } from '../access'

/**
 * GET /production/work-orders/readiness?ids= (B-W2a-46; design wo-grid "Readiness (W2a word)"; workorders.view over each
 * work order): the plan's readiness word of up to 100 work orders, for the list's column. One live plan per site (the
 * planning readiness service nets the whole site once), read only. Work orders the caller may not see are left out.
 */

const NOT_THERE = new Set(['NOT_ENOUGH', 'DELAYED', 'REQUESTED', 'NOT_BOOKED'])

export async function listReadiness(caller: CommandCaller, query: { readonly ids: string }) {
  const context = officeContextOf(caller)
  const ids = [...new Set(query.ids.split(',').map((value) => value.trim()).filter((value) => value !== ''))]
  if (ids.length > 100 || ids.some((value) => !isUuid(value))) throw new ValidationError('Name at most 100 work orders by their ids.', [{ path: 'querystring/ids', message: 'Comma-separated work order ids, at most 100.' }])
  return caller.withClient(async (db) => {
    const rows = (await db.workOrder.findMany({ where: { id: { in: ids } }, select: { id: true, companyId: true, siteId: true } })).filter((row) => mayOn(context, WORKORDERS_VIEW, row))
    const bySite = new Map<string, string[]>()
    for (const row of rows) bySite.set(row.siteId, [...(bySite.get(row.siteId) ?? []), row.id])
    const answers = []
    // One site after another (one connection runs one query at a time).
    for (const [siteId, siteIds] of [...bySite.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const site = await db.site.findUnique({ where: { id: siteId }, select: PLANNING_SITE_COLUMNS })
      if (!site) continue
      const live = await livePlanOf(db, site)
      for (const answer of await readinessFor(db, site, siteIds, live)) {
        answers.push({ workOrderId: answer.workOrderId, word: answer.word, date: answer.date, open: answer.materials.filter((material) => NOT_THERE.has(material.word)).length, materials: answer.materials.map((material) => ({ itemId: material.itemId, itemColourId: material.itemColourId, word: material.word, date: material.date })), asOf: live.today })
      }
    }
    const order = new Map(ids.map((value, index) => [value, index]))
    return { workOrders: answers.sort((a, b) => (order.get(a.workOrderId) ?? 0) - (order.get(b.workOrderId) ?? 0)) }
  })
}
