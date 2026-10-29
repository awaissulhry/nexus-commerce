import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { QUALITY_INSPECTIONS_VIEW } from '@nexus/factory-domain/quality/final/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type FloorContext, type OfficeContext } from '../../../core/context'
import { readHeader, type LabelHeader } from '../../production/serials/store'

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

/** The work order of a final inspection or release, as the caller may reach it with the permission. */
export async function finalWorkOrder(caller: CommandCaller, workOrderId: string, permission: Permission): Promise<LabelHeader> {
  const context = inspectorOf(caller)
  const header = await caller.withClient((client) => readHeader(client, workOrderId))
  if (!header || !(mayOn(context, QUALITY_INSPECTIONS_VIEW, header) || mayOn(context, permission, header))) throw new NotFoundError('Work order not found.')
  if (!mayOn(context, permission, header)) throw new ForbiddenError(`This needs ${permission} over the work order's company and site.`)
  return header
}

/** Who signs: the floor's signed-in worker, or the office user. */
export interface Signer {
  readonly workerId: string | null
  readonly userId: string | null
}

export const signerOf = (context: Inspector): Signer => (context.audience === 'floor' ? { workerId: context.actorId, userId: null } : { workerId: null, userId: context.actorId })

export const postedBy = (context: Inspector): 'FLOOR' | 'OFFICE' => (context.audience === 'floor' ? 'FLOOR' : 'OFFICE')
