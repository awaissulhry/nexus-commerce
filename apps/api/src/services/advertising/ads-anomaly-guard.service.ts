/**
 * TD.0 — anomaly circuit-breaker. A safety net ABOVE the per-rule caps: if the
 * automation engine as a whole goes runaway — too many actions/hour (a
 * misconfigured rule firing in a loop) or ad spend spiking in the trailing hour
 * — it trips a global halt (AdsAutomationState) and notifies operators, so a
 * 24/7 agent can never quietly burn the account. Idempotent; runs on a cron.
 *
 * Group 1 (1b) — three signals now, because the first one alone never saw the engines (one rank-defend tick wrote
 * 514 changes while this counted 0):
 *   1. rule actions — AutomationRuleExecution rows, against `maxActionsPerHour`. Rules only: adding engine writes
 *      here would halt the account on every morning restore tick.
 *   2. engine changes — AdvertisingActionLog rows in the last 60 minutes, per engine (`ads-engine-actors.ts`), each
 *      against its own hourly limit; writes no engine or rule claims count as "unknown".
 *   3. spend — the latest ENDED hour with hourly data (the current hour is partial: the data lands 1–4 h late).
 * A trip stops the whole account; one Resume clears it (Owner decision S4).
 */
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { microsToCents } from '../ads-core/metrics-math.js'
import { getAutomationState, haltAutomation, markGuardChecked } from './ads-automation-state.service.js'
import {
  NON_CHANGE_ACTION_TYPES, breakerLimits, classifyActor, countWritesByEngine, engineLabel, type BreakerBucket,
} from './ads-engine-actors.js'

const DEFAULT_MAX_ACTIONS_PER_HOUR = 250
const DEFAULT_MAX_HOURLY_SPEND_CENTS = 50_000 // €500/hr account-wide
const HOUR = 60 * 60 * 1000
/** How far back the spend signal looks for an hour with data (hourly data lands 1–4 h late). */
const SPEND_LOOKBACK_HOURS = 6

export interface EngineWritesRow {
  engine: BreakerBucket
  label: string
  /** Changes in the last 60 minutes. */
  writes: number
  /** The breaker trips above this. */
  limit: number
}

export interface AnomalyGuardResult {
  checked: true
  tripped: boolean
  reason?: string
  /** Rule actions in the last hour (AutomationRuleExecution). Engine changes are in `engineWritesLastHour`. */
  actionsLastHour: number
  /** Changes per engine in the last 60 minutes, busiest first. Rule writes are not in here. */
  engineWritesLastHour: EngineWritesRow[]
  spendLastHourCents: number
  /** Start (UTC) of the hour the spend signal read; null when no ended hour in the look-back has data. */
  spendHour: string | null
  thresholds: { maxActionsPerHour: number; maxHourlySpendCentsEur: number }
  alreadyStopped: boolean
}

const fmt = (n: number) => n.toLocaleString('en-GB')

/** Signal 2 — action-log rows in the window, bucketed per engine. A read failure reads as no writes. */
async function engineWritesSince(since: Date): Promise<EngineWritesRow[]> {
  const groups = await prisma.advertisingActionLog.groupBy({
    by: ['userId'],
    where: { createdAt: { gte: since }, actionType: { notIn: [...NON_CHANGE_ACTION_TYPES] } },
    _count: { _all: true },
  }).catch((err: unknown) => {
    logger.warn('[ads-anomaly-guard] engine write count failed', { error: String(err) })
    return [] as Array<{ userId: string | null; _count: { _all: number } }>
  })
  const rows = groups.map((g) => ({ userId: g.userId, count: g._count._all }))
  // `automation:<id>` with no engine is a rule only if that id is one; otherwise nobody we know wrote it.
  // If the lookup fails they are taken as rules: an unreadable table must not trip the account.
  const candidates = [...new Set(rows.flatMap((r) => {
    const c = classifyActor(r.userId)
    return c.kind === 'rule-candidate' ? [c.ruleId] : []
  }))]
  const ruleIds = new Set(candidates.length
    ? await prisma.automationRule.findMany({ where: { id: { in: candidates } }, select: { id: true } })
      .then((found) => found.map((r) => r.id))
      .catch(() => candidates)
    : [])
  const counts = countWritesByEngine(rows, ruleIds)
  const limits = breakerLimits()
  return (Object.keys(counts) as BreakerBucket[])
    .map((engine) => ({ engine, label: engineLabel(engine), writes: counts[engine], limit: limits[engine] }))
    .sort((a, b) => b.writes - a.writes)
}

/** Signal 3 — campaign spend in the latest ended UTC hour that has hourly rows, within the look-back. */
async function latestCompleteHourSpend(now: Date): Promise<{ cents: number; hourStart: Date | null }> {
  const currentHourStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours())
  const hours = Array.from({ length: SPEND_LOOKBACK_HOURS }, (_, i) => {
    const start = new Date(currentHourStart - (i + 1) * HOUR) // newest first
    return { start, date: new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate())), hour: start.getUTCHours() }
  })
  const groups = await prisma.amazonAdsHourlyPerformance.groupBy({
    by: ['date', 'hour'],
    where: { entityType: 'CAMPAIGN', OR: hours.map((h) => ({ date: h.date, hour: h.hour })) },
    _sum: { costMicros: true },
  }).catch(() => [] as Array<{ date: Date; hour: number; _sum: { costMicros: bigint | null } }>)
  const day = (d: Date) => d.toISOString().slice(0, 10)
  for (const h of hours) {
    const g = groups.find((x) => x.hour === h.hour && day(x.date) === day(h.date))
    if (g) return { cents: microsToCents(g._sum.costMicros), hourStart: h.start }
  }
  return { cents: 0, hourStart: null }
}

export async function runAnomalyGuardOnce(opts: { now?: Date } = {}): Promise<AnomalyGuardResult> {
  // AX2.9 — ride this cron to self-check the sync spine (report-only; a stale
  // sync must never halt automation the way a spend runaway does). Failures
  // here can never break the guard itself.
  void import('./ads-sync-integrity.service.js')
    .then((m) => m.runSyncIntegrityCheck())
    .catch(() => { /* integrity reporting is best-effort */ })

  const now = opts.now ?? new Date()
  const state = await getAutomationState()
  const maxActions = state.maxActionsPerHour ?? DEFAULT_MAX_ACTIONS_PER_HOUR
  const maxSpend = state.maxHourlySpendCentsEur ?? DEFAULT_MAX_HOURLY_SPEND_CENTS
  const since = new Date(now.getTime() - HOUR)

  // Signal 1 — automation action volume (advertising rule executions) this hour.
  const actionsLastHour = await prisma.automationRuleExecution.count({
    where: { startedAt: { gte: since }, status: { in: ['SUCCESS', 'PARTIAL'] }, rule: { domain: 'advertising' } },
  }).catch(() => 0)

  const engineWritesLastHour = await engineWritesSince(since)

  // Signal 3 — account ad spend in the latest complete hour (0 until AMS data flows, so this signal activates
  // automatically once it does). Summed across markets as € — currency conversion is a separate fix.
  const spend = await latestCompleteHourSpend(now)
  const spendLastHourCents = spend.cents
  const spendHour = spend.hourStart?.toISOString() ?? null

  const thresholds = { maxActionsPerHour: maxActions, maxHourlySpendCentsEur: maxSpend }
  if (state.effectivelyStopped) {
    // Already halted/off — nothing to trip; just record the check.
    await markGuardChecked()
    return { checked: true, tripped: false, actionsLastHour, engineWritesLastHour, spendLastHourCents, spendHour, thresholds, alreadyStopped: true }
  }

  let reason: string | undefined
  const overLimit = engineWritesLastHour.filter((e) => e.writes > e.limit)
  if (actionsLastHour > maxActions) {
    reason = `Automation rules acted ${fmt(actionsLastHour)} times in the last hour (limit ${fmt(maxActions)} an hour).`
  } else if (overLimit.length) {
    reason = overLimit
      .sort((a, b) => b.writes / b.limit - a.writes / a.limit)
      .map((e) => (e.engine === 'unknown'
        ? `${fmt(e.writes)} ad changes in the last hour came from no known automation (limit ${fmt(e.limit)} an hour).`
        : `${e.label} made ${fmt(e.writes)} ad changes in the last hour (limit ${fmt(e.limit)} an hour).`))
      .join(' ')
  } else if (maxSpend > 0 && spendLastHourCents > maxSpend && spend.hourStart) {
    const from = spend.hourStart.toISOString().slice(11, 16)
    reason = `Ad spend was €${(spendLastHourCents / 100).toFixed(0)} in the hour from ${from} UTC (limit €${(maxSpend / 100).toFixed(0)} an hour).`
  }

  const tripped = reason != null
  if (reason) {
    await haltAutomation(reason, 'auto:anomaly-guard')
    logger.warn('[ads-anomaly-guard] TRIPPED', {
      reason, actionsLastHour, spendLastHourCents, spendHour,
      engineWrites: Object.fromEntries(engineWritesLastHour.filter((e) => e.writes > 0).map((e) => [e.engine, e.writes])),
    })
  } else {
    await markGuardChecked()
  }
  return { checked: true, tripped, reason, actionsLastHour, engineWritesLastHour, spendLastHourCents, spendHour, thresholds, alreadyStopped: false }
}

/** The cron run's one-line summary (the scheduled tick and Run now print the same line). */
export function anomalyGuardSummary(r: AnomalyGuardResult): string {
  const top = r.engineWritesLastHour[0]
  const busiest = top && top.writes > 0 ? `${top.engine}:${top.writes}/${top.limit}` : 'none'
  const hour = r.spendHour ? ` (hour ${r.spendHour.slice(11, 16)} UTC)` : ''
  return `tripped=${r.tripped} rule-actions/h=${r.actionsLastHour}/${r.thresholds.maxActionsPerHour} busiest-engine/h=${busiest} spend/h=${r.spendLastHourCents}/${r.thresholds.maxHourlySpendCentsEur}c${hour}${r.reason ? ' reason=' + r.reason : ''}`
}
