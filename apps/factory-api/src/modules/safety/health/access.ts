import type { Prisma } from '@nexus/factory-db'
import { ConflictError, ForbiddenError, NotFoundError, type Issue } from '@nexus/factory-domain/core/errors'
import { can, scopeWhere, type Permission } from '@nexus/factory-domain/core/permissions'
import type { HealthRefusal } from '@nexus/factory-domain/safety/health/rules'
import { actorOf, type OfficeContext } from '../../../core/context'

/**
 * Who may do what with the health records (B-W2b-135): office only; each person's record (a visit, a judgement) is checked with
 * can() against the PERSON's company and site (HealthVisit and FitnessJudgement have no site: row-level security keeps the
 * tenant, this module keeps the site), inside the screen's company (`/w/<company>`); a plan against its role sheet's. A record
 * the caller may not read is not found (404) — the same answer for a person who exists and one who does not; a write the
 * caller may read but not make is a 403 in words. A rule's refusal is a 409 `refusal/<CODE>` (+ `body/<field>`), the shape of
 * the safety module's other answers.
 */

export { actorIdOf, assertVersion, bodyIssue, dateOf, dayOf, dayOrNull, officeOf, problemsError, todayOf } from '../../people/employees/access'
export { placeCaller } from '../incidents/access'

export type Placed = { readonly companyId: string; readonly siteId: string }

/** The permission over the place, inside the screen's company. */
export const may = (context: OfficeContext, permission: Permission, place: Placed): boolean =>
  (!context.companyId || context.companyId === place.companyId) && can(actorOf(context), permission, place)

export function assertMay(context: OfficeContext, permission: Permission, place: Placed, what: string): void {
  if (!may(context, permission, place)) throw new NotFoundError(`${what} not found.`)
}

export function assertMayWrite(context: OfficeContext, permission: Permission, place: Placed, words: string): void {
  if (!may(context, permission, place)) throw new ForbiddenError(words)
}

/** The people the permission reaches (an Employee filter), inside the screen's company: a visit's or a judgement's `employee`. */
export function peopleScope(context: OfficeContext, permission: Permission): Prisma.EmployeeWhereInput {
  const reach = scopeWhere(actorOf(context), permission, { company: 'companyId', site: 'siteId' }) as Prisma.EmployeeWhereInput
  return context.companyId ? { AND: [reach, { companyId: context.companyId }] } : reach
}

/** The narrowing a read asks for (`companyId`, `siteId`, one person: `employeeId`, the Employee › Safety tab) on the person. */
export const askedPeople = (query: { readonly companyId?: string | undefined; readonly siteId?: string | undefined; readonly employeeId?: string | undefined }): Prisma.EmployeeWhereInput => ({
  ...(query.companyId ? { companyId: query.companyId } : {}),
  ...(query.siteId ? { siteId: query.siteId } : {}),
  ...(query.employeeId ? { id: query.employeeId } : {}),
})

export class HealthRefusedError extends ConflictError {
  override name = 'HealthRefusedError'
  override readonly issues: readonly Issue[]
  constructor(readonly refusal: HealthRefusal) {
    super(refusal.message)
    this.issues = [{ path: `refusal/${refusal.code}`, message: refusal.message }, ...(refusal.field ? [{ path: `body/${refusal.field}`, message: refusal.message }] : [])]
  }
}

/** A rule's refusal (409). */
export function refuse(refusal: HealthRefusal | null): void {
  if (refusal) throw new HealthRefusedError(refusal)
}

export const VIEW_WORDS = 'The health records are seen by HR and the occupational doctor (safety.health.view), each view recorded.'
export const MANAGE_WORDS = 'Health visits and judgements are kept by HR and the occupational doctor (safety.health.manage).'
export const PLANS_WORDS = 'The plans per role are kept by the safety officer and the occupational doctor (safety.health.plans).'
export const VIEWS_WORDS = 'Who looked at the health records is seen by HR and the data protection officer (safety.health.views).'
