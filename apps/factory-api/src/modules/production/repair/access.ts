import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import type { DowngradeRefusal, RepairRefusal } from '@nexus/factory-domain/production/repair/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type FloorContext, type OfficeContext } from '../../../core/context'
import { reachesWorkOrder, type WorkOrderReach } from '../work-orders/scope' // B-PR-05

/**
 * Who may do what at the repair station and with second quality (B-W2b-126): each rework and work order is checked with can()
 * against its company and site; a floor device only at its own site (can() pins it, row-level security too). A rule's
 * refusal is a 409 whose issues are `refusal/<CODE>` (the words) and `fix` (the one thing to do), as the floor's task screens
 * and the office's dialogs read them.
 */

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

/**
 * May the caller do this on a work order's record? A floor device: only at its own site. B-PR-05 (production plan §2, the brand
 * wall, ../work-orders/scope): the record names its work order's one customer (`partyId`): another customer's is not found.
 */
export function may(context: FloorContext | OfficeContext, permission: Permission, record: WorkOrderReach): boolean {
  if (context.audience === 'floor' && context.siteId !== record.siteId) return false
  return reachesWorkOrder(actorOf(context), permission, record)
}

export function assertMay(context: FloorContext | OfficeContext, permission: Permission, record: WorkOrderReach | null, what: string): asserts record is WorkOrderReach {
  if (!record || !may(context, permission, record)) throw new NotFoundError(`${what} not found.`)
}

// ── B-PR-05 (the brand wall) ──
/** A rework row's reach (read with its work order's customer: store.ts REPAIR_COLUMNS). */
export const repairReach = (row: { readonly companyId: string; readonly siteId: string; readonly workOrder: { readonly partyId: string | null } }): WorkOrderReach => ({ companyId: row.companyId, siteId: row.siteId, partyId: row.workOrder.partyId })

/** A downgrade's reach (read with its cell's work order's customer: store.ts DOWNGRADE_COLUMNS). */
export const downgradeReach = (row: { readonly companyId: string; readonly siteId: string; readonly workOrderSize: { readonly workOrder: { readonly partyId: string | null } } }): WorkOrderReach => ({ companyId: row.companyId, siteId: row.siteId, partyId: row.workOrderSize.workOrder.partyId })
// ── end B-PR-05 ──

export class RepairRefusedError extends ConflictError {
  override name = 'RepairRefusedError'
  override readonly issues: readonly Issue[]
  constructor(readonly refusal: RepairRefusal | DowngradeRefusal) {
    super(refusal.message)
    this.issues = [{ path: `refusal/${refusal.code}`, message: refusal.message }, ...(refusal.fix ? [{ path: 'fix', message: refusal.fix }] : [])]
  }
}

export const refuse = (refusal: RepairRefusal | DowngradeRefusal): never => {
  throw new RepairRefusedError(refusal)
}

/** A 400 naming one body field. */
export const bodyIssue = (path: string, message: string): ValidationError => new ValidationError(message, [{ path: `body/${path}`, message }])
