import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import type { AllocationRefusal } from '@nexus/factory-domain/production/cutorders/allocation'
import type { PlyRefusal } from '@nexus/factory-domain/production/cutorders/plies'
import type { CutOrderRefusal } from '@nexus/factory-domain/production/cutorders/rules'
import type { TicketRefusal } from '@nexus/factory-domain/production/cutorders/tickets'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type FloorContext, type OfficeContext } from '../../../core/context'

/**
 * Who may do what with cut orders and their tickets (B-W2b-112): each cut order is checked with can() against its company and
 * site; a floor device only at its own site (can() pins it, row-level security too). A rule's refusal is a 409 whose issue is
 * `refusal/<CODE>` with the words (the office's dialogs and the cutting tablet read them; `refusal.<CODE>` in the web's words).
 */

export function officeOf(caller: Pick<CommandCaller, 'factoryContext'>): OfficeContext {
  const context = caller.factoryContext
  if (!context || context.audience !== 'office') throw new ForbiddenError()
  return context
}

export function workerOf(caller: Pick<CommandCaller, 'factoryContext'>): OfficeContext | FloorContext {
  const context = caller.factoryContext
  if (!context || (context.audience !== 'office' && context.audience !== 'floor')) throw new ForbiddenError()
  return context
}

export function floorOf(caller: Pick<CommandCaller, 'factoryContext'>): FloorContext {
  const context = caller.factoryContext
  if (!context || context.audience !== 'floor') throw new ForbiddenError()
  return context
}

/** May the caller do this on a record of that company and site? A floor device: only at its own site. */
export function may(context: OfficeContext | FloorContext, permission: Permission, record: { readonly companyId: string; readonly siteId: string }): boolean {
  if (context.audience === 'floor' && context.siteId !== record.siteId) return false
  return can(actorOf(context), permission, record)
}

/** A refusal of these rules, or one of another module's gates this one asks (the floor's readiness: FLOOR_NOT_READY). */
export type Refusal = CutOrderRefusal | AllocationRefusal | TicketRefusal | PlyRefusal | { readonly code: 'FLOOR_NOT_READY'; readonly message: string }

export class CutOrderRefusedError extends ConflictError {
  override name = 'CutOrderRefusedError'
  override readonly issues: readonly Issue[]
  constructor(readonly refusal: Refusal) {
    super(refusal.message)
    this.issues = [{ path: `refusal/${refusal.code}`, message: refusal.message }]
  }
}

export const refuse = (refusal: Refusal): never => {
  throw new CutOrderRefusedError(refusal)
}

/** A 400 of the body's problems (paths relative to the body). */
export function invalid(problems: readonly Issue[], words: string): never {
  throw new ValidationError(problems.length === 1 ? problems[0]!.message : words, problems.map((problem) => ({ ...problem, path: `body/${problem.path}` })))
}

export const notFound = (what: string): never => {
  throw new NotFoundError(`${what} not found.`)
}
