import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { CalcView } from '@nexus/factory-domain/costing/cost-per-minute/contracts'
import { calcWords, CPM_REFUSAL_WORDS, OVERHEAD_TWICE, seatsOf } from '@nexus/factory-domain/costing/cost-per-minute/rules'
import { perMinuteOf, rulesInForce } from '@nexus/factory-domain/costing/overhead-rules/rules'
import { COSTING_RATES_MANAGE, COSTING_VIEW } from '@nexus/factory-domain/costing/permissions'
import { asMoney } from '@nexus/factory-domain/money/marked'
import type { WorkCentreKind } from '@nexus/factory-domain/product/routing/operations'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { actorOf, type RequestContext } from '../../../core/context'
import { contextOf, mayWrite } from '../../product/materials/store'
import { dayOf } from '../inputs'
import { activeRulesOf } from '../overhead-rules/overhead-rules'
import { refused } from './refusals'

/**
 * What the cost-per-minute calculator's reads and writes share (B-W2b-419; FIN-005): the columns, the view (figures marked
 * money.cost; minutes are not money), who may see and keep a calculation, the work centres a calculation covers with their
 * planned seats (Planning settings: capacity, else active stations; never who), and the warning when the rate carries
 * overhead that per-minute rules add on the cost sheet too.
 */

export const CALC_COLUMNS = {
  id: true,
  companyId: true,
  workCentreKind: true,
  siteId: true,
  workCentreId: true,
  key: true,
  periodStart: true,
  periodEnd: true,
  currency: true,
  directLabourCost: true,
  availableMinutes: true,
  indirectPerMinute: true,
  overheadPerMinute: true,
  costPerMinute: true,
  minutesBasis: true,
  note: true,
  labourRateId: true,
  appliedAt: true,
  appliedById: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  workCentre: { select: { id: true, siteId: true, code: true, name: true } },
} as const satisfies Prisma.CostPerMinuteCalcSelect
export type CalcRow = Prisma.CostPerMinuteCalcGetPayload<{ select: typeof CALC_COLUMNS }>
export type Reader = FactoryClient | CommandTx

export const text = (value: { toString(): string }): string => decimalText(value.toString())
export const dateOf = (day: string): Date => new Date(`${day}T00:00:00.000Z`)
export const CALC_SCOPE = { company: 'companyId', site: { field: 'siteId', nullable: true } } as const

/** A calculation as answered; `validFrom`: the first day of the rate it became (null: not applied, or not read). */
export function calcViewOf(row: CalcRow, validFrom: string | null): CalcView {
  return {
    id: row.id,
    companyId: row.companyId,
    workCentreKind: row.workCentreKind,
    workCentre: row.workCentre && { id: row.workCentre.id, siteId: row.workCentre.siteId, code: row.workCentre.code, name: row.workCentre.name },
    key: row.key,
    periodStart: dayOf(row.periodStart),
    periodEnd: dayOf(row.periodEnd),
    currency: row.currency,
    directLabourCost: asMoney('cost', text(row.directLabourCost)),
    availableMinutes: text(row.availableMinutes),
    indirectPerMinute: asMoney('cost', text(row.indirectPerMinute)),
    overheadPerMinute: asMoney('cost', text(row.overheadPerMinute)),
    costPerMinute: asMoney('cost', text(row.costPerMinute)),
    minutesBasis: (row.minutesBasis ?? null) as Record<string, unknown> | null,
    note: row.note,
    labourRateId: row.labourRateId,
    appliedAt: row.appliedAt ? toUtcIso(row.appliedAt) : null,
    appliedById: row.appliedById,
    words: calcWords(row.appliedAt !== null, validFrom),
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
    updatedAt: toUtcIso(row.updatedAt),
  }
}

/** The company exists and the caller may see its costs (else 404: the caller may not know it exists). */
export async function assertCompany(caller: CommandCaller, companyId: string): Promise<RequestContext> {
  const context = contextOf(caller)
  const row = isUuid(companyId) ? await caller.withClient((db) => db.company.findUnique({ where: { id: companyId }, select: { id: true } })) : null
  if (!row || !can(actorOf(context), COSTING_VIEW, { companyId })) throw new NotFoundError('Company not found.')
  return context
}

/** A calculation is kept with costing.rates.manage over its company: applying it writes the company's labour rate. */
export function assertMayManage(context: RequestContext, companyId: string): void {
  if (!mayWrite(actorOf(context), COSTING_RATES_MANAGE, companyId)) throw new ForbiddenError()
}

/** The calculation as the caller may see it (its company and, for one work centre, its site); else 404. */
export async function readCalc(caller: CommandCaller, calcId: string): Promise<CalcRow> {
  const context = contextOf(caller)
  const row = isUuid(calcId) ? await caller.withClient((db) => db.costPerMinuteCalc.findUnique({ where: { id: calcId }, select: CALC_COLUMNS })) : null
  if (!row || !can(actorOf(context), COSTING_VIEW, { companyId: row.companyId, ...(row.siteId ? { siteId: row.siteId } : {}) })) throw new NotFoundError('Cost-per-minute calculation not found.')
  return row
}

/** A work centre a calculation covers, with its planned seats (never who) and where they come from. */
export interface CoveredCentre {
  readonly id: string
  readonly siteId: string
  readonly code: string
  readonly name: string
  readonly seats: number
  readonly seatsFrom: 'CAPACITY' | 'STATIONS'
}

/**
 * The ACTIVE work centres of a company's department (or the one named, which must be one of them: else NOT_OF_KIND), with
 * their planned seats: the capacity's units (Planning settings), else the active stations (planning's own rule).
 */
export async function centresOf(db: Reader, companyId: string, kind: WorkCentreKind, workCentreId: string | null): Promise<CoveredCentre[]> {
  const rows = await db.workCentre.findMany({ where: { companyId, kind, status: 'ACTIVE', ...(workCentreId ? { id: workCentreId } : {}) }, select: { id: true, siteId: true, code: true, name: true }, orderBy: [{ code: 'asc' }, { id: 'asc' }] })
  if (workCentreId !== null && rows.length === 0) throw refused('NOT_OF_KIND', CPM_REFUSAL_WORDS.NOT_OF_KIND)
  const ids = rows.map((row) => row.id)
  const capacity = ids.length ? await db.workCentreCapacity.findMany({ where: { id: { in: ids } }, select: { id: true, units: true } }) : []
  const stations = ids.length ? await db.station.findMany({ where: { workCentreId: { in: ids }, status: 'ACTIVE' }, select: { workCentreId: true } }) : []
  const units = new Map(capacity.map((row) => [row.id, row.units]))
  return rows.map((row) => {
    const planned = units.get(row.id) ?? null
    return { ...row, seats: seatsOf(planned, stations.filter((station) => station.workCentreId === row.id).length), seatsFrom: planned !== null ? ('CAPACITY' as const) : ('STATIONS' as const) }
  })
}

/** The per-minute overhead rules in force for a company's department on a day (UNVERIFIED), and what they add a minute. */
export async function perMinuteRulesOf(db: Reader, companyId: string, kind: WorkCentreKind, on: string, currency: string) {
  const rules = rulesInForce(await activeRulesOf(db, companyId), companyId, kind, on).filter((rule) => rule.basis === 'PER_MINUTE')
  return { rules, perMinute: perMinuteOf(rules, currency) }
}

/** What to look at before applying: overhead in the rate while per-minute rules add it on the cost sheet too. */
export async function warningsOf(db: Reader, row: CalcRow): Promise<string[]> {
  if (!new Dec(text(row.overheadPerMinute)).gt(0)) return []
  const { rules } = await perMinuteRulesOf(db, row.companyId, row.workCentreKind, dayOf(row.periodStart), row.currency)
  return rules.length > 0 ? [OVERHEAD_TWICE] : []
}
