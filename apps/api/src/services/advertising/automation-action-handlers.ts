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

// ── notify (TD.0) ─────────────────────────────────────────────────────
// Alert-only action: fans a notification to every operator's bell. Fires even
// in dry-run (an alert isn't an Amazon write — suppressing it would defeat the
// purpose). Lets rules like "negative ad margin" actually reach a human.
ACTION_HANDLERS.notify = async (action, context, meta): Promise<ActionResult> => {
  const title = (action.title as string) || (action.message as string) || 'Advertising automation alert'
  const severity = ((action.severity as string) === 'danger' || (action.severity as string) === 'info' || (action.severity as string) === 'success')
    ? (action.severity as 'danger' | 'info' | 'success') : 'warn'
  const bits: string[] = []
  const cName = getFieldPath(context, 'campaign.name'); if (cName) bits.push(`Campaign: ${String(cName)}`)
  const tgt = getFieldPath(context, 'adTarget.expressionValue'); if (tgt) bits.push(`Target: ${String(tgt)}`)
  const mkt = getFieldPath(context, 'marketplace'); if (mkt) bits.push(`Market: ${String(mkt)}`)
  const body = [action.body as string | undefined, bits.join(' · ') || undefined].filter(Boolean).join(' — ') || undefined
  try {
    const { notifyAutomation } = await import('./ads-automation-notify.service.js')
    const notified = await notifyAutomation({ type: 'ads-automation-rule', severity, title, body, meta: { ruleId: meta.ruleId, dryRun: meta.dryRun } })
    return { type: action.type, ok: true, output: { notified, title, dryRun: meta.dryRun } }
  } catch (e) {
    return { type: action.type, ok: false, error: (e as Error).message }
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

// ── AU.1: resume_campaign ─────────────────────────────────────────────
// Companion to pause_campaign. Restores a campaign to ENABLED (e.g. when
// retail guard re-evaluates and stock is back / Buy Box regained).
ACTION_HANDLERS.resume_campaign = async (action, context, meta): Promise<ActionResult> => {
  const id = (action.campaignId as string | undefined) ?? ctxCampaignId(action, context)
  if (!id) return { type: action.type, ok: false, error: 'No campaign.id in context' }
  if (meta.dryRun) return { type: action.type, ok: true, output: { dryRun: true, campaignId: id } }
  const res = await updateCampaignWithSync({
    campaignId: id,
    patch: { status: 'ENABLED' },
    actor: RULE_ACTOR(meta.ruleId),
    reason: (action.reason as string | undefined) ?? `resume_campaign via rule ${meta.ruleId}`,
    applyImmediately: true,
  } as never)
  return { type: action.type, ok: res.ok, error: res.error ?? undefined, output: { campaignId: id, outboundQueueId: res.outboundQueueId } }
}

// ── AU.1: harvest_and_negate ──────────────────────────────────────────
// Runs automated keyword harvesting: promotes high-converting search terms
// to exact-match campaigns (graduation) and negates wasters. Designed for
// the SCHEDULE trigger so it runs on a daily cadence without user input.
// Parameters mirror previewHarvest opts so a rule can tune thresholds.
ACTION_HANDLERS.harvest_and_negate = async (action, _context, meta): Promise<ActionResult> => {
  const windowDays = typeof action.windowDays === 'number' ? action.windowDays : 60
  const minSpendCents = typeof action.minSpendCents === 'number' ? action.minSpendCents : 1000 // €10 default
  const minOrders = typeof action.minOrders === 'number' ? action.minOrders : 2
  const { previewHarvest, applyHarvest } = await import('./ads-harvest.service.js')
  const preview = await previewHarvest({ windowDays, minSpendCents, minOrders })
  if (meta.dryRun) {
    return {
      type: action.type,
      ok: true,
      output: {
        dryRun: true,
        wouldNegate: preview.negatives.length,
        wouldGraduate: preview.graduations.length,
        topNegatives: preview.negatives.slice(0, 5).map((n) => ({ query: n.query, costCents: n.costCents })),
        topGraduations: preview.graduations.slice(0, 5).map((g) => ({ query: g.query, orders: g.orders })),
      },
    }
  }
  const result = await applyHarvest({
    negatives: preview.negatives,
    graduations: preview.graduations.map((g) => ({ ...g, bidEur: typeof action.graduationBidEur === 'number' ? action.graduationBidEur : 0.5 })),
    userId: `automation:${meta.ruleId}`,
  })
  return {
    type: action.type,
    ok: result.errors.length === 0 || result.negativesAdded + result.keywordsGraduated > 0,
    output: {
      negativesAdded: result.negativesAdded,
      keywordsGraduated: result.keywordsGraduated,
      errors: result.errors.slice(0, 5),
    },
  }
}

// ── AU.6: set_placement_multiplier ────────────────────────────────────
// Adjusts the PLACEMENT_TOP (or other placement) bid adjustment % for a
// campaign. Lets rules like "raise top-of-search bids when ACOS is low" or
// "lower when ACOS is high" without touching keyword bids directly.
ACTION_HANDLERS.set_placement_multiplier = async (action, context, meta): Promise<ActionResult> => {
  const campaignId = (action.campaignId as string | undefined) ?? ctxCampaignId(action, context)
  if (!campaignId) return { type: action.type, ok: false, error: 'No campaign.id in context' }
  const placement = (action.placement as string | undefined) ?? 'PLACEMENT_TOP'
  const pct = Math.max(0, Math.min(900, Math.round(Number(action.percentage ?? 0))))
  if (meta.dryRun) {
    return { type: action.type, ok: true, output: { dryRun: true, campaignId, placement, percentage: pct } }
  }
  const { updatePlacementBidding } = await import('./ads-create.service.js')
  const c = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { dynamicBidding: true } })
  const db = (c?.dynamicBidding ?? {}) as { placementBidding?: Array<{ placement: string; percentage: number }> }
  const others = (db.placementBidding ?? []).filter((x) => x.placement !== placement)
  const res = await updatePlacementBidding({ campaignId, adjustments: [...others, { placement, percentage: pct }] })
  return { type: action.type, ok: res.ok !== false, output: { campaignId, placement, percentage: pct, mode: res.mode } }
}

// ── AU.2: retail_guard ────────────────────────────────────────────────
// Pauses campaigns advertising out-of-stock products or products that
// lost the Buy Box. Safe to run every 15 min on a SCHEDULE trigger — the
// write-gate + allowlist ensures live Amazon writes only on approved
// campaigns, and resume_campaign undoes it when conditions clear.
ACTION_HANDLERS.retail_guard = async (action, _context, meta): Promise<ActionResult> => {
  const marketplace = typeof action.marketplace === 'string' ? action.marketplace : undefined
  const { analyzeRetailReadiness, applyRetailGuard } = await import('./ads-retail-readiness.service.js')
  const analysis = await analyzeRetailReadiness({ marketplace })
  const toPause = analysis.campaigns.filter((c) => c.verdict === 'pause' && c.status === 'ENABLED')
  if (meta.dryRun) {
    return {
      type: action.type,
      ok: true,
      output: {
        dryRun: true,
        wouldPause: toPause.length,
        sample: toPause.slice(0, 8).map((c) => ({ id: c.campaignId, name: c.name, reason: c.reason })),
        watched: analysis.summary.watch,
      },
    }
  }
  const result = await applyRetailGuard({
    campaignIds: toPause.map((c) => c.campaignId),
    actor: RULE_ACTOR(meta.ruleId),
    marketplace,
  })
  return {
    type: action.type,
    ok: true,
    output: {
      paused: result.paused.length,
      skipped: result.skipped,
      pausedIds: result.paused.slice(0, 10),
    },
  }
}

// ── AU.4: pause_all_campaigns (budget failsafe kill-switch) ──────────
// Pauses ALL ENABLED campaigns for a marketplace instantly. Used as the
// hard budget-cap kill-switch: triggered when total monthly spend crosses a
// threshold. The SCHEDULE trigger polls spend and fires this action.
// Resume individually or via a companion rule with resume_campaign.
ACTION_HANDLERS.pause_all_campaigns = async (action, _context, meta): Promise<ActionResult> => {
  const marketplace = typeof action.marketplace === 'string' ? action.marketplace : undefined
  const where: Record<string, unknown> = { status: 'ENABLED' }
  if (marketplace) where.marketplace = marketplace
  const campaigns = await prisma.campaign.findMany({ where, select: { id: true, name: true, marketplace: true } })
  if (meta.dryRun) {
    return { type: action.type, ok: true, output: { dryRun: true, wouldPause: campaigns.length, sample: campaigns.slice(0, 5).map((c) => c.name) } }
  }
  let paused = 0
  const errors: string[] = []
  for (const c of campaigns) {
    try {
      await updateCampaignWithSync({ campaignId: c.id, patch: { status: 'PAUSED' }, actor: RULE_ACTOR(meta.ruleId), reason: (action.reason as string | undefined) ?? `budget cap hit — pause_all_campaigns rule ${meta.ruleId}`, applyImmediately: true } as never)
      paused++
    } catch (e) { errors.push((e as Error).message) }
  }
  logger.warn('[pause_all_campaigns] budget cap pause executed', { ruleId: meta.ruleId, marketplace, paused, errors: errors.length })
  return { type: action.type, ok: errors.length < campaigns.length, output: { paused, errors: errors.slice(0, 5) } }
}

// ── add_negative_exact ────────────────────────────────────────────────
// Add a specific query as negative exact to a campaign. Designed for use with
// KEYWORD_WASTED_SPEND and SEARCH_TERM triggers where we know the exact term.
ACTION_HANDLERS.add_negative_exact = async (action, context, meta): Promise<ActionResult> => {
  const keyword = (action.keyword as string | undefined) ?? (action.query as string | undefined) ?? (context as any)?.searchTerm?.query
  const externalCampaignId = (action.externalCampaignId as string | undefined) ?? (context as any)?.searchTerm?.externalCampaignId ?? (context as any)?.campaign?.externalCampaignId
  if (!keyword) return { type: action.type, ok: false, error: 'No keyword/query to negate' }
  if (!externalCampaignId) return { type: action.type, ok: false, error: 'No externalCampaignId in context' }
  // EA2 — honor the builder's Negation Level: AD_GROUP scopes to the source ad group; CAMPAIGN (default) is broader.
  const scope = (action.scope as string | undefined) === 'AD_GROUP' ? 'AD_GROUP' : 'CAMPAIGN'
  const externalAdGroupId = scope === 'AD_GROUP'
    ? ((action.externalAdGroupId as string | undefined) ?? (context as any)?.searchTerm?.externalAdGroupId)
    : undefined
  if (meta.dryRun) return { type: action.type, ok: true, output: { dryRun: true, keyword, externalCampaignId, scope } }
  const { createNegative } = await import('./ads-negative-kw.service.js')
  const conn = await prisma.amazonAdsConnection.findFirst({ where: { marketplace: (context as any).marketplace, isActive: true }, select: { profileId: true } })
  await createNegative({ profileId: conn?.profileId ?? '', externalCampaignId, externalAdGroupId, keywordText: keyword, matchType: 'NEGATIVE_EXACT', scope } as never)
  return { type: action.type, ok: true, output: { keyword, externalCampaignId, matchType: 'NEGATIVE_EXACT', scope } }
}

// ── promote_to_exact ──────────────────────────────────────────────────
// Take a converting search term and create an EXACT match keyword in the
// ad group (or a specified target ad group). The match-type migration engine.
ACTION_HANDLERS.promote_to_exact = async (action, context, meta): Promise<ActionResult> => {
  const query = (action.query as string | undefined) ?? (context as any)?.searchTerm?.query
  const targetAdGroupId = (action.adGroupId as string | undefined) ?? (context as any)?.searchTerm?.externalAdGroupId
  const bidEur = Number(action.bidEur ?? 0.5)
  if (!query) return { type: action.type, ok: false, error: 'No query in context' }
  if (!targetAdGroupId) return { type: action.type, ok: false, error: 'No adGroupId' }
  if (meta.dryRun) return { type: action.type, ok: true, output: { dryRun: true, query, matchType: 'EXACT', bidEur } }
  const { createKeywordLocal } = await import('./ads-create.service.js')
  // Resolve local adGroup id from externalAdGroupId
  const ag = await prisma.adGroup.findFirst({ where: { externalAdGroupId: targetAdGroupId }, select: { id: true } })
  if (!ag) return { type: action.type, ok: false, error: `No local ad group for externalAdGroupId=${targetAdGroupId}` }
  await createKeywordLocal({ adGroupId: ag.id, keywordText: query, matchType: 'EXACT', bidEur })
  return { type: action.type, ok: true, output: { query, matchType: 'EXACT', adGroupId: ag.id, bidEur } }
}

// ── sync_negatives_across_campaigns ──────────────────────────────────
// Add a wasted keyword as NEGATIVE EXACT to ALL campaigns in a marketplace.
// Stops the same bad term from wasting money across the whole account.
ACTION_HANDLERS.sync_negatives_across_campaigns = async (action, context, meta): Promise<ActionResult> => {
  const keyword = (action.keyword as string | undefined) ?? (context as any)?.searchTerm?.query ?? (context as any)?.adTarget?.expressionValue
  const marketplace = (action.marketplace as string | undefined) ?? (context as any).marketplace
  if (!keyword || !marketplace) return { type: action.type, ok: false, error: 'keyword + marketplace required' }
  const campaigns = await prisma.campaign.findMany({ where: { marketplace, status: 'ENABLED', externalCampaignId: { not: null } }, select: { id: true, externalCampaignId: true } })
  if (meta.dryRun) return { type: action.type, ok: true, output: { dryRun: true, keyword, wouldNegateIn: campaigns.length } }
  const conn = await prisma.amazonAdsConnection.findFirst({ where: { marketplace, isActive: true }, select: { profileId: true } })
  const { createNegative } = await import('./ads-negative-kw.service.js')
  let added = 0; const errors: string[] = []
  for (const c of campaigns) {
    try { await createNegative({ profileId: conn?.profileId ?? '', externalCampaignId: c.externalCampaignId!, keywordText: keyword, matchType: 'NEGATIVE_EXACT', scope: 'CAMPAIGN' } as never); added++ }
    catch (e) { errors.push((e as Error).message) }
  }
  return { type: action.type, ok: added > 0, output: { keyword, marketplace, added, errors: errors.slice(0, 5) } }
}

// ── set_campaign_target_acos ──────────────────────────────────────────
// Update a campaign's target ACOS stored in dynamicBidding JSON. The bid
// optimizer reads this to calculate per-campaign bids in profit mode.
ACTION_HANDLERS.set_campaign_target_acos = async (action, context, meta): Promise<ActionResult> => {
  const id = (action.campaignId as string | undefined) ?? ctxCampaignId(action, context)
  const targetAcos = Number(action.targetAcos ?? 0.3)
  if (!id) return { type: action.type, ok: false, error: 'No campaign.id' }
  if (meta.dryRun) return { type: action.type, ok: true, output: { dryRun: true, campaignId: id, targetAcos } }
  const c = await prisma.campaign.findUnique({ where: { id }, select: { dynamicBidding: true } })
  const db = (c?.dynamicBidding ?? {}) as Record<string, unknown>
  db.targetAcos = targetAcos
  await prisma.campaign.update({ where: { id }, data: { dynamicBidding: db as never } })
  return { type: action.type, ok: true, output: { campaignId: id, targetAcos } }
}

// ── increase_daily_budget_cap ────────────────────────────────────────
// Set a campaign's daily budget to a fixed value (not a % — used for
// "unlock this campaign on Prime Day" style automation).
ACTION_HANDLERS.set_daily_budget = async (action, context, meta): Promise<ActionResult> => {
  const id = (action.campaignId as string | undefined) ?? ctxCampaignId(action, context)
  const budgetEur = Number(action.budgetEur)
  if (!id) return { type: action.type, ok: false, error: 'No campaign.id' }
  if (!Number.isFinite(budgetEur) || budgetEur <= 0) return { type: action.type, ok: false, error: 'budgetEur must be a positive number' }
  if (meta.dryRun) return { type: action.type, ok: true, output: { dryRun: true, campaignId: id, budgetEur } }
  const cap = await checkDailySpendCap(meta.ruleId, Math.round(budgetEur * 100))
  if (!cap.allowed) return { type: action.type, ok: false, error: `daily spend cap: ${cap.capCents}¢` }
  const res = await updateCampaignWithSync({ campaignId: id, patch: { dailyBudget: budgetEur } as never, actor: RULE_ACTOR(meta.ruleId), reason: (action.reason as string | undefined) ?? `set_daily_budget via rule ${meta.ruleId}`, applyImmediately: true } as never)
  return { type: action.type, ok: res.ok, output: { campaignId: id, budgetEur, outboundQueueId: res.outboundQueueId } }
}

// ── scale_bids_for_price_change ───────────────────────────────────────
// When product price changes, bids should scale proportionally to maintain
// the same target ACOS (higher price = can afford higher bid; lower price = must cut).
// Reads Product.listPrice to compute the scale factor.
ACTION_HANDLERS.scale_bids_for_price_change = async (action, context, meta): Promise<ActionResult> => {
  const id = (action.campaignId as string | undefined) ?? ctxCampaignId(action, context)
  if (!id) return { type: action.type, ok: false, error: 'No campaign.id' }
  const oldPriceEur = Number(action.oldPriceEur)
  const newPriceEur = Number(action.newPriceEur)
  if (!Number.isFinite(oldPriceEur) || !Number.isFinite(newPriceEur) || oldPriceEur <= 0) return { type: action.type, ok: false, error: 'oldPriceEur + newPriceEur required' }
  const scaleFactor = newPriceEur / oldPriceEur
  const clamped = Math.max(0.5, Math.min(2.0, scaleFactor)) // ±50% max per trigger
  const targets = await prisma.adTarget.findMany({ where: { status: 'ENABLED', isNegative: false, adGroup: { campaignId: id } }, select: { id: true, bidCents: true } })
  if (meta.dryRun) return { type: action.type, ok: true, output: { dryRun: true, targets: targets.length, scaleFactor: clamped, oldPriceEur, newPriceEur } }
  const { bulkUpdateAdTargetBids } = await import('./ads-mutation.service.js')
  const entries = targets.map((t) => ({ adTargetId: t.id, bidCents: Math.max(5, Math.round(t.bidCents * clamped)) }))
  await bulkUpdateAdTargetBids({ entries, actor: RULE_ACTOR(meta.ruleId), reason: `scale_bids_for_price_change ×${clamped.toFixed(2)}` })
  return { type: action.type, ok: true, output: { scaled: entries.length, scaleFactor: clamped } }
}

// ── enable_campaign ───────────────────────────────────────────────────
ACTION_HANDLERS.enable_campaign = async (action, context, meta): Promise<ActionResult> => {
  const id = (action.campaignId as string | undefined) ?? ctxCampaignId(action, context)
  if (!id) return { type: action.type, ok: false, error: 'No campaign.id' }
  if (meta.dryRun) return { type: action.type, ok: true, output: { dryRun: true, campaignId: id } }
  const res = await updateCampaignWithSync({ campaignId: id, patch: { status: 'ENABLED' }, actor: RULE_ACTOR(meta.ruleId), reason: 'enable_campaign via rule', applyImmediately: true } as never)
  return { type: action.type, ok: res.ok, output: { campaignId: id, outboundQueueId: res.outboundQueueId } }
}

// ── archive_keyword ───────────────────────────────────────────────────
// Permanently archive a keyword (stronger than pause — Amazon ignores it).
ACTION_HANDLERS.archive_keyword = async (action, context, meta): Promise<ActionResult> => {
  const id = (action.adTargetId as string | undefined) ?? ctxAdTargetId(action, context)
  if (!id) return { type: action.type, ok: false, error: 'No adTarget.id' }
  if (meta.dryRun) return { type: action.type, ok: true, output: { dryRun: true, adTargetId: id } }
  const res = await updateAdTargetWithSync({ adTargetId: id, patch: { status: 'ARCHIVED' }, actor: RULE_ACTOR(meta.ruleId), reason: 'archive_keyword via rule' })
  return { type: action.type, ok: res.ok, error: res.error ?? undefined, output: { adTargetId: id, outboundQueueId: res.outboundQueueId } }
}

// ── lower_bid_to_floor ────────────────────────────────────────────────
// Set a keyword bid to the absolute minimum (€0.05). Keeps it alive for
// data collection while minimizing waste — preferred over archiving for
// low-data keywords.
ACTION_HANDLERS.lower_bid_to_floor = async (action, context, meta): Promise<ActionResult> => {
  const id = (action.adTargetId as string | undefined) ?? ctxAdTargetId(action, context)
  const floorCents = Math.max(5, Number(action.floorCents ?? 5))
  if (!id) return { type: action.type, ok: false, error: 'No adTarget.id' }
  if (meta.dryRun) return { type: action.type, ok: true, output: { dryRun: true, adTargetId: id, bidCents: floorCents } }
  const res = await updateAdTargetWithSync({ adTargetId: id, patch: { bidCents: floorCents }, actor: RULE_ACTOR(meta.ruleId), reason: 'lower_bid_to_floor via rule' })
  return { type: action.type, ok: res.ok, error: res.error ?? undefined, output: { adTargetId: id, bidCents: floorCents, outboundQueueId: res.outboundQueueId } }
}

// ── raise_bids_for_rank_defense ───────────────────────────────────────
// When impression share drops, raise bids aggressively to defend position.
// Rate-limited: caps at MAX_PCT and one-step-at-a-time per rule fire.
ACTION_HANDLERS.raise_bids_for_rank_defense = async (action, context, meta): Promise<ActionResult> => {
  const id = (action.campaignId as string | undefined) ?? ctxCampaignId(action, context)
  const pct = Math.min(50, Math.max(5, Number(action.percent ?? 20)))
  if (!id) return { type: action.type, ok: false, error: 'No campaign.id' }
  const targets = await prisma.adTarget.findMany({ where: { status: 'ENABLED', isNegative: false, adGroup: { campaignId: id } }, select: { id: true, bidCents: true }, take: 200 })
  const entries = targets.map((t) => ({ adTargetId: t.id, bidCents: Math.round(t.bidCents * (1 + pct / 100)) }))
  if (meta.dryRun) return { type: action.type, ok: true, output: { dryRun: true, targets: entries.length, raisePct: pct } }
  const { bulkUpdateAdTargetBids } = await import('./ads-mutation.service.js')
  await bulkUpdateAdTargetBids({ entries, actor: RULE_ACTOR(meta.ruleId), reason: `rank_defense +${pct}%` })
  return { type: action.type, ok: true, output: { raised: entries.length, pct } }
}

// ── alert_operator ────────────────────────────────────────────────────
// Richer version of notify — can include structured data for dashboard alerts.
ACTION_HANDLERS.alert_operator = async (action, context, meta): Promise<ActionResult> => {
  const severity = (action.severity as string | undefined) ?? 'info'
  const message = (action.message as string | undefined) ?? `Automation alert: ${action.type}`
  logger.warn(`[automation:alert] ${severity.toUpperCase()}: ${message}`, { ruleId: meta.ruleId, context: JSON.stringify(context)?.slice(0, 500) })
  return { type: action.type, ok: true, output: { severity, message, ruleId: meta.ruleId, timestamp: new Date().toISOString() } }
}

// ── EA1: builder-rule apply handlers ──────────────────────────────────
// Thin handlers the ads-rule-adapter translates the Budget/Placement BUILDER rules to. They
// support the builder's full action vocab (set / increase / decrease, % or absolute) + the
// builder's guardrail clamps, reading CURRENT from the campaign and routing the write through
// the SAME gated path as adjust_ad_budget. Kept separate from adjust_ad_budget so the seeded
// AME/AD rules stay byte-identical.
type BuilderOp = 'set' | 'incPct' | 'decPct' | 'incAbs' | 'decAbs'
function applyBuilderOp(op: BuilderOp | string, current: number, value: number): number {
  switch (op) {
    case 'set': return value
    case 'incPct': return current * (1 + value / 100)
    case 'decPct': return current * (1 - value / 100)
    case 'incAbs': return current + value
    case 'decAbs': return current - value
    default: return current
  }
}
const clampRange = (x: number, min: number, max: number | null) => Math.min(max ?? Infinity, Math.max(min, x))

// budget_apply — Set/Increase/Decrease a campaign's daily budget, clamped to [minEur, maxEur].
ACTION_HANDLERS.budget_apply = async (action, context, meta): Promise<ActionResult> => {
  const id = ctxCampaignId(action, context)
  if (!id) return { type: action.type, ok: false, error: 'No campaign.id in context' }
  const c = await prisma.campaign.findUnique({ where: { id }, select: { dailyBudget: true } })
  if (!c) return { type: action.type, ok: false, error: 'Campaign not found' }
  const current = Number(c.dailyBudget)
  const minEur = Math.max(1, Number(action.minEur ?? 1)) // never below Amazon's €1 floor
  const maxEur = action.maxEur != null ? Number(action.maxEur) : null
  const next = Math.round(clampRange(applyBuilderOp(action.op as string, current, Number(action.value) || 0), minEur, maxEur) * 100) / 100
  const delta = Math.max(0, Math.round((next - current) * 100))
  if (meta.dryRun) {
    return { type: action.type, ok: true, estimatedValueCentsEur: delta, output: { dryRun: true, campaignId: id, wouldChange: `€${current.toFixed(2)} → €${next.toFixed(2)}` } }
  }
  if (next === current) return { type: action.type, ok: true, estimatedValueCentsEur: 0, output: { campaignId: id, noChange: true } }
  const cap = await checkDailySpendCap(meta.ruleId, delta)
  if (!cap.allowed) return { type: action.type, ok: false, error: cap.error, estimatedValueCentsEur: 0 }
  const res = await updateCampaignWithSync({ campaignId: id, patch: { dailyBudget: next }, actor: RULE_ACTOR(meta.ruleId), reason: (action.reason as string) ?? `budget_apply via rule ${meta.ruleId}` })
  return { type: action.type, ok: res.ok, error: res.error ?? undefined, estimatedValueCentsEur: delta, output: { campaignId: id, newDailyBudget: next, outboundQueueId: res.outboundQueueId } }
}

// placement_apply — Set/Increase/Decrease a placement bid modifier (%), clamped to [minPct, maxPct]
// (Amazon allows 0–900%). Reads CURRENT from dynamicBidding.placementBidding for inc/dec.
ACTION_HANDLERS.placement_apply = async (action, context, meta): Promise<ActionResult> => {
  const id = (action.campaignId as string | undefined) ?? ctxCampaignId(action, context)
  if (!id) return { type: action.type, ok: false, error: 'No campaign.id in context' }
  const placement = (action.placement as string | undefined) ?? 'PLACEMENT_TOP'
  const c = await prisma.campaign.findUnique({ where: { id }, select: { dynamicBidding: true } })
  const db = (c?.dynamicBidding ?? {}) as { placementBidding?: Array<{ placement: string; percentage: number }> }
  const current = db.placementBidding?.find((x) => x.placement === placement)?.percentage ?? 0
  const minPct = Math.max(0, Number(action.minPct ?? 0))
  const maxPct = Math.min(900, Number(action.maxPct ?? 900))
  const next = Math.round(clampRange(applyBuilderOp(action.op as string, current, Number(action.value) || 0), minPct, maxPct))
  if (meta.dryRun) {
    return { type: action.type, ok: true, output: { dryRun: true, campaignId: id, placement, wouldChange: `${current}% → ${next}%` } }
  }
  if (next === current) return { type: action.type, ok: true, output: { campaignId: id, placement, noChange: true } }
  const { updatePlacementBidding } = await import('./ads-create.service.js')
  const others = (db.placementBidding ?? []).filter((x) => x.placement !== placement)
  const res = await updatePlacementBidding({ campaignId: id, adjustments: [...others, { placement, percentage: next }] })
  return { type: action.type, ok: res.ok !== false, output: { campaignId: id, placement, percentage: next, mode: res.mode } }
}

// bid_apply (EA2) — Set/Increase/Decrease a keyword/target bid (adTarget.bidCents), clamped to
// [minEur,maxEur] with the €0.05 floor. Optional campaignIds allowlist (the Bid builder's picker):
// skip targets whose campaign isn't selected.
ACTION_HANDLERS.bid_apply = async (action, context, meta): Promise<ActionResult> => {
  const id = (action.adTargetId as string | undefined) ?? (getFieldPath(context, 'adTarget.id') as string | undefined)
  if (!id) return { type: action.type, ok: false, error: 'No adTarget.id in context' }
  const t = await prisma.adTarget.findUnique({ where: { id }, select: { bidCents: true, adGroup: { select: { campaignId: true } } } })
  if (!t) return { type: action.type, ok: false, error: 'AdTarget not found' }
  const allow = Array.isArray(action.campaignIds) ? (action.campaignIds as string[]) : []
  if (allow.length && t.adGroup?.campaignId && !allow.includes(t.adGroup.campaignId)) {
    return { type: action.type, ok: true, output: { skipped: 'campaign-not-selected', adTargetId: id } }
  }
  const currentEur = (t.bidCents ?? 0) / 100
  const floorEur = Math.max(0.05, action.minEur != null ? Number(action.minEur) : 0.05)
  const ceilEur = action.maxEur != null ? Number(action.maxEur) : null
  const nextEur = Math.round(clampRange(applyBuilderOp(action.op as string, currentEur, Number(action.value) || 0), floorEur, ceilEur) * 100) / 100
  const nextCents = Math.round(nextEur * 100)
  if (meta.dryRun) return { type: action.type, ok: true, output: { dryRun: true, adTargetId: id, wouldChange: `${t.bidCents}¢ → ${nextCents}¢` } }
  if (nextCents === t.bidCents) return { type: action.type, ok: true, output: { adTargetId: id, noChange: true } }
  const res = await updateAdTargetWithSync({ adTargetId: id, patch: { bidCents: nextCents }, actor: RULE_ACTOR(meta.ruleId), reason: (action.reason as string) ?? `bid_apply via rule ${meta.ruleId}` })
  return { type: action.type, ok: res.ok, error: res.error ?? undefined, output: { adTargetId: id, newBidCents: nextCents, outboundQueueId: res.outboundQueueId } }
}

// dayparting_apply (EA2) — SCHEDULE trigger. At each tick, find the weekly window(s) covering the
// current hour (in the rule's timezone) and enable/pause the rule's campaigns for THIS marketplace.
const DOW_NAME: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
function nowInTimezone(tz: string): { dow: number; hour: number } {
  const now = new Date()
  let dowName = 'Mon', hourStr = '0'
  try {
    dowName = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(now)
    hourStr = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hour12: false }).format(now)
  } catch { /* invalid tz → defaults */ }
  return { dow: DOW_NAME[dowName] ?? 1, hour: Number(hourStr) % 24 }
}
ACTION_HANDLERS.dayparting_apply = async (action, context, meta): Promise<ActionResult> => {
  const tz = (action.timezone as string) ?? 'Europe/Rome'
  const windows = (Array.isArray(action.windows) ? action.windows : []) as Array<{ day: number; start: string; end: string; adj: string }>
  const allow = (Array.isArray(action.campaignIds) ? action.campaignIds : []) as string[]
  const marketplace = (context as { marketplace?: string }).marketplace ?? null
  const { dow, hour } = nowInTimezone(tz)
  const hh = (t: string) => Number(String(t).split(':')[0])
  // active window for the current day+hour (last one wins if overlapping)
  const active = windows.filter((w) => w.day === dow && hh(w.start) <= hour && hour < hh(w.end) && (w.adj === 'enable' || w.adj === 'pause')).pop()
  if (!active) return { type: action.type, ok: true, output: { tz, dow, hour, noActiveWindow: true } }
  // the rule's campaigns in THIS marketplace
  const camps = await prisma.campaign.findMany({
    where: { id: { in: allow.length ? allow : ['__none__'] }, ...(marketplace ? { marketplace } : {}) },
    select: { id: true, status: true, name: true },
  })
  const desired = active.adj === 'enable' ? 'ENABLED' : 'PAUSED'
  const toChange = camps.filter((c) => c.status !== desired)
  if (meta.dryRun) return { type: action.type, ok: true, output: { dryRun: true, tz, dow, hour, action: active.adj, wouldChange: toChange.length, sample: toChange.slice(0, 6).map((c) => c.name) } }
  let changed = 0; const errors: string[] = []
  for (const c of toChange) {
    try { const r = await updateCampaignWithSync({ campaignId: c.id, patch: { status: desired as 'ENABLED' | 'PAUSED' }, actor: RULE_ACTOR(meta.ruleId), reason: `dayparting ${active.adj} via rule ${meta.ruleId}` }); if (r.ok) changed++ }
    catch (e) { errors.push((e as Error).message) }
  }
  return { type: action.type, ok: true, output: { tz, dow, hour, action: active.adj, changed, errors: errors.slice(0, 5) } }
}

logger.debug('[advertising] action handlers registered', {
  count: 13,
  types: [
    'bid_down',
    'bid_up',
    'pause_ad_group',
    'pause_campaign',
    'adjust_ad_budget',
    'create_amazon_promotion',
    'reroute_marketplace_budget',
    'liquidate_aged_stock',
    'budget_apply',
    'placement_apply',
    'bid_apply',
    'dayparting_apply',
    'add_negative_exact(scope)',
  ],
})
