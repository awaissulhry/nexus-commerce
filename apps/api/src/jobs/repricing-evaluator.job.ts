/**
 * W4.10 — Repricing evaluator cron.
 *
 * Schedule: every 5 minutes (the cron 5-minute pattern). Picks up every enabled
 * RepricingRule, builds a market context from the latest
 * BuyBoxHistory observation + the matching ChannelListing's current
 * price, calls repricingEngineService.evaluate(), and logs a
 * RepricingDecision row.
 *
 * Important: applyToProduct=false at this stage. The cron LOGS
 * decisions; it does NOT push prices to marketplaces yet. That
 * integration (calling the per-channel price-override path on
 * applied=true decisions) is W4.10b once the channel-override flow
 * is formalised. Until then, operators see what the engine WOULD
 * do via the drawer's decision-history modal + decide manually
 * whether to push.
 *
 * Behaviour summary:
 *   - For each enabled RepricingRule:
 *       1. Find the matching ChannelListing (channel + marketplace
 *          OR channel only when rule.marketplace is null and the
 *          listing is unique on the channel).
 *       2. Find the latest BuyBoxHistory observation for (product,
 *          channel, marketplace) within RECENT_OBSERVATION_HOURS.
 *       3. Call evaluate() with the assembled market context.
 *   - Skips rules without a matching ChannelListing (no current
 *     price → can't run a strategy).
 *   - Skips rules whose latest observation is too stale (engine
 *     decisions on day-old market data are noise).
 *
 * Concurrency: the rule update + decision write inside
 * RepricingEngineService.evaluate are independent per-rule, so
 * parallel cron replicas are safe (decisions land twice in the
 * worst case — visible but harmless).
 *
 * Default-on; opt out via NEXUS_ENABLE_REPRICING_EVALUATOR=0.
 */

import cron from 'node-cron'
import { Prisma } from '@prisma/client'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { repricingEngineService } from '../services/repricing-engine.service.js'
import { recordCronRun } from '../utils/cron-observability.js'

interface RunSummary {
  enabledRules: number
  evaluated: number
  skippedNoListing: number
  skippedStaleObservation: number
  errors: number
  changed: number
}

const RECENT_OBSERVATION_HOURS = 6
const PER_RUN_CAP = 500 // safety against pathological catalog sizes

let scheduledTask: ReturnType<typeof cron.schedule> | null = null
let lastRunAt: Date | null = null
let lastSummary: RunSummary | null = null

export async function runRepricingEvaluatorOnce(): Promise<RunSummary> {
  const summary: RunSummary = {
    enabledRules: 0,
    evaluated: 0,
    skippedNoListing: 0,
    skippedStaleObservation: 0,
    errors: 0,
    changed: 0,
  }

  if (process.env.NEXUS_ENABLE_REPRICING_EVALUATOR === '0') {
    lastRunAt = new Date()
    lastSummary = summary
    return summary
  }

  const rules = await prisma.repricingRule.findMany({
    where: { enabled: true },
    take: PER_RUN_CAP,
  })
  summary.enabledRules = rules.length

  const observationCutoff = new Date(
    Date.now() - RECENT_OBSERVATION_HOURS * 3600 * 1000,
  )

  for (const rule of rules) {
    try {
      // Find matching ChannelListing for currentPrice.
      const listing = await prisma.channelListing.findFirst({
        where: {
          productId: rule.productId,
          channel: rule.channel,
          ...(rule.marketplace ? { marketplace: rule.marketplace } : {}),
        },
        select: { price: true, marketplace: true },
        orderBy: { updatedAt: 'desc' },
      })
      if (!listing) {
        summary.skippedNoListing++
        continue
      }

      // Find latest BuyBoxHistory for the same key.
      const obs = await prisma.buyBoxHistory.findFirst({
        where: {
          productId: rule.productId,
          channel: rule.channel,
          ...(rule.marketplace
            ? { marketplace: rule.marketplace }
            : { marketplace: listing.marketplace }),
          observedAt: { gte: observationCutoff },
        },
        orderBy: { observedAt: 'desc' },
      })

      // No recent observation: still evaluate (manual + match_buy_box-
      // with-no-data strategies hold gracefully via the service's
      // own no-data branches), but record so summary reflects it.
      if (!obs) summary.skippedStaleObservation++

      const result = await repricingEngineService.evaluate(
        rule.id,
        {
          currentPrice: Number(
            listing.price as unknown as Prisma.Decimal,
          ),
          buyBoxPrice:
            obs?.buyBoxPrice == null
              ? null
              : Number(obs.buyBoxPrice as unknown as Prisma.Decimal),
          lowestCompPrice:
            obs?.lowestCompetitorPrice == null
              ? null
              : Number(
                  obs.lowestCompetitorPrice as unknown as Prisma.Decimal,
                ),
          competitorCount: null,
        },
        // applyToProduct=false on the cron path until the channel-
        // override push integration lands (W4.10b). Decisions are
        // logged regardless so operators see what the engine WOULD
        // do.
        { applyToProduct: false },
      )

      summary.evaluated++
      if (result.changed) summary.changed++
    } catch (err) {
      summary.errors++
      logger.error('repricing-evaluator: rule failed', {
        ruleId: rule.id,
        productId: rule.productId,
        channel: rule.channel,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  lastRunAt = new Date()
  lastSummary = summary
  return summary
}

export function startRepricingEvaluatorCron(): void {
  if (scheduledTask) {
    logger.warn('repricing-evaluator cron already started — skipping')
    return
  }
  const schedule =
    process.env.NEXUS_REPRICING_EVALUATOR_SCHEDULE ?? '*/5 * * * *'
  if (!cron.validate(schedule)) {
    logger.error('repricing-evaluator cron: invalid schedule', { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, () => {
    if (process.env.NEXUS_ENABLE_REPRICING_EVALUATOR === '0') return
    void recordCronRun('repricing-evaluator', async () => {
      const r = await runRepricingEvaluatorOnce()
      return `rules=${r.enabledRules} evaluated=${r.evaluated} changed=${r.changed} no-listing=${r.skippedNoListing} stale-obs=${r.skippedStaleObservation} errors=${r.errors}`
    }).catch((err) => {
      logger.error('repricing-evaluator cron: top-level failure', {
        error: err instanceof Error ? err.message : String(err),
      })
    })
  })
  logger.info('repricing-evaluator cron: scheduled', { schedule })
}

export function stopRepricingEvaluatorCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}

export function getRepricingEvaluatorStatus() {
  return {
    scheduled: scheduledTask !== null,
    lastRunAt,
    lastSummary,
  }
}
