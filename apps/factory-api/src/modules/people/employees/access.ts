import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { can, scopeWhere, type Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'

/**
 * Who may do what with the people records (B-W2b-26), shared by modules/people/employees, teams and leavers: office only
 * (the floor reads its crews with its own routes); each record is checked with can() against its company and site; a
 * record the caller may not read is not found (404), a write the caller may read but not make is a 403 in words. A
 * people rule's refusal is a 409 whose issues are `refusal/<CODE>` (the web has the words of each code) and, when one
 * field is at fault, `body/<field>` (the record shows the words at that field).
 */

export function officeOf(caller: Pick<CommandCaller, 'factoryContext'>): OfficeContext {
  const context = caller.factoryContext
  if (!context || context.audience !== 'office') throw new ForbiddenError()
  return context
}

export type Placed = { readonly companyId: string; readonly siteId: string }

export const may = (context: OfficeContext, permission: Permission, record: Placed): boolean => can(actorOf(context), permission, record)

/** The record, or a 404: a record the caller may not read is not found. */
export function assertMay(context: OfficeContext, permission: Permission, record: Placed, what: string): void {
  if (!may(context, permission, record)) throw new NotFoundError(`${what} not found.`)
}

/** A write the caller may read but not make: a 403 in words. */
export function assertMayWrite(context: OfficeContext, permission: Permission, record: Placed, words: string): void {
  if (!may(context, permission, record)) throw new ForbiddenError(words)
}

const SCOPE = { company: 'companyId', site: 'siteId' } as const

/** A list's filter: the rows of the companies and sites the permission reaches. */
export const scopeOf = (context: OfficeContext, permission: Permission): Record<string, unknown> => scopeWhere(actorOf(context), permission, SCOPE) as Record<string, unknown>

export class PeopleRefusedError extends ConflictError {
  override name = 'PeopleRefusedError'
  override readonly issues: readonly Issue[]
  constructor(
    readonly refusal: string,
    message: string,
    field?: string,
    more: readonly Issue[] = [],
  ) {
    super(message)
    this.issues = [{ path: `refusal/${refusal}`, message }, ...(field ? [{ path: `body/${field}`, message }] : []), ...more]
  }
}

/** A people rule's refusal (409): `refusal/<CODE>`, the field at fault when there is one, and any more issues. */
export const refuse = (code: string, message: string, field?: string, more: readonly Issue[] = []): never => {
  throw new PeopleRefusedError(code, message, field, more)
}

/** A 400 naming one body field. */
export const bodyIssue = (path: string, message: string): ValidationError => new ValidationError(message, [{ path: `body/${path}`, message }])

/** A 400 from a domain rule's problems (their paths without `body/`). */
export function problemsError(problems: readonly Issue[], words: string): ValidationError {
  return new ValidationError(problems.length === 1 ? problems[0]!.message : words, problems.map((problem) => ({ ...problem, path: `body/${problem.path}` })))
}

/** The version a write was read at, or a 409 in words. */
export function assertVersion(what: string, current: number, sent: number): void {
  if (current !== sent) throw new ConflictError(`This ${what} changed since you read it (version ${current}, not ${sent}): read it again.`)
}

/** Today in the factory's time zone (Europe/Rome: the guards' "today"). */
export const todayOf = (now: Date): BusinessDate => businessDate(now)

/** A stored calendar day (a DATE column) as YYYY-MM-DD. */
export const dayOf = (value: Date): BusinessDate => value.toISOString().slice(0, 10)
export const dayOrNull = (value: Date | null): BusinessDate | null => (value === null ? null : dayOf(value))

/** A calendar day as a DATE column takes it. */
export const dateOf = (day: BusinessDate): Date => new Date(`${day}T00:00:00.000Z`)

/** The office user who made a change (null in the system scope). */
export const actorIdOf = (context: { readonly audience: string; readonly actorId?: string }): string | null => (context.audience === 'office' && context.actorId ? context.actorId : null)
