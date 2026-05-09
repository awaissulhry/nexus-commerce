/**
 * W4.6 — Automation rule evaluator cron.
 *
 * Walks enabled rules grouped by trigger, builds the appropriate
 * trigger payload, and fans the evaluator across each context.
 *
 * Schedule: every 15 minutes by default (override via
 * NEXUS_AUTOMATION_RULE_SCHEDULE). Default-OFF in dev — opt in via
 * NEXUS_ENABLE_AUTOMATION_RULE_CRON=1. Even when on, every rule
 * defaults to dryRun=true so a fresh seed produces only audit rows.
 *
 * Triggers handled in this commit:
 *
 *   recommendation_generated
 *     Context per ACTIVE recommendation generated since the previous
 *     run. Carries recommendation + product + (optional) supplier.
 *     Used by templates 1, 5 (auto-approve, overstock-protection).
 *
 *   stockout_imminent
 *     Context per ACTIVE recommendation with urgency='CRITICAL' +
 *     daysOfStockLeft < 3. Used by template 3.
 *
 *   cron_tick
 *     Context per active product (one per cron firing). Used by
 *     templates 7, 8 (auto-markdown, auto-disposal). Carries product
 *     + the latest ACTIVE recommendation if any.
 *
 * Other triggers — recommendation_approved, demand_spike_detected,
 * imbalance_detected — need event hooks (W4.7) or detector services
 * (W4.9 / W4.10). Today this cron is a no-op for those.
 */

import cron from 'node-cron'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { evaluateAllRulesForTrigger } from '../services/automation-rule.service.js'
import { detectDemandSpikes } from '../services/demand-spike-detector.service.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null
let lastRunAt: Date | null = null
let lastSummary: string | null = null

interface RecommendationContext {
  recommendation: {
    id: string
    sku: string
    urgency: string
    needsReorder: boolean
    daysOfStockLeft: number | null
    reorderQuantity: number
    totalCents: number | null
  }
  product: {
    id: string
    sku: string
    abcClass: string | null
    daysOfStockLeft: number | null
  }
  supplier: {
    id: string | null
    name: string | null
    autoTriggerEnabled: boolean
  } | null
}

interface ProductCronTickContext {
  product: {
    id: string
    sku: string
    abcClass: string | null
    daysOfStockLeft: number | null
    daysSinceLastMovement: number | null
  }
  recommendation: RecommendationContext['recommendation'] | null
}

/**
 * Build a recommendation-shaped context bag from a recommendation
 * row + its product + (optional) primary supplier. Pure given inputs.
 */
function buildRecContext(args: {
  rec: {
    id: string
    productId: string
    sku: string
    urgency: string
    needsReorder: boolean
    daysOfStockLeft: number | null
    reorderQuantity: number
    unitCostCents: number | null
    landedCostPerUnitCents: number | null
  }
  product: { id: string; sku: string; abcClass: string | null }
  supplier: { id: string; name: string; autoTriggerEnabled: boolean } | null
}): RecommendationContext {
  const unitCostCents = args.rec.landedCostPerUnitCents ?? args.rec.unitCostCents ?? null
  const totalCents =
    unitCostCents != null ? unitCostCents * args.rec.reorderQuantity : null
  return {
    recommendation: {
      id: args.rec.id,
      sku: args.rec.sku,
      urgency: args.rec.urgency,
      needsReorder: args.rec.needsReorder,
      daysOfStockLeft: args.rec.daysOfStockLeft,
      reorderQuantity: args.rec.reorderQuantity,
      totalCents,
    },
    product: {
      id: args.product.id,
      sku: args.product.sku,
      abcClass: args.product.abcClass,
      daysOfStockLeft: args.rec.daysOfStockLeft,
    },
    supplier: args.supplier
      ? {
          id: args.supplier.id,
          name: args.supplier.name,
          autoTriggerEnabled: args.supplier.autoTriggerEnabled,
        }
      : null,
  }
}

/**
 * Run one tick: evaluate every enabled rule across the appropriate
 * trigger payloads. Returns a summary string for the CronRun row.
 */
export async function runAutomationRuleEvaluatorOnce(): Promise<string> {
  const since = lastRunAt ?? new Date(Date.now() - 30 * 60 * 1000) // 30m fallback
  const startedAt = Date.now()

  const counts = {
    recommendation_generated: 0,
    stockout_imminent: 0,
    cron_tick: 0,
    demand_spike_detected: 0,
  }
  const matched = {
    recommendation_generated: 0,
    stockout_imminent: 0,
    cron_tick: 0,
    demand_spike_detected: 0,
  }

  // ── recommendation_generated ────────────────────────────────────
  // Hydrate rec + product + primary supplier in one shot.
  const newRecs = await prisma.replenishmentRecommendation.findMany({
    where: { status: 'ACTIVE', generatedAt: { gte: since } },
    select: {
      id: true,
      productId: true,
      sku: true,
      urgency: true,
      needsReorder: true,
      daysOfStockLeft: true,
      reorderQuantity: true,
      unitCostCents: true,
      landedCostPerUnitCents: true,
    },
    take: 5000,
  })

  if (newRecs.length > 0) {
    const productIds = Array.from(new Set(newRecs.map((r) => r.productId)))
    const products = await prisma.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, sku: true, abcClass: true },
    })
    const productById = new Map(products.map((p) => [p.id, p]))

    const supplierLinks = await prisma.supplierProduct.findMany({
      where: { productId: { in: productIds }, isPrimary: true },
      select: {
        productId: true,
        supplier: { select: { id: true, name: true, autoTriggerEnabled: true } },
      },
    })
    const supplierByProduct = new Map(
      supplierLinks.map((sl) => [sl.productId, sl.supplier]),
    )

    for (const rec of newRecs) {
      const product = productById.get(rec.productId)
      if (!product) continue
      const supplier = supplierByProduct.get(rec.productId) ?? null
      const ctx = buildRecContext({ rec, product, supplier })

      const results = await evaluateAllRulesForTrigger({
        domain: 'replenishment',
        trigger: 'recommendation_generated',
        context: ctx,
      })
      counts.recommendation_generated += results.length
      matched.recommendation_generated += results.filter((r) => r.matched).length

      // Stockout-imminent piggy-backs on the same rec walk so we
      // don't run the same query twice.
      if (rec.urgency === 'CRITICAL' && (rec.daysOfStockLeft ?? Infinity) < 3) {
        const sResults = await evaluateAllRulesForTrigger({
          domain: 'replenishment',
          trigger: 'stockout_imminent',
          context: ctx,
        })
        counts.stockout_imminent += sResults.length
        matched.stockout_imminent += sResults.filter((r) => r.matched).length
      }
    }
  }

  // ── cron_tick (per-product) ─────────────────────────────────────
  // Only fire if at least one cron_tick rule is enabled — otherwise
  // we'd walk 3K products for nothing.
  const cronTickRuleCount = await prisma.automationRule.count({
    where: { domain: 'replenishment', trigger: 'cron_tick', enabled: true },
  })

  if (cronTickRuleCount > 0) {
    const products = await prisma.product.findMany({
      where: { isParent: false, status: 'ACTIVE' },
      select: { id: true, sku: true, abcClass: true },
      take: 5000,
    })
    const productIds = products.map((p) => p.id)
    const recs = await prisma.replenishmentRecommendation.findMany({
      where: { status: 'ACTIVE', productId: { in: productIds } },
      select: {
        id: true,
        productId: true,
        sku: true,
        urgency: true,
        needsReorder: true,
        daysOfStockLeft: true,
        reorderQuantity: true,
        unitCostCents: true,
        landedCostPerUnitCents: true,
      },
    })
    const recByProduct = new Map(recs.map((r) => [r.productId, r]))

    for (const product of products) {
      const rec = recByProduct.get(product.id)
      const ctx: ProductCronTickContext = {
        product: {
          id: product.id,
          sku: product.sku,
          abcClass: product.abcClass,
          daysOfStockLeft: rec?.daysOfStockLeft ?? null,
          // daysSinceLastMovement is computed in a follow-up — null
          // is treated as "unknown" by the operator dsl (op:'gte'
          // returns false against null, so disposal rule won't fire
          // against unmovement-unknown SKUs by default).
          daysSinceLastMovement: null,
        },
        recommendation: rec
          ? buildRecContext({
              rec,
              product,
              supplier: null,
            }).recommendation
          : null,
      }
      const results = await evaluateAllRulesForTrigger({
        domain: 'replenishment',
        trigger: 'cron_tick',
        context: ctx,
      })
      counts.cron_tick += results.length
      matched.cron_tick += results.filter((r) => r.matched).length
    }
  }

  // ── demand_spike_detected ────────────────────────────────────────
  // Only run the detector if at least one spike rule is enabled —
  // a full DailySalesAggregate scan per tick is wasted when nothing
  // can match.
  const spikeRuleCount = await prisma.automationRule.count({
    where: { domain: 'replenishment', trigger: 'demand_spike_detected', enabled: true },
  })
  if (spikeRuleCount > 0) {
    const spikes = await detectDemandSpikes()
    for (const spikeCtx of spikes) {
      const results = await evaluateAllRulesForTrigger({
        domain: 'replenishment',
        trigger: 'demand_spike_detected',
        context: spikeCtx,
      })
      counts.demand_spike_detected += results.length
      matched.demand_spike_detected += results.filter((r) => r.matched).length
    }
  }

  lastRunAt = new Date()
  const totalEvals =
    counts.recommendation_generated +
    counts.stockout_imminent +
    counts.cron_tick +
    counts.demand_spike_detected
  const totalMatches =
    matched.recommendation_generated +
    matched.stockout_imminent +
    matched.cron_tick +
    matched.demand_spike_detected
  const summary = `evals=${totalEvals} matches=${totalMatches} (rec_gen=${counts.recommendation_generated} stockout=${counts.stockout_imminent} cron_tick=${counts.cron_tick} spike=${counts.demand_spike_detected}) durationMs=${Date.now() - startedAt}`
  lastSummary = summary
  return summary
}

export async function runAutomationRuleCronOnce(): Promise<void> {
  try {
    await recordCronRun('automation-rule-evaluator', async () => {
      const summary = await runAutomationRuleEvaluatorOnce()
      logger.info('automation-rule-evaluator cron: completed', { summary })
      return summary
    })
  } catch (err) {
    logger.error('automation-rule-evaluator cron: failure', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function startAutomationRuleEvaluatorCron(): void {
  if (scheduledTask) {
    logger.warn('automation-rule-evaluator cron already started')
    return
  }
  const schedule = process.env.NEXUS_AUTOMATION_RULE_SCHEDULE ?? '*/15 * * * *'
  if (!cron.validate(schedule)) {
    logger.error('automation-rule-evaluator cron: invalid schedule', { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, () => {
    void runAutomationRuleCronOnce()
  })
  logger.info('automation-rule-evaluator cron: scheduled', { schedule })
}

export function stopAutomationRuleEvaluatorCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}

export function getAutomationRuleCronStatus(): {
  scheduled: boolean
  lastRunAt: Date | null
  lastSummary: string | null
} {
  return {
    scheduled: scheduledTask !== null,
    lastRunAt,
    lastSummary,
  }
}
