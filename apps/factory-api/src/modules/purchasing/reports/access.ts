import type { Prisma } from '@nexus/factory-db'
import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere, type Actor } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { PURCHASING_VIEW } from '@nexus/factory-domain/purchasing/permissions'
import { PURCHASING_REPORTS_VIEW } from '@nexus/factory-domain/purchasing/reports/permissions'
import { periodOf, periodProblems, spanOf, type Period } from '@nexus/factory-domain/purchasing/reports/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { officeContextOf, type Reader } from '../store'

/**
 * Who reads a purchasing report and of what (B-W2b-350). The office caller needs purchasing.reports.view over the screen's
 * company (else 403 in words); the figures count only the orders the caller also reaches with purchasing.view (the orders' own
 * view: company, delivery site and supplier; none at all: `sight.orders` false and no figure), and every amount needs the cost
 * grain (`sight.values`; the contract's money.cost fields are dropped for everyone else). A site asked must be one of the
 * company's (else 404).
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
  /** The company's own currency (the spend is said in it). */
  readonly companyCurrency: string | null
  readonly site: Ref | null
  readonly period: Period
  readonly span: { readonly start: Date; readonly end: Date }
  readonly today: BusinessDate
  readonly now: Date
  readonly sight: { readonly orders: boolean; readonly values: boolean }
  /** The orders the figures count: the caller's (both permissions), of the company and the site asked. */
  readonly orders: Prisma.PurchaseOrderWhereInput
}

const ORDER_SCOPE = { company: 'companyId', site: 'siteId', party: 'partyId' } as const
const REPORT_SCOPE = { company: 'companyId', site: 'siteId' } as const

export const companyRef = (row: { readonly id: string; readonly code: string; readonly legalName: string; readonly tradeName: string | null }): Ref => ({ id: row.id, code: row.code, name: row.tradeName ?? row.legalName })

/**
 * The company, site and period of a read: the screen's company (purchasing.reports.view over it, else 403 in words), the site
 * asked (of that company, else 404), the period asked or this month so far (400 in words otherwise), the orders the caller
 * reaches, and whether it sees amounts.
 */
export async function placeOf(db: Reader, caller: CommandCaller, query: { readonly siteId?: string | undefined; readonly from?: string | undefined; readonly to?: string | undefined }): Promise<Place> {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const companyId = context.companyId ?? null
  let company: Ref | null = null
  let companyCurrency: string | null = null
  if (companyId) {
    if (!can(actor, PURCHASING_REPORTS_VIEW, { companyId })) throw new ForbiddenError('Purchasing reports of this company are not in your role.')
    const row = await db.company.findUnique({ where: { id: companyId }, select: { id: true, code: true, legalName: true, tradeName: true, currency: true } })
    if (!row) throw new NotFoundError('Company not found.')
    company = companyRef(row)
    companyCurrency = row.currency
  }
  let site: Ref | null = null
  if (query.siteId) {
    const row = isUuid(query.siteId) ? await db.site.findUnique({ where: { id: query.siteId }, select: { id: true, code: true, name: true, companyId: true } }) : null
    if (!row || (companyId && row.companyId !== companyId)) throw new NotFoundError('Site not found.')
    if (!can(actor, PURCHASING_REPORTS_VIEW, { companyId: row.companyId, siteId: row.id })) throw new ForbiddenError('Purchasing reports of this site are not in your role.')
    site = { id: row.id, code: row.code, name: row.name }
  }
  const now = serverClock.now()
  const today = businessDate(now)
  const period = periodOf(query, today)
  const problems = periodProblems(period, today)
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  const orders: Prisma.PurchaseOrderWhereInput = {
    AND: [
      scopeWhere(actor, PURCHASING_VIEW, ORDER_SCOPE) as Prisma.PurchaseOrderWhereInput,
      scopeWhere(actor, PURCHASING_REPORTS_VIEW, REPORT_SCOPE) as Prisma.PurchaseOrderWhereInput,
      companyId ? { companyId } : {},
      site ? { siteId: site.id } : {},
    ],
  }
  // The orders' own view somewhere in the company (or at the site asked): else no figure at all, said in words.
  const sites = await db.site.findMany({ where: { ...(companyId ? { companyId } : {}), ...(site ? { id: site.id } : {}) }, select: { id: true, companyId: true } })
  const seesOrders = sites.some((row) => can(actor, PURCHASING_VIEW, { companyId: row.companyId, siteId: row.id }))
  return {
    context,
    actor,
    company,
    companyCurrency,
    site,
    period,
    span: spanOf(period),
    today,
    now,
    sight: { orders: seesOrders, values: heldGrains(actor).has('cost') },
    orders,
  }
}

/** The answer's head: the company, the site, the period, today, as of. */
export function headOf(place: Place) {
  return { company: place.company, site: place.site, from: place.period.from, to: place.period.to, today: place.today, asOf: toUtcIso(place.now) }
}
