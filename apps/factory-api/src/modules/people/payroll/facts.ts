import { blockingLeft, payrollChecks, type CheckFacts, type PayrollCheck } from '@nexus/factory-domain/people/payroll/checks'
import { HOUR_CODES, mappingKey, type HourCode, type PayrollCodeKind } from '@nexus/factory-domain/people/payroll/codes'
import { layoutConfirmed, overflowingValues, parseDefinition, printsProviderCode, type FileContext } from '@nexus/factory-domain/people/payroll/layouts'
import { carriesPay, earningFacts, flatValues, personValues, type MappedCode, type PayrollValue, type PersonFacts, type PersonValues } from '@nexus/factory-domain/people/payroll/values'
import { paysOn } from '@nexus/factory-domain/people/earnings/rules'
import { eachDay } from '@nexus/factory-domain/calendars/dates'
import { dateOf, dayOf } from '../employees/access'
import type { Client } from '../attendance/store'
import { closeOfMonth, codesById, gatesOf, lineDaysLeft, monthDays, monthFactsOf, type CloseRow, type Gates, type Place } from '../close/store'
import { PayFacts, periodOfMonth, type PeriodRecord } from '../earnings/store'
import { contextOfFile, periodDaysOf, type LayoutRow } from './store'

/**
 * What a payroll export carries (B-W2b-54; MES-267, MES-272): one reader of the month's figures. Hours come from close/store's
 * `monthDays`, the `effective` figures (each closed one replaced by its latest correction), never
 * AttendanceDay.overtimeMinutes. Earnings come from the month's pay period (the ledger, reversals included), read only once
 * the period is what it will be: the check PAY_PERIOD_LOCKED stops a file with a period still moving. The person is read
 * here only, behind the caller's gate; what leaves is by employee code.
 */

export interface MonthPeople {
  readonly rows: readonly PersonValues[]
  readonly values: readonly PayrollValue[]
  readonly leftOut: readonly string[]
  readonly noCode: readonly string[]
  readonly leavers: readonly string[]
  readonly notOnFile: readonly string[]
  /** The corrections of closed days the figures stand on. */
  readonly corrections: readonly string[]
  readonly period: PeriodRecord | null
  readonly piecePayOn: boolean
}

const noHours = (): Record<HourCode, number> => Object.fromEntries(HOUR_CODES.map((code) => [code, 0])) as Record<HourCode, number>

const mappingOf = async (db: Client, companyId: string): Promise<Map<string, MappedCode>> => {
  const rows = await db.payrollCodeMapping.findMany({ where: { companyId, status: 'ACTIVE' }, select: { kind: true, ourCode: true, meaning: true, providerCode: true } })
  return new Map(rows.map((row) => [mappingKey(row.kind as PayrollCodeKind, row.ourCode), { providerCode: row.providerCode, meaning: row.meaning }]))
}

/** Piece pay reaches the month: a site's switch window touches it. */
async function pieceWindow(db: Client, place: Place, days: { readonly from: string; readonly to: string }, now: Date): Promise<boolean> {
  const facts = new PayFacts(db, now)
  const dates = eachDay(days.from, days.to)
  for (const site of place.sites) {
    const { windows } = await facts.site(site.id)
    if (dates.some((day) => paysOn(windows, day))) return true
  }
  return false
}

/** The month's people and what the file says of each. One query after another: the client may be a command's transaction. */
export async function monthPeople(db: Client, place: Place, month: string, now: Date): Promise<MonthPeople> {
  const days = periodDaysOf(month)
  const companyId = place.company.id
  const dayRows = await monthDays(db, { companyId, ...days })
  const period = await periodOfMonth(db, companyId, month)
  const ledger = period ? await db.earningsEntry.groupBy({ by: ['employeeId', 'kind', 'correctsPeriodId', 'currency'], where: { payPeriodId: period.id }, _sum: { amount: true, pieces: true, minutes: true } }) : []
  const piecePayOn = ledger.length > 0 || (await pieceWindow(db, place, days, now))
  const ids = [...new Set([...dayRows.map((day) => day.employeeId), ...ledger.map((row) => row.employeeId)])]
  const people = ids.length === 0 ? [] : await db.employee.findMany({ where: { id: { in: ids } }, select: { id: true, employeeCode: true, kind: true, endDate: true } })
  const cases = ids.length === 0 ? [] : await db.leaverCase.findMany({ where: { employeeId: { in: ids }, status: 'OPEN', lastWorkingDay: { lte: dateOf(days.to) } }, select: { employeeId: true, lastWorkingDay: true } })
  const lastOf = new Map(cases.map((row) => [row.employeeId, dayOf(row.lastWorkingDay)]))
  const codes = await codesById(db, dayRows.flatMap((day) => [...day.effective.absences.keys()]))
  const mapping = await mappingOf(db, companyId)
  const facts: PersonFacts[] = people.map((person) => {
    const hours = noHours()
    const absences = new Map<string, number>()
    for (const day of dayRows) {
      if (day.employeeId !== person.id) continue
      const cells = day.effective
      hours.ORD += cells.ordinary
      hours.OT_DAY += cells.overtimeDay
      hours.OT_NIGHT += cells.overtimeNight
      hours.OT_HOLIDAY += cells.overtimeHoliday
      hours.NIGHT += cells.night
      hours.HOLIDAY += cells.holiday
      for (const [codeId, minutes] of cells.absences) {
        const code = codes.get(codeId)?.code ?? codeId
        absences.set(code, (absences.get(code) ?? 0) + minutes)
      }
    }
    const ended = person.endDate && dayOf(person.endDate) >= days.from && dayOf(person.endDate) <= days.to ? dayOf(person.endDate) : null
    const earnings = earningFacts(ledger.filter((row) => row.employeeId === person.id).map((row) => ({ kind: row.kind, correctsPeriodId: row.correctsPeriodId, currency: row.currency, amount: row._sum.amount ?? 0, pieces: row._sum.pieces, minutes: row._sum.minutes?.toString() ?? null })))
    return { employeeId: person.id, employeeCode: person.employeeCode, kind: person.kind, lastDay: lastOf.get(person.id) ?? ended, hours, absences, earnings }
  })
  const labels = new Map([...codes.values()].map((row) => [row.code, row]))
  const rows = personValues(facts, mapping, (code) => {
    const words = labels.get(code)?.labelI18n as { en?: string; it?: string } | undefined
    return words?.it ?? words?.en ?? code
  })
  const notOnFile = await db.employee.findMany({ where: { companyId, kind: 'EMPLOYEE', status: 'ACTIVE', startDate: { lte: dateOf(days.to) }, OR: [{ endDate: null }, { endDate: { gte: dateOf(days.from) } }], id: { notIn: rows.map((row) => row.employeeId) } }, select: { id: true } })
  return {
    rows,
    values: flatValues(rows),
    leftOut: facts.filter((person) => person.kind !== 'EMPLOYEE').map((person) => person.employeeId),
    noCode: rows.filter((row) => row.employeeCode === null).map((row) => row.employeeId),
    leavers: rows.filter((row) => row.lastDay !== null).map((row) => row.employeeId),
    notOnFile: notOnFile.map((row) => row.id),
    corrections: dayRows.flatMap((day) => day.corrections.map((entry) => entry.id)).sort(),
    period,
    piecePayOn,
  }
}

export interface MonthChecks {
  readonly close: CloseRow | null
  readonly gates: Gates
  readonly people: MonthPeople
  readonly checks: readonly PayrollCheck[]
  readonly blocking: readonly PayrollCheck[]
  readonly carriesPay: boolean
  readonly context: FileContext
}

/** Line days nobody closed (read before a command: a month of scans for an open month). */
export const lineDaysOf = (db: Client, place: Place, month: string): Promise<number> => lineDaysLeft(db, place, periodDaysOf(month))

const unmappedCodes = (values: readonly PayrollValue[]): number => new Set(values.filter((value) => value.providerCode === null).map((value) => `${value.kind}|${value.code}`)).size

/** The month's checks for this layout (none chosen: as for one that prints the provider's code). */
export async function monthChecks(db: Client, place: Place, month: string, input: { readonly layout: LayoutRow | null; readonly lineDaysOpen: number; readonly now: Date; readonly revision: number }): Promise<MonthChecks> {
  const gates = await gatesOf(db, place)
  const close = await closeOfMonth(db, place.company.id, month)
  const closed = close?.status === 'CLOSED'
  const facts = await monthFactsOf(db, place, month, { gates, closed, lineDaysOpen: input.lineDaysOpen, now: input.now })
  const people = await monthPeople(db, place, month, input.now)
  const context = contextOfFile(place, month, input.revision)
  const definition = input.layout ? parseDefinition(input.layout.definition) : null
  const asked: CheckFacts = {
    month,
    closed,
    noEmployeeCode: people.noCode.length,
    daysOpen: facts.daysOpen,
    anomaliesOpen: facts.anomaliesOpen,
    lineDaysOpen: facts.lineDaysOpen,
    piecePayOn: people.piecePayOn,
    payPeriodStatus: people.period?.status ?? null,
    unmapped: unmappedCodes(people.values),
    printsProviderCode: definition === null || printsProviderCode(definition),
    overflowing: input.layout && definition ? overflowingValues(definition, input.layout.format, people.values, context) : 0,
    leftOut: people.leftOut.length,
    leavers: people.leavers.length,
    notOnFile: people.notOnFile.length,
    layoutNotConfirmed: input.layout !== null && definition !== null && !layoutConfirmed({ provider: input.layout.provider, definition }),
  }
  const checks = payrollChecks(asked)
  return { close, gates, people, checks, blocking: blockingLeft(checks), carriesPay: carriesPay(people.values), context }
}
