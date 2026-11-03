import type { Prisma } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError, UnauthenticatedError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere, type Actor, type Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { QUALITY_CAPA_VIEW } from '@nexus/factory-domain/quality/capa/permissions'
import { QUALITY_INSPECTIONS_VIEW } from '@nexus/factory-domain/quality/final/permissions'
import { QUALITY_HOLDS_VIEW } from '@nexus/factory-domain/quality/holds/permissions'
import { QUALITY_INCOMING_VIEW } from '@nexus/factory-domain/quality/incoming/permissions'
import { QUALITY_INPROCESS_VIEW } from '@nexus/factory-domain/quality/inprocess/permissions'
import { QUALITY_LOTS_VIEW } from '@nexus/factory-domain/quality/lab/permissions'
import { QUALITY_NCR_VIEW } from '@nexus/factory-domain/quality/ncr/permissions'
import { QUALITY_REPORTS_VIEW } from '@nexus/factory-domain/quality/reports/permissions'
import { periodOf, periodProblems, spanOf, type Period, type Sight } from '@nexus/factory-domain/quality/reports/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { minimumGroupSizeFor } from '../../people/privacy/groups'
import type { Reader, Span } from './facts'

/**
 * Who reads a quality report and of what (B-W2b-138). The office caller needs quality.reports.view at the site (else the site
 * is not found); each figure also needs the view permission of the records it is counted from at that site (`sightOf`): a
 * figure the caller may not see is null and its sight false, so every role sees the report of what it may see (QHS-147).
 */

export interface ReportSite {
  readonly id: string
  readonly companyId: string
  readonly code: string
  readonly name: string
  readonly timezone: string
}

const SITE_SELECT = { id: true, companyId: true, code: true, name: true, timezone: true } as const satisfies Prisma.SiteSelect

export function officeOf(caller: Pick<CommandCaller, 'factoryContext'>): OfficeContext {
  const context = caller.factoryContext
  if (!context) throw new UnauthenticatedError()
  if (context.audience !== 'office') throw new ForbiddenError()
  return context
}

/** The permission each kind of record is seen with. */
export const SIGHT_PERMISSIONS: Readonly<Record<Sight, Permission>> = Object.freeze({
  inprocess: QUALITY_INPROCESS_VIEW,
  inspections: QUALITY_INSPECTIONS_VIEW,
  ncr: QUALITY_NCR_VIEW,
  capa: QUALITY_CAPA_VIEW,
  holds: QUALITY_HOLDS_VIEW,
  incoming: QUALITY_INCOMING_VIEW,
  lots: QUALITY_LOTS_VIEW,
})

export type SightMap = Readonly<Record<Sight, boolean>>

/** What the caller may see at the site (CAPA is company-wide: at the site's company, customer by customer later). */
export function sightOf(actor: Actor, site: Pick<ReportSite, 'id' | 'companyId'>): SightMap {
  const at = { companyId: site.companyId, siteId: site.id }
  return {
    inprocess: can(actor, QUALITY_INPROCESS_VIEW, at),
    inspections: can(actor, QUALITY_INSPECTIONS_VIEW, at),
    ncr: can(actor, QUALITY_NCR_VIEW, at),
    capa: can(actor, QUALITY_CAPA_VIEW, { companyId: site.companyId }),
    holds: can(actor, QUALITY_HOLDS_VIEW, at),
    incoming: can(actor, QUALITY_INCOMING_VIEW, at),
    lots: can(actor, QUALITY_LOTS_VIEW, at),
  }
}

export interface Place {
  readonly context: OfficeContext
  readonly actor: Actor
  readonly site: ReportSite
  readonly sites: readonly { readonly id: string; readonly code: string; readonly name: string }[]
  readonly period: Period
  readonly span: Span
  readonly today: BusinessDate
  readonly now: Date
  readonly minimum: number
  readonly sight: SightMap
}

/**
 * The site and period of a read: the site asked (of the screen's company, read with quality.reports.view, else not found) or
 * the first such site by code; the period asked or the 30 days up to today at the site (400 in words otherwise); the
 * company's minimum group; what the caller may see there.
 */
export async function placeOf(db: Reader, caller: CommandCaller, query: { readonly siteId?: string | undefined; readonly from?: string | undefined; readonly to?: string | undefined }): Promise<Place> {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const scope = scopeWhere(actor, QUALITY_REPORTS_VIEW, { company: 'companyId', site: 'id' }) as Prisma.SiteWhereInput
  const sites = await db.site.findMany({ where: context.companyId ? { AND: [scope, { companyId: context.companyId }] } : scope, select: SITE_SELECT, orderBy: [{ code: 'asc' }, { id: 'asc' }] })
  let site: ReportSite | undefined
  if (query.siteId) {
    const found = isUuid(query.siteId) ? await db.site.findUnique({ where: { id: query.siteId }, select: SITE_SELECT }) : null
    if (!found || (context.companyId && found.companyId !== context.companyId) || !can(actor, QUALITY_REPORTS_VIEW, { companyId: found.companyId, siteId: found.id })) throw new NotFoundError('Site not found.')
    site = found
  } else {
    site = sites[0]
    if (!site) throw new NotFoundError('No site of this company has quality reports you may read.')
  }
  const now = serverClock.now()
  const today = businessDate(now, site.timezone)
  const period = periodOf(query, today)
  const problems = periodProblems(period, today)
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  return {
    context,
    actor,
    site,
    sites: sites.map((row) => ({ id: row.id, code: row.code, name: row.name })),
    period,
    span: spanOf(period, site.timezone),
    today,
    now,
    minimum: await minimumGroupSizeFor(db, site.companyId),
    sight: sightOf(actor, site),
  }
}

/** The answer's head: the site, the caller's sites, the period, today, as of, the minimum group. */
export function headOf(place: Place) {
  return {
    site: { id: place.site.id, code: place.site.code, name: place.site.name, timeZone: place.site.timezone },
    sites: place.sites.map((row) => ({ ...row })),
    from: place.period.from,
    to: place.period.to,
    today: place.today,
    asOf: toUtcIso(place.now),
    minimumGroupSize: place.minimum,
  }
}

/** The moment a stock-like figure (NCRs open, old holds) is read at: the period's end, or now when that is still to come. */
export const momentOf = (span: Span, now: Date): Date => (span.end.getTime() <= now.getTime() ? new Date(span.end.getTime() - 1) : now)
