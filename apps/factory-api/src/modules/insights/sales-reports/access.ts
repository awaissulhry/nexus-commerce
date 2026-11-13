import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { can, grantsFor, scopeWhere, type Actor, type Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { SALES_REPORTS_VIEW } from '@nexus/factory-domain/insights/sales-reports/permissions'
import { periodOf, periodProblems, spanOf, type Period } from '@nexus/factory-domain/insights/sales-reports/rules'
import { QUOTES_VIEW } from '@nexus/factory-domain/sales/quotes/permissions'
import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import { SALES_RETURNS_VIEW } from '@nexus/factory-domain/sales/returns/permissions'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { officeContextOf } from '../viewer'

/**
 * Who reads a sales report and of what (B-W2b-348). The office caller needs sales.reports.view over the screen's company (else
 * 403 in words; Quote speed on Sales › Quotes needs quotes.view instead). The figures count only the records the caller also
 * reaches with their own view: orders with orders.view (company, customer), quotes with quotes.view (company, customer),
 * returns with sales.returns.view (company, site, customer) — none at all: that `sight` is false and the figure is null, said
 * on screen. Every amount needs the price grain (`sight.values`; the contract's money.price fields are dropped otherwise).
 */

export type Reader = FactoryClient | CommandTx

export interface Ref {
  readonly id: string
  readonly code: string
  readonly name: string
}

export type ReportPage = 'reports' | 'quotes'

export interface Place {
  readonly context: OfficeContext
  readonly actor: Actor
  readonly company: Ref | null
  /** The company's own currency (null: no company on screen). */
  readonly companyCurrency: string | null
  readonly period: Period
  readonly span: { readonly start: Date; readonly end: Date }
  readonly today: BusinessDate
  readonly now: Date
  readonly sight: { readonly orders: boolean; readonly quotes: boolean; readonly returns: boolean; readonly values: boolean }
  /** The records the figures count: the caller's (the record's view and the page's), of the company on screen. */
  readonly orders: Prisma.SalesOrderWhereInput
  readonly quotes: Prisma.QuoteWhereInput
  readonly returns: Prisma.ReturnAuthorisationWhereInput
}

const PARTY_SCOPE = { company: 'companyId', party: 'partyId' } as const
const RETURN_SCOPE = { company: 'companyId', site: 'siteId', party: 'partyId' } as const
const COMPANY_SCOPE = { company: 'companyId' } as const

export const partyRef = (row: { readonly id: string; readonly code: string; readonly legalName: string; readonly tradeName: string | null }): Ref => ({ id: row.id, code: row.code, name: row.tradeName ?? row.legalName })

/** The caller reaches some records of `permission` in the company (any grant over it, or every company). */
function reaches(actor: Actor, permission: Permission, companyId: string | null): boolean {
  return grantsFor(actor, permission).some((grant) => companyId === null || grant.companies === 'all' || grant.companies.includes(companyId))
}

/**
 * The company and period of a read: the screen's company (the page's permission over it, else 403 in words), the period asked
 * or this month so far (400 in words otherwise; `periodless` for the backlog, which is now), the records the caller reaches,
 * and whether it sees amounts.
 */
export async function placeOf(db: Reader, caller: CommandCaller, query: { readonly from?: string | undefined; readonly to?: string | undefined }, page: ReportPage = 'reports'): Promise<Place> {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const pagePermission = page === 'reports' ? SALES_REPORTS_VIEW : QUOTES_VIEW
  const companyId = context.companyId ?? null
  let company: Ref | null = null
  let companyCurrency: string | null = null
  if (companyId) {
    if (!can(actor, pagePermission, { companyId })) throw new ForbiddenError(page === 'reports' ? 'Sales reports of this company are not in your role.' : 'Quotes of this company are not in your role.')
    const row = await db.company.findUnique({ where: { id: companyId }, select: { id: true, code: true, legalName: true, tradeName: true, currency: true } })
    if (!row) throw new NotFoundError('Company not found.')
    company = { id: row.id, code: row.code, name: row.tradeName ?? row.legalName }
    companyCurrency = row.currency
  }
  const now = serverClock.now()
  const today = businessDate(now)
  const period = periodOf(query, today)
  const problems = periodProblems(period, today)
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  const own = companyId ? { companyId } : {}
  const pageScope = scopeWhere(actor, pagePermission, COMPANY_SCOPE)
  return {
    context,
    actor,
    company,
    companyCurrency,
    period,
    span: spanOf(period),
    today,
    now,
    sight: { orders: reaches(actor, ORDERS_VIEW, companyId), quotes: reaches(actor, QUOTES_VIEW, companyId), returns: reaches(actor, SALES_RETURNS_VIEW, companyId), values: heldGrains(actor).has('price') },
    orders: { AND: [scopeWhere(actor, ORDERS_VIEW, PARTY_SCOPE) as Prisma.SalesOrderWhereInput, pageScope as Prisma.SalesOrderWhereInput, own] },
    quotes: { AND: [scopeWhere(actor, QUOTES_VIEW, PARTY_SCOPE) as Prisma.QuoteWhereInput, pageScope as Prisma.QuoteWhereInput, own] },
    returns: { AND: [scopeWhere(actor, SALES_RETURNS_VIEW, RETURN_SCOPE) as Prisma.ReturnAuthorisationWhereInput, pageScope as Prisma.ReturnAuthorisationWhereInput, own] },
  }
}

/** The answer's head: the company, the period, today, as of. */
export function headOf(place: Place) {
  return { company: place.company, from: place.period.from, to: place.period.to, today: place.today, asOf: toUtcIso(place.now) }
}
