import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { can, scopeWhere, type Permission } from '@nexus/factory-domain/core/permissions'
import { PLANT_MACHINES_MANAGE } from '@nexus/factory-domain/plant/permissions'
import type { PlantRefusal } from '@nexus/factory-domain/plant/rules'
import type { CommandCaller } from '../../core/command'
import { actorOf, type FloorContext, type OfficeContext } from '../../core/context'
import { mayWrite } from '../product/materials/store'

/**
 * Who may do what in the plant (B-W2a-35): each machine, request and job is checked with can() against its company and
 * site; a floor device only at its own site (can() pins it, row-level security too). Lists filter with scopeWhere(). The
 * machine classes and symptoms are the whole group's: keeping them needs plant.machines.manage over every company.
 * A plant rule's refusal is a 409 whose issues are `refusal/<CODE>` (the words) and `fix` (the one thing to do), as the
 * floor's task screens read them (factory-web floor/tasks/shared/task-api.ts).
 */

export type PlantContext = OfficeContext | FloorContext

export function contextOf(caller: Pick<CommandCaller, 'factoryContext'>): PlantContext {
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
export function may(context: PlantContext, permission: Permission, record: { readonly companyId: string; readonly siteId: string }): boolean {
  if (context.audience === 'floor' && context.siteId !== record.siteId) return false
  return can(actorOf(context), permission, record)
}

/** The same, or a 404 (a record the caller may not see is not found). */
export function assertMay(context: PlantContext, permission: Permission, record: { readonly companyId: string; readonly siteId: string }, what: string): void {
  if (!may(context, permission, record)) throw new NotFoundError(`${what} not found.`)
}

/** The same for a write the caller may read but not make: a 403 in words. */
export function assertMayWrite(context: PlantContext, permission: Permission, record: { readonly companyId: string; readonly siteId: string }, words: string): void {
  if (!may(context, permission, record)) throw new ForbiddenError(words)
}

const SCOPE = { company: 'companyId', site: 'siteId' } as const

/** A list's filter: the rows of the companies and sites the permission reaches (a floor device: its own site). */
export function scopeOf(context: PlantContext, permission: Permission): Record<string, unknown> {
  const where = scopeWhere(actorOf(context), permission, SCOPE) as Record<string, unknown>
  return context.audience === 'floor' ? { AND: [where, { siteId: context.siteId }] } : where
}

/** Keeps the classes and symptoms (the whole group's)? */
export const mayManageLists = (context: OfficeContext): boolean => mayWrite(actorOf(context), PLANT_MACHINES_MANAGE, null)

export function assertManageLists(context: OfficeContext): void {
  if (!mayManageLists(context)) throw new ForbiddenError("The machine classes and the symptoms are the whole group's: they are kept with plant.machines.manage over every company.")
}

export class PlantRefusedError extends ConflictError {
  override name = 'PlantRefusedError'
  override readonly issues: readonly Issue[]
  constructor(readonly refusal: PlantRefusal) {
    super(refusal.message)
    this.issues = [
      { path: `refusal/${refusal.code}`, message: refusal.message },
      { path: 'fix', message: refusal.fix },
    ]
  }
}

export const refused = (refusal: PlantRefusal): never => {
  throw new PlantRefusedError(refusal)
}

/** A 400 naming one body field. */
export const bodyIssue = (path: string, message: string): ValidationError => new ValidationError(message, [{ path: `body/${path}`, message }])

/** A 400 from a domain rule's problems (their paths without `body/`). */
export function problemsError(problems: readonly Issue[], words: string): ValidationError {
  return new ValidationError(problems.length === 1 ? problems[0]!.message : words, problems.map((problem) => ({ ...problem, path: `body/${problem.path}` })))
}

/** Who did it, for the events. */
export const byOf = (context: PlantContext): 'OFFICE' | 'FLOOR' => (context.audience === 'floor' ? 'FLOOR' : 'OFFICE')

/** The version a write was read at, or a 409 in words. */
export function assertVersion(what: string, current: number, sent: number): void {
  if (current !== sent) throw new ConflictError(`This ${what} changed since you read it (version ${current}, not ${sent}): read it again.`)
}
