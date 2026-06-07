/**
 * NP — No-pause bid suppression.
 *
 * The user's study: PAUSING a campaign disrupts Amazon's optimisation algorithm and
 * causes re-learning delays. So the rank engine must NEVER set status=PAUSED. When it
 * would pause (a window's Pause target, out-of-stock, lost buy-box), it instead keeps
 * the campaign ENABLED and drops every bid to the floor (~2¢) — near-0 delivery with
 * no status change. The pre-suppression bid is remembered per row so it is restored
 * EXACTLY on resume.
 *
 * State: AdTarget.suppressedFromBidCents + AdGroup.suppressedFromBidCents hold each
 * prior bid; Campaign.bidsSuppressedAt is the fast "is suppressed" flag (+ idempotency).
 * Writes go through the same gated updateAd*WithSync helpers as every other actuation,
 * with force:true to bypass the 5¢ floor / change-clamp (this is a deliberate,
 * reversible, fully-logged system action — the audit trail records every move).
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { updateAdTargetWithSync, updateAdGroupWithSync, type AdsActor } from './ads-mutation.service.js'
import { deltaBidCents } from './ads-placement-math.js'

export const SUPPRESSION_FLOOR_CENTS = 2

/** Floor every bid in the campaign to ~2¢, remembering each prior bid. Idempotent
 * (no-op if already suppressed). Returns how many entities were moved. */
export async function suppressCampaignBids(
  campaignId: string,
  opts: { actor: AdsActor; reason?: string; applyImmediately?: boolean },
): Promise<number> {
  const camp = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { id: true, bidsSuppressedAt: true } })
  if (!camp || camp.bidsSuppressedAt) return 0 // missing or already suppressed → no-op
  const reason = opts.reason ?? 'no-pause: bids floored instead of pausing'
  const applyImmediately = opts.applyImmediately ?? true
  let touched = 0

  // Ad-group default bids (covers AUTO targeting + the fallback bid).
  const groups = await prisma.adGroup.findMany({
    where: { campaignId, defaultBidCents: { gt: SUPPRESSION_FLOOR_CENTS }, suppressedFromBidCents: null },
    select: { id: true, defaultBidCents: true },
  })
  for (const g of groups) {
    // A1 — save the prior BEFORE flooring (so the floor can never lose it) + isolate each entity.
    try {
      await prisma.adGroup.update({ where: { id: g.id }, data: { suppressedFromBidCents: g.defaultBidCents } })
      const r = await updateAdGroupWithSync({ adGroupId: g.id, patch: { defaultBidCents: SUPPRESSION_FLOOR_CENTS }, actor: opts.actor, reason, applyImmediately, force: true })
      if (r.ok) touched++
    } catch (e) { logger.warn('[no-pause] suppress group threw — skipping', { adGroupId: g.id, error: (e as Error).message }) }
  }

  // Keyword/product/category target bids (never negatives — they carry no spend bid).
  const targets = await prisma.adTarget.findMany({
    where: { adGroup: { campaignId }, isNegative: false, bidCents: { gt: SUPPRESSION_FLOOR_CENTS }, suppressedFromBidCents: null },
    select: { id: true, bidCents: true },
  })
  for (const t of targets) {
    try {
      await prisma.adTarget.update({ where: { id: t.id }, data: { suppressedFromBidCents: t.bidCents } })
      const r = await updateAdTargetWithSync({ adTargetId: t.id, patch: { bidCents: SUPPRESSION_FLOOR_CENTS }, actor: opts.actor, reason, applyImmediately, force: true })
      if (r.ok) touched++
    } catch (e) { logger.warn('[no-pause] suppress target threw — skipping', { adTargetId: t.id, error: (e as Error).message }) }
  }

  await prisma.campaign.update({ where: { id: campaignId }, data: { bidsSuppressedAt: new Date() } })
  logger.info('[no-pause] suppressed campaign bids', { campaignId, groups: groups.length, targets: targets.length, touched })
  return touched
}

/** Restore every remembered bid and clear the suppression flag. Idempotent (no-op if
 * not suppressed). Returns how many entities were restored. */
export async function restoreCampaignBids(
  campaignId: string,
  opts: { actor: AdsActor; reason?: string; applyImmediately?: boolean },
): Promise<number> {
  const camp = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { id: true, bidsSuppressedAt: true } })
  if (!camp || !camp.bidsSuppressedAt) return 0 // not suppressed → no-op
  const reason = opts.reason ?? 'no-pause: restored prior bids on resume'
  const applyImmediately = opts.applyImmediately ?? true
  let touched = 0, failed = 0

  // A1 — RETRY-SAFE restore. The prior bid is the campaign's only memory of what to restore to,
  // so we clear it ONLY when the push is accepted (or the entity is gone), isolate each entity so
  // one failure can't abort the rest, and clear the suppression flag ONLY when every entity is
  // restored. A failed entity keeps its suppressedFromBidCents AND bidsSuppressedAt stays set, so
  // the next serving tick retries it — the prior bid can never be silently lost (the old bug).
  const groups = await prisma.adGroup.findMany({ where: { campaignId, suppressedFromBidCents: { not: null } }, select: { id: true, suppressedFromBidCents: true } })
  for (const g of groups) {
    try {
      const r = await updateAdGroupWithSync({ adGroupId: g.id, patch: { defaultBidCents: g.suppressedFromBidCents as number }, actor: opts.actor, reason, applyImmediately, force: true })
      if (r.ok || r.error === 'not_found') { await prisma.adGroup.update({ where: { id: g.id }, data: { suppressedFromBidCents: null } }); if (r.ok) touched++ }
      else { failed++; logger.warn('[no-pause] restore group not accepted — keeping prior for retry', { adGroupId: g.id, error: r.error }) }
    } catch (e) { failed++; logger.warn('[no-pause] restore group threw — keeping prior for retry', { adGroupId: g.id, error: (e as Error).message }) }
  }

  const targets = await prisma.adTarget.findMany({ where: { adGroup: { campaignId }, suppressedFromBidCents: { not: null } }, select: { id: true, suppressedFromBidCents: true } })
  for (const t of targets) {
    try {
      const r = await updateAdTargetWithSync({ adTargetId: t.id, patch: { bidCents: t.suppressedFromBidCents as number }, actor: opts.actor, reason, applyImmediately, force: true })
      if (r.ok || r.error === 'not_found') { await prisma.adTarget.update({ where: { id: t.id }, data: { suppressedFromBidCents: null } }); if (r.ok) touched++ }
      else { failed++; logger.warn('[no-pause] restore target not accepted — keeping prior for retry', { adTargetId: t.id, error: r.error }) }
    } catch (e) { failed++; logger.warn('[no-pause] restore target threw — keeping prior for retry', { adTargetId: t.id, error: (e as Error).message }) }
  }

  if (failed === 0) await prisma.campaign.update({ where: { id: campaignId }, data: { bidsSuppressedAt: null } })
  else logger.warn('[no-pause] restore incomplete — bidsSuppressedAt kept set; next serving tick retries', { campaignId, failed, touched })
  logger.info('[no-pause] restored campaign bids', { campaignId, groups: groups.length, targets: targets.length, touched, failed })
  return touched
}

// BL.7 — base-bid deltaPct: scale every ad-group default + keyword bid by ±% from a STABLE
// remembered baseline (baseBidFromCents), so repeated ticks NEVER compound and a changed
// delta re-applies cleanly from the baseline. Independent of suppress/restore (different
// memory field), so the two compose. force:true lands the exact computed bid (deltaBidCents
// already floors at 2¢). Idempotent. Returns entities moved.
export async function applyBaseBidDelta(
  campaignId: string, deltaPct: number,
  opts: { actor: AdsActor; reason?: string; applyImmediately?: boolean },
): Promise<number> {
  const reason = opts.reason ?? `rank base-bid ${deltaPct >= 0 ? '+' : ''}${deltaPct}%`
  const applyImmediately = opts.applyImmediately ?? true
  let touched = 0
  const groups = await prisma.adGroup.findMany({ where: { campaignId }, select: { id: true, defaultBidCents: true, baseBidFromCents: true } })
  for (const g of groups) {
    const baseline = g.baseBidFromCents ?? g.defaultBidCents // stable baseline → no compounding
    const want = deltaBidCents(baseline, deltaPct)
    if (g.baseBidFromCents != null && g.defaultBidCents === want) continue // already at target
    try {
      if (g.baseBidFromCents == null) await prisma.adGroup.update({ where: { id: g.id }, data: { baseBidFromCents: baseline } })
      const r = await updateAdGroupWithSync({ adGroupId: g.id, patch: { defaultBidCents: want }, actor: opts.actor, reason, applyImmediately, force: true })
      if (r.ok) touched++
    } catch (e) { logger.warn('[base-bid] delta group failed', { adGroupId: g.id, error: (e as Error).message }) }
  }
  const targets = await prisma.adTarget.findMany({ where: { adGroup: { campaignId }, isNegative: false }, select: { id: true, bidCents: true, baseBidFromCents: true } })
  for (const t of targets) {
    const baseline = t.baseBidFromCents ?? t.bidCents
    const want = deltaBidCents(baseline, deltaPct)
    if (t.baseBidFromCents != null && t.bidCents === want) continue
    try {
      if (t.baseBidFromCents == null) await prisma.adTarget.update({ where: { id: t.id }, data: { baseBidFromCents: baseline } })
      const r = await updateAdTargetWithSync({ adTargetId: t.id, patch: { bidCents: want }, actor: opts.actor, reason, applyImmediately, force: true })
      if (r.ok) touched++
    } catch (e) { logger.warn('[base-bid] delta target failed', { adTargetId: t.id, error: (e as Error).message }) }
  }
  if (touched) logger.info('[base-bid] applied delta', { campaignId, deltaPct, touched })
  return touched
}

// BL.7 — revert a base-bid delta: restore each entity to its remembered baseline + clear it.
// Retry-safe like restoreCampaignBids (clears memory only on accepted push / not_found).
export async function revertBaseBidDelta(
  campaignId: string,
  opts: { actor: AdsActor; reason?: string; applyImmediately?: boolean },
): Promise<number> {
  const reason = opts.reason ?? 'rank base-bid delta cleared → restore baseline'
  const applyImmediately = opts.applyImmediately ?? true
  let touched = 0
  const groups = await prisma.adGroup.findMany({ where: { campaignId, baseBidFromCents: { not: null } }, select: { id: true, baseBidFromCents: true } })
  for (const g of groups) {
    try {
      const r = await updateAdGroupWithSync({ adGroupId: g.id, patch: { defaultBidCents: g.baseBidFromCents as number }, actor: opts.actor, reason, applyImmediately, force: true })
      if (r.ok || r.error === 'not_found') { await prisma.adGroup.update({ where: { id: g.id }, data: { baseBidFromCents: null } }); if (r.ok) touched++ }
    } catch (e) { logger.warn('[base-bid] revert group failed', { adGroupId: g.id, error: (e as Error).message }) }
  }
  const targets = await prisma.adTarget.findMany({ where: { adGroup: { campaignId }, baseBidFromCents: { not: null } }, select: { id: true, baseBidFromCents: true } })
  for (const t of targets) {
    try {
      const r = await updateAdTargetWithSync({ adTargetId: t.id, patch: { bidCents: t.baseBidFromCents as number }, actor: opts.actor, reason, applyImmediately, force: true })
      if (r.ok || r.error === 'not_found') { await prisma.adTarget.update({ where: { id: t.id }, data: { baseBidFromCents: null } }); if (r.ok) touched++ }
    } catch (e) { logger.warn('[base-bid] revert target failed', { adTargetId: t.id, error: (e as Error).message }) }
  }
  if (touched) logger.info('[base-bid] reverted delta', { campaignId, touched })
  return touched
}
