import { ConflictError, ForbiddenError, NotFoundError, type Issue } from '@nexus/factory-domain/core/errors'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type FloorContext, type OfficeContext } from '../../../core/context'
import { systemView } from '../../production/scans/access'

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

/** Seen with `view` (else not found), acted on with `permission` (else forbidden). */
export function assertOn(context: Checker, view: Permission, permission: Permission, record: { readonly companyId: string; readonly siteId: string }, what: string): void {
  if (!mayOn(context, view, record) && !mayOn(context, permission, record)) throw new NotFoundError(`${what} not found.`)
  if (!mayOn(context, permission, record)) throw new ForbiddenError(`This needs ${permission} over the ${what.toLowerCase()}'s company and site.`)
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
