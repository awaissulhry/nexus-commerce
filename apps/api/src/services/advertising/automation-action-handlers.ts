/**
 * AD.3 — Advertising-domain action handlers for the AutomationRule engine.
 *
 * Mutates the exported ACTION_HANDLERS map at module load. Importing
 * this file is enough to register every advertising action with the
 * existing engine in automation-rule.service.ts. No engine code touched.
 *
 * Side-effect import lives at the top of apps/api/src/routes/advertising.routes.ts
 * so the registration fires on first request to /api/advertising/*.
 *
 * Action types added:
 *   bid_down            — drop bid by percent (floor €0.05)
 *   bid_up              — raise bid by percent (estimated spend impact reported)
 *   pause_ad_group      — set status=PAUSED
 *   pause_campaign      — set status=PAUSED (heavier — loses impression rank)
 *   adjust_ad_budget    — change Campaign.dailyBudget
 *   create_amazon_promotion — RetailEvent + RetailEventPriceAction
 *                           (reuses promotion-scheduler.service.ts:30)
 *   reroute_marketplace_budget — log-only stub (real in AD.5)
 *   liquidate_aged_stock — composite stub (real in AD.4)
 *
 * Context shape (built by advertising-rule-evaluator.job.ts):
 *   {
 *     trigger: 'FBA_AGE_THRESHOLD_REACHED' | ...,
 *     marketplace: 'IT' | 'DE' | ...,
 *     product: { id, sku, ... } | null,
 *     campaign: { id, externalCampaignId, dailyBudget, ... } | null,
 *     adGroup: { id, defaultBidCents, ... } | null,
 *     adTarget: { id, bidCents, ... } | null,
 *     fbaAge: { quantityInAge271_365, projectedLtsFee30dCents, daysToLtsThreshold } | null,
 *   }
 */

import { ACTION_HANDLERS, type ActionResult, getFieldPath } from '../automation-rule.service.js'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import {
  updateCampaignWithSync,
  updateAdGroupWithSync,
  updateAdTargetWithSync,
  type AdsActor,
} from './ads-mutation.service.js'

const BID_FLOOR_CENTS = 5 // €0.05
const RULE_ACTOR = (ruleId: string): AdsActor => `automation:${ruleId}`

/**
 * Per-rule daily spend cap. The engine's built-in cap is per-execution
 * (rule.maxValueCentsEur). AD.3 adds rule.maxDailyAdSpendCentsEur which
 * sums across today's executions of THIS rule. We enforce it from each
 * spending action handler since the engine doesn't know about advertising.
 *
 * Returns:
 *   - { allowed: true, ... }              spend may proceed
 *   - { allowed: false, error: '...' }   abort this action (engine still
 *                                        records the failure into actionResults)
 */
async function checkDailySpendCap(
  ruleId: string,
  projectedSpendCents: number,
): Promise<{ allowed: boolean; error?: string; spentTodayCents: number; capCents: number | null }> {
  const rule = await prisma.automationRule.findUnique({
    where: { id: ruleId },
    select: { maxDailyAdSpendCentsEur: true },
  })
  const cap = rule?.maxDailyAdSpendCentsEur ?? null
  if (cap == null) {
    return { allowed: true, spentTodayCents: 0, capCents: null }
  }
  const dayStart = new Date()
  dayStart.setUTCHours(0, 0, 0, 0)
  // Sum estimatedValueCentsEur across all actionResults from today's
  // executions of this rule. The actionResults JSON column shape:
  //   [{ type, ok, estimatedValueCentsEur?, ... }, ...]
  const executions = await prisma.automationRuleExecution.findMany({
    where: { ruleId, startedAt: { gte: dayStart } },
    select: { actionResults: true },
  })
  let spentTodayCents = 0
  for (const ex of executions) {
    const results = (ex.actionResults ?? []) as Array<{ ok?: boolean; estimatedValueCentsEur?: number }>
    if (!Array.isArray(results)) continue
    for (const r of results) {
      if (r?.ok && typeof r.estimatedValueCentsEur === 'number') {
        spentTodayCents += r.estimatedValueCentsEur
      }
    }
  }
  if (spentTodayCents + projectedSpendCents > cap) {
    return {
      allowed: false,
      error: `DAILY_AD_SPEND_CAP_EXCEEDED (today=${spentTodayCents}¢ + projected=${projectedSpendCents}¢ > cap=${cap}¢)`,
      spentTodayCents,
      capCents: cap,
    }
  }
  return { allowed: true, spentTodayCents, capCents: cap }
}

function ctxCampaignId(action: Record<string, unknown>, context: unknown): string | null {
  return (
    (action.campaignId as string | undefined) ??
    (getFieldPath(context, 'campaign.id') as string | undefined) ??
    null
  )
}
function ctxAdGroupId(action: Record<string, unknown>, context: unknown): string | null {
  return (
    (action.adGroupId as string | undefined) ??
    (getFieldPath(context, 'adGroup.id') as string | undefined) ??
    null
  )
}
function ctxAdTargetId(action: Record<string, unknown>, context: unknown): string | null {
  return (
    (action.adTargetId as string | undefined) ??
    (getFieldPath(context, 'adTarget.id') as string | undefined) ??
    null
  )
}

function applyBidPercent(currentCents: number, percent: number): number {
  const next = Math.round(currentCents * (1 + percent / 100))
  return Math.max(BID_FLOOR_CENTS, next)
}

// ── bid_down ──────────────────────────────────────────────────────────

ACTION_HANDLERS.bid_down = async (action, context, meta): Promise<ActionResult> => {
  const target = (action.target as string | undefined) ?? 'ad_target'
  const percent = -Math.abs(Number(action.percent ?? 20))
  if (target === 'ad_target') {
    const id = ctxAdTargetId(action, context)
    if (!id) return { type: action.type, ok: false, error: 'No adTarget.id in context' }
    const t = await prisma.adTarget.findUnique({ where: { id }, select: { bidCents: true } })
    if (!t) return { type: action.type, ok: false, error: 'AdTarget not found' }
    const newBid = applyBidPercent(t.bidCents, percent)
    if (meta.dryRun) {
      return {
        type: action.type,
        ok: true,
        output: { dryRun: true, target, id, wouldChange: `${t.bidCents}→${newBid} cents` },
      }
    }
    const res = await updateAdTargetWithSync({
      adTargetId: id,
      patch: { bidCents: newBid },
      actor: RULE_ACTOR(meta.ruleId),
      reason: `bid_down ${percent}% via rule ${meta.ruleId}`,
    })
    return {
      type: action.type,
      ok: res.ok,
      error: res.error ?? undefined,
      output: { target, id, newBidCents: newBid, outboundQueueId: res.outboundQueueId },
    }
  }
  if (target === 'ad_group') {
    const id = ctxAdGroupId(action, context)
    if (!id) return { type: action.type, ok: false, error: 'No adGroup.id in context' }
    const ag = await prisma.adGroup.findUnique({ where: { id }, select: { defaultBidCents: true } })
    if (!ag) return { type: action.type, ok: false, error: 'AdGroup not found' }
    const newBid = applyBidPercent(ag.defaultBidCents, percent)
    if (meta.dryRun) {
      return {
        type: action.type,
        ok: true,
        output: { dryRun: true, target, id, wouldChange: `${ag.defaultBidCents}→${newBid} cents` },
      }
    }
    const res = await updateAdGroupWithSync({
      adGroupId: id,
      patch: { defaultBidCents: newBid },
      actor: RULE_ACTOR(meta.ruleId),
      reason: `bid_down ${percent}% via rule ${meta.ruleId}`,
    })
    return {
      type: action.type,
      ok: res.ok,
      error: res.error ?? undefined,
      output: { target, id, newBidCents: newBid, outboundQueueId: res.outboundQueueId },
    }
  }
  return { type: action.type, ok: false, error: `Unsupported target=${target}` }
}

// ── bid_up ────────────────────────────────────────────────────────────

ACTION_HANDLERS.bid_up = async (action, context, meta): Promise<ActionResult> => {
  const target = (action.target as string | undefined) ?? 'ad_target'
  const percent = Math.abs(Number(action.percent ?? 15))
  // Estimate ~24h incremental spend at the new bid level. Cheap heuristic:
  // currentSpend24h × (newBid/oldBid − 1). Provides a value-cap signal.
  let estimated = 0
  if (target === 'ad_target') {
    const id = ctxAdTargetId(action, context)
    if (!id) return { type: action.type, ok: false, error: 'No adTarget.id in context' }
    const t = await prisma.adTarget.findUnique({
      where: { id },
      select: { bidCents: true, spendCents: true },
    })
    if (!t) return { type: action.type, ok: false, error: 'AdTarget not found' }
    const newBid = applyBidPercent(t.bidCents, percent)
    estimated = Math.max(
      0,
      Math.round((t.spendCents / 30) * (newBid / Math.max(1, t.bidCents) - 1)),
    )
    if (meta.dryRun) {
      return {
        type: action.type,
        ok: true,
        estimatedValueCentsEur: estimated,
        output: { dryRun: true, target, id, wouldChange: `${t.bidCents}→${newBid} cents`, estimatedDailySpendCents: estimated },
      }
    }
    const cap = await checkDailySpendCap(meta.ruleId, estimated)
    if (!cap.allowed) {
      return { type: action.type, ok: false, error: cap.error, estimatedValueCentsEur: 0 }
    }
    const res = await updateAdTargetWithSync({
      adTargetId: id,
      patch: { bidCents: newBid },
      actor: RULE_ACTOR(meta.ruleId),
      reason: `bid_up ${percent}% via rule ${meta.ruleId}`,
    })
    return {
      type: action.type,
      ok: res.ok,
      error: res.error ?? undefined,
      estimatedValueCentsEur: estimated,
      output: { target, id, newBidCents: newBid, outboundQueueId: res.outboundQueueId },
    }
  }
  return { type: action.type, ok: false, error: `Unsupported target=${target}` }
}

// ── pause_ad_group / pause_campaign ───────────────────────────────────

ACTION_HANDLERS.pause_ad_group = async (action, context, meta): Promise<ActionResult> => {
  const id = ctxAdGroupId(action, context)
  if (!id) return { type: action.type, ok: false, error: 'No adGroup.id in context' }
  if (meta.dryRun) {
    return { type: action.type, ok: true, output: { dryRun: true, adGroupId: id, wouldSet: 'PAUSED' } }
  }
  const res = await updateAdGroupWithSync({
    adGroupId: id,
    patch: { status: 'PAUSED' },
    actor: RULE_ACTOR(meta.ruleId),
    reason: action.reason as string | undefined ?? `pause_ad_group via rule ${meta.ruleId}`,
  })
  return {
    type: action.type,
    ok: res.ok,
    error: res.error ?? undefined,
    output: { adGroupId: id, outboundQueueId: res.outboundQueueId },
  }
}

ACTION_HANDLERS.pause_campaign = async (action, context, meta): Promise<ActionResult> => {
  const id = ctxCampaignId(action, context)
  if (!id) return { type: action.type, ok: false, error: 'No campaign.id in context' }
  if (meta.dryRun) {
    return { type: action.type, ok: true, output: { dryRun: true, campaignId: id, wouldSet: 'PAUSED' } }
  }
  const res = await updateCampaignWithSync({
    campaignId: id,
    patch: { status: 'PAUSED' },
    actor: RULE_ACTOR(meta.ruleId),
    reason: action.reason as string | undefined ?? `pause_campaign via rule ${meta.ruleId}`,
  })
  return {
    type: action.type,
    ok: res.ok,
    error: res.error ?? undefined,
    output: { campaignId: id, outboundQueueId: res.outboundQueueId },
  }
}

// ── adjust_ad_budget ──────────────────────────────────────────────────

ACTION_HANDLERS.adjust_ad_budget = async (action, context, meta): Promise<ActionResult> => {
  const id = ctxCampaignId(action, context)
  if (!id) return { type: action.type, ok: false, error: 'No campaign.id in context' }
  const c = await prisma.campaign.findUnique({
    where: { id },
    select: { dailyBudget: true, dailyBudgetCurrency: true },
  })
  if (!c) return { type: action.type, ok: false, error: 'Campaign not found' }
  const current = Number(c.dailyBudget)
  let next: number
  if (action.newDailyBudget != null) {
    next = Number(action.newDailyBudget)
  } else if (action.percent != null) {
    next = current * (1 + Number(action.percent) / 100)
  } else {
    return { type: action.type, ok: false, error: 'Specify newDailyBudget or percent' }
  }
  next = Math.max(1, Math.round(next * 100) / 100) // floor €1
  const delta = Math.max(0, Math.round((next - current) * 100))
  if (meta.dryRun) {
    return {
      type: action.type,
      ok: true,
      estimatedValueCentsEur: delta,
      output: {
        dryRun: true,
        campaignId: id,
        wouldChange: `€${current.toFixed(2)} → €${next.toFixed(2)}`,
        estimatedDailySpendIncrementCents: delta,
      },
    }
  }
  const cap = await checkDailySpendCap(meta.ruleId, delta)
  if (!cap.allowed) {
    return { type: action.type, ok: false, error: cap.error, estimatedValueCentsEur: 0 }
  }
  const res = await updateCampaignWithSync({
    campaignId: id,
    patch: { dailyBudget: next },
    actor: RULE_ACTOR(meta.ruleId),
    reason: action.reason as string | undefined ?? `adjust_ad_budget via rule ${meta.ruleId}`,
  })
  return {
    type: action.type,
    ok: res.ok,
    error: res.error ?? undefined,
    estimatedValueCentsEur: delta,
    output: { campaignId: id, newDailyBudget: next, outboundQueueId: res.outboundQueueId },
  }
}

// ── create_amazon_promotion ───────────────────────────────────────────
// Reuses RetailEvent + RetailEventPriceAction so promotion-scheduler.service.ts
// (existing hourly tick) materializes ChannelListing.salePrice on its next
// run. We do NOT call Amazon's Coupon API here — only create the internal
// "scheduled markdown" promotion. Amazon Coupon deep-link is a separate
// path (amazon-coupon.service.ts) operators can use manually.

ACTION_HANDLERS.create_amazon_promotion = async (action, context, meta): Promise<ActionResult> => {
  const productId =
    (action.productId as string | undefined) ??
    (getFieldPath(context, 'product.id') as string | undefined)
  if (!productId) {
    return { type: action.type, ok: false, error: 'No product.id in context' }
  }
  const marketplace =
    (action.marketplace as string | undefined) ??
    (getFieldPath(context, 'marketplace') as string | undefined)
  if (!marketplace) {
    return { type: action.type, ok: false, error: 'No marketplace in context' }
  }
  const discountPct = Number(action.discountPct ?? 15)
  const durationDays = Number(action.durationDays ?? 14)
  const startAt = new Date()
  const endAt = new Date(startAt.getTime() + durationDays * 24 * 60 * 60 * 1000)

  // Project the revenue at stake so the engine's value cap can see it.
  // Cheap heuristic: 7d unit-velocity × discountPct × current price × duration.
  let estimatedValueCentsEur = 0
  try {
    const recent = await prisma.productProfitDaily.aggregate({
      where: {
        productId,
        marketplace,
        date: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
      },
      _sum: { unitsSold: true, grossRevenueCents: true },
    })
    const units7d = recent._sum.unitsSold ?? 0
    const revenue7d = recent._sum.grossRevenueCents ?? 0
    if (units7d > 0 && revenue7d > 0) {
      const pricePerUnit = revenue7d / units7d
      const projectedUnits = (units7d / 7) * durationDays
      estimatedValueCentsEur = Math.round(projectedUnits * pricePerUnit * (discountPct / 100))
    }
  } catch (err) {
    logger.warn('[create_amazon_promotion] projection failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  if (meta.dryRun) {
    return {
      type: action.type,
      ok: true,
      estimatedValueCentsEur,
      output: {
        dryRun: true,
        productId,
        marketplace,
        discountPct,
        durationDays,
        wouldCreate: 'RetailEvent + RetailEventPriceAction',
        startAt: startAt.toISOString(),
        endAt: endAt.toISOString(),
      },
    }
  }
  const cap = await checkDailySpendCap(meta.ruleId, estimatedValueCentsEur)
  if (!cap.allowed) {
    return { type: action.type, ok: false, error: cap.error, estimatedValueCentsEur: 0 }
  }

  // RetailEventPriceAction is productType-scoped (no productId field),
  // so the auto-promo affects every SKU of the same productType in the
  // marketplace. For Xavia's "liquidate this specific aged SKU" intent
  // this is broader than ideal — a SKU-specific markdown mechanism is
  // a follow-up. The campaign-pause action (pause_ad_group) still
  // targets the specific advertised SKU, so the combined rule still
  // narrows the operator impact.
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { productType: true, sku: true },
  })
  if (!product?.productType) {
    return {
      type: action.type,
      ok: false,
      error: 'product.productType missing — needed for marketplace promo scope',
    }
  }
  const startDate = new Date(Date.UTC(startAt.getUTCFullYear(), startAt.getUTCMonth(), startAt.getUTCDate()))
  const endDate = new Date(Date.UTC(endAt.getUTCFullYear(), endAt.getUTCMonth(), endAt.getUTCDate()))

  // Atomic: RetailEvent + RetailEventPriceAction in one transaction so
  // an orphan parent never appears.
  try {
    const event = await prisma.$transaction(async (tx) => {
      const re = await tx.retailEvent.create({
        data: {
          name: `Auto-promo aged stock (${product.sku}) — rule ${meta.ruleId}`,
          startDate,
          endDate,
          marketplace,
          productType: product.productType,
          source: 'AUTOMATION',
          description: `Auto-generated by AutomationRule ${meta.ruleId} for SKU ${product.sku}. Scope: marketplace × productType.`,
        },
        select: { id: true },
      })
      await tx.retailEventPriceAction.create({
        data: {
          eventId: re.id,
          action: 'PERCENT_OFF',
          value: discountPct,
          marketplace,
          productType: product.productType,
          setSalePriceFrom: startAt,
          setSalePriceUntil: endAt,
        },
      })
      return re
    })
    return {
      type: action.type,
      ok: true,
      estimatedValueCentsEur,
      output: {
        retailEventId: event.id,
        productId,
        sku: product.sku,
        productType: product.productType,
        marketplace,
        discountPct,
        durationDays,
        scopeNote: 'productType-scoped — promo affects every SKU of this type in the marketplace',
      },
    }
  } catch (err) {
    return {
      type: action.type,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// ── reroute_marketplace_budget (AD.5 real implementation) ─────────────
//
// Two operating modes:
//   1. budgetPoolId supplied → trigger an immediate rebalance on that
//      pool (ignoring its cooldown). Pool's own strategy decides who
//      gets what; this handler just kicks the trigger.
//   2. fromMarketplace + toMarketplace + percent → no pool needed.
//      Identify the loudest-spend Campaign on fromMarketplace, cut its
//      dailyBudget by `percent`. Spread the freed budget across active
//      campaigns on toMarketplace.
//
// Pre-flight: respects per-rule daily spend cap. Reports estimated
// value cents = budget shifted (cap counts only the increases, not
// the decreases).

ACTION_HANDLERS.reroute_marketplace_budget = async (action, _context, meta): Promise<ActionResult> => {
  const budgetPoolId = action.budgetPoolId as string | undefined
  const fromMarketplace = action.fromMarketplace as string | undefined
  const toMarketplace = action.toMarketplace as string | undefined
  const percent = Number(action.percent ?? 25)

  // Mode 1: pool-driven.
  if (budgetPoolId) {
    const { rebalanceAndAudit } = await import('./budget-pool-rebalancer.service.js')
    const outcome = await rebalanceAndAudit({
      poolId: budgetPoolId,
      triggeredBy: `rule:${meta.ruleId}`,
      ignoreCoolDown: true, // rule firing is the explicit trigger
      forceDryRun: meta.dryRun,
      actor: RULE_ACTOR(meta.ruleId),
    })
    if (outcome.skipped) {
      return {
        type: action.type,
        ok: false,
        error: `pool skipped: ${outcome.skipped}`,
      }
    }
    // Estimated value = sum of POSITIVE shifts (increases only — the
    // engine's per-execution cap shouldn't double-count both sides).
    const estimatedValueCentsEur = outcome.proposed.reduce(
      (acc, p) => acc + Math.max(0, p.shiftCents),
      0,
    )
    return {
      type: action.type,
      ok: outcome.ok,
      estimatedValueCentsEur,
      output: {
        mode: 'pool',
        poolId: budgetPoolId,
        auditId: outcome.auditId,
        proposed: outcome.proposed.map((p) => ({
          campaignId: p.campaignId,
          marketplace: p.marketplace,
          oldBudgetCents: p.oldBudgetCents,
          proposedBudgetCents: p.proposedBudgetCents,
          shiftCents: p.shiftCents,
        })),
        applied: outcome.applied
          ? { applied: outcome.applied.applied, failed: outcome.applied.failed }
          : { dryRun: true },
        warnings: outcome.warnings,
      },
    }
  }

  // Mode 2: ad-hoc from→to.
  if (!fromMarketplace || !toMarketplace) {
    return {
      type: action.type,
      ok: false,
      error: 'Specify budgetPoolId, OR fromMarketplace + toMarketplace + percent',
    }
  }

  // Find the loudest-spend campaign on fromMarketplace.
  const fromCamp = await prisma.campaign.findFirst({
    where: { marketplace: fromMarketplace, status: 'ENABLED' },
    orderBy: { spend: 'desc' },
    select: { id: true, dailyBudget: true, marketplace: true, name: true },
  })
  if (!fromCamp) {
    return { type: action.type, ok: false, error: `no enabled campaign on ${fromMarketplace}` }
  }
  const cutCents = Math.round(Number(fromCamp.dailyBudget) * 100 * (percent / 100))
  const newFromBudget = Math.max(100, Math.round(Number(fromCamp.dailyBudget) * 100 - cutCents))
  const actualCutCents = Math.round(Number(fromCamp.dailyBudget) * 100) - newFromBudget

  // Spread the cut across enabled campaigns on toMarketplace.
  const toCamps = await prisma.campaign.findMany({
    where: { marketplace: toMarketplace, status: 'ENABLED' },
    orderBy: { trueProfitCents: 'desc' },
    take: 5, // top-5 most-profitable campaigns absorb the shift
    select: { id: true, dailyBudget: true, name: true },
  })
  if (toCamps.length === 0) {
    return { type: action.type, ok: false, error: `no enabled campaign on ${toMarketplace}` }
  }
  const perCampPlusCents = Math.floor(actualCutCents / toCamps.length)

  if (meta.dryRun) {
    return {
      type: action.type,
      ok: true,
      estimatedValueCentsEur: actualCutCents,
      output: {
        mode: 'adhoc',
        dryRun: true,
        from: { campaignId: fromCamp.id, name: fromCamp.name, oldCents: Math.round(Number(fromCamp.dailyBudget) * 100), newCents: newFromBudget },
        to: toCamps.map((c) => ({ campaignId: c.id, name: c.name, plusCents: perCampPlusCents })),
        percent,
      },
    }
  }

  const cap = await checkDailySpendCap(meta.ruleId, actualCutCents)
  if (!cap.allowed) {
    return { type: action.type, ok: false, error: cap.error, estimatedValueCentsEur: 0 }
  }

  // Apply: cut "from", boost each "to".
  const cutResult = await prisma.campaign.update({
    where: { id: fromCamp.id },
    data: { dailyBudget: newFromBudget / 100 },
    select: { id: true },
  })
  for (const c of toCamps) {
    const newCents = Math.round(Number(c.dailyBudget) * 100) + perCampPlusCents
    await prisma.campaign.update({
      where: { id: c.id },
      data: { dailyBudget: newCents / 100 },
    })
  }
  return {
    type: action.type,
    ok: true,
    estimatedValueCentsEur: actualCutCents,
    output: {
      mode: 'adhoc',
      from: { campaignId: cutResult.id, cutCents: actualCutCents },
      to: toCamps.map((c) => ({ campaignId: c.id, plusCents: perCampPlusCents })),
      percent,
    },
  }
}

// ── liquidate_aged_stock (AD.4 real composite) ────────────────────────

ACTION_HANDLERS.liquidate_aged_stock = async (action, context, meta): Promise<ActionResult> => {
  const productId =
    (action.productId as string | undefined) ??
    (getFieldPath(context, 'product.id') as string | undefined)
  const marketplace =
    (action.marketplace as string | undefined) ??
    (getFieldPath(context, 'marketplace') as string | undefined)
  if (!productId) return { type: action.type, ok: false, error: 'No product.id in context' }
  if (!marketplace) return { type: action.type, ok: false, error: 'No marketplace in context' }

  const { liquidateAgedStock } = await import('./promotion-ad-coordinator.service.js')
  const outcome = await liquidateAgedStock({
    productId,
    marketplace,
    discountPct: Number(action.discountPct ?? 15),
    durationDays: Number(action.durationDays ?? 14),
    boostPercent: Number(action.boostPercent ?? 25),
    actor: RULE_ACTOR(meta.ruleId),
    reason: (action.reason as string | undefined) ?? `liquidate_aged_stock via rule ${meta.ruleId}`,
    dryRun: meta.dryRun,
    executionId: null, // AD.5 will pass through if engine plumbs it
  })

  // Optional daily-spend cap on the budget-boost component.
  if (!meta.dryRun && outcome.subActions.find((s) => s.step === 'boost_aged_product_ads')?.estimatedValueCentsEur) {
    const cap = await checkDailySpendCap(
      meta.ruleId,
      outcome.totalEstimatedValueCentsEur,
    )
    if (!cap.allowed) {
      // Cap exceeded AFTER the writes already happened — log loudly so
      // the operator sees the breach. The rollback endpoint can undo.
      logger.warn('[liquidate_aged_stock] daily spend cap exceeded after composite executed', {
        ruleId: meta.ruleId,
        cap: cap.capCents,
        spentTodayCents: cap.spentTodayCents,
        totalEstimatedValueCentsEur: outcome.totalEstimatedValueCentsEur,
      })
    }
  }

  return {
    type: action.type,
    ok: outcome.ok,
    estimatedValueCentsEur: outcome.totalEstimatedValueCentsEur,
    output: {
      subActions: outcome.subActions,
      retailEventId: outcome.retailEventId,
      pausedCampaignIds: outcome.pausedCampaignIds,
      boostedCampaignIds: outcome.boostedCampaignIds,
      actionLogIds: outcome.actionLogIds,
    },
  }
}

logger.debug('[advertising] action handlers registered', {
  count: 8,
  types: [
    'bid_down',
    'bid_up',
    'pause_ad_group',
    'pause_campaign',
    'adjust_ad_budget',
    'create_amazon_promotion',
    'reroute_marketplace_budget',
    'liquidate_aged_stock',
  ],
})
