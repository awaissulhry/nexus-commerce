import type { FactoryDatabase } from '@nexus/factory-db'
import { plusDays } from '@nexus/factory-domain/calendars/dates'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { callerFor, COMMAND_SETTINGS, runCommand, type CommandCaller, type CommandSettings } from '../../../core/command'
import { defineCron, type CronJob } from '../../../core/cron'
import type { Log } from '../../../core/queue'
import { serverClock, type Clock } from '../../../core/time'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { activeTenants, systemContext } from '../../../platform/outbox/system'
import { legalGateFor } from '../privacy/gate'
import { dayWouldChange, daysOfEvent, lockPerson, syncDayInCommand } from './compute'
import { personOf, siteOf, type Client } from './store'

/**
 * The days computed in the background (B-W2b-37; MES-225, MES-226): the worker's handler and the scheduler's cron, each
 * a system command per day that changes (read first: an idle pass writes nothing), only at sites whose ATTENDANCE gate is
 * open (Statuto dei Lavoratori art. 4 c.2). A computation records; it decides nothing about a person (approvals and
 * fixes are a person's, B-W2b-27 `assertPersonDecides`).
 *
 *   handler people.attendanceDays   attendance.clock_event → the day of the event and the day before (a night shift) of
 *                                   that person (key `attendance-day:<event id>:<day>`)
 *   cron people.attendanceDays      every 15 minutes: yesterday and today of every person of the open sites (a person
 *                                   with a shift planned who never clocked in gets the day "absence without a code"; a
 *                                   clock-in open past 13 hours becomes a missing clock-out)
 *
 * background.ts lists both (handler and cron lines only).
 */

class NoChange extends Error {}

/** Computes one person's day in its own system command when it would change (the change re-read under the person's lock). */
export async function computeDayNow(caller: CommandCaller, settings: CommandSettings, tenantId: string, employeeId: string, date: BusinessDate, key?: string): Promise<boolean> {
  const person = await caller.withClient((db) => personOf(db, employeeId))
  if (!person) return false
  if (!(await caller.withClient((db) => dayWouldChange(db, person, date, settings.clock.now())))) return false
  try {
    await runCommand(
      caller,
      { name: 'people.computeAttendanceDay', idempotencyKey: key, input: { employeeId, date } },
      async (tools) => {
        await lockPerson(tools.tx, tenantId, employeeId)
        const synced = await syncDayInCommand(tools, person, date, { change: 'COMPUTED' })
        if (!synced.changed) throw new NoChange()
        return { dayId: synced.dayId, status: synced.status }
      },
      settings,
    )
    return true
  } catch (error) {
    if (error instanceof NoChange) return false
    throw error
  }
}

/** attendance.clock_event → that person's day (and the day before) computed again. */
export function attendanceHandlers(): EventHandler[] {
  return [
    defineHandler({
      name: 'people.attendanceDays',
      events: ['attendance.clock_event'],
      async handle(event, { caller }) {
        const payload = event.payload as { clockEventId: string; siteId: string; employeeId: string }
        const facts = await caller.withClient(async (db: Client) => {
          const clock = await db.clockEvent.findUnique({ where: { id: payload.clockEventId }, select: { occurredAt: true } })
          const site = await siteOf(db, payload.siteId)
          const open = site ? (await legalGateFor(db, site.id, 'ATTENDANCE')).open : false
          return clock && site && open ? { occurredAt: clock.occurredAt, timeZone: site.timezone } : null
        })
        if (!facts) return
        for (const date of daysOfEvent(facts.occurredAt, facts.timeZone)) {
          await computeDayNow(caller, COMMAND_SETTINGS, event.tenantId, payload.employeeId, date, `attendance-day:${event.eventId}:${date}`)
        }
      },
    }),
  ]
}

export interface AttendanceDaysOptions {
  readonly database: FactoryDatabase
  readonly log: Log
  readonly clock?: Clock
}

/** One pass over every tenant (the cron's body; tests call it with a moved clock). */
export async function runAttendanceDays(options: AttendanceDaysOptions): Promise<{ readonly tenants: number; readonly computed: number; readonly failed: number }> {
  const settings: CommandSettings = { ...COMMAND_SETTINGS, clock: options.clock ?? serverClock }
  const requestId = `attendance-days-${newId()}`
  let computed = 0
  let failed = 0
  const tenants = await activeTenants(options.database)
  for (const tenantId of tenants) {
    const caller = callerFor(options.database, systemContext(tenantId, requestId))
    const now = settings.clock.now()
    const gates = await caller.withClient((db) => db.peopleLegalGate.findMany({ where: { purpose: 'ATTENDANCE', switchedOffAt: null, switchedOnAt: { lte: now } }, select: { siteId: true } }))
    for (const siteId of [...new Set(gates.map((gate) => gate.siteId))]) {
      const site = await caller.withClient((db) => siteOf(db, siteId))
      if (!site) continue
      const today = businessDate(now, site.timezone)
      const since = new Date(now.getTime() - 3 * 86_400_000)
      const people = await caller.withClient(async (db) => {
        const own = await db.employee.findMany({ where: { siteId, status: 'ACTIVE' }, select: { id: true } })
        const clocked = await db.clockEvent.findMany({ where: { siteId, occurredAt: { gte: since } }, select: { employeeId: true }, distinct: ['employeeId'] })
        return [...new Set([...own.map((row) => row.id), ...clocked.map((row) => row.employeeId)])]
      })
      for (const employeeId of people) {
        for (const date of [plusDays(today, -1), today]) {
          try {
            if (await computeDayNow(caller, settings, tenantId, employeeId, date)) computed++
          } catch (error) {
            failed++
            options.log.error({ err: error, tenantId, employeeId, date }, 'an attendance day could not be computed')
          }
        }
      }
    }
  }
  if (computed + failed > 0) options.log.info({ tenants: tenants.length, computed, failed }, 'attendance days computed')
  return { tenants: tenants.length, computed, failed }
}

/** The clustered cron (scheduler only; one replica per tick): every 15 minutes. */
export function attendanceDaysCron(options: AttendanceDaysOptions): CronJob {
  return defineCron({
    name: 'people.attendanceDays',
    schedule: '*/15 * * * *',
    async run() {
      await runAttendanceDays(options)
    },
  })
}
