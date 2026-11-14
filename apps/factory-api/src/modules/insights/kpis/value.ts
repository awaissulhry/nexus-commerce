import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import { holds, type Actor } from '@nexus/factory-domain/core/permissions'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { applyCalc, measuresOfCalc } from '@nexus/factory-domain/insights/kpis/calc'
import { grainOfKpi, grainsOfKpi, permissionsOfKpi, type KpiFile } from '@nexus/factory-domain/insights/kpis/catalogue'
import { periodsBack, type Period, type PeriodKind } from '@nexus/factory-domain/insights/periods/periods'
import { markMoney } from '@nexus/factory-domain/money/marked'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { isStale, readMeasures, type Bucket, type MeasureProblem, type Place } from '../facts/reads'

/**
 * A KPI's value: the ONE calculation every reader uses (B-W2b-428; ANA-070 "dashboards, reports, alerts, the portal and the
 * API read one definition and one calculation"; design home.kpis › a KPI › Now). The KPI's calculation in code (factory-domain
 * insights/kpis/defs: applyCalc) over its measures' sums per period (facts/reads.ts: the facts in the person's scope, or their
 * own records live when their grant is limited to some customers). The KPI library, Today's key numbers and every later
 * dashboard, digest and alert read a KPI here and nowhere else.
 *
 * No value is ever a guess: a person without a measure's list or the KPI's money grain gets null with NO_ACCESS or
 * NEEDS_GRAIN; a period never rebuilt NOT_BUILT; money that cannot be counted in one currency MIXED_CURRENCIES; a KPI the
 * database knows but the code has no calculation for NO_CALCULATION.
 */

export const KPI_PROBLEMS = ['NO_CALCULATION', 'NO_ACCESS', 'NEEDS_GRAIN', 'NOT_BUILT', 'MIXED_CURRENCIES'] as const
export type KpiProblem = (typeof KPI_PROBLEMS)[number]

export interface KpiReading {
  /** Per bucket, a decimal string (`17`, minor units `1250000`, a percent `93.5`), or null. */
  readonly values: (string | null)[]
  readonly currency: string | null
  readonly converted: string[]
  readonly asOf: Date | null
  readonly stale: boolean
  readonly live: boolean
  readonly missingDays: number
  readonly problem: KpiProblem | null
}

const ORDER: readonly MeasureProblem[] = ['NO_ACCESS', 'NEEDS_GRAIN', 'NOT_BUILT', 'MIXED_CURRENCIES']

/** The KPI's value over buckets of days at a place, as one person. */
export async function kpiReading(caller: CommandCaller, actor: Actor, file: KpiFile, buckets: readonly Bucket[], place: Place = {}): Promise<KpiReading> {
  const none = (problem: KpiProblem): KpiReading => ({ values: buckets.map(() => null), currency: null, converted: [], asOf: null, stale: false, live: false, missingDays: 0, problem })
  if (!permissionsOfKpi(file).every((permission) => holds(actor, permission))) return none('NO_ACCESS')
  const grains = heldGrains(actor)
  if (!grainsOfKpi(file).every((grain) => grains.has(grain))) return none('NEEDS_GRAIN')
  const measures = measuresOfCalc(file.calc)
  const readings = await readMeasures(caller, actor, measures, buckets, place)
  const problems = measures.map((key) => readings.get(key)!.problem).filter((problem): problem is MeasureProblem => problem !== null)
  const values = buckets.map((_, index) => applyCalc(file.calc, new Map(measures.map((key) => [key, readings.get(key)!.values[index] ?? null]))))
  const first = readings.get(measures[0]!)!
  const stamps = measures.flatMap((key) => {
    const asOf = readings.get(key)!.asOf
    return asOf ? [asOf.getTime()] : []
  })
  const asOf = stamps.length > 0 ? new Date(Math.min(...stamps)) : null
  return {
    values,
    currency: file.unit === 'MONEY' ? first.currency : null,
    converted: [...new Set(measures.flatMap((key) => readings.get(key)!.converted))].sort(),
    asOf,
    stale: isStale(asOf),
    live: measures.some((key) => readings.get(key)!.live),
    missingDays: Math.max(...measures.map((key) => readings.get(key)!.missingDays)),
    problem: ORDER.find((problem) => problems.includes(problem)) ?? null,
  }
}

/** A KPI value for an answer: marked with the KPI's money grain (the grain filter drops it for anyone without it). */
export const markedValue = (file: KpiFile, value: string | null): unknown => (value === null ? null : file.grain ? markMoney(grainOfKpi(file.grain), value) : value)

export interface NowQuery {
  readonly period?: PeriodKind | undefined
  readonly periods?: number | undefined
  readonly day?: BusinessDate | undefined
  readonly companyId?: string | undefined
  readonly siteId?: string | undefined
  readonly lineId?: string | undefined
}

/** The fiscal year start a fiscal period is cut by: the named company's (a fiscal period needs one). */
async function fiscalStartOf(caller: CommandCaller, kind: PeriodKind, companyId: string | undefined): Promise<number> {
  if (kind !== 'FISCAL_QUARTER' && kind !== 'FISCAL_YEAR') return 1
  if (!companyId) throw new ValidationError('A fiscal period is a company’s: choose the company.', [{ path: 'querystring/companyId', message: 'Required with a fiscal period.' }])
  const company = await caller.withClient((db) => db.company.findUnique({ where: { id: companyId }, select: { fiscalYearStartMonth: true } }))
  return company?.fiscalYearStartMonth ?? 1
}

/** A KPI over its period and the ones before it (the library's "Now" with its trend): the last period is the current one. */
export async function kpiNow(caller: CommandCaller, actor: Actor, file: KpiFile, query: NowQuery): Promise<{ periods: Period[]; reading: KpiReading }> {
  const kind = query.period ?? file.period
  const anchor = query.day ?? businessDate(serverClock.now())
  const periods = periodsBack(kind, anchor, query.periods ?? 12, await fiscalStartOf(caller, kind, query.companyId))
  const reading = await kpiReading(caller, actor, file, periods, { companyId: query.companyId, siteId: query.siteId, lineId: query.lineId })
  return { periods, reading }
}
