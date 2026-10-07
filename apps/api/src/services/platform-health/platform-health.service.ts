/**
 * Platform health watchdog (2026-10-07) — the Owner's ads run with no person in the loop, so a part that stops must be
 * found by the platform, not by chance. That day eight faults were found that had run silently for days or weeks: SQP
 * requests refused 24 of 30 nightly under a SUCCESS cron row, the scheduler dying at 03:20 UTC every night, every ads
 * rule's graduation gate reading a sandbox connection, auto-bid counting refused writes as applied, approved plan steps
 * skipped as "facts moved", writes waiting for a drain cron, the Economics feed 11 days behind.
 *
 * Once a day (jobs/platform-health-watchdog.job.ts, and "Run now" on the Sync Logs hub) every check of the registry
 * (registry.ts) measures one part of the platform:
 *
 *   measure   each check gathers its facts and judges them (types.ts); a check that throws is "could not measure",
 *             never ok. Checks run one after another to spare the database.
 *   store     one PlatformHealthCheck row per check, sharing the run's id; rows older than 60 days are removed.
 *   alert     one AlertRule per check (metric `platformHealth:<id>`, "Platform health: <title>", created on the first
 *             run with the channels of the "Critical cron stopped" rule, else the default ones) settled through the
 *             existing alert path (alert-evaluator.service.ts settleAlertRule): a failing (or warning) check opens ONE
 *             AlertEvent and notifies with its words; it stays one while the check keeps failing, is raised again when
 *             it gets worse, and is resolved automatically when the check passes. A check that could not measure leaves
 *             its alert as it is. A rule a person disabled raises nothing; its threshold (1 = warn, 2 = fail only) and
 *             channels are theirs to tune on the alerts page.
 *   read      readPlatformHealth: the newest run with its checks, since when each one is not ok, and the open alerts —
 *             what Claude's `platform-health-checks` returns (stale after 26 h: the watchdog not running is itself a
 *             failure).
 *
 * Every read and write runs in the caller's business (the cron runs inside each active business).
 */
import { randomUUID } from 'node:crypto'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import {
  PLATFORM_HEALTH_METRIC_PREFIX, defaultAlertChannels, settleAlertRule, type AlertSettlement, type SettleableRule,
} from '../alert-evaluator.service.js'
import { HEALTH_CHECKS } from './registry.js'
import { HOUR, DAY, CHECK_STATUSES, type AnyHealthCheck, type CheckContext, type CheckResult, type CheckStatus } from './types.js'

/** The value a check's alert rule is settled with: its default rule (gte 1) fires on warn and fail. */
export const ALERT_VALUE: Record<CheckStatus, number> = { fail: 2, warn: 1, ok: 0, unknown: 0 }
/** The newest run is stale after this: the daily watchdog did not run. */
export const STALE_AFTER_MS = 26 * HOUR
export const RETENTION_DAYS = 60

export const metricOf = (checkId: string) => `${PLATFORM_HEALTH_METRIC_PREFIX}${checkId}`
const checkIdOf = (metric: string) => (metric.startsWith(PLATFORM_HEALTH_METRIC_PREFIX) ? metric.slice(PLATFORM_HEALTH_METRIC_PREFIX.length) : null)

// ── Measure ──────────────────────────────────────────────────────────────────────────────────────────

/** Every check, measured now, in the caller's business. Writes nothing. */
export async function measurePlatformHealth(now: Date = new Date(), checks: readonly AnyHealthCheck[] = HEALTH_CHECKS): Promise<CheckResult[]> {
  const memo = new Map<string, Promise<unknown>>()
  const ctx: CheckContext = {
    now,
    memo<T>(key: string, read: () => Promise<T>): Promise<T> {
      if (!memo.has(key)) memo.set(key, read())
      return memo.get(key) as Promise<T>
    },
  }
  const results: CheckResult[] = []
  for (const check of checks) {
    try {
      const facts = await check.gather(ctx)
      const verdict = check.judge(facts, now)
      results.push({ id: check.id, subsystem: check.subsystem, title: check.title, ...verdict })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.warn('[platform-health] a check could not measure', { check: check.id, error: message.slice(0, 300) })
      results.push({
        id: check.id, subsystem: check.subsystem, title: check.title,
        status: 'unknown',
        message: `Could not measure: the check failed while reading (${message.replace(/\s+/g, ' ').slice(0, 240)}).`,
        likelyCause: 'A fault in the watchdog check itself or a database error, not a verdict on the part it watches.',
        nextStep: 'Report it to whoever maintains Nexus: until it is fixed this part is not watched.',
        evidence: { error: message.slice(0, 300) },
      })
    }
  }
  return results
}

// ── Alerts ───────────────────────────────────────────────────────────────────────────────────────────

type HealthRule = SettleableRule & { enabled: boolean }

/** The channels a new check rule notifies: the Owner's own choice on "Critical cron stopped", else the defaults. */
async function channelsForNewRules(): Promise<string[]> {
  const critical = await prisma.alertRule.findFirst({ where: { name: 'Critical cron stopped' }, select: { notificationChannels: true } })
  const theirs = critical?.notificationChannels
  return Array.isArray(theirs) && theirs.length && theirs.every((c) => typeof c === 'string') ? (theirs as string[]) : defaultAlertChannels().channels
}

/** One alert rule per check, created on the first run; the oldest wins if two runs ever made two. */
export async function ensureHealthRules(checks: readonly AnyHealthCheck[] = HEALTH_CHECKS): Promise<Map<string, HealthRule>> {
  const existing = await prisma.alertRule.findMany({ where: { metric: { startsWith: PLATFORM_HEALTH_METRIC_PREFIX } }, orderBy: { createdAt: 'asc' } })
  const byCheck = new Map<string, HealthRule>()
  for (const rule of existing) {
    const id = checkIdOf(rule.metric)
    if (id && !byCheck.has(id)) byCheck.set(id, rule)
  }
  let channels: string[] | null = null
  for (const check of checks) {
    if (byCheck.has(check.id)) continue
    channels ??= await channelsForNewRules()
    const rule = await prisma.alertRule.create({
      data: {
        name: `Platform health: ${check.title}`,
        description: `${check.watches} Evaluated once a day by the platform health watchdog (1 = warn, 2 = fail).`,
        metric: metricOf(check.id),
        operator: 'gte',
        threshold: 1,
        windowMinutes: 1440,
        notificationChannels: channels as never,
        enabled: true,
      },
    })
    byCheck.set(check.id, rule)
  }
  return byCheck
}

export interface AlertTally { fired: string[]; resolved: string[]; escalated: string[] }

/** Settle each check's alert through the existing alert path. A check that could not measure leaves its alert as it is. */
export async function settleHealthAlerts(results: readonly CheckResult[], checks: readonly AnyHealthCheck[] = HEALTH_CHECKS): Promise<AlertTally> {
  const tally: AlertTally = { fired: [], resolved: [], escalated: [] }
  const rules = await ensureHealthRules(checks)
  for (const result of results) {
    const rule = rules.get(result.id)
    if (!rule || !rule.enabled || result.status === 'unknown') continue
    try {
      const outcome: AlertSettlement = await settleAlertRule(rule, ALERT_VALUE[result.status], {
        detail: { status: result.status, message: result.message, likelyCause: result.likelyCause, nextStep: result.nextStep },
        resolveAcknowledged: true,
        notifyOnRise: true,
      })
      if (outcome === 'fired') tally.fired.push(result.id)
      else if (outcome === 'resolved') tally.resolved.push(result.id)
      else if (outcome === 'escalated') tally.escalated.push(result.id)
    } catch (error) {
      logger.error('[platform-health] an alert could not be settled', { check: result.id, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return tally
}

// ── One run ──────────────────────────────────────────────────────────────────────────────────────────

export interface WatchdogRun {
  runId: string
  measuredAt: string
  counts: Record<CheckStatus, number>
  alerts: AlertTally
  results: CheckResult[]
}

const countsOf = (results: readonly { status: string }[]) =>
  Object.fromEntries(CHECK_STATUSES.map((s) => [s, results.filter((r) => r.status === s).length])) as Record<CheckStatus, number>

/** Measure, store, alert — one watchdog run in the caller's business. */
export async function runPlatformHealthWatchdog(opts: { now?: Date; triggeredBy?: 'cron' | 'manual'; checks?: readonly AnyHealthCheck[] } = {}): Promise<WatchdogRun> {
  const now = opts.now ?? new Date()
  const checks = opts.checks ?? HEALTH_CHECKS
  const results = await measurePlatformHealth(now, checks)
  const runId = randomUUID()
  await prisma.platformHealthCheck.createMany({
    data: results.map((r) => ({
      runId, checkId: r.id, subsystem: r.subsystem, status: r.status, message: r.message,
      likelyCause: r.likelyCause, nextStep: r.nextStep, evidence: r.evidence as never,
      triggeredBy: opts.triggeredBy ?? 'cron', measuredAt: now,
    })),
  })
  await prisma.platformHealthCheck.deleteMany({ where: { measuredAt: { lt: new Date(now.getTime() - RETENTION_DAYS * DAY) } } })
  const alerts = await settleHealthAlerts(results, checks)
  return { runId, measuredAt: now.toISOString(), counts: countsOf(results), alerts, results }
}

/** The CronRun line of a run: the counts, which checks are not ok, and what the alerts did. */
export function watchdogSummary(run: Pick<WatchdogRun, 'counts' | 'alerts' | 'results'>): string {
  const ids = (status: CheckStatus) => run.results.filter((r) => r.status === status).map((r) => r.id)
  const named = (['fail', 'warn', 'unknown'] as const).filter((s) => ids(s).length).map((s) => `${s}: ${ids(s).join(',')}`)
  return `checks=${run.results.length} ok=${run.counts.ok} warn=${run.counts.warn} fail=${run.counts.fail} unknown=${run.counts.unknown}`
    + (named.length ? ` · ${named.join(' · ')}` : '')
    + ` · alerts fired=${run.alerts.fired.length} escalated=${run.alerts.escalated.length} resolved=${run.alerts.resolved.length}`
}

// ── Read ─────────────────────────────────────────────────────────────────────────────────────────────

export interface StoredCheck {
  id: string
  subsystem: string
  status: string
  message: string
  likelyCause: string | null
  nextStep: string | null
  evidence: unknown
  /** The newest run in which this check was ok (null: never, in the rows kept). */
  lastOkAt: string | null
}

export interface PlatformHealthReading {
  run: { runId: string; measuredAt: string; triggeredBy: string; ageHours: number; stale: boolean } | null
  counts: Record<CheckStatus, number>
  checks: StoredCheck[]
  /** The watchdog's alerts still open (triggered or acknowledged). */
  openAlerts: Array<{ check: string; rule: string; state: string; level: 'fail' | 'warn'; since: string }>
}

/** The newest watchdog run of the caller's business, its checks, and the watchdog's open alerts. */
export async function readPlatformHealth(now: Date = new Date()): Promise<PlatformHealthReading> {
  const latest = await prisma.platformHealthCheck.findFirst({ orderBy: { measuredAt: 'desc' }, select: { runId: true, measuredAt: true, triggeredBy: true } })
  const [rows, okRows, open] = await Promise.all([
    latest ? prisma.platformHealthCheck.findMany({ where: { runId: latest.runId } }) : Promise.resolve([]),
    prisma.platformHealthCheck.groupBy({ by: ['checkId'], where: { status: 'ok' }, _max: { measuredAt: true } }),
    prisma.alertEvent.findMany({
      where: { status: { in: ['TRIGGERED', 'ACKNOWLEDGED'] }, rule: { metric: { startsWith: PLATFORM_HEALTH_METRIC_PREFIX } } },
      orderBy: { triggeredAt: 'asc' },
      select: { status: true, value: true, triggeredAt: true, rule: { select: { name: true, metric: true } } },
      take: 50,
    }),
  ])
  const lastOk = new Map(okRows.map((r) => [r.checkId, r._max.measuredAt?.toISOString() ?? null]))
  const order = new Map(HEALTH_CHECKS.map((c, i) => [c.id, i]))
  const checks = rows
    .map((r) => ({ id: r.checkId, subsystem: r.subsystem, status: r.status, message: r.message, likelyCause: r.likelyCause, nextStep: r.nextStep, evidence: r.evidence, lastOkAt: lastOk.get(r.checkId) ?? null }))
    .sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99))
  const age = latest ? now.getTime() - latest.measuredAt.getTime() : null
  return {
    run: latest ? { runId: latest.runId, measuredAt: latest.measuredAt.toISOString(), triggeredBy: latest.triggeredBy, ageHours: Math.round((age! / HOUR) * 10) / 10, stale: age! > STALE_AFTER_MS } : null,
    counts: countsOf(checks),
    checks,
    openAlerts: open.map((e) => ({
      check: checkIdOf(e.rule.metric) ?? e.rule.metric, rule: e.rule.name, state: e.status,
      level: e.value >= ALERT_VALUE.fail ? 'fail' : 'warn', since: e.triggeredAt.toISOString(),
    })),
  }
}
