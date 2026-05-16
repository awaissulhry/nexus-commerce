/**
 * AD.4 — Composite "liquidate aged stock" flow.
 *
 * Implements the headline blueprint step for Pillar 2:
 *   "200 units of Summer Gloves in DE will incur LTS fees in 14 days
 *    → trigger a 15% Amazon DE promotion, pause Sponsored Display
 *    ads for the new gloves, and reroute 100% of German ad budget
 *    to liquidate aged stock before fees hit."
 *
 * Single transactional choreographer with three steps:
 *   1. Create RetailEvent + RetailEventPriceAction (markdown for the
 *      aged SKU's productType + marketplace). promotion-scheduler
 *      materializes ChannelListing.salePrice on its next tick.
 *   2. Pause Campaign rows that advertise the SAME productType in
 *      the SAME marketplace but for NEW (non-aged) products.
 *   3. Boost Campaign.dailyBudget for campaigns advertising the
 *      aged product, by the configured percent.
 *
 * Cross-marketplace budget reroute is intentionally OUT of scope for
 * AD.4 — that lands in AD.5's BudgetPool flow. AD.4 stays intra-
 * marketplace.
 *
 * Failure-mode strategy: each sub-step is independent and best-effort.
 * The function returns a SubAction[] array enumerating what actually
 * happened. Operators can rollback selectively via the
 * AdvertisingActionLog rows.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { updateCampaignWithSync, type AdsActor } from './ads-mutation.service.js'

export interface LiquidateInput {
  productId: string
  marketplace: string
  discountPct: number // typical 10–25
  durationDays: number // typical 7–14
  boostPercent: number // intra-marketplace budget boost for ads on aged SKU; default 25
  actor: AdsActor
  reason: string | null
  dryRun: boolean
  executionId: string | null
}

export interface LiquidateSubAction {
  step: 'create_retail_event' | 'pause_new_product_ads' | 'boost_aged_product_ads'
  ok: boolean
  error?: string
  output?: Record<string, unknown>
  /** Estimated EUR-cents this sub-action contributes to spend impact.
   *  Sums up for the engine's per-rule value cap when used as the
   *  liquidate_aged_stock action handler. */
  estimatedValueCentsEur: number
}

export interface LiquidateOutcome {
  ok: boolean
  subActions: LiquidateSubAction[]
  retailEventId: string | null
  pausedCampaignIds: string[]
  boostedCampaignIds: string[]
  actionLogIds: string[]
  totalEstimatedValueCentsEur: number
}

async function writeActionLog(args: {
  actor: AdsActor
  executionId: string | null
  actionType: string
  entityType: 'CAMPAIGN' | 'RETAIL_EVENT'
  entityId: string
  payloadBefore: object
  payloadAfter: object
  outboundQueueId: string | null
}): Promise<string> {
  const row = await prisma.advertisingActionLog.create({
    data: {
      executionId: args.executionId,
      userId: args.actor,
      actionType: args.actionType,
      entityType: args.entityType,
      entityId: args.entityId,
      payloadBefore: args.payloadBefore,
      payloadAfter: args.payloadAfter,
      outboundQueueId: args.outboundQueueId,
      amazonResponseStatus: args.outboundQueueId ? 'PENDING' : 'SUCCESS',
    },
    select: { id: true },
  })
  return row.id
}

// ── Step 1: create RetailEvent (markdown) ─────────────────────────────

async function createMarkdownEvent(
  input: LiquidateInput,
  product: { productType: string | null; sku: string },
): Promise<LiquidateSubAction & { retailEventId: string | null; actionLogId: string | null }> {
  if (!product.productType) {
    return {
      step: 'create_retail_event',
      ok: false,
      error: 'product.productType missing — RetailEvent is productType-scoped',
      estimatedValueCentsEur: 0,
      retailEventId: null,
      actionLogId: null,
    }
  }

  // Project revenue at stake — same heuristic as create_amazon_promotion
  // handler, kept independent so this service stands alone.
  let estimatedValueCentsEur = 0
  try {
    const recent = await prisma.productProfitDaily.aggregate({
      where: {
        productId: input.productId,
        marketplace: input.marketplace,
        date: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
      },
      _sum: { unitsSold: true, grossRevenueCents: true },
    })
    const units7d = recent._sum.unitsSold ?? 0
    const revenue7d = recent._sum.grossRevenueCents ?? 0
    if (units7d > 0 && revenue7d > 0) {
      const pricePerUnit = revenue7d / units7d
      const projectedUnits = (units7d / 7) * input.durationDays
      estimatedValueCentsEur = Math.round(
        projectedUnits * pricePerUnit * (input.discountPct / 100),
      )
    }
  } catch (err) {
    logger.warn('[liquidate] projection failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  if (input.dryRun) {
    return {
      step: 'create_retail_event',
      ok: true,
      output: {
        dryRun: true,
        wouldCreate: 'RetailEvent + RetailEventPriceAction',
        productType: product.productType,
        marketplace: input.marketplace,
        discountPct: input.discountPct,
        durationDays: input.durationDays,
      },
      estimatedValueCentsEur,
      retailEventId: null,
      actionLogId: null,
    }
  }

  const startAt = new Date()
  const endAt = new Date(startAt.getTime() + input.durationDays * 24 * 60 * 60 * 1000)
  const startDate = new Date(Date.UTC(startAt.getUTCFullYear(), startAt.getUTCMonth(), startAt.getUTCDate()))
  const endDate = new Date(Date.UTC(endAt.getUTCFullYear(), endAt.getUTCMonth(), endAt.getUTCDate()))

  try {
    const event = await prisma.$transaction(async (tx) => {
      const re = await tx.retailEvent.create({
        data: {
          name: `Liquidate aged stock (${product.sku}) — ${input.actor}`,
          startDate,
          endDate,
          marketplace: input.marketplace,
          productType: product.productType,
          source: 'AUTOMATION',
          description: `liquidate_aged_stock composite. discount=${input.discountPct}% duration=${input.durationDays}d.`,
        },
        select: { id: true },
      })
      await tx.retailEventPriceAction.create({
        data: {
          eventId: re.id,
          action: 'PERCENT_OFF',
          value: input.discountPct,
          marketplace: input.marketplace,
          productType: product.productType,
          setSalePriceFrom: startAt,
          setSalePriceUntil: endAt,
        },
      })
      return re
    })

    const actionLogId = await writeActionLog({
      actor: input.actor,
      executionId: input.executionId,
      actionType: 'liquidate_aged_stock:create_retail_event',
      entityType: 'RETAIL_EVENT',
      entityId: event.id,
      payloadBefore: { exists: false },
      payloadAfter: {
        productType: product.productType,
        marketplace: input.marketplace,
        discountPct: input.discountPct,
        durationDays: input.durationDays,
      },
      outboundQueueId: null,
    })

    return {
      step: 'create_retail_event',
      ok: true,
      output: { retailEventId: event.id, productType: product.productType, discountPct: input.discountPct },
      estimatedValueCentsEur,
      retailEventId: event.id,
      actionLogId,
    }
  } catch (err) {
    return {
      step: 'create_retail_event',
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      estimatedValueCentsEur: 0,
      retailEventId: null,
      actionLogId: null,
    }
  }
}

// ── Step 2: pause new-product ads ─────────────────────────────────────

async function pauseNewProductAds(
  input: LiquidateInput,
  agedProductId: string,
  productType: string | null,
): Promise<LiquidateSubAction & { pausedCampaignIds: string[]; actionLogIds: string[] }> {
  // Find campaigns in the same marketplace whose ad-groups advertise
  // products of the same productType but that are NOT the aged SKU.
  // "New" here = simply "any product that isn't the aged one"; an aged-
  // tier query would be more nuanced but this is the pragmatic AD.4
  // interpretation. AD.5+ refines using FbaStorageAge filtering.
  if (!productType) {
    return {
      step: 'pause_new_product_ads',
      ok: true,
      output: { skipped: 'no productType' },
      estimatedValueCentsEur: 0,
      pausedCampaignIds: [],
      actionLogIds: [],
    }
  }

  const candidates = await prisma.campaign.findMany({
    where: {
      marketplace: input.marketplace,
      status: 'ENABLED',
      adGroups: {
        some: {
          productAds: {
            some: {
              product: { productType, NOT: { id: agedProductId } },
            },
          },
        },
      },
    },
    select: { id: true, name: true, status: true, dailyBudget: true, marketplace: true },
  })

  if (input.dryRun) {
    return {
      step: 'pause_new_product_ads',
      ok: true,
      output: {
        dryRun: true,
        wouldPause: candidates.map((c) => ({ id: c.id, name: c.name })),
        count: candidates.length,
      },
      estimatedValueCentsEur: 0,
      pausedCampaignIds: [],
      actionLogIds: [],
    }
  }

  const paused: string[] = []
  const actionLogIds: string[] = []
  let anyError = false
  for (const c of candidates) {
    const result = await updateCampaignWithSync({
      campaignId: c.id,
      patch: { status: 'PAUSED' },
      actor: input.actor,
      reason: input.reason ?? `liquidate_aged_stock — pause new-product ads`,
    })
    if (result.ok && result.outboundQueueId) {
      paused.push(c.id)
      if (result.actionLogId) actionLogIds.push(result.actionLogId)
    } else {
      anyError = true
    }
  }

  return {
    step: 'pause_new_product_ads',
    ok: !anyError,
    output: { pausedCampaignIds: paused, count: paused.length },
    estimatedValueCentsEur: 0,
    pausedCampaignIds: paused,
    actionLogIds,
  }
}

// ── Step 3: boost aged-product ad budget ──────────────────────────────

async function boostAgedProductAds(
  input: LiquidateInput,
  agedProductId: string,
): Promise<LiquidateSubAction & { boostedCampaignIds: string[]; actionLogIds: string[] }> {
  const candidates = await prisma.campaign.findMany({
    where: {
      marketplace: input.marketplace,
      status: 'ENABLED',
      adGroups: {
        some: { productAds: { some: { productId: agedProductId } } },
      },
    },
    select: { id: true, name: true, dailyBudget: true },
  })

  if (input.dryRun) {
    return {
      step: 'boost_aged_product_ads',
      ok: true,
      output: {
        dryRun: true,
        wouldBoost: candidates.map((c) => ({
          id: c.id,
          name: c.name,
          newBudget: Number(c.dailyBudget) * (1 + input.boostPercent / 100),
        })),
        count: candidates.length,
        percent: input.boostPercent,
      },
      estimatedValueCentsEur: candidates.reduce(
        (acc, c) => acc + Math.round(Number(c.dailyBudget) * 100 * (input.boostPercent / 100)),
        0,
      ),
      boostedCampaignIds: [],
      actionLogIds: [],
    }
  }

  const boosted: string[] = []
  const actionLogIds: string[] = []
  let totalIncrementCents = 0
  let anyError = false
  for (const c of candidates) {
    const newBudget = Number(c.dailyBudget) * (1 + input.boostPercent / 100)
    const incrementCents = Math.round((newBudget - Number(c.dailyBudget)) * 100)
    const result = await updateCampaignWithSync({
      campaignId: c.id,
      patch: { dailyBudget: Math.round(newBudget * 100) / 100 },
      actor: input.actor,
      reason: input.reason ?? `liquidate_aged_stock — boost aged-product ad budget +${input.boostPercent}%`,
    })
    if (result.ok && result.outboundQueueId) {
      boosted.push(c.id)
      totalIncrementCents += incrementCents
      if (result.actionLogId) actionLogIds.push(result.actionLogId)
    } else {
      anyError = true
    }
  }

  return {
    step: 'boost_aged_product_ads',
    ok: !anyError,
    output: { boostedCampaignIds: boosted, incrementCents: totalIncrementCents },
    estimatedValueCentsEur: totalIncrementCents,
    boostedCampaignIds: boosted,
    actionLogIds,
  }
}

// ── Public composite ──────────────────────────────────────────────────

export async function liquidateAgedStock(input: LiquidateInput): Promise<LiquidateOutcome> {
  const product = await prisma.product.findUnique({
    where: { id: input.productId },
    select: { id: true, sku: true, productType: true },
  })
  if (!product) {
    return {
      ok: false,
      subActions: [],
      retailEventId: null,
      pausedCampaignIds: [],
      boostedCampaignIds: [],
      actionLogIds: [],
      totalEstimatedValueCentsEur: 0,
    }
  }

  const step1 = await createMarkdownEvent(input, product)
  const step2 = await pauseNewProductAds(input, product.id, product.productType)
  const step3 = await boostAgedProductAds(input, product.id)

  const subActions: LiquidateSubAction[] = [
    {
      step: step1.step,
      ok: step1.ok,
      error: step1.error,
      output: step1.output,
      estimatedValueCentsEur: step1.estimatedValueCentsEur,
    },
    {
      step: step2.step,
      ok: step2.ok,
      error: step2.error,
      output: step2.output,
      estimatedValueCentsEur: step2.estimatedValueCentsEur,
    },
    {
      step: step3.step,
      ok: step3.ok,
      error: step3.error,
      output: step3.output,
      estimatedValueCentsEur: step3.estimatedValueCentsEur,
    },
  ]
  const actionLogIds = [
    ...(step1.actionLogId ? [step1.actionLogId] : []),
    ...step2.actionLogIds,
    ...step3.actionLogIds,
  ]

  return {
    ok: subActions.every((s) => s.ok),
    subActions,
    retailEventId: step1.retailEventId,
    pausedCampaignIds: step2.pausedCampaignIds,
    boostedCampaignIds: step3.boostedCampaignIds,
    actionLogIds,
    totalEstimatedValueCentsEur:
      step1.estimatedValueCentsEur +
      step2.estimatedValueCentsEur +
      step3.estimatedValueCentsEur,
  }
}
