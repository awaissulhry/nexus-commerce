import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { PRODUCTION_OFFSTANDARD_VIEW } from '@nexus/factory-domain/production/offstandard/permissions'
import { minutesOf, offStandardByWorkOrder } from '@nexus/factory-domain/production/offstandard/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { openWorkOf } from '../terminal/timing'
import { officeOf } from './access'
import { codesById, type Reader, type Subject } from './store'
import { tileOf } from './views'

/**
 * Off-standard time per work order (B-W2b-81; the Labour tab of a work order; OffStandardEntry.workOrderId, nullable).
 * A block has a work order when someone named one, or when the bundle it interrupts says so:
 *
 *   a call        the work order the help call names (its waiting block)
 *   a typed block the work order the team leader or the office names
 *   else          the work order of the ONE bundle the subject has paused: a block starts only while no bundle runs, so a
 *                 paused one is what it interrupts. Several paused bundles, or none: the block has none (never a guess).
 *
 * The figures are per work order, state and code: never per person (Owner answers W1, F2; Statuto dei Lavoratori art. 4).
 * A rejected block is no off-standard time, so it counts nowhere.
 */

const NOT_BOOKABLE = ['DRAFT', 'CANCELLED']

/** A work order of the site a block may name (the database refuses a draft or a cancelled one). */
export async function blockableWorkOrder(db: Reader, siteId: string, workOrderId: string): Promise<boolean> {
  const row = await db.workOrder.findUnique({ where: { id: workOrderId }, select: { siteId: true, status: true } })
  return row !== null && row.siteId === siteId && !NOT_BOOKABLE.includes(row.status)
}

/** The work order of the one bundle the subject has paused at the site, or null. */
export async function pausedWorkOrderOf(db: Parameters<typeof openWorkOf>[0], siteId: string, subject: Subject, now: Date): Promise<string | null> {
  const orders = new Set((await openWorkOf(db, siteId, subject, now)).filter((entry) => entry.stretch.open === 'PAUSED').map((entry) => entry.workOrderId))
  return orders.size === 1 ? [...orders][0]! : null
}

/** GET /production/offstandard/work-orders/:workOrderId/minutes (production.offstandard.view on the work order's company and site). */
export async function workOrderMinutes(caller: CommandCaller, workOrderId: string) {
  const context = officeOf(caller)
  const now = new Date()
  return caller.withClient(async (db) => {
    const workOrder = isUuid(workOrderId) ? await db.workOrder.findUnique({ where: { id: workOrderId }, select: { id: true, companyId: true, siteId: true } }) : null
    if (!workOrder || !can(actorOf(context), PRODUCTION_OFFSTANDARD_VIEW, { companyId: workOrder.companyId, siteId: workOrder.siteId })) throw new NotFoundError('Work order not found.')
    const blocks = await db.offStandardEntry.findMany({ where: { workOrderId: workOrder.id, status: { not: 'REJECTED' } }, select: { codeId: true, status: true, startedAt: true, endedAt: true } })
    const totals = offStandardByWorkOrder(blocks.map((block) => ({ codeId: block.codeId, status: block.status, minutes: minutesOf(block.startedAt, block.endedAt, now) })))
    const codes = await codesById(db, totals.codes.map((entry) => entry.codeId))
    return { workOrderId: workOrder.id, ...totals, codes: totals.codes.map(({ codeId, ...entry }) => ({ code: tileOf(codes.get(codeId)!), ...entry })) }
  })
}
