import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere, type Actor, type Permission, type WhereClause } from '@nexus/factory-domain/core/permissions'
import { businessDate, type BusinessDate, type Clock } from '@nexus/factory-domain/core/time'
import { TECHFILES_VIEW } from '@nexus/factory-domain/compliance/techfiles/permissions'
import { COMMAND_SETTINGS, type CommandCaller, type CommandSettings } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { namesFor, officeOf as rulesOfficeOf, rulesGuarded, type Reader } from '../register-of-rules/common'

/**
 * What the technical files' parts share (B-W2b-251; modules/compliance/techfiles): the office context, who may read or keep
 * a row (a company is a column here, not a policy key: the API keeps staff to the companies their grants reach), the module
 * clock and "today" in Rome, people's names, and the last line of defence that turns the database's own refusal (B-W2b-218's
 * `compliance: …` check and restrict violations, a unique key, a reference) into a 409 in words — never a 500.
 */

export type { Reader }
export { namesFor }

export const officeOf = (caller: CommandCaller): OfficeContext => rulesOfficeOf(caller)

let clock: Clock = serverClock
/** Test only: the module clock (today, the commands' time). */
export function useTechfilesClock(next: Clock | undefined): void {
  clock = next ?? serverClock
}
export const techfilesClock = (): Clock => clock
export const settings = (): CommandSettings => ({ ...COMMAND_SETTINGS, clock })
/** Today in Rome (the database's factory_techfiles_today). */
export const todayOf = (now: Date = clock.now()): BusinessDate => businessDate(now)

export const dayOf = (value: Date | null): BusinessDate | null => (value === null ? null : value.toISOString().slice(0, 10))
export const dateOfDay = (day: BusinessDate): Date => new Date(`${day}T00:00:00.000Z`)

/** A database refusal of a technical-file write answered as a 409 in words (never a 500). */
export function guarded<T>(work: () => Promise<T>, words: { readonly taken?: string; readonly named?: string } = {}): Promise<T> {
  return rulesGuarded(work, words)
}

/** The permission over the row's company, or a 403 in words. */
export function assertMay(context: OfficeContext, permission: Permission, companyId: string, what?: string): void {
  if (!can(actorOf(context), permission, { companyId })) throw new ForbiddenError(what ? `${what} needs ${permission} over this company.` : undefined)
}

export const mayOn = (actor: Actor, permission: Permission, companyId: string): boolean => can(actor, permission, { companyId })

/** The rows of the companies the permission reaches (the company is a column, required). */
export const companyReach = (actor: Actor, permission: Permission = TECHFILES_VIEW): WhereClause => scopeWhere(actor, permission, { company: 'companyId' })

/** A record read by id that the caller may see, or the one 404. */
export function seen<T extends { companyId: string }>(row: T | null, actor: Actor, notFound: string, permission: Permission = TECHFILES_VIEW): T {
  if (!row || !can(actor, permission, { companyId: row.companyId })) throw new NotFoundError(notFound)
  return row
}

export const uuidOr404 = (value: string, notFound: string): string => {
  if (!isUuid(value)) throw new NotFoundError(notFound)
  return value
}
