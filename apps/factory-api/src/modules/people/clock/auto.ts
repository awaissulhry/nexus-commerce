import type { FactoryDatabase } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { autoClockOutDue, autoClockOutReason, CLOCK_RULES, shiftForClockIn, standingOf } from '@nexus/factory-domain/people/clock/rules'
import { callerFor, COMMAND_SETTINGS, runCommand, type CommandCaller, type CommandSettings, type CommandTools, type CommandTx } from '../../../core/command'
import { defineCron, type CronJob } from '../../../core/cron'
import type { Log } from '../../../core/queue'
import { serverClock, type Clock } from '../../../core/time'
import { activeTenants, systemContext } from '../../../platform/outbox/system'
import { endRunningBlock } from '../../production/offstandard/writes'
import { attendanceOpen } from './access'
import { emitClockEvent } from './clock'
import { EVENT_SELECT, eventsOf, factOf, monthClosed, shiftsAround, siteOf } from './store'

/**
 * The automatic clock-out (B-W2b-33; MES-227; design people.settings "Rounding, tolerance and grace": "Automatic clock-out
 * after shift end + tolerance"). Every five minutes, for each company whose People settings set
 * autoClockOutAfterMinutes (null: never, the default — the day is flagged instead), every person whose latest counted
 * clock event of the last 7 days leaves them in (IN, or on a break) is closed when the rule's time has come: an AUTO
 * clock-out at the shift's end plus the tolerance (that time, not the run's), with the rule in words as its reason, in
 * ONE system command per open stretch (key `clock-auto:<the clock-in's id>`: a second tick answers from its receipt).
 * The shift: the published roster cell of the clock-in's day (or the day before, a night shift), else the person's
 * default pattern; a clock-in no shift fits is never closed by the rule. Not at a site whose ATTENDANCE gate is off, and
 * not in a closed month. The clock-out emits attendance.clock_event and clock.out (B-W2b-40 pauses open work) and ends
 * the worker's running off-standard block at that time.
 *
 * A recording rule the company set, never a decision about the worker: the attendance day it closes is approved by a
 * person (B-W2b-37, ATTENDANCE_APPROVAL), who sees the AUTO event and its reason.
 */

export interface AutoClockOutOptions {
  readonly database: FactoryDatabase
  readonly log: Log
  readonly clock?: Clock
}

interface Open {
  readonly employeeId: string
}

/** The people of a company whose latest counted clock event of the look-back leaves them in. */
async function openPeople(db: CommandTx, tenantId: string, companyId: string, since: Date): Promise<Open[]> {
  return db.$queryRaw<Open[]>`
    SELECT "employeeId"::text AS "employeeId" FROM (
      SELECT DISTINCT ON (e."employeeId") e."employeeId", e."kind"
        FROM "ClockEvent" e
       WHERE e."tenantId" = ${tenantId}::uuid AND e."companyId" = ${companyId}::uuid AND e."occurredAt" >= ${since}
         AND e."kind" <> 'VOID'
         AND NOT EXISTS (SELECT 1 FROM "ClockEvent" v WHERE v."tenantId" = e."tenantId" AND v."voidsEventId" = e."id")
       ORDER BY e."employeeId", e."occurredAt" DESC, e."id" DESC
    ) latest
    WHERE latest."kind" <> 'OUT'`
}

interface Plan {
  readonly openEventId: string
  readonly at: Date
}

/** Nothing is due any more (seen inside the command): nothing written. */
class NothingDue extends Error {}

/** What the rule closes for one person now, or null (read with the system's client: the command reads it again). */
async function planFor(db: CommandTx, employeeId: string, afterMinutes: number, now: Date): Promise<(Plan & { readonly siteId: string; readonly workerId: string | null; readonly timeZone: string; readonly reason: string }) | null> {
  const rows = await eventsOf(db, employeeId, new Date(now.getTime() - CLOCK_RULES.autoLookBackDays * 86_400_000))
  const standing = standingOf(rows.map(factOf), now)
  if (!standing.openSince || !standing.openEventId) return null
  const opening = rows.find((row) => row.id === standing.openEventId)!
  const site = await siteOf(db, opening.siteId)
  if (!site) return null
  const shift = shiftForClockIn(await shiftsAround(db, employeeId, standing.openSince, site.timezone), standing.openSince)
  const at = autoClockOutDue(standing, shift, afterMinutes, now)
  if (!at || !shift) return null
  if (!(await attendanceOpen(db, site.id))) return null
  if (await monthClosed(db, opening.companyId, businessDate(at, site.timezone))) return null
  return { openEventId: opening.id, at, siteId: site.id, workerId: opening.workerId, timeZone: site.timezone, reason: autoClockOutReason(shift, afterMinutes, site.timezone) }
}

/** Closes one person's open stretch by the rule, in its own system command (or nothing, when nothing is due). */
async function closeOne(caller: CommandCaller, tenantId: string, companyId: string, employeeId: string, afterMinutes: number, settings: CommandSettings): Promise<boolean> {
  const first = await caller.withClient((db) => planFor(db as CommandTx, employeeId, afterMinutes, settings.clock.now()))
  if (!first) return false
  try {
    await runCommand(
      caller,
      { name: 'people.autoClockOut', idempotencyKey: `clock-auto:${first.openEventId}`, input: { employeeId, openEventId: first.openEventId } },
      async (tools: CommandTools) => {
        await tools.tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.people.clock', ${tenantId}::uuid, ${employeeId}::uuid), 0))`
        const plan = await planFor(tools.tx, employeeId, afterMinutes, tools.now)
        if (!plan || plan.openEventId !== first.openEventId) throw new NothingDue()
        const id = newId()
        await tools.tx.clockEvent.create({
          data: { id, companyId, siteId: plan.siteId, employeeId, kind: 'OUT', source: 'AUTO', occurredAt: plan.at, reason: plan.reason },
          select: EVENT_SELECT,
        })
        tools.audit({ recordType: 'ClockEvent', recordId: id, companyId, siteId: plan.siteId, after: { employeeId, kind: 'OUT', source: 'AUTO', occurredAt: toUtcIso(plan.at), closes: plan.openEventId }, reason: plan.reason })
        emitClockEvent(tools, { id, companyId, siteId: plan.siteId, employeeId, workerId: plan.workerId, kind: 'OUT', source: 'AUTO', flagged: false })
        if (plan.workerId) await endRunningBlock(tools, { tenantId, siteId: plan.siteId, subject: { workerId: plan.workerId, stationId: null }, at: plan.at, endedBy: 'CLOCK_OUT' })
        return { clockEventId: id, at: toUtcIso(plan.at) }
      },
      settings,
    )
    return true
  } catch (error) {
    if (error instanceof NothingDue) return false
    throw error
  }
}

/** One pass over every tenant (the cron's body; tests call it with a moved clock). */
export async function runAutoClockOut(options: AutoClockOutOptions): Promise<{ readonly tenants: number; readonly closed: number; readonly failed: number }> {
  const settings: CommandSettings = { ...COMMAND_SETTINGS, clock: options.clock ?? serverClock }
  const requestId = `clock-auto-${newId()}`
  let closed = 0
  let failed = 0
  const tenants = await activeTenants(options.database)
  for (const tenantId of tenants) {
    const caller = callerFor(options.database, systemContext(tenantId, requestId))
    const companies = await caller.withClient((client) => client.peopleSettings.findMany({ where: { autoClockOutAfterMinutes: { not: null } }, select: { companyId: true, autoClockOutAfterMinutes: true } }))
    for (const company of companies) {
      const since = new Date(settings.clock.now().getTime() - CLOCK_RULES.autoLookBackDays * 86_400_000)
      const open = await caller.withClient((client) => openPeople(client as CommandTx, tenantId, company.companyId, since))
      for (const { employeeId } of open) {
        try {
          if (await closeOne(caller, tenantId, company.companyId, employeeId, company.autoClockOutAfterMinutes!, settings)) closed++
        } catch (error) {
          failed++
          options.log.error({ err: error, tenantId, employeeId }, 'an open clock-in could not be closed by the automatic clock-out')
        }
      }
    }
  }
  if (closed + failed > 0) options.log.info({ tenants: tenants.length, closed, failed }, 'automatic clock-outs')
  return { tenants: tenants.length, closed, failed }
}

/** The clustered cron (scheduler only; one replica per tick): every five minutes. */
export function autoClockOutCron(options: AutoClockOutOptions): CronJob {
  return defineCron({
    name: 'people.autoClockOut',
    schedule: '*/5 * * * *',
    async run() {
      await runAutoClockOut(options)
    },
  })
}
