import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { can, scopeWhere, type Permission } from '@nexus/factory-domain/core/permissions'
import type { CallRefusal } from '@nexus/factory-domain/production/calls/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type FloorContext, type OfficeContext } from '../../../core/context'

/**
 * Who may do what with help calls (B-W2b-35): each call and type is checked with can() against its company and site; a
 * floor device only at its own site (can() pins it, row-level security too). Lists filter with scopeWhere(). A call rule's
 * refusal is a 409 whose issues are `refusal/<CODE>` (the words) and `fix` (the one thing to do), as the floor's task
 * screens read them (factory-web floor/tasks/shared/task-api.ts).
 */

export type CallContext = OfficeContext | FloorContext

export function contextOf(caller: Pick<CommandCaller, 'factoryContext'>): CallContext {
  const context = caller.factoryContext
  if (!context || (context.audience !== 'office' && context.audience !== 'floor')) throw new ForbiddenError()
  return context
}

export function officeOf(caller: Pick<CommandCaller, 'factoryContext'>): OfficeContext {
  const context = caller.factoryContext
  if (!context || context.audience !== 'office') throw new ForbiddenError()
  return context
}

export function floorOf(caller: Pick<CommandCaller, 'factoryContext'>): FloorContext {
  const context = caller.factoryContext
  if (!context || context.audience !== 'floor') throw new ForbiddenError()
  return context
}

/** May the caller do this on a record of that company and site? A floor device: only at its own site. */
export function may(context: CallContext, permission: Permission, record: { readonly companyId: string; readonly siteId: string }): boolean {
  if (context.audience === 'floor' && context.siteId !== record.siteId) return false
  return can(actorOf(context), permission, record)
}

/** The same, or a 404 (a record the caller may not see is not found). */
export function assertMay(context: CallContext, permission: Permission, record: { readonly companyId: string; readonly siteId: string }, what: string): void {
  if (!may(context, permission, record)) throw new NotFoundError(`${what} not found.`)
}

/** A list's filter over the sites (and their companies) the permission reaches; a floor device: its own site. */
export function siteScopeOf(context: CallContext, permission: Permission): Record<string, unknown> {
  const where = scopeWhere(actorOf(context), permission, { company: 'companyId', site: 'id' }) as Record<string, unknown>
  return context.audience === 'floor' ? { AND: [where, { id: context.siteId }] } : where
}

export class CallRefusedError extends ConflictError {
  override name = 'CallRefusedError'
  override readonly issues: readonly Issue[]
  constructor(readonly refusal: CallRefusal) {
    super(refusal.message)
    this.issues = [
      { path: `refusal/${refusal.code}`, message: refusal.message },
      { path: 'fix', message: refusal.fix },
    ]
  }
}

export const refuse = (refusal: CallRefusal): never => {
  throw new CallRefusedError(refusal)
}

/** A 400 naming one body field. */
export const bodyIssue = (path: string, message: string): ValidationError => new ValidationError(message, [{ path: `body/${path}`, message }])

/** A 400 from a domain rule's problems (their paths without `body/`). */
export function problemsError(problems: readonly Issue[], words: string): ValidationError {
  return new ValidationError(problems.length === 1 ? problems[0]!.message : words, problems.map((problem) => ({ ...problem, path: `body/${problem.path}` })))
}

/** Who did it, for the events. */
export const byOf = (context: CallContext): 'OFFICE' | 'FLOOR' => (context.audience === 'floor' ? 'FLOOR' : 'OFFICE')

/** The version a write was read at, or a 409 in words. */
export function assertVersion(what: string, current: number, sent: number | undefined): void {
  if (sent !== undefined && current !== sent) throw new ConflictError(`This ${what} changed since you read it (version ${current}, not ${sent}): read it again.`)
}
