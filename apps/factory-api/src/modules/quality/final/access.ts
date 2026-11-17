import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { QUALITY_INSPECTIONS_VIEW } from '@nexus/factory-domain/quality/final/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type FloorContext, type OfficeContext } from '../../../core/context'
import { LABEL_HEADER, type LabelHeader } from '../../production/serials/store'
// B-PR-06: the brand wall (a work order's customer, as B-PR-03's reachesWorkOrder).
import { mayOnWorkOrder, workOrderReachOf } from '../wall'
import type { Reader } from './store'

/**
 * Who may reach a work order's final inspection and release (B-W1-45): the office with the permission over the work
 * order's company and site, a floor device only at its own site (can() pins it, row-level security too). A work order
 * the caller may not see is not found; one it sees (quality.inspections.view) but may not act on is forbidden.
 */

export type Inspector = FloorContext | OfficeContext

export function inspectorOf(caller: Pick<CommandCaller, 'factoryContext'>): Inspector {
  const context = caller.factoryContext
  if (!context || (context.audience !== 'floor' && context.audience !== 'office')) throw new ForbiddenError()
  return context
}

export function officeOf(caller: Pick<CommandCaller, 'factoryContext'>): OfficeContext {
  const context = caller.factoryContext
  if (!context || context.audience !== 'office') throw new ForbiddenError()
  return context
}

/** May the caller do this on a record of this company and site (and customer)? A floor device: only at its own site. */
export function mayOn(context: Inspector, permission: Permission, record: { readonly companyId: string; readonly siteId: string; readonly partyId?: string | null }): boolean {
  if (context.audience === 'floor' && context.siteId !== record.siteId) return false
  return can(actorOf(context), permission, { companyId: record.companyId, siteId: record.siteId, ...(record.partyId ? { partyId: record.partyId } : {}) })
}

/** A work order's label header and its one customer (null: none, or mixed before the rule). */
export type FinalHeader = LabelHeader & { readonly partyId: string | null }

/**
 * The work order of a final inspection or release, as the caller may reach it with the permission. B-PR-06 (the brand wall):
 * its customer too — a work order of another customer (or of none, for a person who does not reach every customer) is not
 * found, in the words of the record asked (`missing`: an inspection's or a release's route says its own), as an unknown one.
 */
export async function finalWorkOrder(caller: CommandCaller, workOrderId: string, permission: Permission, missing = 'Work order not found.'): Promise<FinalHeader> {
  const context = inspectorOf(caller)
  const header = isUuid(workOrderId) ? await caller.withClient((client) => client.workOrder.findUnique({ where: { id: workOrderId }, select: { ...LABEL_HEADER, partyId: true } })) : null
  if (!header || !(mayOnWorkOrder(context, QUALITY_INSPECTIONS_VIEW, header) || mayOnWorkOrder(context, permission, header))) throw new NotFoundError(missing)
  if (!mayOnWorkOrder(context, permission, header)) throw new ForbiddenError("This needs a right your role does not hold over the work order's company and site.")
  return header
}

/**
 * B-PR-06 (the brand wall): the permission reaches this inspection's work order — its customer too (none: only who reaches
 * every customer). Read in `db` (a command's transaction, or the caller's client).
 */
export async function reachesInspectionWork(db: Reader, context: Inspector, permission: Permission, row: { readonly workOrderId: string }): Promise<boolean> {
  const reach = (await workOrderReachOf(db, [row.workOrderId])).get(row.workOrderId)
  return reach !== undefined && mayOnWorkOrder(context, permission, reach)
}

/** Who signs: the floor's signed-in worker, or the office user. */
export interface Signer {
  readonly workerId: string | null
  readonly userId: string | null
}

export const signerOf = (context: Inspector): Signer => (context.audience === 'floor' ? { workerId: context.actorId, userId: null } : { workerId: null, userId: context.actorId })

export const postedBy = (context: Inspector): 'FLOOR' | 'OFFICE' => (context.audience === 'floor' ? 'FLOOR' : 'OFFICE')
