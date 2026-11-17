import { ConflictError, ForbiddenError, NotFoundError, type Issue } from '@nexus/factory-domain/core/errors'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type FloorContext, type OfficeContext } from '../../../core/context'
import { systemView } from '../../production/scans/access'
import type { WorkOrderReach } from '../../production/work-orders/scope'
import { mayOnWorkOrder, workOrderReachOf } from '../wall'
import type { Reader } from './store'

/**
 * Who may reach an in-process check (B-W2b-99): the office with the permission over the check's company and site, a floor
 * device only at its own site (can() pins it, row-level security too). A check the caller may not see is not found; one it
 * sees but may not act on is forbidden. A rule's refusal is a 409 whose issues are `refusal/<CODE>` (the words) and `fix`
 * (the one thing to do), as the floor's task screens read them.
 */

export type Checker = FloorContext | OfficeContext

export function checkerOf(caller: Pick<CommandCaller, 'factoryContext'>): Checker {
  const context = caller.factoryContext
  if (!context || (context.audience !== 'floor' && context.audience !== 'office')) throw new ForbiddenError()
  return context
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

/** May the caller do this on a record of this company and site? A floor device: only at its own site. */
export function mayOn(context: Checker, permission: Permission, record: { readonly companyId: string; readonly siteId: string }): boolean {
  if (context.audience === 'floor' && context.siteId !== record.siteId) return false
  return can(actorOf(context), permission, { companyId: record.companyId, siteId: record.siteId })
}

/**
 * B-PR-06 (the brand wall): a record on a work order (a check on it, its bundle, its operation) also needs the work order's
 * customer — B-PR-03's reachesWorkOrder through `workOrder` (null: a record of a line, which names no customer).
 */
export function mayOnWork(context: Checker, permission: Permission, record: { readonly companyId: string; readonly siteId: string }, workOrder: WorkOrderReach | null | undefined): boolean {
  if (workOrder === undefined) return false
  return mayOn(context, permission, record) && (workOrder === null || mayOnWorkOrder(context, permission, workOrder))
}

/** B-PR-06: the scope of a record's work order (null: it names none; undefined: an unknown work order, which nobody reaches). */
export async function workOrderReachFor(db: Reader, workOrderId: string | null | undefined): Promise<WorkOrderReach | null | undefined> {
  if (!workOrderId) return null
  return (await workOrderReachOf(db, [workOrderId])).get(workOrderId)
}

/**
 * Seen with `view` (else not found), acted on with `permission` (else forbidden). B-PR-06: a record on a work order names it
 * (`workOrder`): another customer's is not found, as an unknown one.
 */
export function assertOn(context: Checker, view: Permission, permission: Permission, record: { readonly companyId: string; readonly siteId: string }, what: string, workOrder: WorkOrderReach | null | undefined = null): void {
  if (!mayOnWork(context, view, record, workOrder) && !mayOnWork(context, permission, record, workOrder)) throw new NotFoundError(`${what} not found.`)
  if (!mayOnWork(context, permission, record, workOrder)) throw new ForbiddenError(`This needs a right your role does not hold over the ${what.toLowerCase()}'s company and site.`)
}

/** Who records and signs: the floor's signed-in worker, or the office user. */
export const signerOf = (context: Checker): { readonly workerId: string | null; readonly userId: string | null } =>
  context.audience === 'floor' ? { workerId: context.actorId, userId: null } : { workerId: null, userId: context.actorId }

export const postedBy = (context: Checker): 'FLOOR' | 'OFFICE' => (context.audience === 'floor' ? 'FLOOR' : 'OFFICE')

/** The tenant's system view: the legal gate and a worker's employee, which the floor role does not read. */
export const systemOf = (caller: CommandCaller): CommandCaller => systemView(caller)

export interface InProcessRefusal {
  readonly code: string
  readonly message: string
  readonly fix: string
}

export class InProcessRefusedError extends ConflictError {
  override name = 'InProcessRefusedError'
  override readonly issues: readonly Issue[]
  constructor(readonly refusal: InProcessRefusal) {
    super(refusal.message)
    this.issues = [
      { path: `refusal/${refusal.code}`, message: refusal.message },
      { path: 'fix', message: refusal.fix },
    ]
  }
}

export const refuse = (refusal: InProcessRefusal): never => {
  throw new InProcessRefusedError(refusal)
}
