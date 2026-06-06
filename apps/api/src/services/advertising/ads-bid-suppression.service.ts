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
    await prisma.adGroup.update({ where: { id: g.id }, data: { suppressedFromBidCents: g.defaultBidCents } })
    const r = await updateAdGroupWithSync({ adGroupId: g.id, patch: { defaultBidCents: SUPPRESSION_FLOOR_CENTS }, actor: opts.actor, reason, applyImmediately, force: true })
    if (r.ok) touched++
  }

  // Keyword/product/category target bids (never negatives — they carry no spend bid).
  const targets = await prisma.adTarget.findMany({
    where: { adGroup: { campaignId }, isNegative: false, bidCents: { gt: SUPPRESSION_FLOOR_CENTS }, suppressedFromBidCents: null },
    select: { id: true, bidCents: true },
  })
  for (const t of targets) {
    await prisma.adTarget.update({ where: { id: t.id }, data: { suppressedFromBidCents: t.bidCents } })
    const r = await updateAdTargetWithSync({ adTargetId: t.id, patch: { bidCents: SUPPRESSION_FLOOR_CENTS }, actor: opts.actor, reason, applyImmediately, force: true })
    if (r.ok) touched++
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
  let touched = 0

  const groups = await prisma.adGroup.findMany({ where: { campaignId, suppressedFromBidCents: { not: null } }, select: { id: true, suppressedFromBidCents: true } })
  for (const g of groups) {
    const prior = g.suppressedFromBidCents as number
    const r = await updateAdGroupWithSync({ adGroupId: g.id, patch: { defaultBidCents: prior }, actor: opts.actor, reason, applyImmediately, force: true })
    await prisma.adGroup.update({ where: { id: g.id }, data: { suppressedFromBidCents: null } })
    if (r.ok) touched++
  }

  const targets = await prisma.adTarget.findMany({ where: { adGroup: { campaignId }, suppressedFromBidCents: { not: null } }, select: { id: true, suppressedFromBidCents: true } })
  for (const t of targets) {
    const prior = t.suppressedFromBidCents as number
    const r = await updateAdTargetWithSync({ adTargetId: t.id, patch: { bidCents: prior }, actor: opts.actor, reason, applyImmediately, force: true })
    await prisma.adTarget.update({ where: { id: t.id }, data: { suppressedFromBidCents: null } })
    if (r.ok) touched++
  }

  await prisma.campaign.update({ where: { id: campaignId }, data: { bidsSuppressedAt: null } })
  logger.info('[no-pause] restored campaign bids', { campaignId, groups: groups.length, targets: targets.length, touched })
  return touched
}
