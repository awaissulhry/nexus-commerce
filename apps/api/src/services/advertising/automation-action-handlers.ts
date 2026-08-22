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
import type { AdWriteEvidence } from './ads-evidence.js'
// P1 — the harvest thresholds this file falls back to, shared with the Rules grid that renders them.
import { BID_WINDOW_MAX, BID_WINDOW_MIN, HARVEST_DEFAULTS, TRIGGER_WINDOW } from '@nexus/shared/ads-rule-window'
import { ruleWindowBounds } from '@nexus/shared/data-vintage'
import { microsToCents } from '../ads-core/metrics-math.js'
// NEG.0(a) — the reader for `protectConverting`. Until this import existed, the builder's headline
// safety promise was written into every negation rule's action JSON and consulted by nothing.
import { checkProtectConverting, protectConvertingConfig, normaliseNegTerm } from './ads-protect-converting.js'
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

/**
 * ADX A2 — forward the trigger's own evidence onto the write it causes.
 *
 * The context builder states the measurement that made the rule match (metric, observed,
 * threshold, window); this hands it to the mutation so AdvertisingActionLog.evidence
 * records WHY, not just what. Returns null when the trigger declared nothing, which keeps
 * "no evidence" distinguishable from "{}" — see packEvidence.
 */
function ctxEvidence(context: unknown): AdWriteEvidence | null {
  const e = (context as { evidence?: AdWriteEvidence } | null | undefined)?.evidence
  return e && typeof e === 'object' ? e : null
}

function ctxCampaignId(action: Record<string, unknown>, context: unknown): string | null {
  return (
    (action.campaignId as string | undefined) ??
    (getFieldPath(context, 'campaign.id') as string | undefined) ??
    null
  )
}
/**
 * EA4 — does this action's campaign allowlist admit `campaignId`?
 *
 * `campaignIds` is what the builder's campaign picker becomes (`ads-rule-adapter.service.ts`).
 * **Empty or absent means no restriction** — an account-wide rule stores no list, and treating
 * that as "match nothing" would silently disarm every existing rule.
 */
function campaignAllowed(action: Record<string, unknown>, campaignId: string): boolean {
  const allow = Array.isArray(action.campaignIds) ? (action.campaignIds as string[]) : []
  return allow.length === 0 || allow.includes(campaignId)
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
      evidence: ctxEvidence(context),
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
      evidence: ctxEvidence(context),
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
      evidence: ctxEvidence(context),
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
  /**
   * ACR.6 — this branch was missing, and its absence was a one-way ratchet.
   *
   * `bid_down` has handled BOTH `ad_target` and `ad_group` since it was written; `bid_up` handled
   * only `ad_target` and fell through to "Unsupported target=ad_group". The two are mirror-image
   * actions authored together, so this is an oversight rather than a decision — and the effect on
   * prod was that automation could lower ad-group bids but never raise them. Measured 2026-08-05:
   * "Reduce bids on ACOS spike" (bid_down · ad_group · enabled · live) worked, while "New-to-brand
   * optimizer" (bid_up · ad_group · enabled · live) failed 2,032 times in 30 days with this exact
   * error, its runs completing so every run-based health read showed it fine.
   *
   * Structure mirrors bid_down's ad_group branch; the spend estimate and the daily-cap check are
   * bid_up's own, because raising a bid costs money and lowering one does not. AdGroup carries
   * `spendCents`, so the estimate is the same shape as the ad_target branch above.
   */
  if (target === 'ad_group') {
    const id = ctxAdGroupId(action, context)
    if (!id) return { type: action.type, ok: false, error: 'No adGroup.id in context' }
    const ag = await prisma.adGroup.findUnique({
      where: { id },
      select: { defaultBidCents: true, spendCents: true },
    })
    if (!ag) return { type: action.type, ok: false, error: 'AdGroup not found' }
    const newBid = applyBidPercent(ag.defaultBidCents, percent)
    estimated = Math.max(
      0,
      Math.round((ag.spendCents / 30) * (newBid / Math.max(1, ag.defaultBidCents) - 1)),
    )
    if (meta.dryRun) {
      return {
        type: action.type,
        ok: true,
        estimatedValueCentsEur: estimated,
        output: { dryRun: true, target, id, wouldChange: `${ag.defaultBidCents}→${newBid} cents`, estimatedDailySpendCents: estimated },
      }
    }
    const cap = await checkDailySpendCap(meta.ruleId, estimated)
    if (!cap.allowed) {
      return { type: action.type, ok: false, error: cap.error, estimatedValueCentsEur: 0 }
    }
    const res = await updateAdGroupWithSync({
      evidence: ctxEvidence(context),
      adGroupId: id,
      patch: { defaultBidCents: newBid },
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
    evidence: ctxEvidence(context),
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
    // CAP — the detailed variant, so a SUPPRESSED notice does not read as a failed one.
    // `notified: 0` from a dedupe and `notified: 0` from a broken notifier are the same number and
    // very different facts; that conflation is what hid `alert_operator` for months.
    const { notifyAutomationDetailed } = await import('./ads-automation-notify.service.js')
    const r = await notifyAutomationDetailed({ type: 'ads-automation-rule', severity, title, body, meta: { ruleId: meta.ruleId, dryRun: meta.dryRun } })
    return {
      type: action.type,
      ok: true,
      output: { notified: r.created, deduped: r.deduped, reachable: r.wouldHaveReached, title, dryRun: meta.dryRun },
    }
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
    select: { dailyBudget: true, dailyBudgetCurrency: true, budgetBaselineCents: true },
  })
  if (!c) return { type: action.type, ok: false, error: 'Campaign not found' }
  const current = Number(c.dailyBudget)
  // BUD.2 — a RELATIVE change anchors to the BASELINE when one is captured. −20% of the current
  // value compounds (€100 → €1 in 39 ticks, measured); −20% of a €100 baseline is €80 on every
  // tick — the same rule, idempotent. NULL baseline = the old behaviour, so nothing changes
  // until an operator captures one.
  const anchor = c.budgetBaselineCents != null ? c.budgetBaselineCents / 100 : current
  let next: number
  if (action.newDailyBudget != null) {
    next = Number(action.newDailyBudget)
  } else if (action.percent != null) {
    next = anchor * (1 + Number(action.percent) / 100)
  } else {
    return { type: action.type, ok: false, error: 'Specify newDailyBudget or percent' }
  }
  next = Math.max(1, Math.round(next * 100) / 100) // floor €1
  // BUD.2 — at the target already: say so and stop. Without this, a baseline-anchored rule
  // re-issues the identical write every tick — the 488-row loop BUD.1 measured, re-created
  // politely.
  if (next === current) {
    return { type: action.type, ok: true, estimatedValueCentsEur: 0, output: { campaignId: id, noChange: true, dailyBudget: next, anchoredToBaseline: c.budgetBaselineCents != null } }
  }
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
    // ACR.0.5 — nulls last. trueProfitCents is nullable now ("no cost price loaded"), and
    // Postgres sorts NULLS FIRST on DESC, which would have handed the budget to the
    // campaigns we know least about while calling them the most profitable.
    orderBy: { trueProfitCents: { sort: 'desc', nulls: 'last' } },
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

/**
 * ACR.7b — resolve a rule's drag-binding into the entity sets its SWEEPS may touch.
 *
 * Scope enforcement at the evaluator governs WHERE a rule fires. Sweep actions
 * (harvest_and_negate, sync_negatives_across_campaigns) then act marketplace-wide from a
 * single firing — so without this, binding a harvest rule to the GALE portfolio changed which
 * tick triggered it and nothing about what it swept. The cockpit said so honestly; this
 * closes it: a bound rule's sweep is restricted to the campaigns inside its binding.
 *
 * Fail-closed on purpose: a scope that resolves to zero campaigns (portfolio emptied, campaign
 * archived) sweeps NOTHING rather than falling back to everything — the same rule the wizard
 * sources path already follows ("resolves to [] and harvests nothing").
 */
async function resolveRuleSweepScope(ruleId: string): Promise<{
  scoped: boolean
  campaignIds: string[]
  adGroupExternalIds: string[]
}> {
  const rule = await prisma.automationRule.findUnique({
    where: { id: ruleId },
    select: { scopePortfolioId: true, scopeCampaignId: true },
  }).catch(() => null)
  if (!rule || (rule.scopePortfolioId == null && rule.scopeCampaignId == null)) {
    return { scoped: false, campaignIds: [], adGroupExternalIds: [] }
  }
  const campaigns = await prisma.campaign.findMany({
    where: rule.scopeCampaignId ? { id: rule.scopeCampaignId } : { portfolioId: rule.scopePortfolioId },
    select: { id: true, adGroups: { select: { externalAdGroupId: true } } },
  })
  return {
    scoped: true,
    campaignIds: campaigns.map((c) => c.id),
    adGroupExternalIds: campaigns
      .flatMap((c) => c.adGroups.map((g) => g.externalAdGroupId))
      .filter((x): x is string => !!x),
  }
}

// ── AU.1: harvest_and_negate ──────────────────────────────────────────
// Runs automated keyword harvesting: promotes high-converting search terms
// to exact-match campaigns (graduation) and negates wasters. Designed for
// the SCHEDULE trigger so it runs on a daily cadence without user input.
// Parameters mirror previewHarvest opts so a rule can tune thresholds.
//
// 🔴 P1 (2026-08-20) — the three fallbacks are imported from `@nexus/shared/ads-rule-window`, not
// inlined. Same numbers as before (60 · 1000 · 2, diffed on the day); what changed is that the
// Rules & Automation grid can now state what binds a rule that sets none of them, instead of
// printing "Always" over a rule that harvests at ≥2 orders and €10. Two copies of a threshold is
// how a grid starts describing a rule the engine does not run.
//
// ⚠ These are NOT `previewHarvest`'s own defaults — it falls back to minSpendCents **1500**
// (€15) where every rule negates at €10. The gap stopped biting when HP5 (2026-08-21) retired
// the nightly cron that called `previewHarvest({})` bare; the remaining bare-preview callers
// are read-only surfaces.
ACTION_HANDLERS.harvest_and_negate = async (action, _context, meta): Promise<ActionResult> => {
  const windowDays = typeof action.windowDays === 'number' ? action.windowDays : HARVEST_DEFAULTS.windowDays
  const minSpendCents = typeof action.minSpendCents === 'number' ? action.minSpendCents : HARVEST_DEFAULTS.minSpendCents
  const minOrders = typeof action.minOrders === 'number' ? action.minOrders : HARVEST_DEFAULTS.minOrders
  const { previewHarvest, applyHarvest } = await import('./ads-harvest.service.js')

  // AT.4b — if the rule carries wizard `sources` (per-ad-group harvest scope +
  // graduate/negate match types), scope harvesting to those ad groups and honor
  // their match types. No `sources` → unchanged global behaviour (the standalone
  // "Auto harvest & negate" template). Scope uses live external ad-group ids, so a
  // rule whose campaigns are still gated/local resolves to [] and harvests nothing.
  const rawSources = (action as unknown as { sources?: unknown }).sources
  const sources = Array.isArray(rawSources)
    ? (rawSources as Array<{ adGroupId?: string; graduate?: string[]; negate?: string[]; harvestFrom?: boolean; graduateProduct?: boolean; negateProduct?: boolean }>)
    : null
  let adGroupExternalIds: string[] | undefined
  let plan: Record<string, { graduate?: string[]; negate?: string[]; graduateProduct?: boolean; negateProduct?: boolean }> | undefined
  if (sources && sources.length) {
    const localIds = sources.filter((s) => s.adGroupId).map((s) => s.adGroupId as string)
    const ags = localIds.length ? await prisma.adGroup.findMany({ where: { id: { in: localIds } }, select: { id: true, externalAdGroupId: true } }) : []
    const extById = new Map(ags.map((a) => [a.id, a.externalAdGroupId]))
    adGroupExternalIds = sources.filter((s) => s.harvestFrom && s.adGroupId).map((s) => extById.get(s.adGroupId as string)).filter((x): x is string => !!x)
    plan = {}
    // H.5 — forward the product flags (graduateProduct/negateProduct) so the engine harvests ASINs too.
    for (const s of sources) {
      const ext = s.adGroupId ? extById.get(s.adGroupId) : null
      if (ext) plan[ext] = { graduate: s.graduate, negate: s.negate, graduateProduct: s.graduateProduct, negateProduct: s.negateProduct }
    }
  }

  // ACR.7b — a drag-bound rule sweeps only inside its binding. When the wizard ALSO scoped
  // it to specific ad groups, the binding still bounds the sweep: intersect, never widen.
  const sweep = await resolveRuleSweepScope(meta.ruleId)
  if (sweep.scoped) {
    adGroupExternalIds = adGroupExternalIds
      ? adGroupExternalIds.filter((id) => sweep.adGroupExternalIds.includes(id))
      : sweep.adGroupExternalIds
  }

  const preview = await previewHarvest({ windowDays, minSpendCents, minOrders, adGroupExternalIds })
  if (meta.dryRun) {
    return {
      type: action.type,
      ok: true,
      output: {
        dryRun: true,
        scoped: !!sources || sweep.scoped,
        ruleScope: sweep.scoped ? { adGroups: sweep.adGroupExternalIds.length, campaigns: sweep.campaignIds.length } : null,
        // H.4 — nothing to harvest this tick → noChange, so the Suggestions generator skips an empty card.
        noChange: preview.negatives.length === 0 && preview.graduations.length === 0 && preview.productNegatives.length === 0 && preview.productGraduations.length === 0,
        wouldNegate: preview.negatives.length,
        wouldGraduate: preview.graduations.length,
        wouldGraduateProduct: preview.productGraduations.length,
        wouldNegateProduct: preview.productNegatives.length,
        topNegatives: preview.negatives.slice(0, 5).map((n) => ({ query: n.query, costCents: n.costCents })),
        topGraduations: preview.graduations.slice(0, 5).map((g) => ({ query: g.query, orders: g.orders })),
      },
    }
  }
  // H.2 — destination map (matchType → destination local ad group) carried by the wizard rule, so a
  // graduated keyword promotes into the campaign that hosts that match type instead of its source.
  const destinations = (action as unknown as { destinations?: Record<string, string> }).destinations
  const result = await applyHarvest({
    negatives: preview.negatives,
    graduations: preview.graduations.map((g) => ({ ...g, bidEur: typeof action.graduationBidEur === 'number' ? action.graduationBidEur : 0.5 })),
    productNegatives: preview.productNegatives,
    productGraduations: preview.productGraduations.map((g) => ({ ...g, bidEur: typeof action.graduationBidEur === 'number' ? action.graduationBidEur : 0.5 })),
    userId: `automation:${meta.ruleId}`,
    plan,
    destinations: destinations && typeof destinations === 'object' ? destinations : undefined,
    // NEG.0(a) — carry the rule's own toggle through. Absent means ON, in the service as here.
    protectConverting: (action as unknown as { protectConverting?: boolean }).protectConverting,
    protectDays: (action as unknown as { protectDays?: number }).protectDays,
  })
  return {
    type: action.type,
    ok: result.errors.length === 0 || result.negativesAdded + result.keywordsGraduated + result.productsGraduated + result.productNegativesAdded > 0,
    output: {
      negativesAdded: result.negativesAdded,
      keywordsGraduated: result.keywordsGraduated,
      isolationNegativesAdded: result.isolationNegativesAdded,
      productsGraduated: result.productsGraduated,
      productNegativesAdded: result.productNegativesAdded,
      // A refusal that never leaves the service is the same silent skip in a different file.
      negativesProtected: result.negativesProtected,
      protectedTerms: result.protectedTerms.slice(0, 5),
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
  const res = await updatePlacementBidding({ campaignId, adjustments: [...others, { placement, percentage: pct }], actor: `automation:rule-${meta.ruleId}`, reason: `rule ${action.type}` })
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

// ── add_negative_exact · add_negative_phrase ──────────────────────────
// Add a specific query as a negative to a campaign. Designed for use with
// KEYWORD_WASTED_SPEND and SEARCH_TERM triggers where we know the exact term.
//
// P2.6 — one body, two match types. `add_negative_phrase` was offered on the Negative Targeting
// tab, categorised in rule-category.ts and ceilinged in ads-graduation.ts — and absent from this
// map, so a rule using it failed every execution with "Unknown action type". NEG.X proved phrase
// negation through the same `createNegative` path (three NEGATIVE_PHRASE rows live at Amazon), so
// the handler is the exact handler with the match type as a parameter.
const makeAddNegativeHandler = (matchType: 'NEGATIVE_EXACT' | 'NEGATIVE_PHRASE') =>
  async (action: Record<string, unknown> & { type: string }, context: unknown, meta: { ruleId: string; dryRun: boolean }): Promise<ActionResult> => {
    const keyword = (action.keyword as string | undefined) ?? (action.query as string | undefined) ?? (context as any)?.searchTerm?.query
    const externalCampaignId = (action.externalCampaignId as string | undefined) ?? (context as any)?.searchTerm?.externalCampaignId ?? (context as any)?.campaign?.externalCampaignId
    if (!keyword) return { type: action.type, ok: false, error: 'No keyword/query to negate' }
    if (!externalCampaignId) return { type: action.type, ok: false, error: 'No externalCampaignId in context' }

    /**
     * NEG-P1 — the mapped wire path. A builder negative rule carries `action.negative`
     * (normalizeHarvestWire's shape — same stored form as harvest) plus `levels` from the
     * Negation Level select. The look-set gates which contexts may act; the create-ticks decide
     * what is created where (E → negative exact, P → negative phrase, product → negative product
     * target when the term IS an ASIN); the term/brand filters and dedupe are honoured; every
     * write that does not land at Amazon is a FAILURE naming its gate, and every landed write is
     * mirrored locally with an audit row (createNegative alone leaves no local record — the
     * NEG.X defect this path must not reintroduce). Rules without the wire (every engine-native
     * caller) take the legacy single-scope path below, byte-for-byte.
     */
    const wire = (action.negative ?? null) as import('./ads-harvest-wire.js').HarvestWire | null
    if (wire) {
      const marketplace = (context as any)?.marketplace as string | undefined
      if (!marketplace) return { type: action.type, ok: false, error: 'No marketplace in context — the write gate cannot resolve a connection, so this negation cannot be checked against the protected terms' }
      const srcExt = (action.externalAdGroupId as string | undefined) ?? (context as any)?.searchTerm?.externalAdGroupId
      if (!srcExt) return { type: action.type, ok: false, error: 'No source ad group in context to check the mappings against' }
      const src = await prisma.adGroup.findFirst({ where: { externalAdGroupId: srcExt }, select: { id: true } })
      if (!src) return { type: action.type, ok: false, error: `No local ad group for externalAdGroupId=${srcExt}` }
      const { matchedBlocks, termPassesFilters } = await import('./ads-harvest-wire.js')

      // 1 — is this term's source ad group inside the rule's mappings?
      const blocks = matchedBlocks(wire.blocks, src.id)
      if (blocks !== 'account-wide' && blocks.length === 0) {
        return { type: action.type, ok: true, output: { skipped: 'source-ad-group-not-in-mappings', keyword, sourceAdGroupId: src.id } }
      }

      // 2 — term/brand/competitor filters. Same predicate as harvest; the direction matches:
      // brandExclude = never negate your own brand terms, competitorOnly = own ASINs pass through.
      const looksLikeAsin = /^b0[a-z0-9]{8}$/i.test(keyword.trim())
      const isOwnAsin = wire.filters.competitorOnly && looksLikeAsin
        ? (await prisma.adProductAd.count({ where: { asin: { equals: keyword.trim(), mode: 'insensitive' } } })) > 0
        : false
      const filt = termPassesFilters(keyword, wire.filters, isOwnAsin)
      if (filt.pass === false) return { type: action.type, ok: true, output: { skipped: 'term-filter', reason: filt.reason, keyword } }

      // 3 — the account protections (NEG.0a), before any write and before the dry-run return.
      const guard = await checkProtectConverting({ terms: [keyword], config: protectConvertingConfig(action) })
      const decision = guard.get(normaliseNegTerm(keyword))
      if (decision && !decision.allowed) {
        logger.warn(`[${action.type}] refused by protectConverting`, { ruleId: meta.ruleId, keyword, evidence: decision.evidence })
        return { type: action.type, ok: false, error: decision.reason, output: { refusedBy: 'protectConverting', evidence: decision.evidence, keyword } }
      }

      // 4 — the negation set: mapped destinations × ticked types; account-wide negates the source.
      const targets = blocks === 'account-wide'
        ? [{ adGroupId: src.id, types: ['EXACT' as const] }]
        : (() => {
          const seen = new Map<string, Set<string>>()
          for (const b of blocks) for (const c of b.create) {
            const s = seen.get(c.adGroupId) ?? new Set<string>()
            for (const t of c.types) s.add(t)
            seen.set(c.adGroupId, s)
          }
          return [...seen.entries()].map(([adGroupId, types]) => ({ adGroupId, types: [...types] as Array<'PHRASE' | 'EXACT' | 'ASIN'> }))
        })()
      const levels = Array.isArray(action.levels) && (action.levels as unknown[]).length > 0
        ? (action.levels as unknown[]).map(String).filter((l) => l === 'AD_GROUP' || l === 'CAMPAIGN')
        : ['AD_GROUP']

      const conn = await prisma.amazonAdsConnection.findFirst({ where: { marketplace, isActive: true }, select: { profileId: true } })
      const { createNegative } = await import('./ads-negative-kw.service.js')
      const { mirrorNegativeKeywordLocal, createNegativeKeywordCampaignLocal, createNegativeProductTargetLocal } = await import('./ads-create.service.js')

      const outcomes: Array<Record<string, unknown>> = []
      let confirmed = 0
      let failedWrites = 0
      const campaignsDone = new Set<string>() // one campaign-level write per campaign, however many destinations share it
      for (const target of targets) {
        const dst = await prisma.adGroup.findFirst({
          where: { id: target.adGroupId },
          select: { id: true, externalAdGroupId: true, campaignId: true, campaign: { select: { externalCampaignId: true } } },
        })
        if (!dst?.externalAdGroupId || !dst.campaign?.externalCampaignId) {
          failedWrites += 1
          outcomes.push({ adGroupId: target.adGroupId, refused: 'destination ad group has no Amazon ids — it cannot receive a negative' })
          continue
        }
        for (const t of target.types) {
          // product circle → a negative PRODUCT target; only an ASIN-shaped term can be one.
          if (t === 'ASIN') {
            if (!looksLikeAsin) { outcomes.push({ adGroupId: dst.id, matchType: 'PRODUCT', skipped: 'negative product target needs an ASIN-shaped term — keyword types on this mapping were still processed' }); continue }
            if (meta.dryRun) { outcomes.push({ adGroupId: dst.id, matchType: 'PRODUCT', level: 'AD_GROUP', wouldCreate: true }); continue }
            const r = await createNegativeProductTargetLocal({ adGroupId: dst.id, asin: keyword.trim() })
            if (r.externalTargetId != null) { confirmed += 1; outcomes.push({ adGroupId: dst.id, matchType: 'PRODUCT', level: 'AD_GROUP', externalTargetId: r.externalTargetId, reachedAmazon: true }) }
            else { failedWrites += 1; outcomes.push({ adGroupId: dst.id, matchType: 'PRODUCT', level: 'AD_GROUP', adTargetId: r.id, reachedAmazon: false, refused: `negative product target did not land (mode=${r.mode}) — gate or connection` }) }
            continue
          }
          const matchType = t === 'PHRASE' ? 'NEGATIVE_PHRASE' as const : 'NEGATIVE_EXACT' as const
          for (const level of levels) {
            if (level === 'CAMPAIGN' && campaignsDone.has(dst.campaignId)) continue
            // dedupe — "already negated with this match type in this scope" is a skip, not a write
            if (wire.dedupe) {
              const exists = await prisma.adTarget.findFirst({
                where: {
                  isNegative: true, status: 'ENABLED',
                  expressionType: { in: [matchType, t] },
                  expressionValue: { equals: keyword, mode: 'insensitive' },
                  ...(level === 'AD_GROUP'
                    ? { adGroupId: dst.id, negativeLevel: { not: 'CAMPAIGN' } }
                    : { negativeLevel: 'CAMPAIGN', adGroup: { campaignId: dst.campaignId } }),
                },
                select: { id: true },
              })
              if (exists) { outcomes.push({ adGroupId: dst.id, matchType, level, skipped: 'dedupe — the term is already negated at this level with this match type' }); continue }
            }
            if (meta.dryRun) { outcomes.push({ adGroupId: dst.id, matchType, level, wouldCreate: true }); if (level === 'CAMPAIGN') campaignsDone.add(dst.campaignId); continue }
            const res = await createNegative({
              profileId: conn?.profileId ?? '', externalCampaignId: dst.campaign.externalCampaignId,
              ...(level === 'AD_GROUP' ? { externalAdGroupId: dst.externalAdGroupId } : {}),
              keywordText: keyword, matchType, scope: level as 'AD_GROUP' | 'CAMPAIGN', marketplace,
            })
            if (level === 'CAMPAIGN') campaignsDone.add(dst.campaignId)
            if (res.denied) { failedWrites += 1; outcomes.push({ adGroupId: dst.id, matchType, level, reachedAmazon: false, refused: `write gate denied at ${res.denied.deniedAt}: ${res.denied.reason}` }); continue }
            if (res.alreadyExisted) { outcomes.push({ adGroupId: dst.id, matchType, level, skipped: 'already negated (existing row found at create time)' }); continue }
            if (res.mode !== 'live' || res.externalNegativeKeywordId == null) {
              // NEG.X lesson: a sandbox stub or an id-less success is NOT a landed negative.
              failedWrites += 1
              outcomes.push({ adGroupId: dst.id, matchType, level, reachedAmazon: false, refused: res.mode !== 'live' ? `no Amazon call was made (mode=${res.mode})` : 'Amazon accepted the create but returned no id — not counting it as landed' })
              continue
            }
            // 5 — mirror the landed write locally, with its audit row (create_negative_keyword).
            if (level === 'AD_GROUP') await mirrorNegativeKeywordLocal({ adGroupId: dst.id, keywordText: keyword, matchType, externalTargetId: res.externalNegativeKeywordId })
            else await createNegativeKeywordCampaignLocal({ externalCampaignId: dst.campaign.externalCampaignId, keywordText: keyword, matchType: t, externalTargetId: res.externalNegativeKeywordId })
            confirmed += 1
            outcomes.push({ adGroupId: dst.id, matchType, level, externalTargetId: res.externalNegativeKeywordId, reachedAmazon: true })
          }
        }
      }
      return {
        type: action.type,
        // Skips are policy working; a write that did not land is a failure. All-skips is a clean run.
        ok: failedWrites === 0,
        error: failedWrites > 0 ? `${failedWrites} negation${failedWrites === 1 ? '' : 's'} did not reach Amazon — see outcomes` : undefined,
        output: { keyword, sourceAdGroupId: src.id, dryRun: meta.dryRun || undefined, confirmed, failedWrites, outcomes },
      }
    }

    /**
     * HP1 — a negate-at-source coupled to a MAPPED harvest rule must not fire outside the
     * mapping. The paired `promote_to_exact` skips terms whose source ad group is not in the
     * rule's `look` set; without the same check here, the rule would negate a term it never
     * harvested — silencing demand it did not act on. Absent (every non-harvest caller, and
     * unmapped rules), nothing changes.
     */
    const sourceAllow = Array.isArray(action.sourceLookAdGroupIds)
      ? (action.sourceLookAdGroupIds as unknown[]).map(String)
      : null
    if (sourceAllow) {
      const srcExt = (action.externalAdGroupId as string | undefined) ?? (context as any)?.searchTerm?.externalAdGroupId
      const srcLocal = srcExt ? await prisma.adGroup.findFirst({ where: { externalAdGroupId: srcExt }, select: { id: true } }) : null
      if (!srcLocal || !sourceAllow.includes(srcLocal.id)) {
        return { type: action.type, ok: true, output: { skipped: 'source-ad-group-not-in-mappings', keyword } }
      }
    }
    /**
     * 🔴 SG.0 — the default scope is AD_GROUP now, not CAMPAIGN.
     *
     * EA2 honoured the builder's Negation Level with CAMPAIGN as the fallback — and campaign-scope
     * negatives have a measured landing rate of 0 of 20 EVER in this account, against 2,017 of
     * 2,037 (99%) at ad-group scope (`ads-harvest.service.ts:194-197`, which flipped its own
     * default for the same reason). An explicit `scope:'CAMPAIGN'` on the action is still
     * honoured — the builder's "both" maps there — but the fallback now takes the path that
     * demonstrably reaches Amazon. When AD_GROUP is intended and no ad group can be resolved
     * from the action or the trigger context, this FAILS CLOSED rather than silently widening
     * to the campaign: a negation that lands somewhere other than where the operator approved
     * it is worse than one that asks to be re-scoped.
     */
    const scope = (action.scope as string | undefined) === 'CAMPAIGN' ? 'CAMPAIGN' : 'AD_GROUP'
    const externalAdGroupId = scope === 'AD_GROUP'
      ? ((action.externalAdGroupId as string | undefined) ?? (context as any)?.searchTerm?.externalAdGroupId)
      : undefined
    if (scope === 'AD_GROUP' && !externalAdGroupId) {
      return { type: action.type, ok: false, error: 'No ad group in context to scope the negative to — set scope:"CAMPAIGN" explicitly to negate campaign-wide' }
    }

    // NEG.0(b) — the gate's FIRST substantive check is `if (!ctx.marketplace) → deniedAt:'connection'`
    // (ads-write-gate.ts:165-171), BEFORE the whitelist at :304. This handler used to hide the missing
    // field behind `as never`, so every negation it attempted was refused at the connection check and
    // the whitelist never ran. Refuse here instead: a write that cannot be gated is not a write.
    const marketplace = (context as any)?.marketplace as string | undefined
    if (!marketplace) return { type: action.type, ok: false, error: 'No marketplace in context — the write gate cannot resolve a connection, so this negation cannot be checked against the protected terms' }

    // NEG.0(a) — "Never create a negative for a term that converted (≥1 order) in the last 30 days in
    // any campaign". Checked BEFORE the dry-run return: every rule in this account is on PROPOSE, so
    // the dry run is the only path any of them takes, and a preview promising a negation the armed
    // rule would refuse is the same defect one step earlier.
    const guard = await checkProtectConverting({ terms: [keyword], config: protectConvertingConfig(action) })
    const decision = guard.get(normaliseNegTerm(keyword))
    if (decision && !decision.allowed) {
      logger.warn(`[${action.type}] refused by protectConverting`, { ruleId: meta.ruleId, keyword, evidence: decision.evidence })
      return { type: action.type, ok: false, error: decision.reason, output: { refusedBy: 'protectConverting', evidence: decision.evidence, keyword, externalCampaignId, scope } }
    }

    if (meta.dryRun) return { type: action.type, ok: true, output: { dryRun: true, keyword, externalCampaignId, matchType, scope } }
    const { createNegative } = await import('./ads-negative-kw.service.js')
    const conn = await prisma.amazonAdsConnection.findFirst({ where: { marketplace, isActive: true }, select: { profileId: true } })
    const res = await createNegative({ profileId: conn?.profileId ?? '', externalCampaignId, externalAdGroupId, keywordText: keyword, matchType, scope, marketplace })
    // A denied write used to be reported as `ok: true`. With the gate now reachable (above), a
    // refusal by the protected-terms whitelist is the expected outcome for a brand term — and it has
    // to land in the execution row as a failure, or the whitelist is invisible to whoever reads it.
    if (res.denied) return { type: action.type, ok: false, error: `Write gate denied at ${res.denied.deniedAt}: ${res.denied.reason}`, output: { keyword, externalCampaignId, scope, denied: res.denied } }
    return { type: action.type, ok: true, output: { keyword, externalCampaignId, matchType, scope, alreadyExisted: res.alreadyExisted, externalTargetId: res.externalNegativeKeywordId } }
  }
ACTION_HANDLERS.add_negative_exact = makeAddNegativeHandler('NEGATIVE_EXACT')
ACTION_HANDLERS.add_negative_phrase = makeAddNegativeHandler('NEGATIVE_PHRASE')

// ── promote_to_exact ──────────────────────────────────────────────────
// Take a converting search term and create new targets from it.
//
// HP1 (2026-08-21) — the handler honours the WHOLE builder form now. A builder harvest rule
// carries `action.harvest` (the normalised wire: mapping blocks, term filters, dedupe) and
// `action.bid` ({mode, value} — CPC-inheriting by default, never a silent constant): terms are
// read only from the mapped `look` ad groups, targets are created in the mapped destinations
// with the ticked types, and every skip or refusal is named in the output. Before HP1 all of
// that was stored-but-unread: EXACT-only, in the source ad group, account-wide, at a constant
// bid — and `ok: true` even when the write gate refused and the keyword existed only locally
// (the 209-of-218 never-reached-Amazon mechanism). An action WITHOUT `harvest` is an
// engine-native rule and keeps the exact pre-HP1 behaviour.
ACTION_HANDLERS.promote_to_exact = async (action, context, meta): Promise<ActionResult> => {
  const query = (action.query as string | undefined) ?? (context as any)?.searchTerm?.query
  const srcExternalAdGroupId = (action.adGroupId as string | undefined) ?? (context as any)?.searchTerm?.externalAdGroupId
  if (!query) return { type: action.type, ok: false, error: 'No query in context' }
  if (!srcExternalAdGroupId) return { type: action.type, ok: false, error: 'No adGroupId' }
  const { createKeywordLocal, pushExistingKeyword } = await import('./ads-create.service.js')
  const src = await prisma.adGroup.findFirst({ where: { externalAdGroupId: srcExternalAdGroupId }, select: { id: true } })
  if (!src) return { type: action.type, ok: false, error: `No local ad group for externalAdGroupId=${srcExternalAdGroupId}` }

  const wire = (action.harvest ?? null) as import('./ads-harvest-wire.js').HarvestWire | null
  if (!wire) {
    // engine-native path, byte-for-byte the pre-HP1 behaviour — except the write's fate is
    // reported: a create the gate refused is a failure, not a success that silenced nothing.
    const bidEur = Number(action.bidEur ?? 0.5)
    if (meta.dryRun) return { type: action.type, ok: true, output: { dryRun: true, query, matchType: 'EXACT', bidEur } }
    const r = await createKeywordLocal({ adGroupId: src.id, keywordText: query, matchType: 'EXACT', bidEur, evidence: ctxEvidence(context) })
    if (r.externalTargetId == null) {
      return { type: action.type, ok: false, error: r.denied ? `Write gate denied at ${r.denied.deniedAt}: ${r.denied.reason}` : r.pushError ?? (r.existed ? 'keyword exists locally but never reached Amazon' : 'created locally only — Amazon did not take the keyword'), output: { query, matchType: 'EXACT', adGroupId: src.id, bidEur, adTargetId: r.id, reachedAmazon: false } }
    }
    return { type: action.type, ok: true, output: { query, matchType: 'EXACT', adGroupId: src.id, bidEur, externalTargetId: r.externalTargetId, reachedAmazon: true } }
  }

  const { matchedBlocks, termPassesFilters, resolveHarvestBidEur, normalizeHarvestBidMode } = await import('./ads-harvest-wire.js')

  // 1 — is this term's SOURCE ad group inside the rule's mappings?
  const blocks = matchedBlocks(wire.blocks, src.id)
  if (blocks !== 'account-wide' && blocks.length === 0) {
    return { type: action.type, ok: true, output: { skipped: 'source-ad-group-not-in-mappings', query, sourceAdGroupId: src.id } }
  }

  // 2 — the term filters (contains / does-not-contain / brand / competitor-only)
  const looksLikeAsin = /^b0[a-z0-9]{8}$/i.test(query.trim())
  const isOwnAsin = wire.filters.competitorOnly && looksLikeAsin
    ? (await prisma.adProductAd.count({ where: { asin: { equals: query.trim(), mode: 'insensitive' } } })) > 0
    : false
  const filt = termPassesFilters(query, wire.filters, isOwnAsin)
  if (filt.pass === false) return { type: action.type, ok: true, output: { skipped: 'term-filter', reason: filt.reason, query } }

  // 3 — the creation set: mapped destinations × ticked types; account-wide keeps create-in-source EXACT
  const targets = blocks === 'account-wide'
    ? [{ adGroupId: src.id, types: ['EXACT' as const] }]
    : (() => {
      const seen = new Map<string, Set<string>>()
      for (const b of blocks) for (const c of b.create) {
        const s = seen.get(c.adGroupId) ?? new Set<string>()
        for (const t of c.types) s.add(t)
        seen.set(c.adGroupId, s)
      }
      return [...seen.entries()].map(([adGroupId, types]) => ({ adGroupId, types: [...types] as Array<'PHRASE' | 'EXACT' | 'ASIN'> }))
    })()

  // dedupe scope = the campaigns of every mapped ad group ("the campaigns from this rule group");
  // an account-wide rule dedupes account-wide.
  const mappedAgIds = blocks === 'account-wide' ? null : [...new Set(blocks.flatMap((b) => [...b.look, ...b.create.map((c) => c.adGroupId)]))]
  const dedupeCampaignIds = mappedAgIds
    ? (await prisma.adGroup.findMany({ where: { id: { in: mappedAgIds } }, select: { campaignId: true } })).map((g) => g.campaignId)
    : null

  const st = (context as any)?.searchTerm as { clicks?: number; spendCents?: number } | undefined
  const termCpcEur = st && Number(st.clicks) > 0 ? (Number(st.spendCents ?? 0) / Number(st.clicks)) / 100 : null
  const bidMode = normalizeHarvestBidMode((action.bid as { mode?: unknown } | undefined)?.mode)
  const bidValue = (action.bid as { value?: unknown } | undefined)?.value
  const bidValueNum = bidValue != null && Number.isFinite(Number(bidValue)) ? Number(bidValue) : null

  const outcomes: Array<Record<string, unknown>> = []
  let confirmed = 0
  let failedWrites = 0
  for (const target of targets) {
    const agDefault = bidMode === 'adGroupDefault'
      ? await prisma.adGroup.findUnique({ where: { id: target.adGroupId }, select: { defaultBidCents: true } }).then((g) => (g?.defaultBidCents != null ? g.defaultBidCents / 100 : null))
      : null
    for (const matchType of target.types) {
      if (matchType === 'ASIN') {
        // Named, never silent: a product-target create path does not exist yet. The keyword types
        // on the same mapping still land; this refusal is visible in the execution row.
        outcomes.push({ adGroupId: target.adGroupId, matchType, refused: 'product-target (ASIN) creation is not supported yet — keyword types on this mapping were still processed' })
        continue
      }
      if (wire.dedupe) {
        const exists = await prisma.adTarget.findFirst({
          where: {
            kind: 'KEYWORD', isNegative: false, expressionType: matchType,
            expressionValue: { equals: query, mode: 'insensitive' },
            ...(dedupeCampaignIds ? { adGroup: { campaignId: { in: dedupeCampaignIds } } } : {}),
          },
          select: { id: true },
        })
        if (exists) { outcomes.push({ adGroupId: target.adGroupId, matchType, skipped: 'dedupe — the term already exists with this match type in this rule group' }); continue }
      }
      const bid = resolveHarvestBidEur(bidMode, bidValueNum, termCpcEur, agDefault)
      if ('refuse' in bid) { failedWrites += 1; outcomes.push({ adGroupId: target.adGroupId, matchType, refused: `bid: ${bid.refuse}` }); continue }
      if (meta.dryRun) { outcomes.push({ adGroupId: target.adGroupId, matchType, wouldCreate: true, bidEur: bid.bidEur }); continue }
      const r = await createKeywordLocal({ adGroupId: target.adGroupId, keywordText: query, matchType, bidEur: bid.bidEur, evidence: ctxEvidence(context) })
      if (r.externalTargetId != null) { confirmed += 1; outcomes.push({ adGroupId: target.adGroupId, matchType, bidEur: bid.bidEur, externalTargetId: r.externalTargetId, reachedAmazon: true, existed: r.existed === true }); continue }
      if (r.existed) {
        // The local-only backlog's live fix: an existing row Amazon never saw gets a PUSH, not a
        // silent idempotent no-op (HV.4's pushExistingKeyword, on the rule path at last).
        const p = await pushExistingKeyword({ adTargetId: r.id, evidence: ctxEvidence(context) })
        if (p.ok && p.externalTargetId) { confirmed += 1; outcomes.push({ adGroupId: target.adGroupId, matchType, pushedExisting: true, externalTargetId: p.externalTargetId, reachedAmazon: true }); continue }
        failedWrites += 1
        outcomes.push({ adGroupId: target.adGroupId, matchType, reachedAmazon: false, refused: p.refusal ? `${p.refusal.deniedAt}: ${p.refusal.reason}` : p.error ?? 'exists locally and the push did not land' })
        continue
      }
      failedWrites += 1
      outcomes.push({ adGroupId: target.adGroupId, matchType, adTargetId: r.id, reachedAmazon: false, refused: r.denied ? `write gate denied at ${r.denied.deniedAt}: ${r.denied.reason}` : r.pushError ?? 'created locally only — Amazon did not take the keyword' })
    }
  }

  return {
    type: action.type,
    // Skips are policy working; a write that did not land is a failure. All-skips is a clean run.
    ok: failedWrites === 0,
    error: failedWrites > 0 ? `${failedWrites} creation${failedWrites === 1 ? '' : 's'} did not reach Amazon — see outcomes` : undefined,
    output: { query, sourceAdGroupId: src.id, dryRun: meta.dryRun || undefined, confirmed, failedWrites, outcomes },
  }
}

// ── sync_negatives_across_campaigns ──────────────────────────────────
// Add a wasted keyword as NEGATIVE EXACT to ALL campaigns in a marketplace.
// Stops the same bad term from wasting money across the whole account.
ACTION_HANDLERS.sync_negatives_across_campaigns = async (action, context, meta): Promise<ActionResult> => {
  const keyword = (action.keyword as string | undefined) ?? (context as any)?.searchTerm?.query ?? (context as any)?.adTarget?.expressionValue
  const marketplace = (action.marketplace as string | undefined) ?? (context as any).marketplace
  if (!keyword || !marketplace) return { type: action.type, ok: false, error: 'keyword + marketplace required' }
  // ACR.7b — a drag-bound rule negates only inside its binding, not across the marketplace.
  const sweep = await resolveRuleSweepScope(meta.ruleId)
  const campaigns = await prisma.campaign.findMany({
    where: {
      marketplace, status: 'ENABLED', externalCampaignId: { not: null },
      ...(sweep.scoped ? { id: { in: sweep.campaignIds } } : {}),
    },
    select: { id: true, externalCampaignId: true },
  })
  // NEG.0(a) — extended to this handler beyond the two the fix pack named, deliberately: this is
  // the widest blast radius in the section (74 campaign-level negatives per execution on IT), it
  // negates ONE term everywhere at once, and "a term that converted" is exactly the term for which
  // that is the worst possible outcome. Its rules predate the builder's switch and carry no key, so
  // the absent-means-ON default is what protects them.
  const guard = await checkProtectConverting({ terms: [keyword], config: protectConvertingConfig(action) })
  const decision = guard.get(normaliseNegTerm(keyword))
  if (decision && !decision.allowed) {
    logger.warn('[sync_negatives_across_campaigns] refused by protectConverting', { ruleId: meta.ruleId, keyword, wouldHaveNegatedIn: campaigns.length, evidence: decision.evidence })
    return { type: action.type, ok: false, error: decision.reason, output: { refusedBy: 'protectConverting', evidence: decision.evidence, keyword, marketplace, wouldHaveNegatedIn: campaigns.length } }
  }

  if (meta.dryRun) return { type: action.type, ok: true, output: { dryRun: true, keyword, wouldNegateIn: campaigns.length, ruleScoped: sweep.scoped } }
  const conn = await prisma.amazonAdsConnection.findFirst({ where: { marketplace, isActive: true }, select: { profileId: true } })
  const { createNegative } = await import('./ads-negative-kw.service.js')
  let added = 0; let denied = 0; const errors: string[] = []
  for (const c of campaigns) {
    // NEG.0(b) — `marketplace` was omitted here behind `as never`. All 22 campaign-scope negatives
    // in the account carry no Amazon id because of it: the gate denied at `connection` and the
    // local mirror was written anyway. Per-campaign outcomes are counted separately for the same
    // reason — one number over 74 attempts is how those 22 rows became invisible.
    try {
      const r = await createNegative({ profileId: conn?.profileId ?? '', externalCampaignId: c.externalCampaignId!, keywordText: keyword, matchType: 'NEGATIVE_EXACT', scope: 'CAMPAIGN', marketplace })
      if (r.denied) { denied++; if (errors.length < 5) errors.push(`${c.externalCampaignId}: denied at ${r.denied.deniedAt} — ${r.denied.reason}`) }
      else added++
    }
    catch (e) { errors.push((e as Error).message) }
  }
  return { type: action.type, ok: added > 0, output: { keyword, marketplace, added, denied, attempted: campaigns.length, errors: errors.slice(0, 5) } }
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
  const res = await updateAdTargetWithSync({ adTargetId: id, patch: { bidCents: floorCents }, actor: RULE_ACTOR(meta.ruleId), reason: 'lower_bid_to_floor via rule' , evidence: ctxEvidence(context) })
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
  // 🔴 It used to stop at that logger.warn. The action named "alert operator" reached neither the
  // bell, the feed nor the inbox — five advertising rules use it and none of their alerts has ever
  // been seen. `notify` (the sibling handler, ~line 369) has always fanned out correctly; this one
  // simply never did.
  //
  // `notified` is on the output so a run that reaches nobody is visible as 0 rather than as silence.
  //
  // CAP — and `deduped` is on it too, because after dedupe `notified: 0` has two meanings:
  // "an identical unread alert is already in the bell" and "the notifier is broken". Those are the
  // same number and opposite facts, and collapsing them is how this handler stayed invisible.
  let notified = 0
  let deduped = false
  let reachable = 0
  try {
    const { notifyAutomationDetailed } = await import('./ads-automation-notify.service.js')
    const sev = (['info', 'success', 'warn', 'danger'] as const).includes(severity as never)
      ? (severity as 'info' | 'success' | 'warn' | 'danger')
      : 'info'
    const r = await notifyAutomationDetailed({
      type: 'ads-automation-rule',
      severity: sev,
      title: message,
      body: `Rule ${meta.ruleId}${meta.dryRun ? ' (dry run)' : ''}`,
      meta: { ruleId: meta.ruleId, dryRun: meta.dryRun, alert: true },
    })
    notified = r.created
    deduped = r.deduped
    reachable = r.wouldHaveReached
  } catch (e) {
    // A failed notification must not fail the rule — but it must not read as a delivered one either.
    logger.warn('[automation:alert] notifyAutomation failed', { ruleId: meta.ruleId, error: String(e).slice(0, 140) })
  }
  return { type: action.type, ok: true, output: { severity, message, ruleId: meta.ruleId, notified, deduped, reachable, timestamp: new Date().toISOString() } }
}

// ── EA1: builder-rule apply handlers ──────────────────────────────────
// Thin handlers the ads-rule-adapter translates the Budget/Placement BUILDER rules to. They
// support the builder's full action vocab (set / increase / decrease, % or absolute) + the
// builder's guardrail clamps, reading CURRENT from the campaign and routing the write through
// the SAME gated path as adjust_ad_budget. Kept separate from adjust_ad_budget so the seeded
// AME/AD rules stay byte-identical.
type BuilderOp = 'set' | 'incPct' | 'decPct' | 'incAbs' | 'decAbs'
/**
 * C1 (2026-08-20) — the two COMPUTED bid ops. They are not arithmetic on the current bid, so they
 * cannot go through `applyBuilderOp`: each needs the target's own measured performance first.
 */
// BP.P4 — `revPerClick` (H10's "Revenue per Click": bid = attributed sales ÷ clicks) and
// `curBidTargetAcos` (H10's "Current Bid × Target ACoS / ACoS") join C1's two.
const COMPUTED_BID_OPS = new Set(['targetAcos', 'setCpc', 'revPerClick', 'curBidTargetAcos'])

/**
 * One ad target's measured CPC and ACoS, over the window the rule is described by.
 *
 * 🔴 The window comes from `TRIGGER_WINDOW`, the same table `ruleLookback` renders in the grid's
 * Lookback column — so the figure this computes on is the figure the operator was shown. A second
 * hard-coded window here is exactly the drift B2 existed to remove.
 *
 * `ruleWindowBounds` drops the two still-settling days, so a bid is never computed against a day
 * whose sales have not finished arriving. Returns null where there is no signal: a CPC needs a
 * click, and an ACoS needs a sale. Acting on a keyword with no clicks is guessing.
 */
async function targetPerformance(adTargetId: string, trigger: string, overrideDays?: number | null): Promise<{ cpcEur: number; acos: number | null; clicks: number; salesCents: number } | null> {
  const spec = TRIGGER_WINDOW[trigger]
  // A trigger with no window of its own (SCHEDULE, CAC_SPIKE) still needs one to measure a
  // keyword over; 30 days is the longest any trigger uses and the most forgiving for sparse rows.
  // BP.P4 — a Bid rule's own lookback (`action.windowDays`, clamped like the emitter clamps it)
  // overrides the trigger default, so the computed bid measures over the window the operator chose.
  const days = typeof overrideDays === 'number' && Number.isFinite(overrideDays)
    ? Math.max(BID_WINDOW_MIN, Math.min(BID_WINDOW_MAX, Math.round(overrideDays)))
    : spec?.days ?? 30
  const { since, until } = ruleWindowBounds(days)
  const perf = await prisma.amazonAdsDailyPerformance.aggregate({
    where: { entityType: 'AD_TARGET', localEntityId: adTargetId, date: { gte: since, lte: until } },
    _sum: { costMicros: true, clicks: true, sales7dCents: true },
  })
  const clicks = perf._sum.clicks ?? 0
  if (clicks <= 0) return null
  const spendCents = microsToCents(perf._sum.costMicros)
  if (spendCents <= 0) return null
  const salesCents = perf._sum.sales7dCents ?? 0
  return {
    cpcEur: spendCents / clicks / 100,
    // No sales is not a 0% ACoS — it is an ACoS that does not exist. A ratio with a zero
    // denominator must not become "infinitely efficient" and double the bid.
    acos: salesCents > 0 ? spendCents / salesCents : null,
    clicks,
    salesCents,
  }
}
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
  // 🔴 EA4 — honour the campaigns the operator picked in the builder.
  // Before this, the Budget builder's campaign picker had NO runtime effect: the adapter never
  // passed `campaigns` through, and this handler takes the campaign from the evaluation context,
  // so a rule showing "12 campaigns selected" applied ACCOUNT-WIDE. `bid_apply` has always had
  // this check; budget and placement did not. An empty list still means "everywhere", which is
  // what an account-wide rule stores.
  if (!campaignAllowed(action, id)) {
    return { type: action.type, ok: true, output: { skipped: 'campaign-not-selected', campaignId: id } }
  }
  const c = await prisma.campaign.findUnique({ where: { id }, select: { dailyBudget: true, budgetBaselineCents: true } })
  if (!c) return { type: action.type, ok: false, error: 'Campaign not found' }
  const current = Number(c.dailyBudget)
  // BUD.2 — every RELATIVE op (inc/dec, % or absolute) anchors to the baseline when captured:
  // −20% or −€2 of a fixed anchor is the same target on every tick, which is what makes the
  // rule idempotent instead of compounding. 'set' is absolute and ignores the anchor anyway.
  const anchor = c.budgetBaselineCents != null ? c.budgetBaselineCents / 100 : current
  const minEur = Math.max(1, Number(action.minEur ?? 1)) // never below Amazon's €1 floor
  const maxEur = action.maxEur != null ? Number(action.maxEur) : null
  const next = Math.round(clampRange(applyBuilderOp(action.op as string, anchor, Number(action.value) || 0), minEur, maxEur) * 100) / 100
  const delta = Math.max(0, Math.round((next - current) * 100))
  // D-PLC-3 — the same ordering defect, and the same fix: `noChange` is added beside
  // `wouldChange`, never instead of it (the Budget preview parses the sentence for its census).
  if (meta.dryRun) {
    const same = next === current
    return { type: action.type, ok: true, estimatedValueCentsEur: same ? 0 : delta, output: { dryRun: true, campaignId: id, wouldChange: `€${current.toFixed(2)} → €${next.toFixed(2)}`, ...(same ? { noChange: true } : {}) } }
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
  // EA4 — same as budget_apply: the Placement builder's picker had no runtime effect either.
  if (!campaignAllowed(action, id)) {
    return { type: action.type, ok: true, output: { skipped: 'campaign-not-selected', campaignId: id } }
  }
  const placement = (action.placement as string | undefined) ?? 'PLACEMENT_TOP'
  const c = await prisma.campaign.findUnique({ where: { id }, select: { dynamicBidding: true } })
  const db = (c?.dynamicBidding ?? {}) as { placementBidding?: Array<{ placement: string; percentage: number }> }
  const current = db.placementBidding?.find((x) => x.placement === placement)?.percentage ?? 0
  const minPct = Math.max(0, Number(action.minPct ?? 0))
  const maxPct = Math.min(900, Number(action.maxPct ?? 900))
  const next = Math.round(clampRange(applyBuilderOp(action.op as string, current, Number(action.value) || 0), minPct, maxPct))
  /**
   * 🔴 D-PLC-3 — a dry run that would change NOTHING says so, and still says what it read.
   *
   * The `dryRun` return used to sit ABOVE the `next === current` check, so a rule proposing no
   * change emitted `wouldChange: "50% → 50%"` and reached the suggestion queue —
   * `recordSuggestions` skips on `output.noChange`, which this branch never set. That is the
   * class ADX A2.1 removed once already: of 227 pending rows, 48 were results that explicitly
   * reported changing nothing.
   *
   * `noChange` is ADDED, not swapped in: `wouldChange` stays, because the builder's preview parses
   * it to render "current → proposed" and to count the rows a guardrail absorbed. Returning one
   * without the other fixes the queue and silently zeroes the preview's census.
   */
  if (meta.dryRun) {
    const same = next === current
    return { type: action.type, ok: true, output: { dryRun: true, campaignId: id, placement, wouldChange: `${current}% → ${next}%`, ...(same ? { noChange: true } : {}) } }
  }
  if (next === current) return { type: action.type, ok: true, output: { campaignId: id, placement, noChange: true } }
  const { updatePlacementBidding } = await import('./ads-create.service.js')
  const { buildManualAdjustments } = await import('./ads-placement-manual.js')
  const { MANAGED_PLACEMENTS } = await import('./ads-placement-math.js')
  /**
   * 🔴 PLC-P4 — a lane this system does not manage REFUSES rather than writing.
   *
   * `buildManualAdjustments` owns the three managed lanes and emits exactly those (plus any
   * non-managed placement it found, untouched). Handed a fourth lane as the TARGET it would build
   * a payload that does not contain it — a write that silently does nothing, reported as success.
   * The adapter can only ever emit the three (`PLACEMENT_ENUM`), so this is unreachable from the
   * builder; an engine-native rule carrying something else is what it guards.
   */
  if (!(MANAGED_PLACEMENTS as readonly string[]).includes(placement)) {
    return { type: action.type, ok: false, error: `“${placement}” is not a placement this system manages (Top of Search · Rest of Search · Product Pages), so this rule cannot write it`, output: { campaignId: id, placement } }
  }
  /**
   * PLC-P4 — ONE implementation of the merge.
   *
   * `updatePlacementBidding` writes `placementBidding` WHOLESALE, so a one-lane payload erases the
   * other two — 88 of 88 two-lane campaigns would have lost one. This handler used to rebuild the
   * payload inline (`others` + the target); `buildManualAdjustments` (14 tests) is the helper that
   * exists for exactly this, and a second implementation of the one rule whose failure is silent
   * and account-wide is not worth the eight characters it saved.
   *
   * Equivalence was MEASURED before converging, not assumed: `_plcp-p4-merge-equiv.mts` built both
   * payloads for all 220 campaign profiles × 3 lanes × 6 values and found **3,960 of 3,960**
   * agreeing on the set of value-carrying lanes. The 24 byte differences are all one kind — the
   * helper omits an untouched lane that is already 0, which Amazon reads identically to absent and
   * which writes no history row (that filter reads the NEW array). The helper additionally clamps
   * every lane rather than only the target, dedupes a doubled lane, and preserves non-managed
   * placements explicitly.
   */
  const res = await updatePlacementBidding({
    campaignId: id,
    adjustments: buildManualAdjustments(db.placementBidding, placement as never, next),
    actor: `automation:rule-${meta.ruleId}`,
    reason: `rule ${action.type}: ${current}% \u2192 ${next}%`,
  })
  /**
   * 🔴 PLC-P4 — a refusal carries the gate's own sentence.
   *
   * `updatePlacementBidding` returns `{ ok:false, mode:'blocked', reason, deniedAt }` — PLC.3 added
   * those two fields for precisely this — and this handler used to discard both, returning a bare
   * `ok:false` with no `error`. The suggestion correctly stayed pending and the operator was shown
   * "refused" with nothing after it, while `actionResults` recorded a failure that named no cause.
   * `bid_apply` has always passed its `res.error` through; placement did not.
   *
   * `reason` is the gate's verbatim sentence and is never paraphrased. `deniedAt` names WHICH gate
   * (authority_pin · campaign_allowlist · automation_halted …) so a surface can link to the control
   * that clears it.
   */
  if (res.ok === false) {
    return {
      type: action.type,
      ok: false,
      error: res.reason ?? `the write gate declined this placement change${res.deniedAt ? ` (${res.deniedAt})` : ''}`,
      output: { campaignId: id, placement, percentage: next, mode: res.mode, ...(res.deniedAt ? { deniedAt: res.deniedAt } : {}) },
    }
  }
  return { type: action.type, ok: true, output: { campaignId: id, placement, percentage: next, mode: res.mode } }
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

  /**
   * C1 — the two COMPUTED ops. Both need the target's own measured performance, so they resolve
   * to a raw euro figure here and then take the SAME clamp and write path as the five arithmetic
   * ops below. One bid-writing code path, five ways of choosing the number.
   *
   * A refusal is never silent: with no clicks in the window there is no CPC to set a bid from,
   * and with no sales there is no ACoS to scale it by. Both return `ok: false` naming which
   * signal was missing, so the execution history says why nothing moved instead of recording a
   * success that changed nothing ([[reference_four_inert_ads_rules]]).
   */
  let computedEur: number | null = null
  if (COMPUTED_BID_OPS.has(String(action.op))) {
    // The trigger comes from the CONTEXT, not `meta` — the handler signature carries only
    // { dryRun, ruleId }, and widening it would touch all 35 handlers for one field that the
    // context already states on every build.
    const perf = await targetPerformance(id, String(getFieldPath(context, 'trigger') ?? ''), action.windowDays != null ? Number(action.windowDays) : null)
    if (!perf) {
      return { type: action.type, ok: false, error: `no measured clicks or spend for this target in the rule's window — there is no CPC to compute a bid from`, output: { adTargetId: id } }
    }
    if (action.op === 'setCpc') {
      computedEur = perf.cpcEur
    } else if (action.op === 'revPerClick') {
      // BP.P4 — H10's "Revenue per Click": the bid becomes what a click has actually been WORTH
      // (attributed sales ÷ clicks) over the rule's window. The break-even bid at 100% ACoS.
      if (perf.salesCents <= 0) {
        return { type: action.type, ok: false, error: `this target has clicks but no attributed sales in the rule's window — there is no revenue per click to bid`, output: { adTargetId: id, clicks: perf.clicks } }
      }
      computedEur = perf.salesCents / perf.clicks / 100
    } else {
      // targetAcos: bid = CPC × (target / actual). curBidTargetAcos (BP.P4, H10's second ratio
      // action): bid = CURRENT BID × (target / actual). Above target the factor is < 1 and the
      // bid comes down; below it, up. The clamp below is what stops a 5% actual ACoS from
      // multiplying a bid by twenty.
      let targetPct = Number(action.value)
      if (!Number.isFinite(targetPct) || targetPct <= 0) {
        // SG.5 — the account default (Suggestions gear → AdsAutomationState.defaultTargetAcosPct,
        // INTEGER percent). This is that column's ONE reader. Dynamic import: the state service
        // is cycle-free but this file sits under half the engine — keep it that way.
        const { getAutomationState } = await import('./ads-automation-state.service.js')
        const st = await getAutomationState().catch(() => null)
        if (st?.defaultTargetAcosPct != null && st.defaultTargetAcosPct > 0) targetPct = st.defaultTargetAcosPct
      }
      if (!Number.isFinite(targetPct) || targetPct <= 0) {
        return { type: action.type, ok: false, error: `${String(action.op)} needs a positive target ACoS percentage — this rule stores ${JSON.stringify(action.value)} and no account default is set (Suggestions → Bid Settings)`, output: { adTargetId: id } }
      }
      if (perf.acos == null) {
        return { type: action.type, ok: false, error: `this target has spend but no attributed sales in the rule's window, so its actual ACoS is undefined — a bid cannot be scaled by it`, output: { adTargetId: id, clicks: perf.clicks } }
      }
      const base = action.op === 'curBidTargetAcos' ? currentEur : perf.cpcEur
      computedEur = base * ((targetPct / 100) / perf.acos)
    }
  }

  const rawEur = computedEur ?? applyBuilderOp(action.op as string, currentEur, Number(action.value) || 0)
  const nextEur = Math.round(clampRange(rawEur, floorEur, ceilEur) * 100) / 100
  const nextCents = Math.round(nextEur * 100)
  if (meta.dryRun) return { type: action.type, ok: true, output: { dryRun: true, adTargetId: id, wouldChange: `${t.bidCents}¢ → ${nextCents}¢` } }
  if (nextCents === t.bidCents) return { type: action.type, ok: true, output: { adTargetId: id, noChange: true } }
  const res = await updateAdTargetWithSync({ adTargetId: id, patch: { bidCents: nextCents }, actor: RULE_ACTOR(meta.ruleId), reason: (action.reason as string) ?? `bid_apply via rule ${meta.ruleId}` , evidence: ctxEvidence(context) })
  return { type: action.type, ok: res.ok, error: res.error ?? undefined, output: { adTargetId: id, newBidCents: nextCents, outboundQueueId: res.outboundQueueId } }
}

/**
 * ── pause_target / enable_target (C2, 2026-08-20) ─────────────────────────────────────────────
 *
 * A REAL status write on one ad target (keyword or product target), not a bid suppression.
 *
 * 🔴 This is a deliberate exception to the account's standing no-pause policy, granted by the
 * operator on 2026-08-20 after the trade-off was put to them explicitly. The policy
 * ([[feedback_no_pause_use_low_bids]]) is that the ENGINE never pauses — it drops bids to ~2¢ so
 * Amazon's algorithm keeps its learning state — with manual operator clicks as the carved-out
 * exception. The operator's H10 study lists "Pause Target" / "Unpause Target" as rule actions and
 * they chose the literal verbs over the suppression equivalent. So: pausing a TARGET from a rule
 * is allowed; `lower_bid_to_floor` remains available for anyone who wants the old behaviour, and
 * nothing here changes campaign- or ad-group-level policy.
 *
 * ⚠ The cost is real and is not hidden by this comment: a paused target re-enters Amazon's
 * learning phase when it is unpaused, which is why the graduation ceiling still caps these below
 * AUTO. A rule carrying one PROPOSES; a human accepts it on the Suggestions page.
 *
 * `campaignIds` is honoured exactly as `bid_apply` honours it — the builder's campaign picker must
 * scope a pause the same way it scopes a bid, or a rule showing "12 campaigns selected" pauses the
 * whole account. That was a live defect in `bid_apply` once (see its own note above).
 *
 * No `as never` on the write call: [[reference_as_never_hides_write_failures]] — twice measured,
 * a gate argument silently dropped for two months and an Apply button that always applied nothing.
 */
async function setTargetStatus(
  action: Record<string, unknown>,
  context: unknown,
  meta: { dryRun: boolean; ruleId: string },
  status: 'PAUSED' | 'ENABLED',
): Promise<ActionResult> {
  const type = String(action.type)
  const id = (action.adTargetId as string | undefined) ?? ctxAdTargetId(action, context)
  if (!id) return { type, ok: false, error: 'No adTarget.id in context' }
  const t = await prisma.adTarget.findUnique({
    where: { id },
    select: { status: true, adGroup: { select: { campaignId: true } } },
  })
  if (!t) return { type, ok: false, error: 'AdTarget not found' }
  const allow = Array.isArray(action.campaignIds) ? (action.campaignIds as string[]) : []
  if (allow.length && t.adGroup?.campaignId && !allow.includes(t.adGroup.campaignId)) {
    return { type, ok: true, output: { skipped: 'campaign-not-selected', adTargetId: id } }
  }
  // Already there. Reported as a no-change rather than a success, so the action log does not fill
  // with writes that moved nothing — the same contract `bid_apply` uses.
  if (t.status === status) return { type, ok: true, output: { adTargetId: id, noChange: true, status } }
  if (meta.dryRun) return { type, ok: true, output: { dryRun: true, adTargetId: id, wouldSet: status, from: t.status } }
  const res = await updateAdTargetWithSync({
    adTargetId: id,
    patch: { status },
    actor: RULE_ACTOR(meta.ruleId),
    reason: (action.reason as string | undefined) ?? `${type} via rule ${meta.ruleId}`,
    evidence: ctxEvidence(context),
  })
  return {
    type,
    ok: res.ok,
    error: res.error ?? undefined,
    output: { adTargetId: id, status, from: t.status, outboundQueueId: res.outboundQueueId },
  }
}

ACTION_HANDLERS.pause_target = async (action, context, meta): Promise<ActionResult> =>
  setTargetStatus(action, context, meta, 'PAUSED')

ACTION_HANDLERS.enable_target = async (action, context, meta): Promise<ActionResult> =>
  setTargetStatus(action, context, meta, 'ENABLED')

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
