/**
 * SR.3 — Review-domain trigger context builder + cron tick.
 *
 * Handles one trigger:
 *
 *   REVIEW_SPIKE_DETECTED
 *     Per OPEN ReviewSpike row. Carries the spike metadata + the
 *     linked product (if any). Rules in domain='reviews' are evaluated
 *     against each context; marketplace scoping is respected.
 *
 * Gated by NEXUS_ENABLE_REVIEW_INGEST=1 (same flag as the ingest/spike
 * detector croons so a single env var turns the whole SR-series on).
 */

import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { evaluateAllRulesForTrigger } from '../services/automation-rule.service.js'
import cron from 'node-cron'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null
let lastRunAt: Date | null = null
let lastSummary: string | null = null

interface ReviewSpikeContext {
  trigger: 'REVIEW_SPIKE_DETECTED'
  marketplace: string
  spike: {
    id: string
    category: string
    spikeMultiplier: string | null
    sampleTopPhrases: string[]
    rate7dNumerator: number
    rate7dDenominator: number
    rate28dNumerator: number
    rate28dDenominator: number
    detectedAt: Date
  }
  product: {
    id: string
    sku: string
    name: string
    productType: string | null
  } | null
}

async function buildReviewSpikeContexts(): Promise<ReviewSpikeContext[]> {
  const spikes = await prisma.reviewSpike.findMany({
    where: { status: 'OPEN' },
    orderBy: { detectedAt: 'desc' },
    take: 500,
    select: {
      id: true,
      marketplace: true,
      category: true,
      spikeMultiplier: true,
      sampleTopPhrases: true,
      rate7dNumerator: true,
      rate7dDenominator: true,
      rate28dNumerator: true,
      rate28dDenominator: true,
      detectedAt: true,
      productId: true,
      product: {
        select: { id: true, sku: true, name: true, productType: true },
      },
    },
  })

  return spikes.map((s) => ({
    trigger: 'REVIEW_SPIKE_DETECTED' as const,
    marketplace: s.marketplace,
    spike: {
      id: s.id,
      category: s.category,
      spikeMultiplier: s.spikeMultiplier != null ? String(s.spikeMultiplier) : null,
      sampleTopPhrases: s.sampleTopPhrases,
      rate7dNumerator: s.rate7dNumerator,
      rate7dDenominator: s.rate7dDenominator,
      rate28dNumerator: s.rate28dNumerator,
      rate28dDenominator: s.rate28dDenominator,
      detectedAt: s.detectedAt,
    },
    product: s.product ?? null,
  }))
}

export async function runReviewRuleEvaluatorOnce(): Promise<{
  spikeContexts: number
  totalEvaluations: number
  totalMatches: number
  durationMs: number
}> {
  const startedAt = Date.now()
  const spikeContexts = await buildReviewSpikeContexts()

  let totalEvaluations = 0
  let totalMatches = 0

  for (const ctx of spikeContexts) {
    const rules = await prisma.automationRule.findMany({
      where: {
        domain: 'reviews',
        trigger: 'REVIEW_SPIKE_DETECTED',
        enabled: true,
        OR: [{ scopeMarketplace: null }, { scopeMarketplace: ctx.marketplace }],
      },
      select: { id: true },
    })
    if (rules.length === 0) continue
    const results = await evaluateAllRulesForTrigger({
      domain: 'reviews',
      trigger: 'REVIEW_SPIKE_DETECTED',
      context: ctx,
    })
    totalEvaluations += results.length
    totalMatches += results.filter((r) => r.matched).length
  }

  const durationMs = Date.now() - startedAt
  lastRunAt = new Date()
  lastSummary = `spikes=${spikeContexts.length} evals=${totalEvaluations} matches=${totalMatches} durationMs=${durationMs}`
  return { spikeContexts: spikeContexts.length, totalEvaluations, totalMatches, durationMs }
}

export async function runReviewRuleEvaluatorCron(): Promise<void> {
  try {
    await recordCronRun('review-rule-evaluator', async () => {
      const summary = await runReviewRuleEvaluatorOnce()
      logger.info('review-rule-evaluator cron: completed', { summary })
      return lastSummary ?? 'no-summary'
    })
  } catch (err) {
    logger.error('review-rule-evaluator cron: failure', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function startReviewRuleEvaluatorCron(): void {
  if (scheduledTask) {
    logger.warn('review-rule-evaluator cron already started')
    return
  }
  const schedule = process.env.NEXUS_REVIEW_RULE_SCHEDULE ?? '*/15 * * * *'
  if (!cron.validate(schedule)) {
    logger.error('review-rule-evaluator cron: invalid schedule', { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, () => {
    void runReviewRuleEvaluatorCron()
  })
  logger.info('review-rule-evaluator cron: scheduled', { schedule })
}

export function stopReviewRuleEvaluatorCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}

export function getReviewRuleEvaluatorStatus(): {
  scheduled: boolean
  lastRunAt: Date | null
  lastSummary: string | null
} {
  return { scheduled: scheduledTask != null, lastRunAt, lastSummary }
}
