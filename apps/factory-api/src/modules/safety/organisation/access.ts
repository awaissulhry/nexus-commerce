import { NotFoundError, ForbiddenError } from '@nexus/factory-domain/core/errors'
import { can, scopeWhere, type Permission } from '@nexus/factory-domain/core/permissions'
import { actorOf, type OfficeContext } from '../../../core/context'

/**
 * Who may do what with the safety records (B-W2b-120), shared by modules/safety/organisation and modules/safety/calendar:
 * office only; each record is checked with can() against its company and, when it has one, its site (a whole-company
 * appointment or deadline has none, so a role of one site reads it too). A record the caller may not read is not found
 * (404); a write the caller may read but not make is a 403 in words. A rule's refusal is a 409 `refusal/<CODE>` (+
 * `body/<field>`), as the people records answer (modules/people/employees/access.ts, reused here).
 */

export { actorIdOf, assertVersion, bodyIssue, dateOf, dayOf, dayOrNull, officeOf, problemsError, refuse, todayOf } from '../../people/employees/access'

/** A record of the safety tables: its company, and its site or null (the whole company). */
export type SafetyPlace = { readonly companyId: string; readonly siteId: string | null }

export const mayAt = (context: OfficeContext, permission: Permission, place: SafetyPlace): boolean =>
  (!context.companyId || context.companyId === place.companyId) && can(actorOf(context), permission, { companyId: place.companyId, ...(place.siteId ? { siteId: place.siteId } : {}) })

/** The record, or a 404: a record the caller may not read is not found. */
export function assertMayAt(context: OfficeContext, permission: Permission, place: SafetyPlace, what: string): void {
  if (!mayAt(context, permission, place)) throw new NotFoundError(`${what} not found.`)
}

/** A write the caller may read but not make: a 403 in words. */
export function assertMayWriteAt(context: OfficeContext, permission: Permission, place: SafetyPlace, words: string): void {
  if (!mayAt(context, permission, place)) throw new ForbiddenError(words)
}

/**
 * A list's filter for a table with `companyId` and a nullable `siteId`: the rows the permission reaches (a whole-company
 * row with every site of a company the grant reaches), inside the screen's company (`/w/<company>`) when it names one.
 */
export function placeScope(context: OfficeContext, permission: Permission, columns: { readonly company: string; readonly site: string } = { company: 'companyId', site: 'siteId' }): Record<string, unknown> {
  const reach = scopeWhere(actorOf(context), permission, { company: columns.company, site: { field: columns.site, nullable: true } }) as Record<string, unknown>
  return context.companyId ? { AND: [reach, { [columns.company]: context.companyId }] } : reach
}

/** The same filter for a table whose site is not nullable (machines' plans, risk assessments). */
export function siteScope(context: OfficeContext, permission: Permission): Record<string, unknown> {
  const reach = scopeWhere(actorOf(context), permission, { company: 'companyId', site: 'siteId' }) as Record<string, unknown>
  return context.companyId ? { AND: [reach, { companyId: context.companyId }] } : reach
}

/** The narrowing a read asks for (`?companyId=&siteId=`): a site's rows and the whole company's. */
export function asked(query: { readonly companyId?: string | undefined; readonly siteId?: string | undefined }, site: 'nullable' | 'strict' = 'nullable'): Record<string, unknown> {
  return {
    ...(query.companyId ? { companyId: query.companyId } : {}),
    ...(query.siteId ? (site === 'nullable' ? { OR: [{ siteId: query.siteId }, { siteId: null }] } : { siteId: query.siteId }) : {}),
  }
}
