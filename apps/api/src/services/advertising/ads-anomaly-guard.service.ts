/**
 * TD.0 — anomaly circuit-breaker. A safety net ABOVE the per-rule caps: if the
 * automation engine as a whole goes runaway — too many actions/hour (a
 * misconfigured rule firing in a loop) or ad spend spiking in the trailing hour
 * — it trips a global halt (AdsAutomationState) and notifies operators, so a
 * 24/7 agent can never quietly burn the account. Idempotent; runs on a cron.
 */
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { microsToCents } from './ads-metrics-math.js'
import { getAutomationState, haltAutomation, markGuardChecked } from './ads-automation-state.service.js'

const DEFAULT_MAX_ACTIONS_PER_HOUR = 250
const DEFAULT_MAX_HOURLY_SPEND_CENTS = 50_000 // €500/hr account-wide

export interface AnomalyGuardResult {
  checked: true
  tripped: boolean
  reason?: string
  actionsLastHour: number
  spendLastHourCents: number
  thresholds: { maxActionsPerHour: number; maxHourlySpendCentsEur: number }
  alreadyStopped: boolean
}

export async function runAnomalyGuardOnce(): Promise<AnomalyGuardResult> {
  const state = await getAutomationState()
  const maxActions = state.maxActionsPerHour ?? DEFAULT_MAX_ACTIONS_PER_HOUR
  const maxSpend = state.maxHourlySpendCentsEur ?? DEFAULT_MAX_HOURLY_SPEND_CENTS
  const since = new Date(Date.now() - 60 * 60 * 1000)

  // Signal 1 — automation action volume (advertising rule executions) this hour.
  const actionsLastHour = await prisma.automationRuleExecution.count({
    where: { startedAt: { gte: since }, status: { in: ['SUCCESS', 'PARTIAL'] }, rule: { domain: 'advertising' } },
  }).catch(() => 0)

  // Signal 2 — account ad spend in the current hour (intraday hourly store; 0
  // until AMS data flows, so this signal activates automatically once it does).
  const nowUtc = new Date()
  const todayUtc = new Date(Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), nowUtc.getUTCDate()))
  const spendAgg = await prisma.amazonAdsHourlyPerformance.aggregate({
    where: { entityType: 'CAMPAIGN', date: todayUtc, hour: nowUtc.getUTCHours() },
    _sum: { costMicros: true },
  }).catch(() => null)
  const spendLastHourCents = microsToCents(spendAgg?._sum.costMicros)

  let tripped = false
  let reason: string | undefined
  if (state.effectivelyStopped) {
    // Already halted/off — nothing to trip; just record the check.
    await markGuardChecked()
    return { checked: true, tripped: false, actionsLastHour, spendLastHourCents, thresholds: { maxActionsPerHour: maxActions, maxHourlySpendCentsEur: maxSpend }, alreadyStopped: true }
  }
  if (actionsLastHour > maxActions) {
    tripped = true; reason = `Automation runaway: ${actionsLastHour} actions in the last hour (limit ${maxActions}).`
  } else if (maxSpend > 0 && spendLastHourCents > maxSpend) {
    tripped = true; reason = `Ad-spend spike: €${(spendLastHourCents / 100).toFixed(0)} this hour (limit €${(maxSpend / 100).toFixed(0)}).`
  }

  if (tripped && reason) {
    await haltAutomation(reason, 'auto:anomaly-guard')
    logger.warn('[ads-anomaly-guard] TRIPPED', { reason, actionsLastHour, spendLastHourCents })
  } else {
    await markGuardChecked()
  }
  return { checked: true, tripped, reason, actionsLastHour, spendLastHourCents, thresholds: { maxActionsPerHour: maxActions, maxHourlySpendCentsEur: maxSpend }, alreadyStopped: false }
}
