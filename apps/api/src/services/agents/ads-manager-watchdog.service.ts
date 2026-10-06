/**
 * ADS AUTONOMY W4-2 — the watchdog of the daily Claude ads run (agent-results/6 §8): the Owner hears it when a run
 * never reported, or started and never ended. A routine on claude.ai shows green when its session merely started and
 * stopped; Nexus is where the report lands, so Nexus is where its absence is noticed.
 *
 *   expected time   per business, a wall-clock time and a time zone ("08:00", "Europe/Rome") by which the day's run
 *                   reports its end; none = the missing-report check is off (the default). Kept in AgentMemory (scope
 *                   claude-ads-manager, key expectedReport): an existing business-scoped store, no migration. Set with
 *                   the set-ads-report-time tool, which a person approves.
 *   missing report  no finish or fail of a run by the expected time + 30 minutes, since the day before's deadline → one
 *                   danger notice and one e-mail (claude-alerts.service.ts). A report that waits for a person in
 *                   Approvals counts as arrived: the run did report.
 *   started, no end a run that started 2 hours ago or more and reported no end → one danger notice and one e-mail.
 *
 * Each alert is raised once (the alerted moments and runs are kept in AgentMemory key `watchdog`). The cron
 * (jobs/claude-ads-run-watchdog.job.ts) runs hourly through lib/cron/clustered.ts, which runs it inside EACH business's
 * own context with business profiles on: every read and write here is that business's only (row-level security).
 */

import type { Prisma } from '@nexus/database'
import prisma from '../../db.js'
import { ADS_MANAGER_AGENT_KEY } from './ads-manager-run.service.js'
import { alertBusiness, type AlertOutcome } from './claude-alerts.service.js'

/** How late a report may be before the Owner hears of it. */
export const REPORT_GRACE_MS = 30 * 60_000
/** How long a started run may go without reporting its end. */
export const STUCK_AFTER_MS = 2 * 3600_000
/** A started run older than this is no longer looked at (it was alerted, or it predates the watchdog). */
const STUCK_LOOKBACK_MS = 26 * 3600_000
export const WATCHDOG_NOTICE_TYPE = 'claude-ads-watchdog'
const SETTINGS = { scope: ADS_MANAGER_AGENT_KEY, entityType: 'business', entityId: 'settings' } as const
const EXPECTED_KEY = 'expectedReport'
const STATE_KEY = 'watchdog'
const HREF = '/settings/ai/claude'

export interface ExpectedReport {
  /** HH:MM, 24-hour, on the business's own clock. */
  time: string
  /** An IANA time zone (Europe/Rome). */
  timeZone: string
}

export const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

/** A time zone this runtime knows (Intl), or null. */
export function knownTimeZone(timeZone: string): string | null {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone
  } catch {
    return null
  }
}

// ── The setting ────────────────────────────────────────────────────────────────────────────────────

async function memoryRow(key: string) {
  return prisma.agentMemory.findFirst({ where: { ...SETTINGS, key }, select: { id: true, value: true, updatedAt: true } })
}

async function writeMemory(key: string, value: unknown, by: string | null): Promise<void> {
  const row = await memoryRow(key)
  const data = { value: value as Prisma.InputJsonValue, updatedBy: by }
  if (row) await prisma.agentMemory.update({ where: { id: row.id }, data })
  else await prisma.agentMemory.create({ data: { ...SETTINGS, key, ...data } })
}

function expectedOf(value: unknown): ExpectedReport | null {
  const v = value as Partial<ExpectedReport> | null
  return v && typeof v.time === 'string' && TIME.test(v.time) && typeof v.timeZone === 'string' && knownTimeZone(v.timeZone)
    ? { time: v.time, timeZone: v.timeZone }
    : null
}

/** The business's expected report time, and when it was last set; null = the missing-report check is off. */
export async function readExpectedReport(): Promise<(ExpectedReport & { setAt: Date }) | null> {
  const row = await memoryRow(EXPECTED_KEY)
  const expected = expectedOf(row?.value)
  return expected && row ? { ...expected, setAt: row.updatedAt } : null
}

/** Set (or, with null, switch off) the expected report time. */
export async function writeExpectedReport(value: ExpectedReport | null, by: string | null): Promise<void> {
  if (value) {
    await writeMemory(EXPECTED_KEY, value, by)
    return
  }
  const row = await memoryRow(EXPECTED_KEY)
  if (row) await prisma.agentMemory.delete({ where: { id: row.id } })
}

// ── Wall-clock time in a zone (pure) ──────────────────────────────────────────────────────────────

/** How far a zone's wall clock is ahead of UTC at a moment, in ms. */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'))
  return wall - Math.floor(at.getTime() / 1000) * 1000
}

/** The calendar day of a moment in a zone. */
function dayIn(at: Date, timeZone: string): { y: number; m: number; d: number } {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at).split('-').map(Number)
  return { y, m, d }
}

/** The moment a wall-clock time on a calendar day has in a zone (a time a DST change skips lands an hour later). */
export function zonedMoment(day: { y: number; m: number; d: number }, time: string, timeZone: string): Date {
  const [hh, mm] = time.split(':').map(Number)
  const wall = Date.UTC(day.y, day.m - 1, day.d, hh, mm)
  const first = wall - zoneOffsetMs(new Date(wall), timeZone)
  return new Date(wall - zoneOffsetMs(new Date(first), timeZone))
}

const shift = (day: { y: number; m: number; d: number }, days: number) => {
  const at = new Date(Date.UTC(day.y, day.m - 1, day.d + days))
  return { y: at.getUTCFullYear(), m: at.getUTCMonth() + 1, d: at.getUTCDate() }
}

/**
 * The newest expected moment whose deadline (+ 30 min) has passed at `now`, and the one the day before: the report of
 * `due` is the one that arrived after the day before's deadline and by its own.
 */
export function lastDeadline(now: Date, expected: ExpectedReport): { due: Date; previous: Date; deadline: Date; since: Date } {
  const today = dayIn(now, expected.timeZone)
  let day = today
  let due = zonedMoment(day, expected.time, expected.timeZone)
  if (due.getTime() + REPORT_GRACE_MS > now.getTime()) {
    day = shift(today, -1)
    due = zonedMoment(day, expected.time, expected.timeZone)
  }
  const previous = zonedMoment(shift(day, -1), expected.time, expected.timeZone)
  return { due, previous, deadline: new Date(due.getTime() + REPORT_GRACE_MS), since: new Date(previous.getTime() + REPORT_GRACE_MS) }
}

const clock = (at: Date, timeZone: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at)

// ── One tick, in one business ─────────────────────────────────────────────────────────────────────

interface WatchdogState { missed: string[]; stuck: string[] }

async function stateOf(): Promise<WatchdogState> {
  const value = (await memoryRow(STATE_KEY))?.value as Partial<WatchdogState> | null
  return { missed: Array.isArray(value?.missed) ? value.missed.map(String) : [], stuck: Array.isArray(value?.stuck) ? value.stuck.map(String) : [] }
}

/** Did a run report its end (or ask to, waiting for a person) in this window? */
async function reportArrived(since: Date, deadline: Date): Promise<boolean> {
  const [ended, asked] = await Promise.all([
    prisma.agentRun.count({ where: { agentKey: ADS_MANAGER_AGENT_KEY, endedAt: { gt: since, lte: deadline }, status: { in: ['done', 'failed', 'cancelled'] } } }),
    prisma.agentApproval.count({
      where: { toolName: 'report-ads-run', requestedAt: { gt: since, lte: deadline }, OR: [{ args: { path: ['op'], equals: 'finish' } }, { args: { path: ['op'], equals: 'fail' } }] },
    }),
  ])
  return ended + asked > 0
}

export interface WatchdogTick {
  expected: ExpectedReport | null
  missing: { due: string; alert: AlertOutcome } | null
  stuck: Array<{ runId: string; alert: AlertOutcome }>
}

/** One watchdog tick in the business the caller is in. Idempotent: each alert is raised once. */
export async function runWatchdogOnce(now = new Date()): Promise<WatchdogTick> {
  const [expected, state] = await Promise.all([readExpectedReport(), stateOf()])
  const tick: WatchdogTick = { expected: expected ? { time: expected.time, timeZone: expected.timeZone } : null, missing: null, stuck: [] }
  const zone = expected?.timeZone ?? 'Europe/Rome'

  // A run that started 2 hours ago or more and reported no end.
  const stuck = await prisma.agentRun.findMany({
    where: { agentKey: ADS_MANAGER_AGENT_KEY, status: 'running', createdAt: { lte: new Date(now.getTime() - STUCK_AFTER_MS), gte: new Date(now.getTime() - STUCK_LOOKBACK_MS) } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, createdAt: true },
  })
  for (const run of stuck.filter((r) => !state.stuck.includes(r.id))) {
    const alert = await alertBusiness({
      type: WATCHDOG_NOTICE_TYPE,
      title: 'Claude ads: a daily run started and did not finish',
      body: `The daily Claude ads run that started at ${clock(run.createdAt, zone)} (${zone}) has reported no end in 2 hours (run ${run.id}).\n`
        + 'Open the run on claude.ai to read why. Anything it asked for that waits for a person is in Nexus Approvals.',
      href: HREF,
      meta: { runId: run.id, check: 'started-no-end' },
    })
    tick.stuck.push({ runId: run.id, alert })
    state.stuck.push(run.id)
  }

  // No report by the expected time + 30 minutes. A setting newer than that deadline does not look back at it.
  if (expected) {
    const window = lastDeadline(now, expected)
    const key = window.due.toISOString()
    if (expected.setAt <= window.deadline && !state.missed.includes(key) && !(await reportArrived(window.since, window.deadline))) {
      const alert = await alertBusiness({
        type: WATCHDOG_NOTICE_TYPE,
        title: 'Claude ads: the daily run did not report',
        body: `Nexus expected the daily Claude ads run to report by ${expected.time} (${expected.timeZone}), with 30 minutes' grace; no report arrived.\n`
          + 'Open the routine on claude.ai and press Run now. If the Claude connection was ended, reconnect it with your authenticator code.',
        href: HREF,
        meta: { due: key, check: 'no-report' },
      })
      tick.missing = { due: key, alert }
      state.missed.push(key)
    }
  }

  if (tick.missing || tick.stuck.length) {
    await writeMemory(STATE_KEY, { missed: state.missed.slice(-14), stuck: state.stuck.slice(-50) }, 'Nexus')
  }
  return tick
}
