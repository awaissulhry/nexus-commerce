import { ConflictError, ForbiddenError, NotFoundError, type Issue } from '@nexus/factory-domain/core/errors'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import type { ScanRefusal } from '@nexus/factory-domain/production/scans/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type FloorContext, type OfficeContext } from '../../../core/context'
import { systemContext } from '../../../platform/outbox/system'
import { readHeader, type ScanHeader } from './store'

/**
 * Who may scan or read what (B-W1-42): a floor device only at its own site, the office within its grants (can() on the
 * work order's company and site), and the refusal error every scan route answers with.
 */

/** A scan refused by its rule (factory-domain production/scans/rules): a 409 with `refusal/<CODE>` and the fix as issues. */
export class ScanRefusedError extends ConflictError {
  override name = 'ScanRefusedError'
  override readonly issues: readonly Issue[]
  constructor(readonly refusal: ScanRefusal) {
    super(refusal.message)
    this.issues = [
      { path: `refusal/${refusal.code}`, message: refusal.message },
      { path: 'fix', message: refusal.fix },
    ]
  }
}

export const refuse = (refusal: ScanRefusal): never => {
  throw new ScanRefusedError(refusal)
}

export function floorOf(caller: Pick<CommandCaller, 'factoryContext'>): FloorContext {
  const context = caller.factoryContext
  if (!context || context.audience !== 'floor') throw new ForbiddenError()
  return context
}

export function officeOf(caller: Pick<CommandCaller, 'factoryContext'>): OfficeContext {
  const context = caller.factoryContext
  if (!context || context.audience !== 'office') throw new ForbiddenError()
  return context
}

export function floorOrOffice(caller: Pick<CommandCaller, 'factoryContext'>): FloorContext | OfficeContext {
  const context = caller.factoryContext
  if (!context || (context.audience !== 'floor' && context.audience !== 'office')) throw new ForbiddenError()
  return context
}

/** May the caller work on this work order with the permission? (A floor device: only at its own site.) */
export function mayScan(context: FloorContext | OfficeContext, permission: Permission, workOrder: { readonly companyId: string; readonly siteId: string }): boolean {
  if (context.audience === 'floor' && context.siteId !== workOrder.siteId) return false
  return can(actorOf(context), permission, { companyId: workOrder.companyId, siteId: workOrder.siteId })
}

/** The work order the caller scans for or reads: one it may reach with the permission (else not found). */
export async function scanWorkOrder(caller: CommandCaller, workOrderId: string, permission: Permission): Promise<ScanHeader> {
  const context = floorOrOffice(caller)
  const workOrder = await caller.withClient((client) => readHeader(client, workOrderId))
  if (!workOrder || !mayScan(context, permission, workOrder)) throw new NotFoundError('Work order not found.')
  return workOrder
}

/**
 * The same request in the tenant's system context (the office role, row-level security forced on the tenant): for the
 * reads the floor role may not make (the floor's readiness gate; the interim seams' audit rows). `withClient` follows
 * the view's context, as platform/privacy's public notice does; it needs a request (a FastifyRequest), not a
 * `callerFor` caller, whose `withClient` is a closure.
 */
export function systemView(caller: CommandCaller): CommandCaller {
  const context = caller.factoryContext
  if (!context || !('tenantId' in context) || !context.tenantId) throw new ForbiddenError()
  const view = Object.create(caller) as CommandCaller & { factoryContext: CommandCaller['factoryContext'] }
  view.factoryContext = systemContext(context.tenantId, context.requestId)
  return view
}
