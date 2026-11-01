import { plusDays } from '@nexus/factory-domain/calendars/dates'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { computeDay, reconcileAnomalies, statusAfter, type ComputedDay, type DayChange, type DayInput } from '@nexus/factory-domain/people/attendance/rules'
import type { CommandTools, CommandTx } from '../../../core/command'
import { dateOf } from '../employees/access'
import { legalGateFor } from '../privacy/gate'
import { absencesOf, anomaliesOf, dayOfPerson, dayRulesFor, eventsBetween, factOf, plannedDays, settingsOf, siteOf, windowOf, type Client, type DayRow, type EventRow, type PersonRow } from './store'

/**
 * Computing a person's attendance day (B-W2b-37; MES-225, MES-226): ONE place reads what the day needs (the clock
 * events around it, the planned shifts, People settings, the working-time limits, the absences), asks the domain's
 * `computeDay`, and writes the AttendanceDay with its anomalies inside the caller's command (`syncDayInCommand`): a new
 * anomaly raised (attendance.anomaly_raised), one no longer found resolved (CLEARED by the system, or FIXED when a
 * person's fix made it go: who and the reason), the status OPEN or NEEDS_FIX, the audit row, attendance.day_changed. An
 * APPROVED or CLOSED day is never computed again (reopen it first; a closed one changes only by a correction). Only at a
 * site whose ATTENDANCE gate is open (Statuto dei Lavoratori art. 4 c.2): the callers check it; this one refuses to
 * write behind a closed gate too.
 */

export interface DayFacts {
  readonly input: DayInput
  readonly computed: ComputedDay
  /** The site of the day: its first clock event's, else the person's own. */
  readonly siteId: string
  readonly timeZone: string
  readonly events: readonly EventRow[]
  readonly today: BusinessDate
}

/** Everything one person's day needs, and what the domain computes from it (any client: office, system, a command's). */
export async function dayFactsOf(db: Client, person: PersonRow, date: BusinessDate, now: Date): Promise<DayFacts> {
  const home = await siteOf(db, person.siteId)
  const timeZone = home?.timezone ?? 'Europe/Rome'
  const window = windowOf(date, timeZone)
  // One query after another: the client may be a command's transaction.
  const events = await eventsBetween(db, person.id, window.from, window.to)
  const plans = await plannedDays(db, person.id, plusDays(date, -1), plusDays(date, 1), timeZone)
  const { settings } = await settingsOf(db, person.companyId)
  const rules = await dayRulesFor(db, person.companyId, person.siteId)
  const absences = await absencesOf(db, person.id, date)
  const input: DayInput = { date, timeZone, now, settings, plans, events: events.map(factOf), absenceMinutes: absences.map((row) => row.minutes), rules }
  const computed = computeDay(input)
  const first = computed.eventIds.map((id) => events.find((event) => event.id === id)).find((event) => event && event.kind !== 'VOID')
  return { input, computed, siteId: first?.siteId ?? person.siteId, timeZone, events, today: businessDate(now, timeZone) }
}

/** The columns a computation writes. */
function columnsOf(facts: DayFacts) {
  const { computed } = facts
  const { figures, planned } = computed
  return {
    siteId: facts.siteId,
    plannedLabel: planned ? (planned.label?.trim() ? planned.label : null) : null,
    plannedStartMinute: planned?.startMinute ?? null,
    plannedEndMinute: planned?.endMinute ?? null,
    plannedMinutes: planned?.minutes ?? null,
    firstInAt: figures.firstInAt,
    lastOutAt: figures.lastOutAt,
    presentMinutes: figures.presentMinutes,
    breakMinutes: figures.breakMinutes,
    ordinaryMinutes: figures.ordinaryMinutes,
    overtimeMinutes: figures.overtimeMinutes,
    nightMinutes: figures.nightMinutes,
    holidayMinutes: figures.holidayMinutes,
    absenceMinutes: figures.absenceMinutes,
  }
}

/** A planned window the database keeps: starting in its day, at most 24 hours (else no planned shift is written). */
function plannedColumns(columns: ReturnType<typeof columnsOf>) {
  const ok = columns.plannedStartMinute !== null && columns.plannedEndMinute !== null && columns.plannedStartMinute >= 0 && columns.plannedStartMinute < 1440 && columns.plannedEndMinute > columns.plannedStartMinute && columns.plannedEndMinute - columns.plannedStartMinute <= 1440
  return ok ? columns : { ...columns, plannedLabel: null, plannedStartMinute: null, plannedEndMinute: null, plannedMinutes: null }
}

const iso = (value: Date | null): string | null => (value ? toUtcIso(value) : null)

const sameColumns = (row: DayRow, columns: ReturnType<typeof columnsOf>): boolean =>
  row.siteId === columns.siteId &&
  row.plannedLabel === columns.plannedLabel &&
  row.plannedStartMinute === columns.plannedStartMinute &&
  row.plannedEndMinute === columns.plannedEndMinute &&
  row.plannedMinutes === columns.plannedMinutes &&
  iso(row.firstInAt) === iso(columns.firstInAt) &&
  iso(row.lastOutAt) === iso(columns.lastOutAt) &&
  row.presentMinutes === columns.presentMinutes &&
  row.breakMinutes === columns.breakMinutes &&
  row.ordinaryMinutes === columns.ordinaryMinutes &&
  row.overtimeMinutes === columns.overtimeMinutes &&
  row.nightMinutes === columns.nightMinutes &&
  row.holidayMinutes === columns.holidayMinutes &&
  row.absenceMinutes === columns.absenceMinutes

/** Whether a day needs a row: something happened or was planned on it (a planned day only once it has begun). */
const needsRow = (facts: DayFacts, date: BusinessDate): boolean =>
  facts.computed.eventIds.length > 0 || facts.computed.figures.absenceMinutes > 0 || (facts.computed.plannedKind === 'WORK' && date <= facts.today)

/** What a computation would change on the stored day (read only: the cron and the handler ask before a command). */
export async function dayWouldChange(db: Client, person: PersonRow, date: BusinessDate, now: Date): Promise<boolean> {
  const row = await dayOfPerson(db, person.id, date)
  if (row && (row.status === 'APPROVED' || row.status === 'CLOSED')) return false
  const facts = await dayFactsOf(db, person, date, now)
  if (!row) return needsRow(facts, date)
  const stored = await anomaliesOf(db, row.id)
  const plan = reconcileAnomalies(stored.map((entry) => ({ id: entry.id, kind: entry.kind, clockEventId: entry.clockEventId, resolution: entry.resolution })), facts.computed.anomalies)
  return !sameColumns(row, plannedColumns(columnsOf(facts))) || plan.raise.length > 0 || plan.resolve.length > 0 || row.status !== statusAfter(plan.open)
}

export interface SyncOptions {
  readonly change: DayChange
  /** A person's fix: the anomalies it made go are FIXED by them, with the reason. */
  readonly fix?: { readonly personId: string; readonly note: string } | undefined
  /** Something was entered or fixed by hand: the day is marked manual for good. */
  readonly manual?: boolean | undefined
  /** The audit row's reason (a manual entry's). */
  readonly reason?: string | undefined
}

export interface Synced {
  readonly dayId: string | null
  readonly status: string | null
  readonly changed: boolean
  /** The day is APPROVED or CLOSED: not computed (reopen it first). */
  readonly frozen: boolean
  readonly facts: DayFacts | null
}

/** The person's lock (the clock's: a clock event and a computation of the same person never interleave). */
export async function lockPerson(tx: CommandTx, tenantId: string, employeeId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.people.clock', ${tenantId}::uuid, ${employeeId}::uuid), 0))`
}

/** Computes the person's day again and writes what changed, inside the caller's command (see the module's comment). */
export async function syncDayInCommand(tools: CommandTools, person: PersonRow, date: BusinessDate, options: SyncOptions): Promise<Synced> {
  const { tx, now } = tools
  const row = await dayOfPerson(tx, person.id, date)
  if (row && (row.status === 'APPROVED' || row.status === 'CLOSED')) return { dayId: row.id, status: row.status, changed: false, frozen: true, facts: null }
  const facts = await dayFactsOf(tx, person, date, now)
  if (!row && !needsRow(facts, date)) return { dayId: null, status: null, changed: false, frozen: false, facts }
  if (!(await legalGateFor(tx, facts.siteId, 'ATTENDANCE', now)).open) return { dayId: row?.id ?? null, status: row?.status ?? null, changed: false, frozen: false, facts }
  const columns = plannedColumns(columnsOf(facts))
  const stored = row ? await anomaliesOf(tx, row.id) : []
  const plan = reconcileAnomalies(stored.map((entry) => ({ id: entry.id, kind: entry.kind, clockEventId: entry.clockEventId, resolution: entry.resolution })), facts.computed.anomalies)
  const status = statusAfter(plan.open)
  const manual = (row?.manual ?? false) || options.manual === true
  if (row && sameColumns(row, columns) && plan.raise.length === 0 && plan.resolve.length === 0 && row.status === status && row.manual === manual) {
    return { dayId: row.id, status: row.status, changed: false, frozen: false, facts }
  }
  const dayId = row?.id ?? newId()
  const actorId = tools.context.audience === 'office' ? tools.context.actorId : null
  if (row) {
    await tx.attendanceDay.update({ where: { id: row.id }, data: { ...columns, status, manual, computedAt: now, version: { increment: 1 } }, select: { id: true } })
  } else {
    await tx.attendanceDay.create({ data: { id: dayId, companyId: person.companyId, employeeId: person.id, date: dateOf(date), ...columns, status, manual, computedAt: now, createdById: actorId }, select: { id: true } })
  }
  // Resolve first, then raise: the day's lock is the database's.
  for (const anomalyId of plan.resolve) {
    await tx.attendanceAnomaly.update({
      where: { id: anomalyId },
      data: options.fix ? { resolution: 'FIXED', resolvedAt: now, resolvedById: options.fix.personId, resolutionNote: options.fix.note, version: { increment: 1 } } : { resolution: 'CLEARED', resolvedAt: now, version: { increment: 1 } },
      select: { id: true },
    })
  }
  for (const anomaly of plan.raise) {
    const anomalyId = newId()
    await tx.attendanceAnomaly.create({
      data: {
        id: anomalyId,
        companyId: person.companyId,
        employeeId: person.id,
        dayId,
        kind: anomaly.kind,
        ruleKey: anomaly.ruleKey,
        workingTimeRuleId: anomaly.workingTimeRuleId,
        clockEventId: anomaly.clockEventId,
        detail: anomaly.detail as object,
        raisedAt: now,
        createdById: actorId,
      },
      select: { id: true },
    })
    tools.emit({ type: 'attendance.anomaly_raised', subject: person.id, companyId: person.companyId, siteId: facts.siteId, payload: { anomalyId, dayId, siteId: facts.siteId, employeeId: person.id, kind: anomaly.kind } })
  }
  const after = { ...columns, firstInAt: iso(columns.firstInAt), lastOutAt: iso(columns.lastOutAt), status, manual, raised: plan.raise.map((entry) => entry.kind), resolved: plan.resolve.length, resolvedAs: plan.resolve.length > 0 ? (options.fix ? 'FIXED' : 'CLEARED') : null }
  tools.audit({
    action: 'people.computeAttendanceDay',
    recordType: 'AttendanceDay',
    recordId: dayId,
    companyId: person.companyId,
    siteId: facts.siteId,
    ...(row ? { before: { status: row.status, presentMinutes: row.presentMinutes, ordinaryMinutes: row.ordinaryMinutes, overtimeMinutes: row.overtimeMinutes, absenceMinutes: row.absenceMinutes, manual: row.manual } } : {}),
    after: { employeeId: person.id, date, ...after },
    ...(options.reason ? { reason: options.reason } : {}),
  })
  tools.emit({ type: 'attendance.day_changed', subject: person.id, companyId: person.companyId, siteId: facts.siteId, payload: { dayId, siteId: facts.siteId, employeeId: person.id, status, change: options.change } })
  return { dayId, status, changed: true, frozen: false, facts }
}

/** The days a clock event can change: its own day and the day before (a night shift), in the site's time zone. */
export const daysOfEvent = (occurredAt: Date, timeZone: string): BusinessDate[] => {
  const day = businessDate(occurredAt, timeZone)
  return [plusDays(day, -1), day]
}

