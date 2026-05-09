/**
 * AI-1.3 — pre-call cost ceiling enforcement across four horizons.
 *
 *   per-call:    one outgoing AI call vs NEXUS_AI_PER_CALL_USD_MAX
 *   per-wizard:  total spend on a single ListingWizard vs MAX
 *   per-day:     last-24h spend across all features vs MAX
 *   per-month:   last-30d spend across all features vs MAX
 *
 * Pre-call: the budget read happens BEFORE the vendor call so we
 * never burn money on a call we'd refuse anyway. Token counts are
 * estimated from the prompt + maxOutputTokens; tokenisation skews
 * for non-English content over-estimate input cost (good — safe
 * direction for a budget gate), but the per-call horizon is purely
 * about catching obviously oversized calls (giant prompts, max_tokens
 * cranked up). Per-wizard / per-day / per-month read AiUsageLog —
 * exact, not estimated.
 *
 * Env-driven: this is the BLOCKING-foundation commit before DB-backed
 * AiBudget rows ship in AI-1.1 (deferred while a concurrent agent's
 * schema work is uncommitted). Default ceilings:
 *   per-call:  $0.50  — catches a single oversized call
 *   per-wizard: $2.00 — caps spend on a single product publish
 *   per-day:   $50.00 — catches runaway spend on a bad day
 *   per-month: $500   — global ceiling
 * All overridable via env. Setting any to '0' disables that horizon
 * (useful in dev / load-tests). Unsetting an env keeps the default.
 *
 * Soft warn at 90%: callers can render a "you've used 90% of today's
 * budget" hint without refusing the call. Wired through hitWarn in
 * the result.
 *
 * Failure mode: if the AiUsageLog read errors (DB hiccup), we
 * fail OPEN (allow the call) rather than risk stranding the operator
 * mid-wizard. The kill switch is the right tool for "no spending
 * today, no exceptions"; budget enforcement is best-effort cost
 * containment, not authorisation.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import {
  estimateInputTokens,
  priceFor,
  type RateCard,
} from './rate-cards.js'
import type { ProviderName } from './providers/types.js'

const DEFAULTS = {
  perCallUSD: 0.5,
  perWizardUSD: 2.0,
  perDayUSD: 50.0,
  perMonthUSD: 500.0,
} as const

// 90% threshold — surface a soft-warn before the hard refuse.
const WARN_RATIO = 0.9

function readEnvUSD(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw == null) return fallback
  const trimmed = raw.trim()
  if (trimmed === '') return fallback
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed) || parsed < 0) return fallback
  return parsed
}

export interface BudgetLimits {
  perCallUSD: number
  perWizardUSD: number
  perDayUSD: number
  perMonthUSD: number
}

export function readBudgetLimits(): BudgetLimits {
  return {
    perCallUSD: readEnvUSD('NEXUS_AI_PER_CALL_USD_MAX', DEFAULTS.perCallUSD),
    perWizardUSD: readEnvUSD(
      'NEXUS_AI_PER_WIZARD_USD_MAX',
      DEFAULTS.perWizardUSD,
    ),
    perDayUSD: readEnvUSD('NEXUS_AI_PER_DAY_USD_MAX', DEFAULTS.perDayUSD),
    perMonthUSD: readEnvUSD(
      'NEXUS_AI_PER_MONTH_USD_MAX',
      DEFAULTS.perMonthUSD,
    ),
  }
}

export interface BudgetCheckScope {
  /** Telemetry tag (matches AiUsageLog.feature). Required so warn
   *  messages name the feature the operator triggered. */
  feature: string
  /** ListingWizard id when the call belongs to a wizard. Drives the
   *  per-wizard horizon read. */
  wizardId?: string
  /** Optional user id, reserved for per-user horizons in a follow-up. */
  userId?: string
}

export interface BudgetCheckResult {
  /** false → caller MUST refuse the AI call. */
  allowed: boolean
  /** Categorical reason when allowed=false. Examples: 'per_call',
   *  'per_wizard', 'per_day', 'per_month'. */
  reason?: 'per_call' | 'per_wizard' | 'per_day' | 'per_month'
  /** Human-readable explanation surfaced in error toasts. */
  message?: string
  /** Soft signal: spend is at or above 90% of one of the horizons.
   *  Caller can show a banner without blocking. */
  hitWarn?: 'per_wizard' | 'per_day' | 'per_month'
  /** Snapshot of the four horizons after this call, for telemetry /
   *  UI display. costUSD values include the estimateUSD that was
   *  about to be spent. */
  spendSnapshotUSD: {
    estimate: number
    perWizard?: number
    perDay: number
    perMonth: number
  }
  /** Limits that were applied for this check. */
  limits: BudgetLimits
}

export interface EstimateInput {
  prompt: string
  maxOutputTokens: number
  provider: ProviderName
  model: string
}

export function estimateCallCostUSD(input: EstimateInput): number {
  const inputTokens = estimateInputTokens(input.prompt)
  const outputTokens = input.maxOutputTokens
  return priceFor(input.provider, input.model, inputTokens, outputTokens)
}

async function sumCostUSD(where: Parameters<typeof prisma.aiUsageLog.aggregate>[0]['where']): Promise<number> {
  try {
    const r = await prisma.aiUsageLog.aggregate({
      where,
      _sum: { costUSD: true },
    })
    return Number(r._sum.costUSD ?? 0)
  } catch (err) {
    logger.warn('budget-service: aiUsageLog read failed (failing open)', {
      err: err instanceof Error ? err.message : String(err),
    })
    return 0
  }
}

/**
 * Check whether an outgoing AI call fits within the configured budget
 * across all four horizons. Pre-call: caller passes the estimated
 * USD cost; the service reads AiUsageLog for past spend on each
 * horizon, sums in the estimate, and compares against the env-driven
 * ceiling.
 *
 * Returns the first horizon that would be exceeded (per-call → per-
 * wizard → per-day → per-month). Soft-warn fires when the estimate
 * lands inside [90%, 100%) of any non-call horizon.
 *
 * Limit value of 0 disables the horizon (any spend allowed). Useful
 * in dev / load tests where the env-driven defaults would otherwise
 * choke fixtures.
 */
export async function checkBudget(
  estimateUSD: number,
  scope: BudgetCheckScope,
): Promise<BudgetCheckResult> {
  const limits = readBudgetLimits()

  // 1. Per-call — synchronous, no DB hit.
  if (limits.perCallUSD > 0 && estimateUSD > limits.perCallUSD) {
    return {
      allowed: false,
      reason: 'per_call',
      message: `Single AI call estimate $${estimateUSD.toFixed(4)} exceeds NEXUS_AI_PER_CALL_USD_MAX=$${limits.perCallUSD.toFixed(2)}.`,
      spendSnapshotUSD: {
        estimate: estimateUSD,
        perDay: 0,
        perMonth: 0,
      },
      limits,
    }
  }

  // 2. Per-wizard / per-day / per-month — DB-backed.
  const now = new Date()
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

  const reads: Array<Promise<unknown>> = [
    sumCostUSD({ createdAt: { gte: dayAgo } }),
    sumCostUSD({ createdAt: { gte: monthAgo } }),
  ]
  if (scope.wizardId && limits.perWizardUSD > 0) {
    reads.push(
      sumCostUSD({
        entityType: 'ListingWizard',
        entityId: scope.wizardId,
      }),
    )
  } else {
    reads.push(Promise.resolve(0))
  }

  const [perDay, perMonth, perWizard] = (await Promise.all(reads)) as [
    number,
    number,
    number,
  ]

  const perDayProjected = perDay + estimateUSD
  const perMonthProjected = perMonth + estimateUSD
  const perWizardProjected = scope.wizardId ? perWizard + estimateUSD : 0

  // 2a. Per-wizard hard refuse.
  if (
    scope.wizardId &&
    limits.perWizardUSD > 0 &&
    perWizardProjected > limits.perWizardUSD
  ) {
    return {
      allowed: false,
      reason: 'per_wizard',
      message: `Wizard AI spend $${perWizardProjected.toFixed(4)} would exceed NEXUS_AI_PER_WIZARD_USD_MAX=$${limits.perWizardUSD.toFixed(2)}.`,
      spendSnapshotUSD: {
        estimate: estimateUSD,
        perWizard: perWizardProjected,
        perDay: perDayProjected,
        perMonth: perMonthProjected,
      },
      limits,
    }
  }

  // 2b. Per-day hard refuse.
  if (limits.perDayUSD > 0 && perDayProjected > limits.perDayUSD) {
    return {
      allowed: false,
      reason: 'per_day',
      message: `Today's AI spend $${perDayProjected.toFixed(4)} would exceed NEXUS_AI_PER_DAY_USD_MAX=$${limits.perDayUSD.toFixed(2)}.`,
      spendSnapshotUSD: {
        estimate: estimateUSD,
        perWizard: scope.wizardId ? perWizardProjected : undefined,
        perDay: perDayProjected,
        perMonth: perMonthProjected,
      },
      limits,
    }
  }

  // 2c. Per-month hard refuse.
  if (limits.perMonthUSD > 0 && perMonthProjected > limits.perMonthUSD) {
    return {
      allowed: false,
      reason: 'per_month',
      message: `This month's AI spend $${perMonthProjected.toFixed(4)} would exceed NEXUS_AI_PER_MONTH_USD_MAX=$${limits.perMonthUSD.toFixed(2)}.`,
      spendSnapshotUSD: {
        estimate: estimateUSD,
        perWizard: scope.wizardId ? perWizardProjected : undefined,
        perDay: perDayProjected,
        perMonth: perMonthProjected,
      },
      limits,
    }
  }

  // 3. Soft warns at 90%. First horizon that crosses the threshold
  //    wins (per-wizard → per-day → per-month) so the message is
  //    specific.
  let hitWarn: BudgetCheckResult['hitWarn'] | undefined
  if (
    scope.wizardId &&
    limits.perWizardUSD > 0 &&
    perWizardProjected >= limits.perWizardUSD * WARN_RATIO
  ) {
    hitWarn = 'per_wizard'
  } else if (
    limits.perDayUSD > 0 &&
    perDayProjected >= limits.perDayUSD * WARN_RATIO
  ) {
    hitWarn = 'per_day'
  } else if (
    limits.perMonthUSD > 0 &&
    perMonthProjected >= limits.perMonthUSD * WARN_RATIO
  ) {
    hitWarn = 'per_month'
  }

  return {
    allowed: true,
    hitWarn,
    spendSnapshotUSD: {
      estimate: estimateUSD,
      perWizard: scope.wizardId ? perWizardProjected : undefined,
      perDay: perDayProjected,
      perMonth: perMonthProjected,
    },
    limits,
  }
}

/** Re-export for callers that need to display the rate card. */
export type { RateCard }
