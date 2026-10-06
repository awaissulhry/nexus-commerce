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
 *
 * ADS AUTONOMY W1-6b — an AD GROUP can be floored on its own (a product over its own monthly cap):
 * `suppressAdGroupBids` / `restoreAdGroupBids`, with the same memory on its default bid and targets
 * and its own owner (`AdGroup.bidsSuppressedAt` / `bidsSuppressedBy`). Ownership is kept both ways:
 * a campaign's restore, re-floor and base-bid move (any engine, or a person's restore) leave such an
 * ad group alone; and the ad group's owner, inside a campaign floored by anyone, only hands its
 * memory over to that campaign floor (whoever lifts the campaign floor puts the bids back).
 *
 * ADS AUTONOMY W3-3 — `lowerAdGroupBids` floors ONE ad group whose every product is out of stock, with the same memory
 * and ownership; `restoreAdGroupBids` gives it back. Never a pause, never a stock quantity. (A short ad group's step down
 * is a plain bid lowering with no floor markers, so every stop here still floors it: ads-stock.tools.ts.)
 *
 * PB-5b — a playbook START gives a build's planned bids back with `restoreCampaignBids(…, { planned })`: never above
 * the bid remembered, and a bid that left the floor since stays where it is (plannedGiveBack). Its STOP floors them again.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { updateAdTargetWithSync, updateAdGroupWithSync, type AdsActor } from './ads-mutation.service.js'
import type { AdWriteEvidence } from './ads-evidence.js'
import { deltaBidCents } from './ads-placement-math.js'
import { effectiveBidBounds, withStrategyBand, type BidBound } from './ads-write-gate.js'
import { NO_LIMITS, bidSideWords, clampBid, clampToStrategy, limitWords, strategyBidReader, strategyWords, type BidHoldLog, type StrategyBidLimits } from './ads-strategy/bids.js'

/**
 * ADS AUTONOMY W1-5 — the bounds a give-back (a restore after a stop, a base-bid revert) is held to, per ad group: the
 * campaign's own bid bounds, the bid policies and the ads strategy band of the ad group's products — whoever restores
 * (an engine, a rule, a person's Restore click or a Claude request he approved: a restore puts back what was, inside the
 * limits in force today, rather than waiting for a confirmation). Read once per campaign, only when there is something
 * to give back.
 */
export async function giveBackBounds(campaignId: string, adGroupIds: string[]): Promise<(adGroupId: string) => { max: BidBound | null; min: BidBound | null }> {
  const camp = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { marketplace: true, portfolioId: true, minBidCents: true, maxBidCents: true, minBudgetCents: true, maxBudgetCents: true },
  })
  if (!camp) return () => ({ max: null, min: null })
  const base = await effectiveBidBounds({ campaignId, campaign: camp, strategy: NO_LIMITS })
  const strategy = !adGroupIds.length
    ? new Map<string, { limits: StrategyBidLimits }>()
    : await strategyBidReader().forAdGroups([...new Set(adGroupIds)].map((adGroupId) => ({ adGroupId, marketplace: camp.marketplace })))
  return (adGroupId) => withStrategyBand(base, strategy.get(adGroupId)?.limits ?? NO_LIMITS)
}

/**
 * W1-5 — the silent stop, fixed. A give-back is a forced RAISE, and the write gate refuses a raise above the highest bid
 * (or below the lowest) that binds it: the bid then stayed at the stop's 2¢ and nobody was told. It now goes back to
 * the remembered bid held inside those bounds — min(remembered, highest bid), and up to the lowest bid — and the
 * reason (and the run's `holds`) says so.
 */
function heldGiveBack(
  remembered: number, current: number, bounds: { max: BidBound | null; min: BidBound | null }, reason: string, holds: BidHoldLog | undefined,
): { cents: number; reason: string } {
  const c = clampBid(remembered, bounds, { currentCents: current, forced: true })
  if (!c.held) return { cents: remembered, reason }
  holds?.holds.push({ kind: 'restore', side: c.held.side, source: c.held.limit.source, wantedCents: remembered, writtenCents: c.cents })
  return { cents: c.cents, reason: `${reason} — put back at ${c.cents}¢, not the remembered ${remembered}¢: the ${bidSideWords(c.held.side)} (${c.held.limit.source})` }
}

/**
 * PB-5b — a playbook START's give-back of one remembered (planned) bid, decided once for its preview and its run. A bid
 * still at the floor goes back to the bid remembered, held inside the bounds that bind it (as heldGiveBack) but never
 * ABOVE it: a lowest bid that binds puts back the remembered bid, no more. A bid that left the floor since it was floored
 * (an engine or a person set it) is `left` as it stands. Pure.
 */
export function plannedGiveBack(
  remembered: number, current: number, floorCents: number, bounds: { max: BidBound | null; min: BidBound | null },
): { left: true } | { cents: number; heldBy: string | null } {
  if (current !== floorCents) return { left: true }
  const c = clampBid(remembered, bounds, { currentCents: current, forced: true })
  if (!c.held || c.cents > remembered) return { cents: Math.min(c.cents, remembered), heldBy: null }
  return { cents: c.cents, heldBy: `the ${bidSideWords(c.held.side)} (${c.held.limit.source})` }
}

export const SUPPRESSION_FLOOR_CENTS = 2
// MB.1 — Amazon's own SP minimum bid is 2¢, and a floor of €100 is past any plausible
// keyword bid, so a value outside this range is a typo rather than an intention. Clamped
// (not rejected) because refusing here would leave a Min-bid window holding the PREVIOUS
// target's bids — failing open on spend is the worse of the two failures.
const FLOOR_MIN_CENTS = SUPPRESSION_FLOOR_CENTS
const FLOOR_MAX_CENTS = 10_000
/** MB.1 — the effective floor for a requested value. null/absent → the legacy 2¢. */
export function normaliseFloorCents(cents: number | null | undefined): number {
  if (cents == null || !Number.isFinite(cents)) return SUPPRESSION_FLOOR_CENTS
  return Math.max(FLOOR_MIN_CENTS, Math.min(FLOOR_MAX_CENTS, Math.round(cents)))
}

/**
 * MB.1 — where one entity's bid belongs when an already-suppressed campaign moves to a new
 * floor. Pure and exported because the whole safety of re-flooring rests on one rule that is
 * far easier to state than to re-derive while reading a database loop: a floored bid may
 * move to the new floor, but NEVER above the bid it had before suppression. Raising past
 * `remembered` would spend more inside a Min-bid window than the campaign spent when it was
 * serving normally — which no reading of "Min bid" permits.
 *
 * `remembered` null = an entity that appeared after suppression (a keyword added mid-window)
 * and therefore has no pre-suppression bid to be bounded by; it simply takes the floor.
 */
export function refloorBidCents(floorCents: number, remembered: number | null): number {
  return remembered != null ? Math.min(floorCents, remembered) : floorCents
}

/** Floor every bid in the campaign to ~2¢ (or `floorCents`), remembering each prior bid.
 * Idempotent (no-op if already suppressed). Returns how many entities were moved.
 *
 * MB.1 — `floorCents` defaults to the legacy constant, so every existing caller
 * (dayparting, retail-readiness, budget-enforce, blueprint-apply) is unchanged. The floor
 * only ever moves a bid DOWN: selection is `> floorCents`, so a bid already at or below it
 * is left alone rather than raised to meet it. */
export async function suppressCampaignBids(
  campaignId: string,
  // MCP full control A8 — `changeSetId` (optional) tags every write with an approved request's id; absent for every
  // existing caller, which behaves exactly as before. ADS AUTONOMY W3-1 — `evidence` (optional) goes on every write's
  // audit row (the recommendation the stop carries out); absent, nothing changes.
  // PB-5b — `manual` (optional): a person approved it (a playbook STOP he approved): his writes pass the allowlist like
  // his other edits (isPersonEdit). Absent for every existing caller.
  opts: { actor: AdsActor; reason?: string; applyImmediately?: boolean; floorCents?: number | null; changeSetId?: string | null; evidence?: AdWriteEvidence | null; manual?: boolean },
): Promise<number> {
  const camp = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { id: true, bidsSuppressedAt: true } })
  if (!camp || camp.bidsSuppressedAt) return 0 // missing or already suppressed → no-op
  const floor = normaliseFloorCents(opts.floorCents)
  const reason = opts.reason ?? 'no-pause: bids floored instead of pausing'
  const applyImmediately = opts.applyImmediately ?? true
  let touched = 0

  // Ad-group default bids (covers AUTO targeting + the fallback bid).
  const groups = await prisma.adGroup.findMany({
    where: { campaignId, defaultBidCents: { gt: floor }, suppressedFromBidCents: null },
    select: { id: true, defaultBidCents: true },
  })
  for (const g of groups) {
    // A1 — save the prior BEFORE flooring (so the floor can never lose it) + isolate each entity.
    try {
      await prisma.adGroup.update({ where: { id: g.id }, data: { suppressedFromBidCents: g.defaultBidCents } })
      const r = await updateAdGroupWithSync({ adGroupId: g.id, patch: { defaultBidCents: floor }, actor: opts.actor, reason, applyImmediately, force: true, changeSetId: opts.changeSetId ?? null, ...(opts.evidence ? { evidence: opts.evidence } : {}), ...(opts.manual ? { manual: true } : {}) })
      if (r.ok) touched++
    } catch (e) { logger.warn('[no-pause] suppress group threw — skipping', { adGroupId: g.id, error: (e as Error).message }) }
  }

  // Keyword/product/category target bids (never negatives — they carry no spend bid).
  const targets = await prisma.adTarget.findMany({
    where: { adGroup: { campaignId }, isNegative: false, bidCents: { gt: floor }, suppressedFromBidCents: null },
    select: { id: true, bidCents: true },
  })
  for (const t of targets) {
    try {
      await prisma.adTarget.update({ where: { id: t.id }, data: { suppressedFromBidCents: t.bidCents } })
      const r = await updateAdTargetWithSync({ adTargetId: t.id, patch: { bidCents: floor }, actor: opts.actor, reason, applyImmediately, force: true, changeSetId: opts.changeSetId ?? null, ...(opts.evidence ? { evidence: opts.evidence } : {}), ...(opts.manual ? { manual: true } : {}) })
      if (r.ok) touched++
    } catch (e) { logger.warn('[no-pause] suppress target threw — skipping', { adTargetId: t.id, error: (e as Error).message }) }
  }

  await prisma.campaign.update({ where: { id: campaignId }, data: { bidsSuppressedAt: new Date(), bidsSuppressedFloorCents: floor, bidsSuppressedBy: opts.actor } })
  logger.info('[no-pause] suppressed campaign bids', { campaignId, floor, groups: groups.length, targets: targets.length, touched })
  return touched
}

/**
 * MB.1 — move an ALREADY-suppressed campaign to a different floor.
 *
 * Two Min-bid windows can want different floors back-to-back (paint "Min bid" 02–06 and a
 * 5¢ variant 06–09). suppressCampaignBids is deliberately idempotent — it returns 0 the
 * moment `bidsSuppressedAt` is set — so without this the second window would silently keep
 * the first window's floor for as long as the campaign stayed suppressed.
 *
 * Two invariants make this safe to run every tick:
 *  · `suppressedFromBidCents` is NEVER written here. It is the campaign's only memory of
 *    what to restore to, and re-flooring must not be able to overwrite it with a floor.
 *  · A bid never goes ABOVE its remembered original: the target is min(floor, remembered).
 *    Raising the floor above the pre-suppression bid would spend more than the operator was
 *    spending before Min bid was ever painted, which no reading of "Min bid" permits.
 *
 * Entities that appeared since suppression (a keyword added mid-window) have no memory yet,
 * so they are remembered and floored here too — otherwise they would keep serving at full
 * bid inside a Min-bid window. Returns how many entities moved.
 */
export async function refloorCampaignBids(
  campaignId: string,
  opts: { actor: AdsActor; reason?: string; applyImmediately?: boolean; floorCents?: number | null },
): Promise<number> {
  const camp = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { id: true, bidsSuppressedAt: true, bidsSuppressedFloorCents: true } })
  if (!camp?.bidsSuppressedAt) return 0 // not suppressed → suppressCampaignBids owns this
  const floor = normaliseFloorCents(opts.floorCents)
  const current = camp.bidsSuppressedFloorCents ?? SUPPRESSION_FLOOR_CENTS // null = pre-MB.1 row, floored at 2¢
  const reason = opts.reason ?? `no-pause: floor moved ${(current / 100).toFixed(2)} → ${(floor / 100).toFixed(2)}`
  const applyImmediately = opts.applyImmediately ?? true
  let touched = 0

  // W1-6b — an ad group floored on its own keeps its own floor: its owner moves it, never this campaign floor.
  const groups = await prisma.adGroup.findMany({
    where: { campaignId, bidsSuppressedAt: null, OR: [{ suppressedFromBidCents: { not: null } }, { defaultBidCents: { gt: floor } }] },
    select: { id: true, defaultBidCents: true, suppressedFromBidCents: true },
  })
  for (const g of groups) {
    const want = refloorBidCents(floor, g.suppressedFromBidCents)
    if (g.defaultBidCents === want) continue
    try {
      // Remember first, and only for an entity with no memory yet — an existing memory is
      // the pre-suppression bid and must survive every re-floor.
      if (g.suppressedFromBidCents == null) await prisma.adGroup.update({ where: { id: g.id }, data: { suppressedFromBidCents: g.defaultBidCents } })
      const r = await updateAdGroupWithSync({ adGroupId: g.id, patch: { defaultBidCents: want }, actor: opts.actor, reason, applyImmediately, force: true })
      if (r.ok) touched++
    } catch (e) { logger.warn('[no-pause] refloor group threw — skipping', { adGroupId: g.id, error: (e as Error).message }) }
  }

  const targets = await prisma.adTarget.findMany({
    where: { adGroup: { campaignId, bidsSuppressedAt: null }, isNegative: false, OR: [{ suppressedFromBidCents: { not: null } }, { bidCents: { gt: floor } }] },
    select: { id: true, bidCents: true, suppressedFromBidCents: true },
  })
  for (const t of targets) {
    const want = refloorBidCents(floor, t.suppressedFromBidCents)
    if (t.bidCents === want) continue
    try {
      if (t.suppressedFromBidCents == null) await prisma.adTarget.update({ where: { id: t.id }, data: { suppressedFromBidCents: t.bidCents } })
      const r = await updateAdTargetWithSync({ adTargetId: t.id, patch: { bidCents: want }, actor: opts.actor, reason, applyImmediately, force: true })
      if (r.ok) touched++
    } catch (e) { logger.warn('[no-pause] refloor target threw — skipping', { adTargetId: t.id, error: (e as Error).message }) }
  }

  // Stamped even when nothing moved: every bid already sitting at or under the new floor is
  // a legitimate outcome, and recording it stops the next tick re-running the same scan.
  if (current !== floor) await prisma.campaign.update({ where: { id: campaignId }, data: { bidsSuppressedFloorCents: floor } })
  if (touched) logger.info('[no-pause] re-floored campaign bids', { campaignId, from: current, to: floor, touched })
  return touched
}

/**
 * W1-5 — the bid each remembered target goes back to on a restore, read only and decided as restoreCampaignBids decides
 * it (giveBackBounds + the same clamp): the restore-campaign preview shows these, so what is approved is what lands.
 * `heldBy` names the limit when it is not the remembered bid.
 */
export async function restoreBidsFor(
  campaignId: string,
  targets: ReadonlyArray<{ id: string; adGroupId: string; bidCents: number; suppressedFromBidCents: number }>,
): Promise<Map<string, { cents: number; heldBy: string | null }>> {
  if (!targets.length) return new Map()
  const boundsOf = await giveBackBounds(campaignId, targets.map((t) => t.adGroupId))
  return new Map(targets.map((t) => {
    const c = clampBid(t.suppressedFromBidCents, boundsOf(t.adGroupId), { currentCents: t.bidCents, forced: true })
    return [t.id, { cents: c.cents, heldBy: c.held ? `the ${bidSideWords(c.held.side)} (${c.held.limit.source})` : null }]
  }))
}

/** Restore every remembered bid and clear the suppression flag. Idempotent (no-op if
 * not suppressed). Returns how many entities were restored.
 * 1e (CM-9) — "remembered" includes a bid a person set while the floor held: his edit replaces the
 * memory (ads-mutation.service.ts, keepPersonBidThroughRestore), so this puts back HIS bid. */
export async function restoreCampaignBids(
  campaignId: string,
  // MCP full control A8 — `changeSetId` as in suppressCampaignBids: optional, additive.
  // 1e — `manual`: a person clicked Restore (the Budget Manager control plane): it passes the halt and autonomy OFF
  // like his other edits (isPersonEdit). Engines never set it, so their restores still wait for Resume (S1).
  // W1-5 — `holds`: a run's collector for the restores a bound held below (or above) the remembered bid (its run line).
  // PB-5b — `planned` (a playbook START): each bid goes back as plannedGiveBack decides — never above the bid remembered,
  // and one that left the floor since (`floorCents`: the floor the campaign was put at) stays as it is, its memory
  // dropped, and is listed in `left`. Absent for every existing caller.
  opts: {
    actor: AdsActor; reason?: string; applyImmediately?: boolean; changeSetId?: string | null; manual?: boolean; holds?: BidHoldLog
    planned?: { floorCents: number; left: Array<{ kind: 'adGroup' | 'target'; id: string; bidCents: number; rememberedCents: number }> }
  },
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
  // W1-6b — an ad group floored on its own (a product over its own cap) stays floored: only its owner lifts it.
  const groups = await prisma.adGroup.findMany({ where: { campaignId, bidsSuppressedAt: null, suppressedFromBidCents: { not: null } }, select: { id: true, suppressedFromBidCents: true, defaultBidCents: true } })
  const targets = await prisma.adTarget.findMany({ where: { adGroup: { campaignId, bidsSuppressedAt: null }, suppressedFromBidCents: { not: null } }, select: { id: true, suppressedFromBidCents: true, bidCents: true, adGroupId: true } })
  // W1-5 — held inside the bounds that bind this write (heldGiveBack): never refused into a silent stop.
  const boundsOf = groups.length || targets.length
    ? await giveBackBounds(campaignId, [...groups.map((g) => g.id), ...targets.map((t) => t.adGroupId)])
    : null
  // PB-5b — a START's give-back (plannedGiveBack); null: the bid left the floor since, and stays as it is.
  const givenBack = (remembered: number, current: number, bounds: { max: BidBound | null; min: BidBound | null }) => {
    if (!opts.planned) return heldGiveBack(remembered, current, bounds, reason, opts.holds)
    const p = plannedGiveBack(remembered, current, opts.planned.floorCents, bounds)
    if ('left' in p) return null
    return { cents: p.cents, reason: p.heldBy ? `${reason} — put back at ${p.cents}¢, not the planned ${remembered}¢: ${p.heldBy}` : reason }
  }
  for (const g of groups) {
    try {
      const back = givenBack(g.suppressedFromBidCents as number, g.defaultBidCents, boundsOf!(g.id))
      if (!back) {
        await prisma.adGroup.update({ where: { id: g.id }, data: { suppressedFromBidCents: null } })
        opts.planned!.left.push({ kind: 'adGroup', id: g.id, bidCents: g.defaultBidCents, rememberedCents: g.suppressedFromBidCents as number })
        continue
      }
      const r = await updateAdGroupWithSync({ adGroupId: g.id, patch: { defaultBidCents: back.cents }, actor: opts.actor, reason: back.reason, applyImmediately, force: true, changeSetId: opts.changeSetId ?? null, manual: opts.manual })
      if (r.ok || r.error === 'not_found') { await prisma.adGroup.update({ where: { id: g.id }, data: { suppressedFromBidCents: null } }); if (r.ok) touched++ }
      else { failed++; logger.warn('[no-pause] restore group not accepted — keeping prior for retry', { adGroupId: g.id, error: r.error }) }
    } catch (e) { failed++; logger.warn('[no-pause] restore group threw — keeping prior for retry', { adGroupId: g.id, error: (e as Error).message }) }
  }

  for (const t of targets) {
    try {
      const back = givenBack(t.suppressedFromBidCents as number, t.bidCents, boundsOf!(t.adGroupId))
      if (!back) {
        await prisma.adTarget.update({ where: { id: t.id }, data: { suppressedFromBidCents: null } })
        opts.planned!.left.push({ kind: 'target', id: t.id, bidCents: t.bidCents, rememberedCents: t.suppressedFromBidCents as number })
        continue
      }
      const r = await updateAdTargetWithSync({ adTargetId: t.id, patch: { bidCents: back.cents }, actor: opts.actor, reason: back.reason, applyImmediately, force: true, changeSetId: opts.changeSetId ?? null, manual: opts.manual })
      if (r.ok || r.error === 'not_found') { await prisma.adTarget.update({ where: { id: t.id }, data: { suppressedFromBidCents: null } }); if (r.ok) touched++ }
      else { failed++; logger.warn('[no-pause] restore target not accepted — keeping prior for retry', { adTargetId: t.id, error: r.error }) }
    } catch (e) { failed++; logger.warn('[no-pause] restore target threw — keeping prior for retry', { adTargetId: t.id, error: (e as Error).message }) }
  }

  // MB.1 — the floor stamp is cleared with the flag it belongs to. Leaving it set would
  // make the next suppression look like it was already at that floor and skip the re-floor.
  if (failed === 0) await prisma.campaign.update({ where: { id: campaignId }, data: { bidsSuppressedAt: null, bidsSuppressedFloorCents: null, bidsSuppressedBy: null } })
  else logger.warn('[no-pause] restore incomplete — bidsSuppressedAt kept set; next serving tick retries', { campaignId, failed, touched })
  logger.info('[no-pause] restored campaign bids', { campaignId, groups: groups.length, targets: targets.length, touched, failed })
  return touched
}

/**
 * ADS AUTONOMY W1-6b — floor ONE ad group on its own (a product of it over its own monthly cap): its default bid and
 * every target bid above the floor go to `floorCents` (else 2¢), each prior bid remembered, exactly as a campaign floor
 * does; the ad group carries its own owner (`bidsSuppressedBy`). Inside a campaign already floored, the bids are
 * already floored and remembered: only what is not (a keyword added since) moves, and the ownership is stamped, so the
 * campaign's restore leaves this ad group floored. Idempotent (no-op if already floored on its own). Returns how many
 * entities moved.
 */
export async function suppressAdGroupBids(
  adGroupId: string,
  opts: { actor: AdsActor; reason?: string; applyImmediately?: boolean; floorCents?: number | null },
): Promise<number> {
  const group = await prisma.adGroup.findUnique({ where: { id: adGroupId }, select: { id: true, defaultBidCents: true, suppressedFromBidCents: true, bidsSuppressedAt: true } })
  if (!group || group.bidsSuppressedAt) return 0
  const floor = normaliseFloorCents(opts.floorCents)
  const reason = opts.reason ?? 'no-pause: ad group bids floored instead of pausing'
  const applyImmediately = opts.applyImmediately ?? true
  let touched = 0
  if (group.defaultBidCents > floor && group.suppressedFromBidCents == null) {
    try {
      await prisma.adGroup.update({ where: { id: group.id }, data: { suppressedFromBidCents: group.defaultBidCents } })
      const r = await updateAdGroupWithSync({ adGroupId: group.id, patch: { defaultBidCents: floor }, actor: opts.actor, reason, applyImmediately, force: true })
      if (r.ok) touched++
    } catch (e) { logger.warn('[no-pause] suppress ad group default threw — skipping', { adGroupId, error: (e as Error).message }) }
  }
  const targets = await prisma.adTarget.findMany({
    where: { adGroupId, isNegative: false, bidCents: { gt: floor }, suppressedFromBidCents: null },
    select: { id: true, bidCents: true },
  })
  for (const t of targets) {
    try {
      await prisma.adTarget.update({ where: { id: t.id }, data: { suppressedFromBidCents: t.bidCents } })
      const r = await updateAdTargetWithSync({ adTargetId: t.id, patch: { bidCents: floor }, actor: opts.actor, reason, applyImmediately, force: true })
      if (r.ok) touched++
    } catch (e) { logger.warn('[no-pause] suppress ad group target threw — skipping', { adTargetId: t.id, error: (e as Error).message }) }
  }
  await prisma.adGroup.update({ where: { id: group.id }, data: { bidsSuppressedAt: new Date(), bidsSuppressedFloorCents: floor, bidsSuppressedBy: opts.actor } })
  logger.info('[no-pause] suppressed ad group bids', { adGroupId, floor, targets: targets.length, touched })
  return touched
}

/**
 * ADS AUTONOMY W1-6b — lift an ad group's OWN floor (its owner calls this; a campaign restore never does). Retry-safe
 * like restoreCampaignBids: a memory is cleared only once its bid is accepted, and the ownership only once every bid is
 * back. Inside a campaign floored by anyone, nothing is written: the ownership is handed over to that campaign floor,
 * the memory kept, so whoever lifts the campaign floor puts these bids back too — this owner never lifts another's
 * floor. Returns how many entities were restored.
 */
export async function restoreAdGroupBids(
  adGroupId: string,
  // W1-5 — `holds` as in restoreCampaignBids. ADS AUTONOMY W3-3 — `changeSetId` and `manual` as in restoreCampaignBids
  // (an approved Claude request: its change set, and a person's approval as his own click); optional, additive.
  opts: { actor: AdsActor; reason?: string; applyImmediately?: boolean; holds?: BidHoldLog; changeSetId?: string | null; manual?: boolean },
): Promise<number> {
  const group = await prisma.adGroup.findUnique({ where: { id: adGroupId }, select: { id: true, campaignId: true, defaultBidCents: true, suppressedFromBidCents: true, bidsSuppressedAt: true, campaign: { select: { bidsSuppressedAt: true } } } })
  if (!group?.bidsSuppressedAt) return 0
  const handOver = () => prisma.adGroup.update({ where: { id: group.id }, data: { bidsSuppressedAt: null, bidsSuppressedFloorCents: null, bidsSuppressedBy: null } })
  if (group.campaign?.bidsSuppressedAt) {
    await handOver()
    logger.info('[no-pause] ad group floor handed over to its campaign floor — the campaign restore puts its bids back', { adGroupId })
    return 0
  }
  const reason = opts.reason ?? 'no-pause: restored the ad group\'s prior bids'
  const applyImmediately = opts.applyImmediately ?? true
  let touched = 0, failed = 0
  const targets = await prisma.adTarget.findMany({ where: { adGroupId, suppressedFromBidCents: { not: null } }, select: { id: true, suppressedFromBidCents: true, bidCents: true } })
  // W1-5 — held inside the bounds that bind this write (heldGiveBack), as a campaign restore: never a silent stop.
  const bounds = (await giveBackBounds(group.campaignId, [group.id]))(group.id)
  if (group.suppressedFromBidCents != null) {
    try {
      const back = heldGiveBack(group.suppressedFromBidCents, group.defaultBidCents, bounds, reason, opts.holds)
      const r = await updateAdGroupWithSync({ adGroupId: group.id, patch: { defaultBidCents: back.cents }, actor: opts.actor, reason: back.reason, applyImmediately, force: true, changeSetId: opts.changeSetId ?? null, manual: opts.manual })
      if (r.ok || r.error === 'not_found') { await prisma.adGroup.update({ where: { id: group.id }, data: { suppressedFromBidCents: null } }); if (r.ok) touched++ }
      else { failed++; logger.warn('[no-pause] restore ad group default not accepted — keeping prior for retry', { adGroupId, error: r.error }) }
    } catch (e) { failed++; logger.warn('[no-pause] restore ad group default threw — keeping prior for retry', { adGroupId, error: (e as Error).message }) }
  }
  for (const t of targets) {
    try {
      const back = heldGiveBack(t.suppressedFromBidCents as number, t.bidCents, bounds, reason, opts.holds)
      const r = await updateAdTargetWithSync({ adTargetId: t.id, patch: { bidCents: back.cents }, actor: opts.actor, reason: back.reason, applyImmediately, force: true, changeSetId: opts.changeSetId ?? null, manual: opts.manual })
      if (r.ok || r.error === 'not_found') { await prisma.adTarget.update({ where: { id: t.id }, data: { suppressedFromBidCents: null } }); if (r.ok) touched++ }
      else { failed++; logger.warn('[no-pause] restore ad group target not accepted — keeping prior for retry', { adTargetId: t.id, error: r.error }) }
    } catch (e) { failed++; logger.warn('[no-pause] restore ad group target threw — keeping prior for retry', { adTargetId: t.id, error: (e as Error).message }) }
  }
  if (failed === 0) await handOver()
  else logger.warn('[no-pause] ad group restore incomplete — its floor stays owned; the next run retries', { adGroupId, failed, touched })
  logger.info('[no-pause] restored ad group bids', { adGroupId, targets: targets.length, touched, failed })
  return touched
}

/**
 * ADS AUTONOMY W3-3 — floor ONE ad group whose every product is out of stock (Claude's lower-ad-bids-for-stock, approved
 * like every ad change): suppressAdGroupBids' floor — its default bid and every keyword and target bid above the floor go
 * to it, each bid remembered BEFORE it moves, the ad group carrying its owner (W1-6b) — with the approval's change set and
 * the approver's own click (`manual`). Unlike suppressAdGroupBids it also floors what is still above the floor under its
 * own floor or a person's (a keyword added since, a lower stop bid now), and a memory is never overwritten. Inside a
 * campaign floored by anyone, or under an engine's own floor, it writes nothing (the tool leaves those first). A short
 * (not out) ad group is never floored here: its step down is a plain bid lowering (ads-stock.tools.ts). Returns how many
 * bids moved and how many writes were refused.
 */
export async function lowerAdGroupBids(
  adGroupId: string,
  opts: { actor: AdsActor; reason: string; floorCents: number; changeSetId?: string | null; manual?: boolean; applyImmediately?: boolean },
): Promise<{ moved: number; failed: number }> {
  const group = await prisma.adGroup.findUnique({
    where: { id: adGroupId },
    select: { id: true, defaultBidCents: true, suppressedFromBidCents: true, bidsSuppressedAt: true, bidsSuppressedBy: true, campaign: { select: { bidsSuppressedAt: true } } },
  })
  if (!group || group.campaign?.bidsSuppressedAt) return { moved: 0, failed: 0 }
  if (group.bidsSuppressedAt && group.bidsSuppressedBy !== opts.actor && !group.bidsSuppressedBy?.startsWith('user:')) return { moved: 0, failed: 0 }
  const floor = normaliseFloorCents(opts.floorCents)
  const write = { actor: opts.actor, reason: opts.reason, applyImmediately: opts.applyImmediately ?? true, force: true, changeSetId: opts.changeSetId ?? null, manual: opts.manual }
  let moved = 0, failed = 0
  if (group.defaultBidCents > floor) {
    try {
      if (group.suppressedFromBidCents == null) await prisma.adGroup.update({ where: { id: group.id }, data: { suppressedFromBidCents: group.defaultBidCents } })
      const r = await updateAdGroupWithSync({ adGroupId: group.id, patch: { defaultBidCents: floor }, ...write })
      if (r.ok) moved++
      else { failed++; logger.warn('[no-pause] stock floor of ad group default not accepted', { adGroupId, error: r.error }) }
    } catch (e) { failed++; logger.warn('[no-pause] stock floor of ad group default threw', { adGroupId, error: (e as Error).message }) }
  }
  const targets = await prisma.adTarget.findMany({ where: { adGroupId, isNegative: false, bidCents: { gt: floor } }, select: { id: true, bidCents: true, suppressedFromBidCents: true } })
  for (const t of targets) {
    try {
      if (t.suppressedFromBidCents == null) await prisma.adTarget.update({ where: { id: t.id }, data: { suppressedFromBidCents: t.bidCents } })
      const r = await updateAdTargetWithSync({ adTargetId: t.id, patch: { bidCents: floor }, ...write })
      if (r.ok) moved++
      else { failed++; logger.warn('[no-pause] stock floor of target not accepted', { adTargetId: t.id, error: r.error }) }
    } catch (e) { failed++; logger.warn('[no-pause] stock floor of target threw', { adTargetId: t.id, error: (e as Error).message }) }
  }
  // The floor's owner stays the one who first floored it; a further floor only moves its stamp.
  await prisma.adGroup.update({
    where: { id: group.id },
    data: group.bidsSuppressedAt ? { bidsSuppressedFloorCents: floor } : { bidsSuppressedAt: new Date(), bidsSuppressedFloorCents: floor, bidsSuppressedBy: opts.actor },
  })
  logger.info('[no-pause] floored ad group bids for stock', { adGroupId, floor, moved, failed })
  return { moved, failed }
}

// BL.7 — base-bid deltaPct: scale every ad-group default + keyword bid by ±% from a STABLE
// remembered baseline (baseBidFromCents), so repeated ticks NEVER compound and a changed
// delta re-applies cleanly from the baseline. Independent of suppress/restore (different
// memory field), so the two compose. force:true lands the exact computed bid (deltaBidCents
// already floors at 2¢). Idempotent. Returns entities moved.
export async function applyBaseBidDelta(
  campaignId: string, deltaPct: number,
  // W1-5 — `holds`: a run's collector for the bids the ads strategy band held (its run line).
  opts: { actor: AdsActor; reason?: string; applyImmediately?: boolean; holds?: BidHoldLog },
): Promise<number> {
  const reason = opts.reason ?? `rank base-bid ${deltaPct >= 0 ? '+' : ''}${deltaPct}%`
  const applyImmediately = opts.applyImmediately ?? true
  let touched = 0
  // W1-6b — never inside an ad group floored on its own: a base-bid move would lift its floor.
  const groups = await prisma.adGroup.findMany({ where: { campaignId, bidsSuppressedAt: null }, select: { id: true, defaultBidCents: true, baseBidFromCents: true } })
  const targets = await prisma.adTarget.findMany({ where: { adGroup: { campaignId, bidsSuppressedAt: null }, isNegative: false }, select: { id: true, bidCents: true, baseBidFromCents: true, adGroupId: true } })
  // W1-5 — every bid the delta sets is held inside the ads strategy band of its ad group first, so the write gate does
  // not refuse it (a forced lowering is exempt from the lowest bid there, and here). The reason names the row.
  const camp = groups.length || targets.length ? await prisma.campaign.findUnique({ where: { id: campaignId }, select: { marketplace: true } }) : null
  const strategy = camp
    ? await strategyBidReader().forAdGroups([...new Set([...groups.map((g) => g.id), ...targets.map((t) => t.adGroupId)])].map((adGroupId) => ({ adGroupId, marketplace: camp.marketplace })))
    : new Map<string, { limits: StrategyBidLimits }>()
  const held = (want: number, current: number, adGroupId: string): { cents: number; reason: string } => {
    const c = clampToStrategy(want, strategy.get(adGroupId)?.limits ?? NO_LIMITS, { currentCents: current, forced: true })
    if (!c.held) return { cents: want, reason }
    opts.holds?.holds.push({ kind: 'base', side: c.held.side, source: strategyWords(c.held.limit.source), wantedCents: want, writtenCents: c.cents })
    return { cents: c.cents, reason: `${reason} — held to ${limitWords(c.held.side, c.held.limit)}` }
  }
  for (const g of groups) {
    const baseline = g.baseBidFromCents ?? g.defaultBidCents // stable baseline → no compounding
    const { cents: want, reason: why } = held(deltaBidCents(baseline, deltaPct), g.defaultBidCents, g.id)
    if (g.baseBidFromCents != null && g.defaultBidCents === want) continue // already at target
    try {
      if (g.baseBidFromCents == null) await prisma.adGroup.update({ where: { id: g.id }, data: { baseBidFromCents: baseline } })
      const r = await updateAdGroupWithSync({ adGroupId: g.id, patch: { defaultBidCents: want }, actor: opts.actor, reason: why, applyImmediately, force: true })
      if (r.ok) touched++
    } catch (e) { logger.warn('[base-bid] delta group failed', { adGroupId: g.id, error: (e as Error).message }) }
  }
  for (const t of targets) {
    const baseline = t.baseBidFromCents ?? t.bidCents
    const { cents: want, reason: why } = held(deltaBidCents(baseline, deltaPct), t.bidCents, t.adGroupId)
    if (t.baseBidFromCents != null && t.bidCents === want) continue
    try {
      if (t.baseBidFromCents == null) await prisma.adTarget.update({ where: { id: t.id }, data: { baseBidFromCents: baseline } })
      const r = await updateAdTargetWithSync({ adTargetId: t.id, patch: { bidCents: want }, actor: opts.actor, reason: why, applyImmediately, force: true })
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
  // W1-5 — `holds` as in restoreCampaignBids: a give-back held inside the bounds that bind it is named in the run line.
  opts: { actor: AdsActor; reason?: string; applyImmediately?: boolean; holds?: BidHoldLog },
): Promise<number> {
  const reason = opts.reason ?? 'rank base-bid delta cleared → restore baseline'
  const applyImmediately = opts.applyImmediately ?? true
  let touched = 0
  // W1-6b — not inside an ad group floored on its own (the revert would raise its floored bids); its baseline stays.
  const groups = await prisma.adGroup.findMany({ where: { campaignId, bidsSuppressedAt: null, baseBidFromCents: { not: null } }, select: { id: true, baseBidFromCents: true, defaultBidCents: true } })
  const targets = await prisma.adTarget.findMany({ where: { adGroup: { campaignId, bidsSuppressedAt: null }, baseBidFromCents: { not: null } }, select: { id: true, baseBidFromCents: true, bidCents: true, adGroupId: true } })
  // W1-5 — the baseline held inside the bounds that bind this write, like a restore (heldGiveBack): a refused revert
  // left the delta's bid in place and retried every run.
  const boundsOf = groups.length || targets.length ? await giveBackBounds(campaignId, [...groups.map((g) => g.id), ...targets.map((t) => t.adGroupId)]) : null
  for (const g of groups) {
    try {
      const back = heldGiveBack(g.baseBidFromCents as number, g.defaultBidCents, boundsOf!(g.id), reason, opts.holds)
      const r = await updateAdGroupWithSync({ adGroupId: g.id, patch: { defaultBidCents: back.cents }, actor: opts.actor, reason: back.reason, applyImmediately, force: true })
      if (r.ok || r.error === 'not_found') { await prisma.adGroup.update({ where: { id: g.id }, data: { baseBidFromCents: null } }); if (r.ok) touched++ }
    } catch (e) { logger.warn('[base-bid] revert group failed', { adGroupId: g.id, error: (e as Error).message }) }
  }
  for (const t of targets) {
    try {
      const back = heldGiveBack(t.baseBidFromCents as number, t.bidCents, boundsOf!(t.adGroupId), reason, opts.holds)
      const r = await updateAdTargetWithSync({ adTargetId: t.id, patch: { bidCents: back.cents }, actor: opts.actor, reason: back.reason, applyImmediately, force: true })
      if (r.ok || r.error === 'not_found') { await prisma.adTarget.update({ where: { id: t.id }, data: { baseBidFromCents: null } }); if (r.ok) touched++ }
    } catch (e) { logger.warn('[base-bid] revert target failed', { adTargetId: t.id, error: (e as Error).message }) }
  }
  if (touched) logger.info('[base-bid] reverted delta', { campaignId, touched })
  return touched
}
