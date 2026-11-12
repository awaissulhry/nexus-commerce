import type { Prisma } from '@nexus/factory-db'
import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere, type Actor } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import { INVENTORY_REPORTS_VIEW } from '@nexus/factory-domain/inventory/reports/permissions'
import { periodOf, periodProblems, spanOf, type Period } from '@nexus/factory-domain/inventory/reports/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import type { Reader } from '../../costing/actual/store'
import { officeContextOf } from '../ledger/access'

/**
 * Who reads a warehouse report and of what (B-W2b-356). The office caller needs inventory.reports.view over the screen's company
 * (else 403 in words); the figures are counted only at the sites of that company where the caller also holds
 * inventory.stock.view (`sites`; none: `sight.stock` false and no figure), and every value needs the cost grain (`sight.cost`;
 * the contract's money.cost fields are dropped for everyone else). A site asked must be one of the company's (else 404).
 */

export interface Ref {
  readonly id: string
  readonly code: string
  readonly name: string
}

export interface Place {
  readonly context: OfficeContext
  readonly actor: Actor
  readonly company: Ref | null
  readonly site: Ref | null
  /** The sites read: the company's (or the one asked) where the caller sees the stock. */
  readonly sites: readonly Ref[]
  readonly period: Period
  readonly span: { readonly start: Date; readonly end: Date }
  readonly today: BusinessDate
  readonly now: Date
  readonly sight: { readonly stock: boolean; readonly cost: boolean }
}

const SITE_SCOPE = { company: 'companyId', site: 'id' } as const

const companyRef = (row: { readonly id: string; readonly code: string; readonly legalName: string; readonly tradeName: string | null }): Ref => ({ id: row.id, code: row.code, name: row.tradeName ?? row.legalName })

/**
 * The company, site and period of a read: the screen's company (inventory.reports.view over it, else 403 in words), the site
 * asked (of that company, else 404), the period asked or this month so far (400 in words otherwise), the sites whose stock the
 * caller sees, and whether it sees values.
 */
export async function placeOf(db: Reader, caller: CommandCaller, query: { readonly siteId?: string | undefined; readonly from?: string | undefined; readonly to?: string | undefined }): Promise<Place> {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const companyId = context.companyId ?? null
  let company: Ref | null = null
  if (companyId) {
    if (!can(actor, INVENTORY_REPORTS_VIEW, { companyId })) throw new ForbiddenError('Warehouse reports of this company are not in your role.')
    const row = await db.company.findUnique({ where: { id: companyId }, select: { id: true, code: true, legalName: true, tradeName: true } })
    if (!row) throw new NotFoundError('Company not found.')
    company = companyRef(row)
  }
  let site: Ref | null = null
  if (query.siteId) {
    const row = isUuid(query.siteId) ? await db.site.findUnique({ where: { id: query.siteId }, select: { id: true, code: true, name: true, companyId: true } }) : null
    if (!row || (companyId && row.companyId !== companyId)) throw new NotFoundError('Site not found.')
    if (!can(actor, INVENTORY_REPORTS_VIEW, { companyId: row.companyId, siteId: row.id })) throw new ForbiddenError('Warehouse reports of this site are not in your role.')
    site = { id: row.id, code: row.code, name: row.name }
  }
  const now = new Date()
  const today = businessDate(now)
  const period = periodOf(query, today)
  const problems = periodProblems(period, today)
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  const sites = await db.site.findMany({
    where: {
      AND: [
        scopeWhere(actor, INVENTORY_STOCK_VIEW, SITE_SCOPE) as Prisma.SiteWhereInput,
        scopeWhere(actor, INVENTORY_REPORTS_VIEW, SITE_SCOPE) as Prisma.SiteWhereInput,
        companyId ? { companyId } : {},
        site ? { id: site.id } : {},
      ],
    },
    select: { id: true, code: true, name: true },
    orderBy: [{ code: 'asc' }, { id: 'asc' }],
  })
  return {
    context,
    actor,
    company,
    site,
    sites,
    period,
    span: spanOf(period),
    today,
    now,
    sight: { stock: sites.length > 0, cost: heldGrains(actor).has('cost') },
  }
}

/** The answer's head: the company, the site, the sites read, the period, today, as of. */
export function headOf(place: Place) {
  return { company: place.company, site: place.site, sites: place.sites.map((row) => ({ id: row.id, code: row.code, name: row.name })), from: place.period.from, to: place.period.to, today: place.today, asOf: toUtcIso(place.now) }
}
