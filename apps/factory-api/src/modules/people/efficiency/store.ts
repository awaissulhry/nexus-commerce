import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { daysFrom } from '@nexus/factory-domain/calendars/dates'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { attendedShares, isTraineeDay, timedReportOf, type LineFact, type OperationSample, type TimedReport, type TraineeFacts } from '@nexus/factory-domain/people/efficiency/rules'
import { traineeOn } from '@nexus/factory-domain/people/skills/rules'
import { addDays, labourRecordsOf, type LabourRecord } from '@nexus/factory-domain/production/labour/rules'
import { minutesOf } from '@nexus/factory-domain/production/offstandard/rules'
import { SCAN_KINDS } from '@nexus/factory-domain/production/scans/rules'
import type { CommandTx } from '../../../core/command'
import { dayColumn, dayRange, employeesOfWorkers, isoDay, lineOf, lineSources, toLabourScan, type LineRow, type LineSources, type ScanRow } from '../../production/labour/store'
import { TIMING_COLUMNS, type TimingScanRow } from '../../production/terminal/store'

/**
 * Efficiency's reads (B-W2b-44). Every read names its columns and runs as the caller. Nothing here leaves the module with a
 * person in it: workers and employees are read to count the people behind a group, to leave trainees out and to split
 * attendance over lines; the answers hold figures per line and per operation, masked by the company's minimum group size.
 * Attendance days are read by the person (employeeId), never through a clock event: a day HR entered by hand (a MANUAL
 * event, no worker and no tablet) counts like any other.
 */

export type Reader = FactoryClient | CommandTx

const ROW = { ...TIMING_COLUMNS, approvedById: true } as const satisfies Prisma.OperationScanSelect
type WorkRow = Prisma.OperationScanGetPayload<{ select: typeof ROW }> & TimingScanRow & ScanRow

const COUNT_KINDS: readonly string[] = SCAN_KINDS
/** The rows that can name a team (OperationScanMember). */
const MEMBER_KINDS = new Set(['START', 'RESUME', 'PARTIAL', 'REPORT'])

const chunks = <T>(items: readonly T[], size = 300): T[][] => {
  const out: T[][] = []
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size))
  return out
}

export interface Place {
  readonly id: string
  readonly companyId: string
  readonly timezone: string
}

export interface DayRange {
  readonly from: BusinessDate
  readonly to: BusinessDate
}

/** The same number of days just before a range. */
export function previousRange(range: DayRange): DayRange {
  const to = addDays(range.from, -1)
  return { from: addDays(to, -daysFrom(range.from, range.to)), to }
}

export interface SiteLines {
  readonly lines: Map<string, LineRow>
  readonly sources: LineSources
}

export async function siteLines(db: Reader, place: Place): Promise<SiteLines> {
  const rows = await db.line.findMany({ where: { siteId: place.id }, select: { id: true, siteId: true, code: true, name: true }, orderBy: [{ code: 'asc' }, { id: 'asc' }] })
  return { lines: new Map(rows.map((row) => [row.id, row])), sources: await lineSources(db, rows.map((row) => row.id)) }
}

/** The planned efficiency of each line (LineCapacity), else the site's default (PlanningSettings): the chart's target line. */
export async function lineTargets(db: Reader, place: Place): Promise<{ readonly byLine: Map<string, string>; readonly site: string | null }> {
  const rows = await db.lineCapacity.findMany({ where: { siteId: place.id }, select: { lineId: true, plannedEfficiencyPct: true } })
  const settings = await db.planningSettings.findFirst({ where: { siteId: place.id }, select: { defaultEfficiencyPct: true } })
  return { byLine: new Map(rows.map((row) => [row.lineId, row.plannedEfficiencyPct.toString()])), site: settings ? settings.defaultEfficiencyPct.toString() : null }
}

// ---- the routing steps ----------------------------------------------------------------------------------------------------

/** One step of a style revision's routing: what the standard is set on, and what the review decides about. */
export interface RoutingStep {
  readonly id: string
  readonly styleId: string
  readonly revisionId: string
  readonly seq: number
  readonly operationId: string
  readonly code: string
  readonly name: string
  readonly standardMinutes: string
}

const STEP = { id: true, styleId: true, revisionId: true, seq: true, operationId: true, code: true, name: true, standardMinutes: true } as const satisfies Prisma.RoutingOperationSelect

const stepOf = (row: Prisma.RoutingOperationGetPayload<{ select: typeof STEP }>): RoutingStep => ({ ...row, standardMinutes: row.standardMinutes.toFixed(3) })

async function stepById(db: Reader, id: string): Promise<RoutingStep | null> {
  if (!isUuid(id)) return null
  const row = await db.routingOperation.findUnique({ where: { id }, select: STEP })
  return row ? stepOf(row) : null
}

export async function stepsById(db: Reader, ids: readonly string[]): Promise<Map<string, RoutingStep>> {
  const out = new Map<string, RoutingStep>()
  for (const part of chunks([...new Set(ids)])) for (const row of await db.routingOperation.findMany({ where: { id: { in: part } }, select: STEP })) out.set(row.id, stepOf(row))
  return out
}

export async function stylesById(db: Reader, ids: readonly string[]): Promise<Map<string, { id: string; companyId: string | null; code: string; name: string }>> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return new Map()
  return new Map((await db.style.findMany({ where: { id: { in: unique } }, select: { id: true, companyId: true, code: true, name: true } })).map((row) => [row.id, row]))
}

/** A routing step the site's company makes: its style is the company's, or tenant-wide. Else not found. */
export async function stepOfSite(db: Reader, place: Place, id: string): Promise<{ readonly step: RoutingStep; readonly styles: Awaited<ReturnType<typeof stylesById>> } | null> {
  const step = await stepById(db, id)
  if (!step) return null
  const styles = await stylesById(db, [step.styleId])
  const style = styles.get(step.styleId)
  return style && (style.companyId === null || style.companyId === place.companyId) ? { step, styles } : null
}

export const operationRefOf = (step: RoutingStep) => ({ id: step.operationId, code: step.code, name: step.name, seq: step.seq })

export function styleRefOf(styles: Awaited<ReturnType<typeof stylesById>>, step: RoutingStep) {
  const style = styles.get(step.styleId)
  return { id: step.styleId, code: style?.code ?? '', name: style?.name ?? '' }
}

/**
 * Work order operations → the routing step each one is, with the standard frozen on the work order, and every operation's
 * standard. B-W2b-82: an unplanned operation is no routing step, so it stays out of the per-step list, the cycle times and
 * the standard review (one-off work says nothing about a routing's standard); its standard still earns minutes on the line
 * and person figures: the work was paid and costed, the daily report's line efficiency counts it, and leaving it out would
 * make a line look slower for doing it.
 */
async function stepsOfOperations(db: Reader, ids: readonly string[]): Promise<{ readonly steps: Map<string, RoutingStep>; readonly standard: Map<string, string> }> {
  const steps = new Map<string, RoutingStep>()
  const standard = new Map<string, string>()
  for (const part of chunks([...new Set(ids)])) {
    const rows = await db.workOrderOperation.findMany({ where: { id: { in: part } }, select: { id: true, code: true, name: true, standardMinutes: true, routingOperation: { select: { id: true, styleId: true, revisionId: true, seq: true, operationId: true } } } })
    for (const row of rows) {
      standard.set(row.id, row.standardMinutes.toFixed(3))
      if (row.routingOperation) steps.set(row.id, { ...row.routingOperation, code: row.code, name: row.name, standardMinutes: row.standardMinutes.toFixed(3) })
    }
  }
  return { steps, standard }
}

// ---- the reports ------------------------------------------------------------------------------------------------------------

/** A standing report with where it was made, who made it (for the headcount) and the timing behind it. */
export interface WorkRecord {
  readonly record: LabourRecord
  readonly lineId: string | null
  /** Null: an unplanned operation (B-W2b-82). */
  readonly step: RoutingStep | null
  /** Who made the report: the worker (and the team it names), or the station. */
  readonly subjects: readonly string[]
  /** More than one person on the bundle at the operation: a team, or work handed on. Not one person's. */
  readonly team: boolean
  readonly timed: TimedReport | null
}

export interface WorkFilter {
  /** Only this routing step. */
  readonly step?: Pick<RoutingStep, 'revisionId' | 'seq'>
  /** Only these floor sign-ins. */
  readonly workerIds?: readonly string[]
}

export interface Work {
  readonly records: WorkRecord[]
  /** Floor sign-in → the employee behind it. */
  readonly employees: Map<string, string | null>
}

/**
 * The standing reports made at a site in a range, with their whole chains and timing. A report of work done outside (a
 * subcontract receipt) names nobody and earned nothing here, so it is left out; an undone report stands for nothing.
 */
export async function readWork(db: Reader, place: Place, sources: LineSources, range: DayRange, filter: WorkFilter = {}): Promise<Work> {
  const { start, end } = dayRange(range.from, range.to, place.timezone)
  const reports = await db.operationScan.findMany({
    where: {
      siteId: place.id,
      kind: 'REPORT',
      subcontractReceiptLineId: null,
      serverTime: { gte: start, lt: end },
      ...(filter.step ? { operation: { styleRevisionId: filter.step.revisionId, routingSeq: filter.step.seq } } : {}),
      ...(filter.workerIds ? { workerId: { in: [...filter.workerIds] } } : {}),
    },
    select: { id: true, bundleId: true },
  })
  if (reports.length === 0) return { records: [], employees: new Map() }
  const rows: WorkRow[] = []
  for (const part of chunks([...new Set(reports.map((row) => row.bundleId))])) rows.push(...((await db.operationScan.findMany({ where: { bundleId: { in: part } }, select: ROW })) as WorkRow[]))
  const { steps, standard } = await stepsOfOperations(db, rows.map((row) => row.workOrderOperationId))
  const wanted = new Set(reports.map((row) => row.id))
  const standing = labourRecordsOf(rows.filter((row) => COUNT_KINDS.includes(row.kind)).map(toLabourScan), standard, place.timezone).filter((record) => wanted.has(record.scanId) && record.state !== 'UNDONE')
  const members = new Map<string, string[]>()
  for (const part of chunks(rows.filter((row) => MEMBER_KINDS.has(row.kind)).map((row) => row.id))) {
    for (const row of await db.operationScanMember.findMany({ where: { scanId: { in: part } }, select: { scanId: true, workerId: true } })) members.set(row.scanId, [...(members.get(row.scanId) ?? []), row.workerId])
  }
  const perPair = new Map<string, WorkRow[]>()
  for (const row of rows) {
    const key = `${row.bundleId}|${row.workOrderOperationId}`
    perPair.set(key, [...(perPair.get(key) ?? []), row])
  }
  const records: WorkRecord[] = []
  for (const record of standing) {
    const step = steps.get(record.workOrderOperationId) ?? null
    const timed = timedReportOf(perPair.get(`${record.bundleId}|${record.workOrderOperationId}`) ?? [], members, record.scanId)
    const named = members.get(record.scanId) ?? []
    const own = record.workerId ? [`worker:${record.workerId}`] : record.stationId ? [`station:${record.stationId}`] : []
    const subjects = [...new Set([...own, ...named.map((worker) => `worker:${worker}`)])]
    records.push({ record, lineId: lineOf(sources, record), step, subjects, team: new Set([...subjects, ...(timed?.subjects ?? [])]).size > 1, timed })
  }
  const workers = [...new Set(records.flatMap((entry) => [...entry.subjects, ...(entry.timed?.subjects ?? [])]).filter((subject) => subject.startsWith('worker:')).map((subject) => subject.slice('worker:'.length)))]
  return { records, employees: await employeesOfWorkers(db, workers) }
}

const workerOf = (subject: string): string | null => (subject.startsWith('worker:') ? subject.slice('worker:'.length) : null)

/** The employees behind a list of subjects. */
function employeesIn(subjects: readonly string[], employees: ReadonlyMap<string, string | null>): string[] {
  return subjects.flatMap((subject) => {
    const worker = workerOf(subject)
    const employee = worker ? employees.get(worker) : null
    return employee ? [employee] : []
  })
}

// ---- trainees (MES-244) -----------------------------------------------------------------------------------------------------

export interface Trainees {
  /** Every trainee period of a person. */
  readonly levels: Map<string, TraineeFacts[]>
  /** The same, per person and library operation. */
  readonly onOperation: Map<string, TraineeFacts[]>
}

const dayOrNull = (value: Date | null): BusinessDate | null => (value ? isoDay(value) : null)

export async function traineesOf(db: Reader, employeeIds: readonly string[]): Promise<Trainees> {
  const levels = new Map<string, TraineeFacts[]>()
  const onOperation = new Map<string, TraineeFacts[]>()
  for (const part of chunks([...new Set(employeeIds)])) {
    const rows = await db.employeeSkill.findMany({ where: { employeeId: { in: part }, traineeUntil: { not: null }, removedAt: null }, select: { employeeId: true, since: true, traineeUntil: true, signedOffOn: true, skill: { select: { operationId: true } } } })
    for (const row of rows) {
      const facts: TraineeFacts = { since: isoDay(row.since), traineeUntil: dayOrNull(row.traineeUntil), signedOffOn: dayOrNull(row.signedOffOn) }
      levels.set(row.employeeId, [...(levels.get(row.employeeId) ?? []), facts])
      if (row.skill.operationId) {
        const key = `${row.employeeId}|${row.skill.operationId}`
        onOperation.set(key, [...(onOperation.get(key) ?? []), facts])
      }
    }
  }
  return { levels, onOperation }
}

export const onTraineeDay = (trainees: Trainees, employeeId: string, day: BusinessDate): boolean => isTraineeDay(trainees.levels.get(employeeId) ?? [], day)

// ---- line facts (MES-247, ANA-017) ------------------------------------------------------------------------------------------

export interface LineFacts {
  readonly facts: LineFact[]
  readonly traineeDays: number
  /** Some attendance day in the range is not approved yet: the attended minutes may still move. */
  readonly provisional: boolean
}

/** The facts behind the line figures of a range. `attendanceOpen` false: no attendance day is read at all. */
export async function lineFacts(db: Reader, place: Place, sources: LineSources, range: DayRange, now: Date, attendanceOpen: boolean, lineId?: string): Promise<LineFacts> {
  const work = await readWork(db, place, sources, range)
  const days = attendanceOpen
    ? await db.attendanceDay.findMany({
        where: { siteId: place.id, date: { gte: dayColumn(range.from), lte: dayColumn(range.to) }, OR: [{ presentMinutes: { gt: 0 } }, { plannedMinutes: { gt: 0 } }] },
        select: { employeeId: true, date: true, status: true, presentMinutes: true, plannedMinutes: true, firstInAt: true, lastOutAt: true },
      })
    : []
  const blocks = await db.offStandardEntry.findMany({
    where: { siteId: place.id, workDate: { gte: dayColumn(range.from), lte: dayColumn(range.to) }, status: { not: 'REJECTED' } },
    select: { lineId: true, employeeId: true, workDate: true, startedAt: true, endedAt: true },
  })
  const { start, end } = dayRange(range.from, range.to, place.timezone)
  const people = [...new Set([...days.map((day) => day.employeeId), ...blocks.flatMap((block) => (block.employeeId ? [block.employeeId] : [])), ...work.records.flatMap((entry) => employeesIn(entry.subjects, work.employees))])]
  const trainees = await traineesOf(db, people)
  const homes = new Map<string, string | null>()
  for (const part of chunks([...new Set(days.map((day) => day.employeeId))])) for (const row of await db.employee.findMany({ where: { id: { in: part } }, select: { id: true, siteId: true, homeLineId: true } })) homes.set(row.id, row.siteId === place.id ? row.homeLineId : null)
  const loans = attendanceOpen ? await db.lineLoan.findMany({ where: { siteId: place.id, startsAt: { lt: end }, endsAt: { gt: start } }, select: { employeeId: true, toLineId: true, startsAt: true, endsAt: true } }) : []
  const facts: LineFact[] = []
  let traineeDays = 0
  for (const day of days) {
    const date = isoDay(day.date)
    if (onTraineeDay(trainees, day.employeeId, date)) {
      traineeDays += 1
      continue
    }
    const shares = attendedShares({ presentMinutes: day.presentMinutes, plannedMinutes: day.plannedMinutes, firstInAt: day.firstInAt, lastOutAt: day.lastOutAt, homeLineId: homes.get(day.employeeId) ?? null, loans: loans.filter((loan) => loan.employeeId === day.employeeId) })
    for (const share of shares) facts.push({ kind: 'ATTENDED', lineId: share.lineId, day: date, employeeId: day.employeeId, minutes: share.minutes, plannedMinutes: share.plannedMinutes })
  }
  for (const entry of work.records) {
    const employees = employeesIn(entry.subjects, work.employees)
    if (employees.length > 0 && employees.every((employee) => onTraineeDay(trainees, employee, entry.record.workDate))) continue
    facts.push({ kind: 'EARNED', lineId: entry.lineId, day: entry.record.workDate, subjects: entry.subjects, earnedMinutes: entry.record.earnedMinutes })
  }
  for (const block of blocks) {
    const date = isoDay(block.workDate)
    if (block.employeeId && onTraineeDay(trainees, block.employeeId, date)) continue
    facts.push({ kind: 'OFF_STANDARD', lineId: block.lineId, day: date, minutes: minutesOf(block.startedAt, block.endedAt, now) })
  }
  return { facts: lineId ? facts.filter((fact) => fact.lineId === lineId) : facts, traineeDays, provisional: days.some((day) => day.status === 'OPEN' || day.status === 'NEEDS_FIX') }
}

// ---- operation samples (MES-250, ANA-016) -------------------------------------------------------------------------------------

export interface StepSamples {
  readonly step: RoutingStep
  readonly samples: OperationSample[]
}

export interface Samples {
  /** Per routing step. */
  readonly steps: Map<string, StepSamples>
  /** Reports left out, for the page's words: no timing, or a trainee on the bundle. */
  readonly untimedReports: number
  readonly traineeBundles: number
}

/** The timed bundles of a range per routing step: never by person. A bundle a trainee worked on at the operation is left out. */
export async function readSamples(db: Reader, place: Place, sources: LineSources, range: DayRange, filter: WorkFilter & { readonly lineId?: string | undefined; readonly styleId?: string | undefined } = {}): Promise<Samples> {
  const work = await readWork(db, place, sources, range, filter)
  // B-W2b-82: the per-step samples are the routing's (stepsOfOperations).
  const onSteps = work.records.flatMap((entry) => (entry.step ? [{ ...entry, step: entry.step }] : []))
  const chosen = onSteps.filter((entry) => (filter.lineId ? entry.lineId === filter.lineId : true) && (filter.styleId ? entry.step.styleId === filter.styleId : true))
  const timed = chosen.filter((entry) => entry.timed !== null)
  const trainees = await traineesOf(db, timed.flatMap((entry) => employeesIn([...entry.subjects, ...(entry.timed?.subjects ?? [])], work.employees)))
  const steps = new Map<string, StepSamples>()
  let traineeBundles = 0
  for (const entry of timed) {
    const span = entry.timed!
    const { counts, workDate, at } = entry.record
    const pieces = counts.good + counts.scrap + counts.rework
    if (pieces <= 0) continue
    const subjects = [...new Set([...entry.subjects, ...span.subjects])]
    const trainee = employeesIn(subjects, work.employees).some((employee) => (trainees.onOperation.get(`${employee}|${entry.step.operationId}`) ?? []).some((level) => traineeOn(level, workDate)))
    if (trainee) {
      traineeBundles += 1
      continue
    }
    const held = steps.get(entry.step.id) ?? { step: entry.step, samples: [] }
    held.samples.push({ at, day: workDate, pieces, seconds: span.seconds, personSeconds: span.personSeconds, pausedSeconds: span.pausedSeconds, elapsedSeconds: span.elapsedSeconds, subjects })
    steps.set(entry.step.id, held)
  }
  return { steps, untimedReports: chosen.length - timed.length, traineeBundles }
}

// ---- standard review decisions (audit rows: no table yet, a schema need of B-W2b-44) ----------------------------------------

export const DECIDE_ACTION = 'people.decideStandardReview'

export interface Decision {
  readonly id: string
  readonly routingOperationId: string
  readonly at: Date
  readonly actorId: string
  readonly reason: string | null
  readonly after: Prisma.JsonValue
}

/** The decisions of a site, oldest first; of one routing step when named. */
export async function decisionsOf(db: Reader, siteId: string, routingOperationId?: string): Promise<Decision[]> {
  const rows = await db.auditLog.findMany({
    where: { action: DECIDE_ACTION, recordType: 'RoutingOperation', siteId, ...(routingOperationId ? { recordId: routingOperationId } : {}) },
    select: { id: true, recordId: true, at: true, actorId: true, reason: true, after: true },
    orderBy: [{ at: 'asc' }, { id: 'asc' }],
  })
  return rows.map(({ recordId, ...row }) => ({ ...row, routingOperationId: recordId }))
}
