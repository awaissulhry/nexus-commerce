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
 *   pause_ad_group      — refused: no automation pauses an ad group (1f)
 *   pause_campaign      — refused: no automation pauses a campaign (1f)
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

import { ACTION_HANDLERS, type ActionHandler, type ActionResult, getFieldPath } from '../automation-rule.service.js'
import prisma from '../../db.js'
import { patchDynamicBidding } from './dynamic-bidding-write.js'
// KT-P6 — the ≤3¢ suppression convention has ONE declaration, in the KT.6 blast radius.
import { KT6_SUPPRESSION_CENTS } from './kt6-bid-action.js'
import { logger } from '../../utils/logger.js'
import type { AdWriteEvidence } from './ads-evidence.js'
import { configuredTargetAcos, readOwnerTargets } from './ads-target-acos-resolver.js'
import { NO_LIMITS, limitSources, limitWords, strategyBidReader, strategySource, type BidSide, type WriteSources } from './ads-strategy/bids.js'
import { fractionToPct } from './ads-strategy/fields.js'
// P1 — the harvest thresholds this file falls back to, shared with the Rules grid that renders them.
import { BID_WINDOW_MAX, BID_WINDOW_MIN, HARVEST_DEFAULTS, TRIGGER_WINDOW } from '@nexus/shared/ads-rule-window'
import { settledBounds, settledWhere } from './ads-settled-window.js'
import { withinGoal } from './ads-bid-goal.js'
import { bidForAcos } from './bid-brain/recipe.js'
import { cpcRatio } from './bid-brain/estimator.js'
import { isServingMove, movedThisDataDay, reversalWait, windowBidCents, type BidMove, type WindowBidBasis } from './ads-bid-window.js'
import { microsToCents } from '../ads-core/metrics-math.js'
// NEG.0(a) — the reader for `protectConverting`. Until this import existed, the builder's headline
// safety promise was written into every negation rule's action JSON and consulted by nothing.
import { checkProtectConverting, protectConvertingConfig, normaliseNegTerm } from './ads-protect-converting.js'
import { isAsin } from './ads-negation-policy.js'
import { adProductLabel, adProductOf, SPONSORED_PRODUCTS } from '@nexus/shared/ads-ad-product'
import {
  updateCampaignWithSync,
  updateAdGroupWithSync,
  updateAdTargetWithSync,
  type AdsActor,
} from './ads-mutation.service.js'
import { suppressCampaignBids, restoreCampaignBids } from './ads-bid-suppression.service.js'
import { bidExtraSpend, placementExtraSpend } from './ads-spend-estimate.js'

const BID_FLOOR_CENTS = 5 // €0.05
const RULE_ACTOR = (ruleId: string): AdsActor => `automation:${ruleId}`

type HandlerMeta = Parameters<ActionHandler>[2]

/**
 * AA-W2-10 (D7) — how a rule's write names itself: always the rule's own actor; when an approval carries a suggestion
 * out (`meta.approval`), also the approval's change set (undo-ad-change finds the write by the approval id) and an
 * audit reason that starts with the request and who decided it. Without an approval it is the rule's write as before.
 */
function ruleWrite(meta: Pick<HandlerMeta, 'ruleId' | 'approval'>, reason: string): { actor: AdsActor; reason: string; changeSetId?: string } {
  return {
    actor: RULE_ACTOR(meta.ruleId),
    reason: meta.approval ? `${meta.approval.reason}: ${reason}` : reason,
    ...(meta.approval ? { changeSetId: meta.approval.changeSetId } : {}),
  }
}

/** AA-W2-10 (D7) — a negative an approved apply created (its Nexus row), kept for undo-ad-change to retire. */
function noteNegative(meta: Pick<HandlerMeta, 'approval'>, adTargetId: string | null | undefined): void {
  if (meta.approval && adTargetId && !meta.approval.negatives.includes(adTargetId)) meta.approval.negatives.push(adTargetId)
}

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
  // 4d (review 4.4) — only spend that was really committed counts: LIVE executions, plus this rule's suggestions a
  // person approved today (an approve runs the handler live, outside any execution row, and stores its result in
  // `appliedResult`). Dry runs and PROPOSE ticks used to count their would-be estimates, so previewing a rule used up
  // its own ceiling while an approved raise counted nothing.
  const [executions, approved] = await Promise.all([
    prisma.automationRuleExecution.findMany({
      where: { ruleId, dryRun: false, startedAt: { gte: dayStart } },
      select: { actionResults: true },
    }),
    prisma.adsRuleSuggestion.findMany({
      where: { ruleId, status: 'applied', decidedAt: { gte: dayStart } },
      select: { appliedResult: true },
    }),
  ])
  let spentTodayCents = 0
  const count = (r: { ok?: boolean; estimatedValueCentsEur?: number } | null | undefined) => {
    if (r?.ok && typeof r.estimatedValueCentsEur === 'number') {
      spentTodayCents += r.estimatedValueCentsEur
    }
  }
  for (const ex of executions) {
    const results = (ex.actionResults ?? []) as Array<{ ok?: boolean; estimatedValueCentsEur?: number }>
    if (!Array.isArray(results)) continue
    for (const r of results) count(r)
  }
  for (const s of approved) count(s.appliedResult as { ok?: boolean; estimatedValueCentsEur?: number } | null)
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
      ...ruleWrite(meta, `bid_down ${percent}% via rule ${meta.ruleId}`),
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
      ...ruleWrite(meta, `bid_down ${percent}% via rule ${meta.ruleId}`),
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
      ...ruleWrite(meta, `bid_up ${percent}% via rule ${meta.ruleId}`),
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
      ...ruleWrite(meta, `bid_up ${percent}% via rule ${meta.ruleId}`),
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

// ── pause_ad_group / pause_campaign / pause_all_campaigns — refused (1f) ──
//
// Owner rule: no engine or automation pauses a campaign or an ad group (decision S5, 2026-10-04). A pause
// resets Amazon's learning; an automation lowers bids instead (`lower_bid_to_floor`, the bid floor). The
// handlers stay registered so a stored rule carrying one reports this sentence rather than "Unknown action
// type". They refuse in a dry run too, so no rule proposes a pause that a person's approval would then be
// refused. `updateCampaignWithSync` / `updateAdGroupWithSync` refuse the same write as the backstop.
function refuseAutomatedPause(type: string, what: string, output: Record<string, unknown>): ActionResult {
  return {
    type,
    ok: false,
    error: `Refused: no automation may pause ${what}. An automation lowers bids or budgets instead; a person can still pause by hand.`,
    output: { refusedBy: 'no-automated-pause', ...output },
  }
}

ACTION_HANDLERS.pause_ad_group = async (action, context): Promise<ActionResult> =>
  refuseAutomatedPause(action.type, 'an ad group', { adGroupId: ctxAdGroupId(action, context) })

ACTION_HANDLERS.pause_campaign = async (action, context): Promise<ActionResult> =>
  refuseAutomatedPause(action.type, 'a campaign', { campaignId: ctxCampaignId(action, context) })

// ── notify (TD.0) ─────────────────────────────────────────────────────
// Alert-only action: fans a notification to every operator's bell. Fires even
// in dry-run (an alert isn't an Amazon write — suppressing it would defeat the
// purpose). Lets rules like "negative ad margin" actually reach a human.
ACTION_HANDLERS.notify = async (action, context, meta): Promise<ActionResult> => {
  const title = (action.title as string) || (action.message as string) || 'Advertising automation alert'
  // R8 — a preview (Test, Simulate, Claude's preview-automation) says whom it would tell and tells no one.
  if (meta.preview) return { type: action.type, ok: true, output: { preview: true, notified: 0, wouldNotify: 'every operator', title, dryRun: meta.dryRun } }
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
    ...ruleWrite(meta, action.reason as string | undefined ?? `adjust_ad_budget via rule ${meta.ruleId}`),
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
// budgetPoolId supplied → trigger an immediate rebalance on that pool
// (ignoring its cooldown). Pool's own strategy decides who gets what;
// this handler just kicks the trigger. The pool writes every budget
// through updateCampaignWithSync.
//
// 3e (review 6.9) — without a pool the action is refused. Its second mode (fromMarketplace +
// toMarketplace + percent) cut the highest-spend campaign on one market and raised up to five on the
// other with direct `prisma.campaign.update` calls: no action-log row, no queue row, so the write gate never
// judged it, Undo could not put it back, and Amazon never received it — the local budget diverged until
// the next sync copied Amazon's back. Refused in a dry run too, so no rule proposes a move its approval
// would then refuse.

ACTION_HANDLERS.reroute_marketplace_budget = async (action, _context, meta): Promise<ActionResult> => {
  const budgetPoolId = action.budgetPoolId as string | undefined
  const fromMarketplace = action.fromMarketplace as string | undefined
  const toMarketplace = action.toMarketplace as string | undefined

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

  // No pool: refused (3e — see the note above the handler).
  return {
    type: action.type,
    ok: false,
    error: 'Refused: moving budget between marketplaces is done by a budget pool. Choose a budget pool for this action; it no longer changes budgets by itself.',
    output: { refusedBy: 'budget-pool-only', fromMarketplace: fromMarketplace ?? null, toMarketplace: toMarketplace ?? null },
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
    ...ruleWrite(meta, (action.reason as string | undefined) ?? `resume_campaign via rule ${meta.ruleId}`),
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
//
// ADS AUTONOMY W1-7 — a rule that sets none of the three (windowDays, minSpendCents, minOrders) takes the ads
// strategy's harvest and negate thresholds wherever its market, a category or a product sets them, and these
// defaults elsewhere. A rule that sets any of them keeps its own numbers WHOLE, as before: a rule's own numbers win
// over the strategy (the Owner's control rule).
// PB-6a — winners stay (the Owner's rule 2), for every stored rule as for a playbook's:
//   · `mode` binds: 'harvest' graduates only, 'negative' negates waste only, absent or 'both' runs both (the wizard and
//     AI-goal rules each wrote one of each, and each ran both halves with its own numbers);
//   · `v: 2` lists are literal ([] = none); a stored v1 rule keeps "empty = EXACT";
//   · the lock (applyHarvest's `rule`): a term at home among its product's ad groups is not created again, and its
//     source is closed only once that home meets the harvest bar there (unless a source says `negateOnLanding`); a bid
//     the rule does not name is the term's CPC inside the band (L1, never a negative over a keyword of its ad group,
//     binds every writer in the negative write service);
//   · a dry run lists its `items`, refused winners included; an accepted card (the proposal merges the output) applies
//     only those whose step is still the card's;
//   · `cadenceDays`: a rule that swept within that many days proposes nothing until then.
ACTION_HANDLERS.harvest_and_negate = async (action, _context, meta): Promise<ActionResult> => {
  const ownNumbers = ['windowDays', 'minSpendCents', 'minOrders'].some((key) => typeof action[key] === 'number')
  const windowDays = typeof action.windowDays === 'number' ? action.windowDays : HARVEST_DEFAULTS.windowDays
  const minSpendCents = typeof action.minSpendCents === 'number' ? action.minSpendCents : HARVEST_DEFAULTS.minSpendCents
  const minOrders = typeof action.minOrders === 'number' ? action.minOrders : HARVEST_DEFAULTS.minOrders
  const { previewHarvest, applyHarvest, planRuleHarvest, harvestItemKey, planList } = await import('./ads-harvest.service.js')
  const mode = action.mode === 'harvest' || action.mode === 'negative' ? action.mode : 'both'
  const literal = action.v === 2
  const items = Array.isArray(action.items) ? (action.items as Array<{ kind: string; query: string; externalAdGroupId: string; step?: string; why?: string }>) : null

  // PB-6a — the cadence: a sweep within `cadenceDays` (a run that was not itself held back by it) holds this one back.
  // Only a sweep that ran counts: a run that failed swept nothing, so the next one is not held back by it.
  // An accepted card is never held back: a person decided it.
  const cadenceDays = typeof action.cadenceDays === 'number' && action.cadenceDays > 0 ? action.cadenceDays : null
  if (cadenceDays && !items) {
    const recent = await prisma.automationRuleExecution.findMany({
      where: { ruleId: meta.ruleId, startedAt: { gte: new Date(Date.now() - cadenceDays * 86400_000) } },
      select: { actionResults: true }, take: 50,
    })
    const swept = recent.some((ex) => Array.isArray(ex.actionResults) && (ex.actionResults as Array<{ type?: string; ok?: boolean; output?: { cadenceHeld?: unknown } } | null>)
      .some((r) => r?.type === action.type && r.ok === true && r.output?.cadenceHeld == null))
    if (swept) return { type: action.type, ok: true, output: { noChange: true, cadenceHeld: true, why: `This rule sweeps once every ${cadenceDays} day${cadenceDays === 1 ? '' : 's'}, and it swept within that time.` } }
  }

  // AT.4b — if the rule carries wizard `sources` (per-ad-group harvest scope +
  // graduate/negate match types), scope harvesting to those ad groups and honor
  // their match types. No `sources` → unchanged global behaviour (the standalone
  // "Auto harvest & negate" template). Scope uses live external ad-group ids, so a
  // rule whose campaigns are still gated/local resolves to [] and harvests nothing.
  const rawSources = (action as unknown as { sources?: unknown }).sources
  type RuleSource = { adGroupId?: string; graduate?: string[]; negate?: string[]; harvestFrom?: boolean; graduateProduct?: boolean; negateProduct?: boolean; destinations?: Record<string, string | null>; negateOnLanding?: boolean; negateSource?: boolean; bid?: { mode?: unknown; value?: unknown } }
  const sources = Array.isArray(rawSources) ? (rawSources as RuleSource[]) : null
  let adGroupExternalIds: string[] | undefined
  let plan: import('./ads-harvest.service.js').HarvestPlan | undefined
  if (sources && sources.length) {
    const localIds = sources.filter((s) => s.adGroupId).map((s) => s.adGroupId as string)
    const ags = localIds.length ? await prisma.adGroup.findMany({ where: { id: { in: localIds } }, select: { id: true, externalAdGroupId: true } }) : []
    const extById = new Map(ags.map((a) => [a.id, a.externalAdGroupId]))
    adGroupExternalIds = sources.filter((s) => s.harvestFrom && s.adGroupId).map((s) => extById.get(s.adGroupId as string)).filter((x): x is string => !!x)
    plan = {}
    // H.5 — forward the product flags (graduateProduct/negateProduct) so the engine harvests ASINs too.
    for (const s of sources) {
      const ext = s.adGroupId ? extById.get(s.adGroupId) : null
      if (ext) {
        plan[ext] = {
          graduate: s.graduate, negate: s.negate, graduateProduct: s.graduateProduct, negateProduct: s.negateProduct,
          ...(literal ? { literal: true } : {}),
          ...(s.destinations && typeof s.destinations === 'object' ? { destinations: s.destinations } : {}),
          ...(typeof s.negateOnLanding === 'boolean' ? { negateOnLanding: s.negateOnLanding } : {}),
          // PB-6b — false: this source is never negated for a term that graduated from it (the playbook's edge says so).
          ...(typeof s.negateSource === 'boolean' ? { negateSource: s.negateSource } : {}),
          ...(s.bid && typeof s.bid === 'object' ? { bid: s.bid } : {}),
        }
      }
    }
  }
  // H.2 — destination map (matchType → destination local ad group) carried by the wizard rule, so a
  // graduated keyword promotes into the campaign that hosts that match type instead of its source.
  const rawDestinations = (action as unknown as { destinations?: Record<string, string> }).destinations
  const destinations = rawDestinations && typeof rawDestinations === 'object' ? rawDestinations : undefined
  // PB-6a (L2) — where a term's home is looked up: every ad group of the SAME product in its market (the products the
  // rule's own sources advertise, with their sibling variants; a rule without sources: the term's own source's), plus
  // a compiled rule's own slots. Never another product's ad groups (rule 3).
  const homeScope = Array.isArray(action.homeScope) ? (action.homeScope as unknown[]).filter((id): id is string => typeof id === 'string') : undefined
  const ownAdGroups = sources ? sources.map((s) => s.adGroupId).filter((id): id is string => typeof id === 'string' && !!id) : undefined

  // ACR.7b — a drag-bound rule sweeps only inside its binding. When the wizard ALSO scoped
  // it to specific ad groups, the binding still bounds the sweep: intersect, never widen.
  const sweep = await resolveRuleSweepScope(meta.ruleId)
  if (sweep.scoped) {
    adGroupExternalIds = adGroupExternalIds
      ? adGroupExternalIds.filter((id) => sweep.adGroupExternalIds.includes(id))
      : sweep.adGroupExternalIds
  }

  const criteriaOpts = ownNumbers ? { windowDays, minSpendCents, minOrders } : { defaults: { ...HARVEST_DEFAULTS } }
  const preview = await previewHarvest({ ...criteriaOpts, adGroupExternalIds })
  // W1-7 — which numbers chose the candidates, and the protected products' ASINs left out, said on every run.
  const criteria = { thresholdsFrom: ownNumbers ? 'rule' : 'strategy-and-defaults', ...(preview.criteria.strategy.length ? { strategy: preview.criteria.strategy } : {}) }
  const protectedOut = preview.protectedAsins.length
    ? { protectedProducts: preview.protectedAsins.length, topProtected: preview.protectedAsins.slice(0, 5).map((p) => ({ query: p.query, why: p.reason })) }
    : {}
  /** A list said in full: its count, and its first five. */
  const listed = <T,>(key: string, list: T[]) => (list.length ? { [key]: list.length, [`top${key[0].toUpperCase()}${key.slice(1)}`]: list.slice(0, 5) } : {})

  // PB-6a — this rule's half, its sources' own lists, and the product flags (applyHarvest acts on a product candidate
  // only where its row opts in, so a dry run no longer counts the others).
  const wants = (ext: string, key: 'graduate' | 'negate') => planList(plan?.[ext], key).length > 0
  let negatives = mode === 'harvest' ? [] : preview.negatives.filter((c) => wants(c.externalAdGroupId, 'negate'))
  let graduations: Array<(typeof preview.graduations)[number] & { step?: 'create' | 'handover' }> = mode === 'negative' ? [] : preview.graduations.filter((c) => wants(c.externalAdGroupId, 'graduate'))
  let productNegatives = mode === 'harvest' ? [] : preview.productNegatives.filter((c) => plan?.[c.externalAdGroupId]?.negateProduct === true)
  let productGraduations: Array<(typeof preview.productGraduations)[number] & { step?: 'create' | 'handover' }> = mode === 'negative' ? [] : preview.productGraduations.filter((c) => plan?.[c.externalAdGroupId]?.graduateProduct === true)
  // PB-6b — a compiled playbook rule (it names its playbook) looks a home up only in its own listed slots (rule 3).
  const rule = { homeScope, ownAdGroups, criteria: criteriaOpts, ...(typeof action.playbookId === 'string' && homeScope ? { listedOnly: true } : {}) }

  // PB-6a — an accepted card: only its items, each planned again on today's data and applied only when its step is the
  // card's (a create never turns into a source negation, nor the reverse; a refused winner is never applied).
  const notApplied: Array<{ query: string; externalAdGroupId: string; why: string }> = []
  if (items) {
    const wanted = new Set(items.map(harvestItemKey))
    const named = <T extends { query: string; externalAdGroupId: string }>(kind: string, list: T[]) => list.filter((c) => wanted.has(harvestItemKey({ kind, ...c })))
    const fresh = await planRuleHarvest({
      negatives: named('negative', negatives), graduations: named('graduation', graduations),
      productNegatives: named('productNegative', productNegatives), productGraduations: named('productGraduation', productGraduations),
      plan, destinations, rule,
    })
    const today = new Map(fresh.items.map((i) => [harvestItemKey(i), i]))
    const verb = { negate: 'negate it', create: 'create its keyword', handover: 'negate it in its source', refused: 'refuse it' } as const
    const apply = new Map<string, 'negate' | 'create' | 'handover'>()
    for (const i of items) {
      const now = today.get(harvestItemKey(i))
      const why = !now
        ? 'It no longer meets the bar on today\'s data, or it is already where it should be, so it was left alone.'
        : i.step === 'refused' || now.step === 'refused'
          ? `Nothing can be done for it: ${now.why ?? i.why ?? 'it was refused'}`
          : now.step !== i.step
            ? `The card proposed to ${verb[i.step as keyof typeof verb] ?? i.step}; on today's data the rule would ${verb[now.step]}, so nothing was done. The next card proposes it again.`
            : null
      if (why) notApplied.push({ query: i.query, externalAdGroupId: i.externalAdGroupId, why })
      else apply.set(harvestItemKey(i), now!.step as 'negate' | 'create' | 'handover')
    }
    const take = <T extends { query: string; externalAdGroupId: string }>(kind: string, list: T[]) =>
      list.filter((c) => apply.has(harvestItemKey({ kind, ...c }))).map((c) => ({ ...c, step: apply.get(harvestItemKey({ kind, ...c })) as 'create' | 'handover' }))
    negatives = take('negative', negatives); graduations = take('graduation', graduations)
    productNegatives = take('productNegative', productNegatives); productGraduations = take('productGraduation', productGraduations)
  }

  if (meta.dryRun) {
    const planned = await planRuleHarvest({ negatives, graduations, productNegatives, productGraduations, plan, destinations, rule })
    const steps = (step: string, kinds: string[]) => planned.items.filter((i) => i.step === step && kinds.includes(i.kind)).length
    const refused = planned.items.filter((i) => i.step === 'refused').map((i) => ({ query: i.query, externalAdGroupId: i.externalAdGroupId, why: i.why }))
    return {
      type: action.type,
      ok: true,
      output: {
        dryRun: true,
        mode,
        scoped: !!sources || sweep.scoped,
        ruleScope: sweep.scoped ? { adGroups: sweep.adGroupExternalIds.length, campaigns: sweep.campaignIds.length } : null,
        // H.4 — nothing to harvest this tick → noChange, so the Suggestions generator skips an empty card. PB-6a — a
        // winner the rule would refuse is listed (with why), so a card is never empty while winners wait.
        noChange: planned.items.length === 0,
        wouldNegate: steps('negate', ['negative']),
        wouldGraduate: steps('create', ['graduation']),
        wouldGraduateProduct: steps('create', ['productGraduation']),
        wouldNegateProduct: steps('negate', ['productNegative']),
        // PB-6a (L4) — terms whose home now meets the harvest bar: negated in their source, nothing created.
        wouldHandOver: steps('handover', ['graduation', 'productGraduation']),
        wouldRefuse: refused.length,
        topNegatives: planned.negatives.slice(0, 5).map((n) => ({ query: n.query, costCents: n.costCents })),
        topGraduations: planned.graduations.slice(0, 5).map((g) => ({ query: g.query, orders: g.orders })),
        // PB-6a — what an accept applies: these, and only these, each at its step (≤ 200; the rest come on the next run).
        itemCount: planned.items.length,
        items: planned.items.slice(0, 200),
        ...(planned.items.length > 200 ? { itemsLeftForNextRun: planned.items.length - 200 } : {}),
        ...listed('refused', refused),
        ...listed('keptHome', planned.keptHome),
        ...listed('blockedOwnKeyword', planned.blockedOwnKeyword),
        ...(planned.alreadyStanding ? { alreadyStanding: planned.alreadyStanding } : {}),
        ...criteria,
        ...protectedOut,
      },
    }
  }
  if (items && !negatives.length && !graduations.length && !productNegatives.length && !productGraduations.length) {
    return {
      type: action.type, ok: true,
      output: { skipped: 'no-longer-due', why: `none of the card's ${items.length} term${items.length === 1 ? '' : 's'} can be applied as proposed on today's data, so nothing was written`, ...listed('notApplied', notApplied), ...criteria },
    }
  }
  const bid = typeof action.graduationBidEur === 'number' ? { bidEur: action.graduationBidEur } : {}
  const result = await applyHarvest({
    negatives,
    graduations: graduations.map((g) => ({ ...g, ...bid })),
    productNegatives,
    productGraduations: productGraduations.map((g) => ({ ...g, ...bid })),
    userId: `automation:${meta.ruleId}`,
    plan,
    destinations,
    // NEG.0(a) — carry the rule's own toggle through. Absent means ON, in the service as here.
    protectConverting: (action as unknown as { protectConverting?: boolean }).protectConverting,
    protectDays: (action as unknown as { protectDays?: number }).protectDays,
    rule,
  })
  const keptHome = result.outcomes.filter((o) => o.refusal?.deniedAt === 'already_home').map((o) => ({ query: o.query, why: o.refusal!.reason }))
  const blocked = result.negativeOutcomes.filter((o) => o.refusal?.deniedAt === 'own_keyword').map((o) => ({ query: o.query, why: o.reason }))
  return {
    type: action.type,
    ok: result.errors.length === 0 || result.negativesAdded + result.keywordsGraduated + result.productsGraduated + result.productNegativesAdded + result.isolationNegativesAdded > 0,
    output: {
      mode,
      negativesAdded: result.negativesAdded,
      keywordsGraduated: result.keywordsGraduated,
      isolationNegativesAdded: result.isolationNegativesAdded,
      productsGraduated: result.productsGraduated,
      productNegativesAdded: result.productNegativesAdded,
      // A refusal that never leaves the service is the same silent skip in a different file.
      negativesProtected: result.negativesProtected,
      protectedTerms: result.protectedTerms.slice(0, 5),
      ...listed('keptHome', keptHome),
      ...listed('blockedOwnKeyword', blocked),
      ...listed('notApplied', notApplied),
      errorCount: result.errors.length,
      errors: result.errors.slice(0, 5),
      ...criteria,
      ...protectedOut,
    },
  }
}

/**
 * 4m (review 3.7) — a rule leaves alone what Hourly Bids holds.
 *
 * The rank engine sets the Top of Search placement (and the bids) of every campaign an enabled goal schedule or
 * product plan holds, every run. A rule writing the same lever there is undone on the next run and undoes it in turn,
 * so the rule skips such a campaign and says why. A skip, not a failure, and asked BEFORE the dry-run return, so a
 * PROPOSE rule offers no suggestion a person could accept into the same fight (`recordSuggestions` skips `skipped`).
 * The decision is re-read when a suggestion is accepted, because the handler runs again then.
 */
async function rankOwnedSkip(type: string, campaignId: string, what: string): Promise<ActionResult | null> {
  const { rankOwnedCampaignIds } = await import('./rank-release.service.js')
  if (!(await rankOwnedCampaignIds()).has(campaignId)) return null
  const { rankOwnedWhy } = await import('./ads-top-of-search.service.js')
  return { type, ok: true, output: { skipped: 'rank-owned', campaignId, why: rankOwnedWhy(what) } }
}

// ── AU.6: set_placement_multiplier ────────────────────────────────────
// Adjusts the PLACEMENT_TOP (or other placement) bid adjustment % for a
// campaign. Lets rules like "raise top-of-search bids when ACOS is low" or
// "lower when ACOS is high" without touching keyword bids directly.
// Part 06 fix (lead review of R7) — every placement write of a rule carries the rule's OWN actor (RULE_ACTOR), the string
// its daily write cap counts. It used to be `automation:rule-<ruleId>`, which no cap counted (a cap bypass); old rows keep
// that form and parseActor still reads them as the rule.
ACTION_HANDLERS.set_placement_multiplier = async (action, context, meta): Promise<ActionResult> => {
  const campaignId = (action.campaignId as string | undefined) ?? ctxCampaignId(action, context)
  if (!campaignId) return { type: action.type, ok: false, error: 'No campaign.id in context' }
  const placement = (action.placement as string | undefined) ?? 'PLACEMENT_TOP'
  if (placement === 'PLACEMENT_TOP') {
    const held = await rankOwnedSkip(action.type, campaignId, 'Top of Search placement')
    if (held) return held
  }
  const pct = Math.max(0, Math.min(900, Math.round(Number(action.percentage ?? 0))))
  if (meta.dryRun) {
    return { type: action.type, ok: true, output: { dryRun: true, campaignId, placement, percentage: pct } }
  }
  const { updatePlacementBidding } = await import('./ads-create.service.js')
  const c = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { dynamicBidding: true } })
  const db = (c?.dynamicBidding ?? {}) as { placementBidding?: Array<{ placement: string; percentage: number }> }
  const others = (db.placementBidding ?? []).filter((x) => x.placement !== placement)
  const res = await updatePlacementBidding({ campaignId, adjustments: [...others, { placement, percentage: pct }], ...ruleWrite(meta, `rule ${action.type}`) })
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
    changeSetId: meta.approval?.changeSetId ?? null, // AA-W2-10 (D7)
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

// ── AU.4: pause_all_campaigns (budget failsafe kill-switch) — refused (1f) ──
// It paused ALL ENABLED campaigns of a marketplace when monthly spend crossed a threshold. No automation
// may pause a campaign (see refuseAutomatedPause above); the budget stop for a market is budget
// enforcement's stop-over-spend, which floors bids instead.
ACTION_HANDLERS.pause_all_campaigns = async (action): Promise<ActionResult> =>
  refuseAutomatedPause(action.type, 'campaigns', { marketplace: typeof action.marketplace === 'string' ? action.marketplace : null })

// ── add_negative_exact · add_negative_phrase ──────────────────────────
// Add a specific query as a negative to a campaign. Designed for use with
// KEYWORD_WASTED_SPEND and SEARCH_TERM triggers where we know the exact term.
//
// P2.6 — one body, two match types. `add_negative_phrase` was offered on the Negative Targeting
// tab, categorised in rule-category.ts and ceilinged in ads-graduation.ts — and absent from this
// map, so a rule using it failed every execution with "Unknown action type". NEG.X proved phrase
// negation through the same `createNegative` path (three NEGATIVE_PHRASE rows live at Amazon), so
// the handler is the exact handler with the match type as a parameter.

/** 5d (review 7.5) — the one sentence for an ASIN that would have to be negated campaign-wide. */
const asinCampaignRefusal = (term: string) =>
  `"${term.trim()}" is an ASIN, a product. Nexus negates a product only inside an ad group, as a negative product target, so no campaign-level negative was made.`

const makeAddNegativeHandler = (matchType: 'NEGATIVE_EXACT' | 'NEGATIVE_PHRASE') =>
  async (action: Record<string, unknown> & { type: string }, context: unknown, meta: Pick<HandlerMeta, 'ruleId' | 'dryRun' | 'approval'>): Promise<ActionResult> => {
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
      const looksLikeAsin = isAsin(keyword)
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

      const conn = await (await import('./ads-profile-resolver.js')).adsClientContextFor(marketplace) // CM-29 — the gate's resolver
      const { createNegative, writeNegativeProductTarget } = await import('./ads-negative-kw.service.js')
      const { mirrorNegativeKeywordLocal, createNegativeKeywordCampaignLocal } = await import('./ads-create.service.js')

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
        /**
         * 5d (review 7.5) — an ASIN search term is a product. Whatever is ticked here, it becomes ONE negative
         * product target in this ad group, through the negative write service; as an exact or phrase keyword it
         * blocked nothing (and 5b refuses that write). Nexus negates a product only inside an ad group, so the
         * campaign level is refused by name, not counted as a failed write.
         */
        if (looksLikeAsin) {
          if (levels.includes('CAMPAIGN') && !campaignsDone.has(dst.campaignId)) {
            campaignsDone.add(dst.campaignId)
            outcomes.push({ adGroupId: dst.id, matchType: 'PRODUCT', level: 'CAMPAIGN', refused: asinCampaignRefusal(keyword) })
          }
          if (!levels.includes('AD_GROUP')) continue
          if (wire.dedupe) {
            const exists = await prisma.adTarget.findFirst({
              where: { isNegative: true, kind: 'PRODUCT', status: { not: 'ARCHIVED' }, adGroupId: dst.id, expressionValue: { equals: keyword.trim(), mode: 'insensitive' } },
              select: { id: true },
            })
            if (exists) { outcomes.push({ adGroupId: dst.id, matchType: 'PRODUCT', level: 'AD_GROUP', skipped: 'dedupe — this ASIN is already a negative product target in this ad group' }); continue }
          }
          if (meta.dryRun) { outcomes.push({ adGroupId: dst.id, matchType: 'PRODUCT', level: 'AD_GROUP', wouldCreate: true }); continue }
          const r = await writeNegativeProductTarget({ adGroupId: dst.id, asin: keyword.trim(), userId: RULE_ACTOR(meta.ruleId), evidence: ctxEvidence(context) })
          if (r.outcome === 'created' || r.outcome === 'local') noteNegative(meta, r.adTargetId)
          if (r.outcome === 'already_existed') { outcomes.push({ adGroupId: dst.id, matchType: 'PRODUCT', level: 'AD_GROUP', skipped: 'already a negative product target (existing row found at create time)' }); continue }
          if (r.reachedAmazon) { confirmed += 1; outcomes.push({ adGroupId: dst.id, matchType: 'PRODUCT', level: 'AD_GROUP', externalTargetId: r.externalTargetId, reachedAmazon: true }); continue }
          failedWrites += 1
          outcomes.push({ adGroupId: dst.id, matchType: 'PRODUCT', level: 'AD_GROUP', reachedAmazon: false, refused: r.refusal ? `${r.refusal.deniedAt}: ${r.refusal.reason}` : r.error ?? `the negative product target did not reach Amazon (mode=${r.mode})` })
          continue
        }
        for (const t of target.types) {
          // product circle → a negative PRODUCT target; only an ASIN-shaped term can be one (handled above).
          if (t === 'ASIN') { outcomes.push({ adGroupId: dst.id, matchType: 'PRODUCT', skipped: 'negative product target needs an ASIN-shaped term — keyword types on this mapping were still processed' }); continue }
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
            const mirrored = level === 'AD_GROUP'
              ? await mirrorNegativeKeywordLocal({ adGroupId: dst.id, keywordText: keyword, matchType, externalTargetId: res.externalNegativeKeywordId })
              : await createNegativeKeywordCampaignLocal({ externalCampaignId: dst.campaign.externalCampaignId, keywordText: keyword, matchType: t, externalTargetId: res.externalNegativeKeywordId })
            if (mirrored?.created) noteNegative(meta, mirrored.id)
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
     * unmapped rules), nothing changes. 5d — the adapter no longer emits this action (negate-in-source
     * rides inside promote_to_exact); the check stays for suggestions recorded before.
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

    // 5d (review 7.5) — an ASIN is a product: in its ad group it becomes a negative product target; campaign-wide
    // there is no product negative Nexus can make, so that is refused by name.
    if (isAsin(keyword)) {
      if (scope === 'CAMPAIGN') return { type: action.type, ok: false, error: asinCampaignRefusal(keyword), output: { keyword, externalCampaignId, scope } }
      const ag = await prisma.adGroup.findFirst({ where: { externalAdGroupId }, select: { id: true } })
      if (!ag) return { type: action.type, ok: false, error: `No local ad group for externalAdGroupId=${externalAdGroupId}` }
      if (meta.dryRun) return { type: action.type, ok: true, output: { dryRun: true, keyword, externalCampaignId, matchType: 'PRODUCT', scope } }
      const { writeNegativeProductTarget } = await import('./ads-negative-kw.service.js')
      const r = await writeNegativeProductTarget({ adGroupId: ag.id, asin: keyword.trim(), userId: RULE_ACTOR(meta.ruleId), evidence: ctxEvidence(context) })
      if (r.outcome === 'created' || r.outcome === 'local') noteNegative(meta, r.adTargetId)
      if (r.outcome !== 'already_existed' && !r.reachedAmazon) {
        return { type: action.type, ok: false, error: r.refusal ? `Refused at ${r.refusal.deniedAt}: ${r.refusal.reason}` : r.error ?? `the negative product target did not reach Amazon (mode=${r.mode})`, output: { keyword, externalCampaignId, matchType: 'PRODUCT', scope } }
      }
      return { type: action.type, ok: true, output: { keyword, externalCampaignId, matchType: 'PRODUCT', scope, alreadyExisted: r.outcome === 'already_existed', externalTargetId: r.externalTargetId } }
    }

    if (meta.dryRun) return { type: action.type, ok: true, output: { dryRun: true, keyword, externalCampaignId, matchType, scope } }
    const { createNegative } = await import('./ads-negative-kw.service.js')
    const conn = await (await import('./ads-profile-resolver.js')).adsClientContextFor(marketplace) // CM-29 — the gate's resolver
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
// (the 209-of-218 never-reached-Amazon mechanism).
//
// 5d (review 7.3, 7.4, 7.5) — three more promises the handler keeps:
//   · an ACCOUNT-WIDE rule lands a term where `accountWideLanding` says (the stored harvest
//     destination; the source only when it is a manual Sponsored Products ad group), or refuses
//     by name. An action WITHOUT `harvest` (an engine-native rule) maps nothing, so it is
//     account-wide too, at its own constant bid.
//   · an ASIN search term becomes a PRODUCT target (an asin expression), never a keyword.
//   · `negateInSource` adds the source's isolation negative only AFTER the term landed in
//     ANOTHER ad group (`isolateInSource`).
// PB-6a — winners stay: a term that already lives as a keyword (or product target) of the SAME product in its market is
// not created again, and the source is negated only once that home meets the harvest bar there (handover "proven");
// a fresh landing keeps the term running where it converts until then.

/** 5d — what an account-wide landing needs to know about the term's source ad group. */
const HARVEST_SOURCE_SELECT = {
  id: true, campaignId: true,
  campaign: { select: { marketplace: true, portfolioId: true, targetingType: true, adProduct: true, type: true } },
} as const
type HarvestCampaign = { marketplace?: string | null; portfolioId?: string | null; targetingType: string | null; adProduct: string | null; type: string | null }
type HarvestSource = { id: string; campaignId: string; campaign: HarvestCampaign | null }

/** A manual Sponsored Products campaign: the only kind a harvest can create a keyword or product target in. */
const takesHarvestTargets = (c: HarvestCampaign | null | undefined): boolean =>
  !!c && c.targetingType === 'MANUAL' && adProductOf(c) === SPONSORED_PRODUCTS

/**
 * 5d (review 7.4) — where an ACCOUNT-WIDE harvest lands a term. It used to be the source ad group,
 * always, automatic campaigns included — and an automatic campaign takes no keyword, so the push
 * failed and left local-only rows. Now, in this order:
 *   1. the destination stored for the term's scope (`AdsHarvestDestination`, most specific grain
 *      first: the chain the Keyword Harvest tab saves to), when it is a manual Sponsored Products
 *      ad group in the term's market;
 *   2. else the source ad group, only when it is itself a manual Sponsored Products ad group;
 *   3. else a refusal that says what to set. Nothing is written.
 * Only the STORED destination is read, never the resolver's shortlist: a rule lands a term where a
 * person chose, and the shortlist is 5–21 ad groups long in this account.
 */
async function accountWideLanding(src: HarvestSource, asin: boolean): Promise<{ adGroupId: string; via: 'destination' | 'source' } | { refuse: string }> {
  const what = asin ? 'product target' : 'keyword'
  const kind = asin ? 'product targets' : 'exact keywords'
  const market = src.campaign?.marketplace ?? null
  const { resolveStoredDestinations } = await import('./harvest-destination.service.js')
  const stored = (await resolveStoredDestinations({
    market: market ?? 'all', portfolio: src.campaign?.portfolioId ?? null, campaign: src.campaignId, adGroup: src.id,
  })).get(asin ? 'PRODUCT' : 'EXACT')
  if (stored) {
    const dst = await prisma.adGroup.findUnique({
      where: { id: stored.adGroupId },
      select: { id: true, name: true, campaign: { select: { marketplace: true, targetingType: true, adProduct: true, type: true } } },
    })
    if (!dst) return { refuse: `The harvest destination set for ${kind} no longer exists, so this ${what} was not created. Choose a destination on the Keyword Harvest tab.` }
    if (market && dst.campaign?.marketplace && dst.campaign.marketplace !== market) {
      return { refuse: `The harvest destination “${dst.name}” is in ${dst.campaign.marketplace}, but this search term is from ${market}, so the ${what} was not created. Set a destination for ${market} on the Keyword Harvest tab.` }
    }
    if (!takesHarvestTargets(dst.campaign)) {
      return { refuse: `The harvest destination “${dst.name}” is not in a manual Sponsored Products campaign, so it cannot take a ${what}. Choose another destination on the Keyword Harvest tab.` }
    }
    return { adGroupId: dst.id, via: 'destination' }
  }
  if (takesHarvestTargets(src.campaign)) return { adGroupId: src.id, via: 'source' }
  const product = adProductOf(src.campaign)
  const where = product !== SPONSORED_PRODUCTS
    ? `a ${adProductLabel(product) ?? 'non-Sponsored Products'} campaign`
    : src.campaign?.targetingType === 'AUTO' ? 'an automatic campaign' : 'a campaign that is not set to manual targeting'
  return { refuse: `No harvest destination is set for ${kind}${market ? ` in ${market}` : ''}, and this search term came from an ad group in ${where}, which cannot take a ${what}. Nothing was created. Set a destination on the Keyword Harvest tab.` }
}

/**
 * 5d — what a dry run says about the isolation negative. PB-6a (L4, handover "proven") — it follows only a home elsewhere
 * that meets the harvest bar there; a term that would land elsewhere now keeps running in its source until then.
 */
function isolationPreview(srcId: string, asin: boolean, wouldLandIn: string[], provenHomeId: string | null): Record<string, unknown> {
  const matchType = asin ? 'PRODUCT' : 'NEGATIVE_EXACT'
  if (provenHomeId) return { wouldNegate: true, adGroupId: srcId, matchType, when: 'its home elsewhere meets the harvest bar there', homeAdGroupId: provenHomeId }
  return {
    wouldNegate: false, adGroupId: srcId, matchType,
    reason: wouldLandIn.some((id) => id !== srcId)
      ? KEEPS_RUNNING
      : wouldLandIn.length ? 'The term would land only in the ad group it came from, so the source would not be negated.' : 'Nothing would be created, so the source would not be negated.',
  }
}

/** PB-6a (L4) — a term that lands elsewhere keeps running where it converts until its new keyword proves itself. */
const KEEPS_RUNNING = 'The term lands in another ad group and keeps running in its source until the new keyword meets the harvest bar there; only then is the source negated.'

/**
 * 5d (review 7.3, Owner decision D4) — the source's isolation negative, once the term LANDED at
 * Amazon in ANOTHER ad group. Never before: a negative in the source when nothing landed silences
 * the term everywhere, and a negative in the ad group that just received the keyword cancels it.
 * Because it follows a landing elsewhere it skips the converting guard (a harvested term converted
 * by definition, so the guard refused every one); protected terms, Amazon's text limits and the
 * write gate still bind, inside the negative write service. An ASIN gets a negative product
 * target, a keyword an EXACT negative. A refusal is named, not a failure; a write that did not
 * land is a failure.
 */
async function isolateInSource(args: { srcId: string; query: string; asin: boolean; landedIn: string[]; ruleId: string; evidence: AdWriteEvidence | null; approval?: HandlerMeta['approval'] }): Promise<{ isolation: Record<string, unknown>; failed: boolean }> {
  const base = { adGroupId: args.srcId, matchType: args.asin ? 'PRODUCT' : 'NEGATIVE_EXACT' }
  if (!args.landedIn.some((id) => id !== args.srcId)) {
    return {
      failed: false,
      isolation: { ...base, attempted: false, reason: args.landedIn.length ? 'The term landed only in the ad group it came from, so the source was not negated.' : 'Nothing landed at Amazon, so the source was not negated.' },
    }
  }
  const { writeNegativeKeyword, writeNegativeProductTarget } = await import('./ads-negative-kw.service.js')
  const r = args.asin
    ? await writeNegativeProductTarget({ adGroupId: args.srcId, asin: args.query.trim(), userId: RULE_ACTOR(args.ruleId), evidence: args.evidence })
    : await writeNegativeKeyword({ scope: 'AD_GROUP', adGroupId: args.srcId, keywordText: args.query, matchType: 'EXACT', protectConverting: null, userId: RULE_ACTOR(args.ruleId), evidence: args.evidence })
  if (r.outcome === 'created' || r.outcome === 'local') noteNegative(args, r.adTargetId)
  if (r.outcome === 'already_existed') return { failed: false, isolation: { ...base, attempted: true, alreadyExisted: true, externalTargetId: r.externalTargetId, reachedAmazon: r.reachedAmazon } }
  if (r.outcome === 'refused') return { failed: false, isolation: { ...base, attempted: true, reachedAmazon: false, refused: `${r.refusal?.deniedAt}: ${r.refusal?.reason}` } }
  if (r.reachedAmazon) return { failed: false, isolation: { ...base, attempted: true, externalTargetId: r.externalTargetId, reachedAmazon: true } }
  return { failed: true, isolation: { ...base, attempted: true, reachedAmazon: false, refused: r.error ?? `the isolation negative did not reach Amazon (mode=${r.mode})` } }
}

/** 5d — why a product target did not land, from the only signal `createTargetLocal` returns. */
const productTargetMiss = (mode: string): string => mode === 'live'
  ? 'Amazon returned no id for the product target'
  : mode === 'sandbox' ? 'sandbox mode: nothing was sent to Amazon' : 'nothing was sent: the write gate refused it, or the ad group has no Amazon ids'

ACTION_HANDLERS.promote_to_exact = async (action, context, meta): Promise<ActionResult> => {
  const query = (action.query as string | undefined) ?? (context as any)?.searchTerm?.query
  const srcExternalAdGroupId = (action.adGroupId as string | undefined) ?? (context as any)?.searchTerm?.externalAdGroupId
  if (!query) return { type: action.type, ok: false, error: 'No query in context' }
  if (!srcExternalAdGroupId) return { type: action.type, ok: false, error: 'No adGroupId' }
  const { createKeywordLocal, pushExistingKeyword, createTargetLocal } = await import('./ads-create.service.js')
  const src: HarvestSource | null = await prisma.adGroup.findFirst({ where: { externalAdGroupId: srcExternalAdGroupId }, select: HARVEST_SOURCE_SELECT })
  if (!src) return { type: action.type, ok: false, error: `No local ad group for externalAdGroupId=${srcExternalAdGroupId}` }
  const asin = isAsin(query)

  const wire = (action.harvest ?? null) as import('./ads-harvest-wire.js').HarvestWire | null
  const { matchedBlocks, termPassesFilters, resolveHarvestBidEur, normalizeHarvestBidMode } = await import('./ads-harvest-wire.js')

  // 1 — is this term's SOURCE ad group inside the rule's mappings? (no wire = maps nothing = account-wide)
  const blocks = wire ? matchedBlocks(wire.blocks, src.id) : 'account-wide'
  if (blocks !== 'account-wide' && blocks.length === 0) {
    return { type: action.type, ok: true, output: { skipped: 'source-ad-group-not-in-mappings', query, sourceAdGroupId: src.id } }
  }

  // 2 — the term filters (contains / does-not-contain / brand / competitor-only)
  if (wire) {
    const isOwnAsin = wire.filters.competitorOnly && asin
      ? (await prisma.adProductAd.count({ where: { asin: { equals: query.trim(), mode: 'insensitive' } } })) > 0
      : false
    const filt = termPassesFilters(query, wire.filters, isOwnAsin)
    if (filt.pass === false) return { type: action.type, ok: true, output: { skipped: 'term-filter', reason: filt.reason, query } }
  }

  // 3 — the creation set: mapped destinations × ticked types; account-wide lands where 5d's rule says, or refuses
  let targets: Array<{ adGroupId: string; types: Array<'PHRASE' | 'EXACT' | 'ASIN'> }>
  if (blocks === 'account-wide') {
    const landing = await accountWideLanding(src, asin)
    if ('refuse' in landing) return { type: action.type, ok: false, error: landing.refuse, output: { refusedBy: 'destination', query, sourceAdGroupId: src.id } }
    targets = [{ adGroupId: landing.adGroupId, types: [asin ? 'ASIN' : 'EXACT'] }]
  } else {
    const seen = new Map<string, Set<string>>()
    for (const b of blocks) for (const c of b.create) {
      const s = seen.get(c.adGroupId) ?? new Set<string>()
      for (const t of c.types) s.add(t)
      seen.set(c.adGroupId, s)
    }
    targets = [...seen.entries()].map(([adGroupId, types]) => ({ adGroupId, types: [...types] as Array<'PHRASE' | 'EXACT' | 'ASIN'> }))
  }

  // dedupe scope = the campaigns of every mapped ad group ("the campaigns from this rule group");
  // an account-wide rule dedupes account-wide. An engine-native action does not dedupe (the creators are idempotent).
  const mappedAgIds = blocks === 'account-wide' ? null : [...new Set(blocks.flatMap((b) => [...b.look, ...b.create.map((c) => c.adGroupId)]))]
  const dedupeCampaignIds = mappedAgIds
    ? (await prisma.adGroup.findMany({ where: { id: { in: mappedAgIds } }, select: { campaignId: true } })).map((g) => g.campaignId)
    : null

  const st = (context as any)?.searchTerm as { clicks?: number; spendCents?: number } | undefined
  const termCpcEur = st && Number(st.clicks) > 0 ? (Number(st.spendCents ?? 0) / Number(st.clicks)) / 100 : null
  // An engine-native action carries one constant bid (`bidEur`, default €0.50): the 'fixed' mode.
  const bidMode = wire ? normalizeHarvestBidMode((action.bid as { mode?: unknown } | undefined)?.mode) : 'fixed'
  const bidValue = wire ? (action.bid as { value?: unknown } | undefined)?.value : (action.bidEur ?? 0.5)
  const bidValueNum = bidValue != null && Number.isFinite(Number(bidValue)) ? Number(bidValue) : null
  const evidence = ctxEvidence(context)

  const outcomes: Array<Record<string, unknown>> = []
  const landedIn: string[] = [] // ad groups where the term is now confirmed at Amazon
  let confirmed = 0
  let failedWrites = 0
  // PB-6a (L2) — the term's home among the SAME product's ad groups in its market (the source's products, with their
  // sibling variants): it is never created again elsewhere. Another product's keyword is never a home (rule 3).
  const { familyAdGroups, homeOf, positivesIn, productFamilyOf } = await import('./ads-winner-lock.js')
  const productScope = await familyAdGroups(await productFamilyOf([src.id]), src.campaign?.marketplace ?? null)
  const positives = [...(await positivesIn([...productScope, src.id, ...targets.map((t) => t.adGroupId)])).values()].flat()
  const homes: Array<{ adGroupId: string }> = []
  for (const target of targets) {
    const agDefault = bidMode === 'adGroupDefault'
      ? await prisma.adGroup.findUnique({ where: { id: target.adGroupId }, select: { defaultBidCents: true } }).then((g) => (g?.defaultBidCents != null ? g.defaultBidCents / 100 : null))
      : null
    for (const matchType of target.types) {
      // 5d (review 7.5) — an ASIN is a product: it lands only on the product tick, as a product target, and a keyword
      // only on the keyword ticks. Named skips: the other types on the same mapping are still processed.
      if (asin !== (matchType === 'ASIN')) {
        outcomes.push({ adGroupId: target.adGroupId, matchType, skipped: asin ? 'an ASIN is a product, not a keyword: it is created only where the product type is ticked' : 'a product target needs an ASIN; this term is a keyword' })
        continue
      }
      const home = homeOf(query, positives, asin ? undefined : (matchType as 'EXACT' | 'PHRASE'))
      if (home) {
        homes.push(home)
        outcomes.push({ adGroupId: target.adGroupId, matchType, skipped: 'already-home', homeAdGroupId: home.adGroupId, why: `it already lives as ${asin ? 'a product target' : `a ${matchType.toLowerCase()} keyword`} in this product's campaigns${home.live ? '' : ' (not yet live at Amazon)'}, so it is not created again` })
        continue
      }
      if (wire?.dedupe) {
        const exists = await prisma.adTarget.findFirst({
          where: {
            kind: asin ? 'PRODUCT' : 'KEYWORD', isNegative: false, ...(asin ? {} : { expressionType: matchType }),
            expressionValue: { equals: asin ? query.trim() : query, mode: 'insensitive' },
            ...(dedupeCampaignIds ? { adGroup: { campaignId: { in: dedupeCampaignIds } } } : {}),
          },
          select: { id: true },
        })
        if (exists) { outcomes.push({ adGroupId: target.adGroupId, matchType, skipped: 'dedupe — the term already exists with this match type in this rule group' }); continue }
      }
      const bid = resolveHarvestBidEur(bidMode, bidValueNum, termCpcEur, agDefault)
      if ('refuse' in bid) { failedWrites += 1; outcomes.push({ adGroupId: target.adGroupId, matchType, refused: `bid: ${bid.refuse}` }); continue }
      if (meta.dryRun) { outcomes.push({ adGroupId: target.adGroupId, matchType, wouldCreate: true, bidEur: bid.bidEur }); continue }
      if (matchType === 'ASIN') {
        const r = await createTargetLocal({ adGroupId: target.adGroupId, kind: 'PRODUCT', value: query.trim(), bidEur: bid.bidEur })
        if (r.externalTargetId != null) { confirmed += 1; landedIn.push(target.adGroupId); outcomes.push({ adGroupId: target.adGroupId, matchType, bidEur: bid.bidEur, externalTargetId: r.externalTargetId, reachedAmazon: true }); continue }
        failedWrites += 1
        outcomes.push({ adGroupId: target.adGroupId, matchType, adTargetId: r.id, reachedAmazon: false, refused: productTargetMiss(r.mode) })
        continue
      }
      const r = await createKeywordLocal({ adGroupId: target.adGroupId, keywordText: query, matchType, bidEur: bid.bidEur, evidence })
      if (r.externalTargetId != null) { confirmed += 1; landedIn.push(target.adGroupId); outcomes.push({ adGroupId: target.adGroupId, matchType, bidEur: bid.bidEur, externalTargetId: r.externalTargetId, reachedAmazon: true, existed: r.existed === true }); continue }
      if (r.existed) {
        // The local-only backlog's live fix: an existing row Amazon never saw gets a PUSH, not a
        // silent idempotent no-op (HV.4's pushExistingKeyword, on the rule path at last).
        const p = await pushExistingKeyword({ adTargetId: r.id, evidence })
        if (p.ok && p.externalTargetId) { confirmed += 1; landedIn.push(target.adGroupId); outcomes.push({ adGroupId: target.adGroupId, matchType, pushedExisting: true, externalTargetId: p.externalTargetId, reachedAmazon: true }); continue }
        failedWrites += 1
        outcomes.push({ adGroupId: target.adGroupId, matchType, reachedAmazon: false, refused: p.refusal ? `${p.refusal.deniedAt}: ${p.refusal.reason}` : p.error ?? 'exists locally and the push did not land' })
        continue
      }
      failedWrites += 1
      outcomes.push({ adGroupId: target.adGroupId, matchType, adTargetId: r.id, reachedAmazon: false, refused: r.denied ? `write gate denied at ${r.denied.deniedAt}: ${r.denied.reason}` : r.pushError ?? 'created locally only — Amazon did not take the keyword' })
    }
  }

  // 4 — negate-in-source (5d). PB-6a (L4, handover "proven"): only once the term's home elsewhere meets the harvest bar
  // there (the ads strategy's harvest group for that ad group, else the harvest defaults); a fresh landing keeps the term
  // running where it converts until then.
  let isolation: Record<string, unknown> | null = null
  let isolationFailed = false
  if (action.negateInSource === true) {
    const away = homes.filter((h) => h.adGroupId !== src.id)
    const { homeWinners, winnerKey } = await import('./ads-harvest.service.js')
    const winners = away.length ? await homeWinners(away.map((h) => ({ term: query, adGroupId: h.adGroupId })), { defaults: { ...HARVEST_DEFAULTS } }) : new Set<string>()
    const proven = away.find((h) => winners.has(winnerKey(query, h.adGroupId)))?.adGroupId ?? null
    if (meta.dryRun) {
      isolation = isolationPreview(src.id, asin, outcomes.filter((o) => o.wouldCreate === true).map((o) => String(o.adGroupId)), proven)
      // A handover alone is a change to propose: the negative it would create in the source.
      if (proven) outcomes.push({ adGroupId: src.id, matchType: asin ? 'PRODUCT' : 'NEGATIVE_EXACT', wouldCreate: true, handover: true, why: 'its home elsewhere meets the harvest bar there, so the source is negated' })
    } else if (proven) ({ isolation, failed: isolationFailed } = await isolateInSource({ srcId: src.id, query, asin, landedIn: [proven], ruleId: meta.ruleId, evidence, approval: meta.approval }))
    else if (landedIn.some((id) => id !== src.id)) isolation = { adGroupId: src.id, matchType: asin ? 'PRODUCT' : 'NEGATIVE_EXACT', attempted: false, reason: KEEPS_RUNNING }
    else ({ isolation, failed: isolationFailed } = await isolateInSource({ srcId: src.id, query, asin, landedIn, ruleId: meta.ruleId, evidence, approval: meta.approval }))
  }

  const errors = [
    failedWrites > 0 ? `${failedWrites} creation${failedWrites === 1 ? '' : 's'} did not reach Amazon — see outcomes` : null,
    isolationFailed ? `the negative in the source ad group did not reach Amazon — see isolation` : null,
  ].filter((e): e is string => e != null)
  return {
    type: action.type,
    // Skips are policy working; a write that did not land is a failure. All-skips is a clean run.
    ok: errors.length === 0,
    error: errors.length ? errors.join('; ') : undefined,
    output: { query, sourceAdGroupId: src.id, dryRun: meta.dryRun || undefined, confirmed, failedWrites, outcomes, ...(isolation ? { isolation } : {}) },
  }
}

// ── sync_negatives_across_campaigns ──────────────────────────────────
// Add a wasted keyword as NEGATIVE EXACT to ALL campaigns in a marketplace.
// Stops the same bad term from wasting money across the whole account.
ACTION_HANDLERS.sync_negatives_across_campaigns = async (action, context, meta): Promise<ActionResult> => {
  const keyword = (action.keyword as string | undefined) ?? (context as any)?.searchTerm?.query ?? (context as any)?.adTarget?.expressionValue
  const marketplace = (action.marketplace as string | undefined) ?? (context as any).marketplace
  if (!keyword || !marketplace) return { type: action.type, ok: false, error: 'keyword + marketplace required' }
  // 5d (review 7.5) — every write here is campaign-level, where Nexus has no product negative for an ASIN.
  if (isAsin(keyword)) return { type: action.type, ok: false, error: asinCampaignRefusal(keyword), output: { keyword, marketplace } }
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
  const conn = await (await import('./ads-profile-resolver.js')).adsClientContextFor(marketplace) // CM-29 — the gate's resolver
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
// Update a campaign's target ACOS stored in dynamicBidding JSON, a fraction
// (0.3 = 30%). The bid optimiser moves the campaign's bids toward it in every
// mode — after a rule's or plan's own target, ahead of the account default and
// profit data; a value outside 0–5 is skipped there, not converted
// (ads-target-acos-resolver.ts).
ACTION_HANDLERS.set_campaign_target_acos = async (action, context, meta): Promise<ActionResult> => {
  const id = (action.campaignId as string | undefined) ?? ctxCampaignId(action, context)
  const targetAcos = Number(action.targetAcos ?? 0.3)
  if (!id) return { type: action.type, ok: false, error: 'No campaign.id' }
  if (meta.dryRun) return { type: action.type, ok: true, output: { dryRun: true, campaignId: id, targetAcos } }
  const c = await prisma.campaign.findUnique({ where: { id }, select: { dynamicBidding: true } })
  const db = (c?.dynamicBidding ?? {}) as Record<string, unknown>
  db.targetAcos = targetAcos
  // CM-6 — only `targetAcos`, merged into the row as it is now: writing `db` whole put back a placement (or another
  // setting) saved since the read above.
  await patchDynamicBidding(id, { set: { targetAcos } })
  return { type: action.type, ok: true, output: { campaignId: id, targetAcos } }
}

// ── increase_daily_budget_cap ────────────────────────────────────────
// Set a campaign's daily budget to a fixed value (not a % — used for
// "unlock this campaign on Prime Day" style automation).
//
// 3e (review 6.9) — every check runs in a dry run too, so a rule never proposes a budget its approval would
// then refuse. Below Amazon's €1 minimum is refused, not clamped: a clamp rewrites the rule's intent without
// telling anyone. The write goes through updateCampaignWithSync (action log, queue, write gate) with no
// `as never`, and its refusal is returned instead of a bare ok:false.
ACTION_HANDLERS.set_daily_budget = async (action, context, meta): Promise<ActionResult> => {
  const id = (action.campaignId as string | undefined) ?? ctxCampaignId(action, context)
  const budgetEur = Number(action.budgetEur)
  if (!id) return { type: action.type, ok: false, error: 'No campaign.id' }
  if (!Number.isFinite(budgetEur) || budgetEur <= 0) return { type: action.type, ok: false, error: 'budgetEur must be a positive number' }
  if (budgetEur < 1) return { type: action.type, ok: false, error: `Refused: €${budgetEur.toFixed(2)} is below Amazon's minimum daily budget of €1.00.`, output: { campaignId: id, budgetEur } }
  const c = await prisma.campaign.findUnique({ where: { id }, select: { dailyBudget: true } })
  if (!c) return { type: action.type, ok: false, error: 'Campaign not found' }
  const current = Number(c.dailyBudget)
  if (budgetEur === current) return { type: action.type, ok: true, estimatedValueCentsEur: 0, output: { campaignId: id, noChange: true, dailyBudget: budgetEur } }
  if (meta.dryRun) return { type: action.type, ok: true, output: { dryRun: true, campaignId: id, budgetEur, wouldChange: `€${current.toFixed(2)} → €${budgetEur.toFixed(2)}` } }
  const cap = await checkDailySpendCap(meta.ruleId, Math.round(budgetEur * 100))
  if (!cap.allowed) return { type: action.type, ok: false, error: `daily spend cap: ${cap.capCents}¢` }
  const res = await updateCampaignWithSync({
    campaignId: id,
    patch: { dailyBudget: budgetEur },
    ...ruleWrite(meta, (action.reason as string | undefined) ?? `set_daily_budget via rule ${meta.ruleId}`),
    applyImmediately: true,
  })
  return { type: action.type, ok: res.ok, error: res.error ?? undefined, output: { campaignId: id, budgetEur, outboundQueueId: res.outboundQueueId } }
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
  await bulkUpdateAdTargetBids({ entries, ...ruleWrite(meta, `scale_bids_for_price_change ×${clamped.toFixed(2)}`) })
  return { type: action.type, ok: true, output: { scaled: entries.length, scaleFactor: clamped } }
}

// ── enable_campaign ───────────────────────────────────────────────────
ACTION_HANDLERS.enable_campaign = async (action, context, meta): Promise<ActionResult> => {
  const id = (action.campaignId as string | undefined) ?? ctxCampaignId(action, context)
  if (!id) return { type: action.type, ok: false, error: 'No campaign.id' }
  if (meta.dryRun) return { type: action.type, ok: true, output: { dryRun: true, campaignId: id } }
  const res = await updateCampaignWithSync({ campaignId: id, patch: { status: 'ENABLED' }, ...ruleWrite(meta, 'enable_campaign via rule'), applyImmediately: true } as never)
  return { type: action.type, ok: res.ok, output: { campaignId: id, outboundQueueId: res.outboundQueueId } }
}

/**
 * ADS AUTONOMY W1-7 — no optimiser stops a protected product. A rule that would pause, archive or floor a keyword or
 * target of an ad group advertising a product the ads strategy protects (one protected product protects its ad group)
 * skips it and says why: a skip, not a failure, asked BEFORE the dry-run return, so a PROPOSE rule offers no
 * suggestion of it (the `rankOwnedSkip` pattern). The retail guard, the budget stop, a halt, dayparting and Hourly
 * Bids are not stops of this kind and still apply.
 */
async function protectedStopSkip(type: string, adTargetId: string, target?: { adGroupId: string; adGroup: { campaign: { marketplace: string | null } | null } | null }): Promise<ActionResult | null> {
  const t = target ?? await prisma.adTarget.findUnique({ where: { id: adTargetId }, select: { adGroupId: true, adGroup: { select: { campaign: { select: { marketplace: true } } } } } })
  if (!t) return null
  const { protectedAdGroups, protectedStopWhy } = await import('./ads-strategy/terms.js')
  const source = (await protectedAdGroups([{ id: t.adGroupId, market: t.adGroup?.campaign?.marketplace ?? null }])).get(t.adGroupId)
  return source ? { type, ok: true, output: { skipped: 'protected-product', adTargetId, why: protectedStopWhy(source) } } : null
}

// ── archive_keyword ───────────────────────────────────────────────────
// Permanently archive a keyword (stronger than pause — Amazon ignores it).
ACTION_HANDLERS.archive_keyword = async (action, context, meta): Promise<ActionResult> => {
  const id = (action.adTargetId as string | undefined) ?? ctxAdTargetId(action, context)
  if (!id) return { type: action.type, ok: false, error: 'No adTarget.id' }
  const held = await protectedStopSkip(action.type, id)
  if (held) return held
  if (meta.dryRun) return { type: action.type, ok: true, output: { dryRun: true, adTargetId: id } }
  const res = await updateAdTargetWithSync({ adTargetId: id, patch: { status: 'ARCHIVED' }, ...ruleWrite(meta, 'archive_keyword via rule') })
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
  const held = await protectedStopSkip(action.type, id)
  if (held) return held
  if (meta.dryRun) return { type: action.type, ok: true, output: { dryRun: true, adTargetId: id, bidCents: floorCents } }
  const res = await updateAdTargetWithSync({ adTargetId: id, patch: { bidCents: floorCents }, ...ruleWrite(meta, 'lower_bid_to_floor via rule'), evidence: ctxEvidence(context) })
  return { type: action.type, ok: res.ok, error: res.error ?? undefined, output: { adTargetId: id, bidCents: floorCents, outboundQueueId: res.outboundQueueId } }
}

// ── raise_bids_for_rank_defense ───────────────────────────────────────
// When impression share drops, raise bids aggressively to defend position.
// 4m (review 3.7) — each fire raises every enabled target of the campaign by 5–50% (default 20%), from the bid it has
// now. Nothing here limits how often that repeats: only the rule's own caps do (executions and writes a day). The old
// line here claimed a cap per fire it never had. A campaign Hourly Bids holds is left alone (`rankOwnedSkip`).
ACTION_HANDLERS.raise_bids_for_rank_defense = async (action, context, meta): Promise<ActionResult> => {
  const id = (action.campaignId as string | undefined) ?? ctxCampaignId(action, context)
  const pct = Math.min(50, Math.max(5, Number(action.percent ?? 20)))
  if (!id) return { type: action.type, ok: false, error: 'No campaign.id' }
  const held = await rankOwnedSkip(action.type, id, 'bids')
  if (held) return held
  const targets = await prisma.adTarget.findMany({ where: { status: 'ENABLED', isNegative: false, adGroup: { campaignId: id } }, select: { id: true, bidCents: true }, take: 200 })
  const entries = targets.map((t) => ({ adTargetId: t.id, bidCents: Math.round(t.bidCents * (1 + pct / 100)) }))
  if (meta.dryRun) return { type: action.type, ok: true, output: { dryRun: true, targets: entries.length, raisePct: pct } }
  const { bulkUpdateAdTargetBids } = await import('./ads-mutation.service.js')
  await bulkUpdateAdTargetBids({ entries, ...ruleWrite(meta, `rank_defense +${pct}%`) })
  return { type: action.type, ok: true, output: { raised: entries.length, pct } }
}

// ── alert_operator ────────────────────────────────────────────────────
// Richer version of notify — can include structured data for dashboard alerts.
ACTION_HANDLERS.alert_operator = async (action, context, meta): Promise<ActionResult> => {
  const severity = (action.severity as string | undefined) ?? 'info'
  const message = (action.message as string | undefined) ?? `Automation alert: ${action.type}`
  // R8 — a preview says whom it would alert and alerts no one (no bell, no log line that reads as a real alert).
  if (meta.preview) return { type: action.type, ok: true, output: { preview: true, severity, message, ruleId: meta.ruleId, notified: 0, wouldNotify: 'every operator' } }
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

/** The window a bid rule measures a target over: the rule's own lookback, else its trigger's (see targetPerformance). */
function bidWindowDays(trigger: string, overrideDays?: number | null): number {
  const spec = TRIGGER_WINDOW[trigger]
  // A trigger with no window of its own (SCHEDULE, CAC_SPIKE) still needs one to measure a
  // keyword over; 30 days is the longest any trigger uses and the most forgiving for sparse rows.
  // BP.P4 — a Bid rule's own lookback (`action.windowDays`, clamped like the emitter clamps it)
  // overrides the trigger default, so the computed bid measures over the window the operator chose.
  return typeof overrideDays === 'number' && Number.isFinite(overrideDays)
    ? Math.max(BID_WINDOW_MIN, Math.min(BID_WINDOW_MAX, Math.round(overrideDays)))
    : spec?.days ?? 30
}

/** 4d — one ad target's clicks over the same window, for the projected extra spend of a bid raise. */
async function targetClicks(adTargetId: string, trigger: string, overrideDays?: number | null): Promise<{ clicks: number; days: number }> {
  const days = bidWindowDays(trigger, overrideDays)
  const settled = settledWhere(days) // 6c — ends at the ad product's attribution lag
  const perf = await prisma.amazonAdsDailyPerformance.aggregate({
    where: { entityType: 'AD_TARGET', localEntityId: adTargetId, ...settled },
    _sum: { clicks: true },
  })
  return { clicks: perf._sum.clicks ?? 0, days }
}

/**
 * One ad target's measured CPC and ACoS, over the window the rule is described by.
 *
 * 🔴 The window comes from `TRIGGER_WINDOW`, the same table `ruleLookback` renders in the grid's
 * Lookback column — so the figure this computes on is the figure the operator was shown. A second
 * hard-coded window here is exactly the drift B2 existed to remove.
 *
 * 6c — `settledWhere` ends the window at the ad product's attribution lag (7 days for Sponsored
 * Products, 14 for Brands and Display), so a bid is never computed against a day whose sales have
 * not finished arriving. Returns null where there is no signal: a CPC needs a
 * click, and an ACoS needs a sale. Acting on a keyword with no clicks is guessing.
 */
async function targetPerformance(adTargetId: string, trigger: string, overrideDays?: number | null): Promise<{ cpcEur: number; acos: number | null; clicks: number; spendCents: number; salesCents: number; days: number } | null> {
  const days = bidWindowDays(trigger, overrideDays)
  const settled = settledWhere(days) // 6c — ends at the ad product's attribution lag
  const perf = await prisma.amazonAdsDailyPerformance.aggregate({
    where: { entityType: 'AD_TARGET', localEntityId: adTargetId, ...settled },
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
    spendCents,
    salesCents,
    days,
  }
}

/** The ops that steer a keyword's bid toward a target ACoS (their goal is ÷ r̂, and they wait as auto-bid does). */
const TARGET_ACOS_OPS = new Set(['targetAcos', 'curBidTargetAcos'])

/**
 * Review 2026-10-08 (A, rules) — the bid that served one keyword's clicks over the rule's settled window
 * (ads-bid-window.ts windowBidCents): its bid moves from the bid history since the window began, weighed by its daily
 * clicks. No move: today's bid served them all.
 */
async function ruleServingBid(adTargetId: string, currentCents: number, days: number): Promise<{ cents: number; basis: WindowBidBasis }> {
  const window = settledBounds(days, 'SPONSORED_PRODUCTS')
  const rows = await prisma.campaignBidHistory.findMany({
    where: { entityType: 'AD_TARGET', field: 'bid', entityId: adTargetId, changedAt: { gte: window.since } },
    select: { oldValue: true, newValue: true, changedAt: true },
  })
  const moves: BidMove[] = rows.map((r) => ({ at: r.changedAt, fromCents: Number(r.oldValue), toCents: Number(r.newValue) })).filter((m) => isServingMove(m.fromCents, m.toCents))
  const clickDays = moves.length
    ? await prisma.amazonAdsDailyPerformance.findMany({ where: { entityType: 'AD_TARGET', localEntityId: adTargetId, clicks: { gt: 0 }, ...settledWhere(days) }, select: { date: true, clicks: true } })
    : []
  return windowBidCents(currentCents, moves, clickDays, window)
}

/**
 * Review 2026-10-08 (B, rules) — why a target-ACoS op's move waits, or null: another automatic writer (auto-bid, a rule,
 * a plan) already moved this keyword on the current settled data day, or the move would reverse auto-bid's own last move
 * within its wait (ads-bid-window.ts movedThisDataDay / reversalWait, auto-bid's own reads).
 */
async function ruleBidWait(adTargetId: string, currentCents: number, proposedCents: number): Promise<string | null> {
  const { currentDataDay, recentAutoMoves } = await import('./ads-bid-optimizer.service.js')
  const dataDay = currentDataDay()
  const moves = (await recentAutoMoves([adTargetId])).get(adTargetId) ?? []
  return movedThisDataDay(dataDay, moves) ?? reversalWait(dataDay, currentCents, proposedCents, moves)
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
  const res = await updateCampaignWithSync({ campaignId: id, patch: { dailyBudget: next }, ...ruleWrite(meta, (action.reason as string) ?? `budget_apply via rule ${meta.ruleId}`) })
  return { type: action.type, ok: res.ok, error: res.error ?? undefined, estimatedValueCentsEur: delta, output: { campaignId: id, newDailyBudget: next, outboundQueueId: res.outboundQueueId } }
}

/**
 * 4d — one placement lane's spend over a placement rule's window, for the projected extra spend of a raise.
 *
 * The report holds Amazon's LABELS, never the bidding enums, and its `campaignId` is Amazon's external id — so the lane
 * is matched through `REPORT_LABEL_TO_PLACEMENT` on `localCampaignId`, the same join the evaluator's lane criteria use
 * (PLC-P7). Placement rules read the campaign-performance window; a suggestion approved after its context was pruned
 * has no trigger, and falls back to that same window.
 */
async function laneSpend(campaignId: string, placement: string, trigger: string): Promise<{ spendCents: number; days: number }> {
  const { REPORT_LABEL_TO_PLACEMENT } = await import('./ads-placement-math.js')
  const days = TRIGGER_WINDOW[trigger]?.days ?? TRIGGER_WINDOW.CAMPAIGN_PERFORMANCE_BUDGET?.days ?? 7
  const labels = Object.keys(REPORT_LABEL_TO_PLACEMENT).filter((label) => REPORT_LABEL_TO_PLACEMENT[label] === placement)
  if (!labels.length) return { spendCents: 0, days }
  const settled = settledWhere(days) // 6c — ends at the ad product's attribution lag
  const agg = await prisma.amazonAdsPlacementReport.aggregate({
    where: { localCampaignId: campaignId, placement: { in: labels }, ...settled },
    _sum: { costMicros: true },
  })
  return { spendCents: microsToCents(agg._sum.costMicros), days }
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
  if (placement === 'PLACEMENT_TOP') {
    const held = await rankOwnedSkip(action.type, id, 'Top of Search placement')
    if (held) return held
  }
  const c = await prisma.campaign.findUnique({ where: { id }, select: { dynamicBidding: true } })
  const db = (c?.dynamicBidding ?? {}) as { placementBidding?: Array<{ placement: string; percentage: number }> }
  const current = db.placementBidding?.find((x) => x.placement === placement)?.percentage ?? 0
  const minPct = Math.max(0, Number(action.minPct ?? 0))
  const maxPct = Math.min(900, Number(action.maxPct ?? 900))
  const next = Math.round(clampRange(applyBuilderOp(action.op as string, current, Number(action.value) || 0), minPct, maxPct))
  // 4d (review 4.4) — the spend this write would ADD per day: the lane's measured spend per day, scaled by how much the
  // new multiplier raises what a click in it may cost. Returned as `estimatedValueCentsEur`, so the engine's per-run
  // `maxValueCentsEur` binds a placement rule, and a live raise draws on the rule's daily spend ceiling. Read only for a raise.
  const lane = next > current ? await laneSpend(id, placement, String(getFieldPath(context, 'trigger') ?? '')) : null
  const spend = placementExtraSpend({ oldPct: current, newPct: next, laneSpendCents: lane?.spendCents ?? 0, windowDays: lane?.days ?? 1 })
  const spendOut = { extraSpendPerDayCents: spend.extraCentsPerDay, spendEstimate: spend.basis }
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
    return { type: action.type, ok: true, estimatedValueCentsEur: spend.extraCentsPerDay, output: { dryRun: true, campaignId: id, placement, wouldChange: `${current}% → ${next}%`, ...spendOut, ...(same ? { noChange: true } : {}) } }
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
   * 🔴 4e (review 5.3) — an automated run does not write a lane the rank engine holds on this campaign.
   *
   * The level dial refuses AUTO on a contested rule, but only at the moment the level changes: a schedule enabled later,
   * a widened picker or a blend added to the hourly plan left an AUTO rule writing a lane the engine puts back within the
   * hour, every tick. Checked here, live, at write time. A skip, not a failure (the `campaign-not-selected` shape), with
   * the reason. A change a person approved (`operatorApproved`) is that person's write and goes through.
   */
  if (!meta.operatorApproved) {
    const { contestedLanesByCampaign, contestedLaneSkipReason } = await import('./ads-placement-autonomy.js')
    const engineLanes = (await contestedLanesByCampaign([id])).get(id) ?? []
    if (engineLanes.includes(placement)) {
      return { type: action.type, ok: true, output: { skipped: 'contested_by_rank_engine', campaignId: id, placement, percentage: current, wouldBe: next, reason: contestedLaneSkipReason(placement) } }
    }
  }
  // Only a raise can spend more; a cut is never stopped by the spend ceiling.
  if (spend.extraCentsPerDay > 0) {
    const cap = await checkDailySpendCap(meta.ruleId, spend.extraCentsPerDay)
    if (!cap.allowed) return { type: action.type, ok: false, error: cap.error, estimatedValueCentsEur: 0, output: { campaignId: id, placement, percentage: current, wouldBe: next, ...spendOut } }
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
    ...ruleWrite(meta, `rule ${action.type}: ${current}% \u2192 ${next}%`),
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
      // 4e (review 5.9) — a push Amazon did not take is Amazon's answer, not the gate's: only a refusal (`blocked`) is the gate.
      error: res.mode !== 'blocked'
        ? `Amazon did not take this placement change: ${res.error ?? 'no reason given'}. Nexus keeps the new value and marks the campaign as not synced; the failed-write sweep sends it again if the error is temporary.`
        : res.reason ?? `the write gate declined this placement change${res.deniedAt ? ` (${res.deniedAt})` : ''}`,
      output: { campaignId: id, placement, percentage: next, mode: res.mode, ...(res.deniedAt ? { deniedAt: res.deniedAt } : {}) },
    }
  }
  return { type: action.type, ok: true, estimatedValueCentsEur: spend.extraCentsPerDay, output: { campaignId: id, placement, percentage: next, mode: res.mode, ...spendOut } }
}

// bid_apply (EA2) — Set/Increase/Decrease a keyword/target bid (adTarget.bidCents), clamped to
// [minEur,maxEur] with the €0.05 floor. Optional campaignIds allowlist (the Bid builder's picker):
// skip targets whose campaign isn't selected.
ACTION_HANDLERS.bid_apply = async (action, context, meta): Promise<ActionResult> => {
  const id = (action.adTargetId as string | undefined) ?? (getFieldPath(context, 'adTarget.id') as string | undefined)
  if (!id) return { type: action.type, ok: false, error: 'No adTarget.id in context' }
  const t = await prisma.adTarget.findUnique({
    where: { id },
    select: { bidCents: true, suppressedFromBidCents: true, adGroupId: true, adGroup: { select: { campaignId: true, campaign: { select: { bidsSuppressedAt: true, marketplace: true } } } } },
  })
  if (!t) return { type: action.type, ok: false, error: 'AdTarget not found' }
  const allow = Array.isArray(action.campaignIds) ? (action.campaignIds as string[]) : []
  if (allow.length && t.adGroup?.campaignId && !allow.includes(t.adGroup.campaignId)) {
    return { type: action.type, ok: true, output: { skipped: 'campaign-not-selected', adTargetId: id } }
  }

  /**
   * ── KT-P6 (2026-08-22) — the engine never un-suppresses ───────────────────────────────────────
   *
   * 🔴 This handler's floor is `max(0.05, minEur)`, so it **cannot write ≤3¢**. Every op it
   * performs on a deliberately suppressed target therefore switches delivery back ON for traffic
   * somebody switched off — silently, with an automation's actor on the row.
   *
   * The house rule is *no pause — suppress with a ~2¢ bid* ([[feedback_no_pause_use_low_bids]]),
   * so a low bid here is an off-switch, not a cheap bid. Measured on prod 2026-08-22 across the
   * **1,004** positive keyword targets in the 82 write-enabled campaigns the gate lets through:
   * **561 are suppressed (56%)**, **141 of them carry no flag at all**, and **420 sit in a campaign
   * that is `bidsSuppressedAt` right now**.
   *
   * Three separate tests, counted separately and never merged — the flag is EVIDENCE, ≤3¢ is a
   * CONVENTION, and merging them hides the 141 the flag does not know about
   * ([[reference_ads_suppression_by_low_bid]]). The threshold is imported from the KT.6 blast
   * radius rather than restated, so the engine and the operator-driven path cannot disagree about
   * what "suppressed" means.
   *
   * A skip, not a failure: the target was never a candidate, so the execution row should say it was
   * passed over and why — the same shape `campaign-not-selected` above uses. And this runs BEFORE
   * the `dryRun` return, so a preview reports the refusal instead of promising a raise that the
   * live run would not perform.
   *
   * ⚠️ Re-checked HERE, at write time, never at plan time: `suppressedFromBidCents` is another
   * engine's state machine and a 2¢ bid is a clock reading — the suppressed set turns over within
   * the hour ([[reference_ads_suppression_state_machine]]).
   */
  if (t.suppressedFromBidCents != null) {
    return { type: action.type, ok: true, output: { skipped: 'suppressed_flag', adTargetId: id, suppressedFromCents: t.suppressedFromBidCents } }
  }
  if (t.bidCents != null && t.bidCents <= KT6_SUPPRESSION_CENTS) {
    return { type: action.type, ok: true, output: { skipped: 'suppressed_by_bid', adTargetId: id, bidCents: t.bidCents } }
  }
  if (t.adGroup?.campaign?.bidsSuppressedAt != null) {
    // Writing into a bid-suppressed campaign is not a write: the next resume restores every target
    // from its remembered bid and overwrites this, with the engine's actor on the row.
    return { type: action.type, ok: true, output: { skipped: 'campaign_suppressed', adTargetId: id, campaignId: t.adGroup.campaignId } }
  }

  const currentEur = (t.bidCents ?? 0) / 100
  const floorEur = Math.max(0.05, action.minEur != null ? Number(action.minEur) : 0.05)
  const ceilEur = action.maxEur != null ? Number(action.maxEur) : null
  // W1-5 — the ads strategy of this target's ad group (the safer value across its products): its ACoS target for the
  // target-ACoS ops below, and its bid band, which binds beside the rule's own Min/Max (the stricter wins). A market
  // without a strategy row gives nothing, and the rule works as before.
  const strategy = (await strategyBidReader().forAdGroups([{ adGroupId: t.adGroupId, marketplace: t.adGroup?.campaign?.marketplace }])).get(t.adGroupId)
  const limits = strategy?.limits ?? NO_LIMITS
  const sources: WriteSources = limitSources(limits)

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
  // Review 2026-10-08 (A, rules) — the target-ACoS ops' r̂ and goal, for the output (see below).
  let paid: { ratio: number; servedBidCents: number; basis: string; goalCpcCents: number; goalBidCents: number } | null = null
  const trigger = String(getFieldPath(context, 'trigger') ?? '')
  const windowDays = action.windowDays != null ? Number(action.windowDays) : null
  let measured: { clicks: number; days: number } | null = null
  if (COMPUTED_BID_OPS.has(String(action.op))) {
    // The trigger comes from the CONTEXT, not `meta` — the handler signature carries only
    // { dryRun, ruleId }, and widening it would touch all 35 handlers for one field that the
    // context already states on every build.
    const perf = await targetPerformance(id, trigger, windowDays)
    if (!perf) {
      return { type: action.type, ok: false, error: `no measured clicks or spend for this target in the rule's window — there is no CPC to compute a bid from`, output: { adTargetId: id } }
    }
    measured = perf
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
      // W1-5 — whose target, in the order auto-bid uses (ads-target-acos-resolver.ts), without its profit and flat
      // fallbacks: the rule's own (an INTEGER percent here), else the campaign's own target ACoS, else the ads strategy's
      // for this ad group, else the account default (SG.5: Suggestions gear → AdsAutomationState.defaultTargetAcosPct).
      const own = Number(action.value)
      const owner = await readOwnerTargets(t.adGroup?.campaignId ? [t.adGroup.campaignId] : [])
      const chosen = configuredTargetAcos(
        { adGroupId: t.adGroupId, campaignTargetAcos: t.adGroup?.campaignId ? owner.byCampaign.get(t.adGroup.campaignId) : undefined },
        {
          explicitTargetAcos: Number.isFinite(own) && own > 0 ? own / 100 : undefined,
          accountDefaultPct: owner.accountDefaultPct,
          strategyByAdGroup: strategy?.target ? new Map([[t.adGroupId, strategy.target]]) : null,
        },
      )
      if (!chosen) {
        return { type: action.type, ok: false, error: `${String(action.op)} needs a positive target ACoS percentage — this rule stores ${JSON.stringify(action.value)}, and neither its campaign, the ads strategy nor the account default sets one (Suggestions → Bid Settings)`, output: { adTargetId: id } }
      }
      const targetPct = chosen.targetAcos * 100
      sources.targetAcosPct = chosen.source === 'strategy' && chosen.strategy
        ? strategySource(fractionToPct(chosen.targetAcos), chosen.strategy)
        : { level: chosen.source, value: fractionToPct(chosen.targetAcos), ...(chosen.source === 'explicit' ? { from: "this rule's target" } : {}) }
      if (perf.acos == null) {
        return { type: action.type, ok: false, error: `this target has spend but no attributed sales in the rule's window, so its actual ACoS is undefined — a bid cannot be scaled by it`, output: { adTargetId: id, clicks: perf.clicks } }
      }
      // C3 (2026-10-07) — the goal is CPC × target / ACoS (= target × sales per click), whatever the bid is now; the
      // `targetAcos` op sets it. `curBidTargetAcos` steps from the current bid by H10's ratio, but never past that goal
      // and not at all within GOAL_TOLERANCE of it (or when the goal lies the other way): the window's ACoS barely moves
      // between two firings, so the bare ratio multiplied into the bid again on every firing (ads-bid-goal.ts).
      //
      // Review 2026-10-08 (A, rules) — that goal is a CPC, and Amazon charges less than the bid. The bid that buys it is
      // the CPC ÷ r̂ (paid CPC ÷ the bid that SERVED the window's clicks — ads-bid-window.ts, as auto-bid since #504),
      // with the bid brain's arithmetic (recipe.ts bidForAcos, estimator.ts cpcRatio: 0.6–1.0, 0.85 under 10 clicks).
      // Before, the rule set the CPC itself as the bid: "normal slider auto" at a 44¢ bid paying 62 % of it was cut to
      // 34¢ by this op while auto-bid raised it toward 55¢ — a daily tug-of-war. This changes the rule's named formula
      // from "CPC × target / ACoS" to "CPC × target / ACoS ÷ r̂"; `curBidTargetAcos`'s step (current bid × target / ACoS)
      // is already a bid and is unchanged — only the goal it stops at moves.
      const served = await ruleServingBid(id, t.bidCents ?? 0, perf.days)
      const ratio = cpcRatio({ clicks: perf.clicks, costCents: perf.spendCents }, served.cents)
      const goalEur = bidForAcos(targetPct / 100, 1, perf.salesCents / perf.clicks, ratio) / 100
      paid = { ratio: Math.round(ratio * 100) / 100, servedBidCents: Math.round(served.cents), basis: served.basis, goalCpcCents: Math.round(goalEur * ratio * 100), goalBidCents: Math.round(goalEur * 100) }
      if (action.op === 'curBidTargetAcos') {
        const steppedEur = currentEur * ((targetPct / 100) / perf.acos)
        const towardGoal = (steppedEur < currentEur) === (goalEur < currentEur) && !withinGoal(currentEur * 100, goalEur * 100)
        computedEur = !towardGoal ? currentEur : steppedEur < currentEur ? Math.max(goalEur, steppedEur) : Math.min(goalEur, steppedEur)
      } else {
        computedEur = goalEur
      }
    }
  }

  const rawEur = computedEur ?? applyBuilderOp(action.op as string, currentEur, Number(action.value) || 0)
  // W1-5 — the rule's band and the strategy's both bind: the higher floor and the lower ceiling (where they cross, the
  // ceiling wins — it spends less). The output names the strategy row when it is the one that held the bid.
  const sMin = limits.minBidCents ? limits.minBidCents.value / 100 : null
  const sMax = limits.maxBidCents ? limits.maxBidCents.value / 100 : null
  const ruleOnly = Math.round(clampRange(rawEur, floorEur, ceilEur) * 100) / 100
  const nextEur = Math.round(clampRange(rawEur, Math.max(floorEur, sMin ?? 0), ceilEur != null && sMax != null ? Math.min(ceilEur, sMax) : ceilEur ?? sMax) * 100) / 100
  const nextCents = Math.round(nextEur * 100)
  const heldSide: BidSide | null = nextEur === ruleOnly ? null : nextEur < ruleOnly ? 'max' : 'min'
  const heldLimit = heldSide === 'max' ? limits.maxBidCents : heldSide === 'min' ? limits.minBidCents : null
  const strategyOut = heldSide && heldLimit ? { heldTo: limitWords(heldSide, heldLimit) } : {}
  // 4d (review 4.4) — the spend this write would ADD per day: (new − old) × the target's clicks per day in the rule's
  // window. Returned as `estimatedValueCentsEur`, so the engine's per-run `maxValueCentsEur` binds a bid rule too, and
  // a live raise draws on the rule's daily spend ceiling like a budget raise always has. Clicks are read only for a raise.
  const oldCents = t.bidCents ?? 0
  const raiseWindow = nextCents > oldCents ? (measured ?? await targetClicks(id, trigger, windowDays)) : null
  const spend = bidExtraSpend({ oldBidCents: oldCents, newBidCents: nextCents, clicks: raiseWindow?.clicks ?? 0, windowDays: raiseWindow?.days ?? 1 })
  const spendOut = { extraSpendPerDayCents: spend.extraCentsPerDay, spendEstimate: spend.basis, ...(paid ? { goal: paid } : {}) }
  // Review 2026-10-08 (B, rules) — the target-ACoS ops wait as auto-bid does (ads-bid-window.ts): one move per settled
  // data day, whichever automatic writer moved the keyword first, and no reversal of auto-bid's own move within its wait.
  // Said before the dry run returns, so a preview and a proposal say it too. A person's approval of the change is that
  // person's decision (4e) and is not held back.
  if (TARGET_ACOS_OPS.has(String(action.op)) && nextCents !== oldCents && !meta.operatorApproved) {
    const why = await ruleBidWait(id, oldCents, nextCents)
    if (why) return { type: action.type, ok: true, output: { skipped: 'waits_for_evidence', why, adTargetId: id, bidCents: oldCents, wouldBe: nextCents, ...(paid ? { goal: paid } : {}) } }
  }
  // 5.10 — a dry run that would change nothing says so (as placement and budget do), so a 5¢ → 5¢ card never reaches
  // the suggestion queue. `wouldChange` stays beside it for the preview.
  if (meta.dryRun) return { type: action.type, ok: true, estimatedValueCentsEur: spend.extraCentsPerDay, output: { dryRun: true, adTargetId: id, wouldChange: `${t.bidCents}¢ → ${nextCents}¢`, ...spendOut, ...strategyOut, ...(nextCents === t.bidCents ? { noChange: true } : {}) } }
  if (nextCents === t.bidCents) return { type: action.type, ok: true, output: { adTargetId: id, noChange: true } }
  // Only a raise can spend more; a cut is never stopped by the spend ceiling.
  if (spend.extraCentsPerDay > 0) {
    const cap = await checkDailySpendCap(meta.ruleId, spend.extraCentsPerDay)
    if (!cap.allowed) return { type: action.type, ok: false, error: cap.error, estimatedValueCentsEur: 0, output: { adTargetId: id, bidCents: t.bidCents, wouldBe: nextCents, ...spendOut } }
  }
  const evidence = ctxEvidence(context)
  const res = await updateAdTargetWithSync({
    adTargetId: id, patch: { bidCents: nextCents }, ...ruleWrite(meta, (action.reason as string) ?? `bid_apply via rule ${meta.ruleId}`),
    // W1-5 — which level supplied the target and the strategy limits this bid was held to.
    evidence: Object.keys(sources).length ? { ...(evidence ?? {}), sources } : evidence,
  })
  return { type: action.type, ok: res.ok, error: res.error ?? undefined, estimatedValueCentsEur: spend.extraCentsPerDay, output: { adTargetId: id, newBidCents: nextCents, outboundQueueId: res.outboundQueueId, ...spendOut, ...strategyOut } }
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
  meta: Pick<HandlerMeta, 'ruleId' | 'dryRun' | 'approval'>,
  status: 'PAUSED' | 'ENABLED',
): Promise<ActionResult> {
  const type = String(action.type)
  const id = (action.adTargetId as string | undefined) ?? ctxAdTargetId(action, context)
  if (!id) return { type, ok: false, error: 'No adTarget.id in context' }
  const t = await prisma.adTarget.findUnique({
    where: { id },
    select: { status: true, adGroupId: true, adGroup: { select: { campaignId: true, campaign: { select: { marketplace: true } } } } },
  })
  if (!t) return { type, ok: false, error: 'AdTarget not found' }
  const allow = Array.isArray(action.campaignIds) ? (action.campaignIds as string[]) : []
  if (allow.length && t.adGroup?.campaignId && !allow.includes(t.adGroup.campaignId)) {
    return { type, ok: true, output: { skipped: 'campaign-not-selected', adTargetId: id } }
  }
  // Already there. Reported as a no-change rather than a success, so the action log does not fill
  // with writes that moved nothing — the same contract `bid_apply` uses.
  if (t.status === status) return { type, ok: true, output: { adTargetId: id, noChange: true, status } }
  // W1-7 — a pause is a stop: a protected product's keyword is left alone (a re-enable is not held).
  if (status === 'PAUSED') {
    const held = await protectedStopSkip(type, id, t)
    if (held) return held
  }
  if (meta.dryRun) return { type, ok: true, output: { dryRun: true, adTargetId: id, wouldSet: status, from: t.status } }
  const res = await updateAdTargetWithSync({
    adTargetId: id,
    patch: { status },
    ...ruleWrite(meta, (action.reason as string | undefined) ?? `${type} via rule ${meta.ruleId}`),
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
// current hour (in the rule's timezone) and act on the rule's campaigns for THIS marketplace.
//
// 1f — through BIDS, never campaign status (no automation pauses a campaign). A 'pause' window floors the
// campaign's bids (suppressCampaignBids remembers each bid); an 'enable' window restores them, the same
// mechanism the dayparting cron uses. The restore lifts only a floor THIS rule set (`bidsSuppressedBy`):
// the rank engine, budget stop-over-spend and the retail guard share that flag, and budget enforcement
// follows the same ownership rule for the same reason.
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
  // 2d (review 3.9) — an end of '00:00' is midnight at the end of the day (24), not its start: the builder offers no
  // '24:00', so a window running to midnight never fired. An empty end stays 0 (never active).
  const hhEnd = (t: string) => (String(t ?? '').trim() !== '' && hh(t) === 0 ? 24 : hh(t))
  // active window for the current day+hour (last one wins if overlapping)
  const active = windows.filter((w) => w.day === dow && hh(w.start) <= hour && hour < hhEnd(w.end) && (w.adj === 'enable' || w.adj === 'pause')).pop()
  if (!active) return { type: action.type, ok: true, output: { tz, dow, hour, noActiveWindow: true } }
  // the rule's campaigns in THIS marketplace
  const camps = await prisma.campaign.findMany({
    where: { id: { in: allow.length ? allow : ['__none__'] }, ...(marketplace ? { marketplace } : {}) },
    select: { id: true, name: true, bidsSuppressedAt: true, bidsSuppressedBy: true },
  })
  const actor = RULE_ACTOR(meta.ruleId)
  const floor = active.adj === 'pause'
  // pause → every campaign not floored yet; enable → only the campaigns this rule floored.
  const toChange = camps.filter((c) => floor ? !c.bidsSuppressedAt : !!c.bidsSuppressedAt && c.bidsSuppressedBy === actor)
  if (meta.dryRun) return { type: action.type, ok: true, output: { dryRun: true, tz, dow, hour, action: active.adj, wouldChange: toChange.length, sample: toChange.slice(0, 6).map((c) => c.name) } }
  let changed = 0, bidsMoved = 0; const errors: string[] = []
  for (const c of toChange) {
    try {
      bidsMoved += floor
        ? await suppressCampaignBids(c.id, ruleWrite(meta, `dayparting pause via rule ${meta.ruleId} → bids floored (no-pause)`))
        : await restoreCampaignBids(c.id, ruleWrite(meta, `dayparting enable via rule ${meta.ruleId} → bids restored`))
      changed++
    } catch (e) { errors.push((e as Error).message) }
  }
  return { type: action.type, ok: true, output: { tz, dow, hour, action: active.adj, changed, bidsMoved, errors: errors.slice(0, 5) } }
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

// ── PB-7: isolate_product_terms ───────────────────────────────────────
// Keeps ONE product's own playbook campaigns from bidding against each other (the Owner's rule 3): negatives only inside
// that product's linked slot campaigns in one market, never in a campaign that also advertises another product, never
// over a keyword or a winning search term of the ad group, never a protected term. Compiled per product × market by
// the playbook (ads-playbook/isolation.ts), born off and PROPOSE-capped; the run lives in ads-playbook/isolation-run.ts.
ACTION_HANDLERS.isolate_product_terms = async (action, _context, meta): Promise<ActionResult> => {
  const { runIsolation } = await import('./ads-playbook/isolation-run.js')
  return runIsolation({ action, ruleId: meta.ruleId, dryRun: meta.dryRun, preview: meta.preview, approval: meta.approval })
}
