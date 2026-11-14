import type { Prisma } from '@nexus/factory-db'
import { workingTimeOf } from '@nexus/factory-domain/calendars/working-time'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import type { CalcListQuery, CalcRecordView, CalcView, PrefillQuery, PrefillView } from '@nexus/factory-domain/costing/cost-per-minute/contracts'
import { availableMinutesOf, CPM_REFUSAL_WORDS, MAX_CALC_MONTHS, MINUTES_FROM_WORDS, monthsProblems, NO_SEATS, OVERHEAD_TWICE } from '@nexus/factory-domain/costing/cost-per-minute/rules'
import { costingCurrency } from '@nexus/factory-domain/costing/inputs'
import { OVERHEAD_UNVERIFIED } from '@nexus/factory-domain/costing/overhead-rules/rules'
import { COSTING_VIEW } from '@nexus/factory-domain/costing/permissions'
import { asMoney } from '@nexus/factory-domain/money/marked'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { ownerKey, workingCalendarsFor } from '../../../platform/calendars/service'
import { contextOf } from '../../product/materials/store'
import { dayOf } from '../inputs'
import { rateViewIn } from '../rates'
import { assertCompany, CALC_COLUMNS, CALC_SCOPE, calcViewOf, centresOf, dateOf, perMinuteRulesOf, readCalc, warningsOf, type CalcRow, type Reader } from './store'

/**
 * The cost-per-minute calculator's reads (B-W2b-419; FIN-005; design finance.settings › Costing): the calculations, one with
 * the labour rate it became, and the prefill — a department's (or one work centre's) available minutes for a period from THE
 * calendars service (each work centre's chain: work centre → site → company) × its planned seats, and the per-minute overhead
 * rules in force. Read with costing.view; figures only with the cost grain. Never a headcount or a figure per person.
 */

const today = (): string => businessDate(serverClock.now())

/** The first day of each applied calculation's labour rate (one read). */
async function rateDaysOf(db: Reader, rows: readonly CalcRow[]): Promise<Map<string, string>> {
  const ids = rows.flatMap((row) => (row.labourRateId ? [row.labourRateId] : []))
  if (ids.length === 0) return new Map()
  const rates = await db.labourRate.findMany({ where: { id: { in: ids } }, select: { id: true, validFrom: true } })
  return new Map(rates.map((rate) => [rate.id, dayOf(rate.validFrom)]))
}

/** GET /costing/cost-per-minute: the calculations the caller sees, newest period first. */
export async function listCalcs(caller: CommandCaller, query: CalcListQuery): Promise<{ calcs: CalcView[]; nextCursor: string | null }> {
  const context = contextOf(caller)
  if (query.companyId !== undefined) await assertCompany(caller, query.companyId)
  return caller.withClient(async (db) => {
    const where: Prisma.CostPerMinuteCalcWhereInput = {
      AND: [
        scopeWhere(actorOf(context), COSTING_VIEW, CALC_SCOPE) as Prisma.CostPerMinuteCalcWhereInput,
        query.companyId ? { companyId: query.companyId } : {},
        query.workCentreKind ? { workCentreKind: query.workCentreKind } : {},
        query.workCentreId ? { workCentreId: query.workCentreId } : {},
        query.applied === undefined ? {} : query.applied === 'true' ? { appliedAt: { not: null } } : { appliedAt: null },
        query.to ? { periodStart: { lte: dateOf(query.to) } } : {},
        query.from ? { periodEnd: { gte: dateOf(query.from) } } : {},
      ],
    }
    const rows = await db.costPerMinuteCalc.findMany({
      where,
      select: CALC_COLUMNS,
      orderBy: [{ periodStart: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    })
    const page = rows.slice(0, query.limit)
    const days = await rateDaysOf(db, page)
    return { calcs: page.map((row) => calcViewOf(row, row.labourRateId ? (days.get(row.labourRateId) ?? null) : null)), nextCursor: rows.length > query.limit ? page[page.length - 1]!.id : null }
  })
}

/** One calculation as answered in a reader (a command's transaction or the caller's client). */
export async function calcRecordIn(db: Reader, row: CalcRow, on: string): Promise<CalcRecordView> {
  const labourRate = row.labourRateId ? await rateViewIn(db, row.labourRateId, on) : null
  return { ...calcViewOf(row, labourRate?.validFrom ?? null), labourRate, warnings: await warningsOf(db, row), unverified: OVERHEAD_UNVERIFIED }
}

/** GET /costing/cost-per-minute/:calcId */
export async function calcRecord(caller: CommandCaller, calcId: string): Promise<CalcRecordView> {
  const row = await readCalc(caller, calcId)
  return caller.withClient((db) => calcRecordIn(db, row, today()))
}

/**
 * GET /costing/cost-per-minute/prefill: the department's (or work centre's) available minutes for whole months — each
 * active work centre's working minutes in the period (its calendar chain, else the planning default week) × its planned
 * seats — with the basis to keep on the calculation (no seat count in it), and the per-minute overhead rules in force on the
 * first day. Words say where the minutes come from and what to look at (no seat, one seat, overhead counted twice).
 */
export async function prefill(caller: CommandCaller, query: PrefillQuery): Promise<PrefillView> {
  await assertCompany(caller, query.companyId)
  const problems = monthsProblems(query.periodStart, query.periodEnd, { maxMonths: MAX_CALC_MONTHS, prefix: 'querystring/' })
  if (problems.length > 0) throw new ValidationError('The period is not whole months.', problems)
  return caller.withClient(async (db) => {
    const company = await db.company.findUniqueOrThrow({ where: { id: query.companyId }, select: { currency: true } })
    const currency = costingCurrency(company.currency)
    const centres = await centresOf(db, query.companyId, query.workCentreKind, query.workCentreId ?? null)
    const window = { from: query.periodStart, to: query.periodEnd }
    const calendars = await workingCalendarsFor(db, centres.map((centre) => ({ scope: 'WORK_CENTRE' as const, id: centre.id })), window)
    const counted = centres.map((centre) => {
      const calendar = calendars.get(ownerKey({ scope: 'WORK_CENTRE', id: centre.id }))?.calendar
      const time = calendar ? workingTimeOf(calendar, window.from, window.to) : { days: [], workingDays: 0, minutes: 0 }
      const workingMinutes = time.minutes ?? 0
      return {
        centre,
        workingMinutes,
        view: {
          id: centre.id,
          siteId: centre.siteId,
          code: centre.code,
          name: centre.name,
          workingDays: time.workingDays,
          availableMinutes: availableMinutesOf([{ workingMinutes, seats: centre.seats }]),
          seatsFrom: centre.seatsFrom,
          calendarIds: [...new Set(time.days.flatMap((day) => (day.decidedBy ? [day.decidedBy.calendarId] : [])))].sort(),
        },
      }
    })
    const seats = centres.reduce((sum, centre) => sum + centre.seats, 0)
    const { rules, perMinute } = await perMinuteRulesOf(db, query.companyId, query.workCentreKind, query.periodStart, currency)
    const words = [MINUTES_FROM_WORDS, ...(seats === 0 ? [NO_SEATS] : []), ...(seats === 1 ? [CPM_REFUSAL_WORDS.ONE_SEAT] : []), ...(rules.length > 0 ? [OVERHEAD_TWICE] : [])]
    return {
      companyId: query.companyId,
      workCentreKind: query.workCentreKind,
      periodStart: query.periodStart,
      periodEnd: query.periodEnd,
      currency,
      availableMinutes: availableMinutesOf(counted.map(({ centre, workingMinutes }) => ({ workingMinutes, seats: centre.seats }))),
      workCentres: counted.map(({ view }) => view),
      minutesBasis: {
        source: 'CALENDARS',
        periodStart: query.periodStart,
        periodEnd: query.periodEnd,
        workCentres: counted.map(({ view }) => ({ id: view.id, code: view.code, workingDays: view.workingDays, availableMinutes: view.availableMinutes, capacityFrom: view.seatsFrom })),
      },
      overheadRules: rules.map((rule) => ({ id: rule.id, companyId: rule.companyId, basis: rule.basis, workCentreKind: rule.workCentreKind, value: asMoney('cost', rule.value), currency: rule.currency })),
      overheadPerMinuteFromRules: asMoney('cost', perMinute),
      words,
    }
  })
}

