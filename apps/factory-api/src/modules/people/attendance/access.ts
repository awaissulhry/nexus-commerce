import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { daysFrom } from '@nexus/factory-domain/calendars/dates'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { ATTENDANCE_RULES } from '@nexus/factory-domain/people/attendance/rules'
import type { CommandCaller } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { may, officeOf, refuse } from '../employees/access'
import { requireLegalGate } from '../privacy/gate'
import { personOf, siteOf, type Client, type PersonRow, type SiteRow } from './store'

/**
 * Who reaches attendance days (B-W2b-37), office only. Each site or person is checked with can() against its company
 * and site: one the caller may not read is not found (404). Before anything of a person is read or written, the site's
 * ATTENDANCE legal gate (B-W2b-27 `requireLegalGate`; Statuto dei Lavoratori art. 4 c.2-3): while it is off every route
 * answers 409 `gate/ATTENDANCE` in words. Nobody decides about their own day: an approval, a fix, a reopening or an
 * accepted anomaly of the caller's own employee record is refused (OWN_DAY; D.Lgs. 152/1997 art. 1-bis).
 */

export { officeOf }

/** The site, if the caller holds the permission over it (else 404: a site out of reach is not told). */
export async function siteFor(db: Client, context: OfficeContext, siteId: string, permissions: readonly Permission[]): Promise<SiteRow> {
  const site = isUuid(siteId) ? await siteOf(db, siteId) : null
  if (!site || !permissions.some((permission) => may(context, permission, { companyId: site.companyId, siteId: site.id }))) throw new NotFoundError('Site not found.')
  return site
}

/** The site's ATTENDANCE gate in force, or the refusal in words (before any person's data is read). */
export const requireAttendance = (db: Client, siteId: string) => requireLegalGate(db, siteId, 'ATTENDANCE')

/** The person, if the caller holds the permission over the place (their site, or the day's site); else 404. */
export async function personFor(db: Client, context: OfficeContext, employeeId: string, permission: Permission, siteId?: string): Promise<PersonRow> {
  const person = isUuid(employeeId) ? await personOf(db, employeeId) : null
  if (!person || !may(context, permission, { companyId: person.companyId, siteId: siteId ?? person.siteId })) throw new NotFoundError('Person not found.')
  return person
}

/** The caller's own employee record (null: they have none). */
export async function ownEmployeeId(db: Client, context: OfficeContext): Promise<string | null> {
  return (await db.employee.findFirst({ where: { userId: context.actorId }, select: { id: true } }))?.id ?? null
}

export const OWN_DAY_WORDS = 'Nobody decides about their own attendance: another person approves or fixes it (D.Lgs. 152/1997 art. 1-bis).'

/** Refuses a decision about the caller's own day. */
export async function refuseOwnDay(db: Client, context: OfficeContext, employeeId: string): Promise<void> {
  if ((await ownEmployeeId(db, context)) === employeeId) refuse('OWN_DAY', OWN_DAY_WORDS)
}

/** A range of days (default: the current month in the site's zone), at most ATTENDANCE_RULES.rangeDays long. */
export function rangeOf(query: { readonly from?: string | undefined; readonly to?: string | undefined }, timeZone: string, now: Date = serverClock.now()): { from: BusinessDate; to: BusinessDate; today: BusinessDate } {
  const today = businessDate(now, timeZone)
  const from = query.from ?? `${today.slice(0, 7)}-01`
  const to = query.to ?? today
  if (to < from) throw new ValidationError('The range ends before it starts.', [{ path: 'querystring/to', message: 'On or after the start.' }])
  if (daysFrom(from, to) + 1 > ATTENDANCE_RULES.rangeDays) throw new ValidationError(`A range covers at most ${ATTENDANCE_RULES.rangeDays} days.`, [{ path: 'querystring/to', message: `At most ${ATTENDANCE_RULES.rangeDays} days after the start.` }])
  return { from, to, today }
}

export function officeCaller(caller: CommandCaller): OfficeContext {
  return officeOf(caller)
}
