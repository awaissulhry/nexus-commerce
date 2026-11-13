import { plusDays } from '@nexus/factory-domain/calendars/dates'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import { businessDate, businessDayStart, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { PLANNING_REPORTS_VIEW } from '@nexus/factory-domain/planning/reports/permissions'
import { periodOf, periodProblems, type Period } from '@nexus/factory-domain/planning/reports/rules'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { siteFor } from '../access'
import type { Reader, SiteRow } from '../store'

/**
 * Who reads a planning report and of what (B-W2b-349): the office caller plans the site (planning.view over it, else 404 —
 * planning's own rule: a site it does not plan is not found) and holds planning.reports.view over it (else 403). The period is
 * in the site's days: the one asked or this month so far (the monthly planning review); 400 in words otherwise.
 */

export interface Place {
  readonly site: SiteRow
  readonly period: Period
  /** The period's instants in the site's time zone: from its first day's start to the end of its last (exclusive). */
  readonly span: { readonly start: Date; readonly end: Date }
  readonly today: BusinessDate
  readonly now: Date
}

export async function placeOf(caller: CommandCaller, query: { readonly siteId: string; readonly from?: string | undefined; readonly to?: string | undefined }, db?: Reader): Promise<Place> {
  const site = await siteFor(caller, query.siteId, PLANNING_REPORTS_VIEW, db)
  const now = serverClock.now()
  const today = businessDate(now, site.timezone)
  const period = periodOf(query, today)
  const problems = periodProblems(period, today)
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  return { site, period, span: { start: businessDayStart(period.from, site.timezone), end: businessDayStart(plusDays(period.to, 1), site.timezone) }, today, now }
}

/** The answer's head: the site, the period, today, as of. */
export function headOf(place: Place) {
  return {
    site: { id: place.site.id, companyId: place.site.companyId, code: place.site.code, name: place.site.name, timeZone: place.site.timezone },
    from: place.period.from,
    to: place.period.to,
    today: place.today,
    asOf: toUtcIso(place.now),
  }
}
