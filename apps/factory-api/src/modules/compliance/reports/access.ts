import { CERTIFICATES_VIEW } from '@nexus/factory-domain/compliance/certificates/permissions'
import { REGISTER_VIEW } from '@nexus/factory-domain/compliance/register/permissions'
import { COMPLIANCE_REPORTS_VIEW } from '@nexus/factory-domain/compliance/reports/permissions'
import { periodOf, periodProblems, spanOf, type Period, type Sight } from '@nexus/factory-domain/compliance/reports/rules'
import { ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Actor, type Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { QUALITY_LOTS_VIEW } from '@nexus/factory-domain/quality/lab/permissions'
import { SHIPPING_VIEW } from '@nexus/factory-domain/shipping/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { officeOf, rulesClock, type Reader } from '../register-of-rules/common'

/**
 * Who reads a compliance report and of what (B-W2b-272). The office caller needs compliance.reports.view over the screen's
 * company (else 403 in words); each figure also needs the view permission of the records it is counted from over that company
 * (`sightOf`): a figure the caller may not see is null and its sight false, so every role sees the report of what it may see.
 * "Today" is the status board's clock (register-of-rules/common `rulesClock`), so the board's cells and the report's days agree.
 */

export interface Ref {
  readonly id: string
  readonly code: string
  readonly name: string
}

/** The permission each kind of record is seen with. */
export const SIGHT_PERMISSIONS: Readonly<Record<Sight, Permission>> = Object.freeze({
  certificates: CERTIFICATES_VIEW,
  register: REGISTER_VIEW,
  lots: QUALITY_LOTS_VIEW,
  shipments: SHIPPING_VIEW,
})

export type SightMap = Readonly<Record<Sight, boolean>>

/** What the caller may see in the company (every company the caller reaches when the screen names none). */
export function sightOf(actor: Actor, companyId: string | null): SightMap {
  const at = companyId ? { companyId } : {}
  return {
    certificates: can(actor, CERTIFICATES_VIEW, at),
    register: can(actor, REGISTER_VIEW, at),
    lots: can(actor, QUALITY_LOTS_VIEW, at),
    shipments: can(actor, SHIPPING_VIEW, at),
  }
}

export interface Place {
  readonly context: OfficeContext
  readonly actor: Actor
  readonly company: Ref | null
  readonly brand: Ref | null
  readonly period: Period
  readonly span: { readonly start: Date; readonly end: Date }
  readonly today: BusinessDate
  readonly now: Date
  readonly sight: SightMap
}

const partyName = (party: { readonly legalName: string; readonly tradeName: string | null }): string => party.tradeName ?? party.legalName

/** A party as a reference (code · trade name, else legal name). */
export const partyRef = (party: { readonly id: string; readonly code: string; readonly legalName: string; readonly tradeName: string | null }): Ref => ({ id: party.id, code: party.code, name: partyName(party) })

/**
 * The company, brand and period of a read: the screen's company (compliance.reports.view over it, else 403 in words), the brand
 * asked (a party, else 404), the period asked or the 365 days up to today (400 in words otherwise; `period` given: the annual
 * review's year is checked by its caller), what the caller may see.
 */
export async function placeOf(db: Reader, caller: CommandCaller, query: { readonly from?: string | undefined; readonly to?: string | undefined; readonly brandId?: string | undefined }): Promise<Place> {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const companyId = context.companyId ?? null
  let company: Ref | null = null
  if (companyId) {
    if (!can(actor, COMPLIANCE_REPORTS_VIEW, { companyId })) throw new ForbiddenError('Compliance reports of this company are not in your role.')
    const row = await db.company.findUnique({ where: { id: companyId }, select: { id: true, code: true, legalName: true, tradeName: true } })
    if (!row) throw new NotFoundError('Company not found.')
    company = partyRef(row)
  }
  let brand: Ref | null = null
  if (query.brandId) {
    const row = isUuid(query.brandId) ? await db.party.findUnique({ where: { id: query.brandId }, select: { id: true, code: true, legalName: true, tradeName: true } }) : null
    if (!row) throw new NotFoundError('Brand not found.')
    brand = partyRef(row)
  }
  const now = rulesClock().now()
  const today = businessDate(now)
  const period = periodOf(query, today)
  const problems = periodProblems(period, today)
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  return { context, actor, company, brand, period, span: spanOf(period), today, now, sight: sightOf(actor, companyId) }
}

/** The answer's head: the company, the brand, the period, today, as of. */
export function headOf(place: Place, period: Period = place.period) {
  return { company: place.company, brand: place.brand, from: period.from, to: period.to, today: place.today, asOf: toUtcIso(place.now) }
}

/** `companyId = the screen's company`, or also NULL (tenant-wide rows) when the column is nullable; nothing without a company. */
export function companyWhere(place: Pick<Place, 'company'>, nullable = false): Record<string, unknown> {
  if (!place.company) return {}
  return nullable ? { OR: [{ companyId: place.company.id }, { companyId: null }] } : { companyId: place.company.id }
}
