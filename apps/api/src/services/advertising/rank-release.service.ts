/**
 * Group 2 (2a) — Rank & Dayparting gives back what it set when it stops holding a campaign.
 *
 * Review 3.2: deleting or pausing a schedule, or removing a campaign from one, called no restore. Removed during Min-bid
 * hours, the bids stayed at 2¢ and `bidsSuppressedAt` stayed set, so every bid rule and the optimiser skipped the
 * campaign for good. Same when a schedule resolved to nothing (no window open, no baseline) or to a deleted target, and
 * when a product plan auto-paused. Review 3.3: the legacy schedule delete / disable wrote `status: ENABLED` and could
 * re-enable a campaign a person had paused; they now give bids back instead and never write a campaign status.
 * Review N1: the serve path lifted floors it never set (a person's, the out-of-stock check's) — see `isRankOwnedFloor`.
 * Review N3: switched off, the engine froze its floors; the orphan sweep gives them back on its first run after.
 *
 * WHAT IS GIVEN BACK — only Rank & Dayparting's own state:
 *   · a bid floor whose owner (`Campaign.bidsSuppressedBy`) is `automation:rank-defend-*`, `automation:rank-plan-*` or
 *     `automation:dayparting-*`, or null (set before the owner column existed: legacy, read as ours);
 *   · a base-bid delta (`baseBidFromCents`), which only rank-defend writes.
 * A floor anyone else set is kept as it is ("kept by others"). Placements stay as last set (Owner S6): the
 * pre-schedule placement was never stored, so resetting it would be a spend decision nobody made.
 *
 * THE BRAKES (wave 1, ads-engine-guard.ts):
 *   stopped (halt, dial OFF, kill switch)  nothing is attempted: `restoreCampaignBids` changes Nexus's copy before the
 *                                          write gate refuses the raise, which would strand Amazon at 2¢. The release
 *                                          is `deferred`, `bidsSuppressedAt` stays, and the orphan sweep gives it back
 *                                          on the first run after Resume.
 *   suggest                                allowed: an engine undoing its own state (Owner S2).
 *   Rank & Dayparting switched off         deferred the same way (Owner S7: a brake must not raise spend); the sweep
 *                                          gives it back on the first run after it is switched back on.
 *   caps                                   counted against the engine's caps through the guard, never refused by one.
 *
 * LIVE CAMPAIGNS (Owner, 2026-10-04): the orphan sweep never changes bids on a live (ENABLED) campaign by itself — a
 * leftover floor or base-bid delta there is of unknown size and age. It gives back on paused (and draft) campaigns
 * only. The live ones are listed (`listEnabledOrphans`, the banner on the Hourly Bids list) and a person gives
 * each one back (`releaseEnabledOrphan`, through `releaseCampaigns`, so every brake above still applies). So "the sweep
 * gives it back after Resume" below holds for a paused campaign; a live one waits on that list.
 */
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { done, refused, type ServiceOutcome } from '../automation/service-outcome.js'
import type { AdsActor } from './ads-mutation.service.js'
import { restoreCampaignBids, revertBaseBidDelta } from './ads-bid-suppression.service.js'
import { nothingHeld, openEngineGuard, readEnginePosture, type EngineGuard } from './ads-engine-guard.js'
import { engineForActor, engineLabel } from './ads-engine-actors.js'

/** The actor prefixes whose floors are Rank & Dayparting's own. */
export const RANK_OWNER_PREFIXES = ['automation:rank-defend-', 'automation:rank-plan-', 'automation:dayparting-'] as const

/** Is this floor Rank & Dayparting's to lift? A null (or empty) owner predates the column: legacy, read as ours. */
export function isRankOwnedFloor(by: string | null | undefined): boolean {
  if (by == null || by === '') return true
  return RANK_OWNER_PREFIXES.some((p) => by.startsWith(p))
}

/** Who set a floor, in words. */
export function floorOwnerWords(by: string | null | undefined): string {
  if (isRankOwnedFloor(by)) return 'Rank & Dayparting'
  const who = by as string
  if (who.startsWith('user:')) return 'a person'
  if (who === 'automation:retail-guard') return 'the out-of-stock check'
  const engine = engineForActor(who)
  if (engine) return engineLabel(engine)
  return who.startsWith('automation:') ? 'a rule or another automation' : 'a person'
}

/** The sweep's actor when the floor's owner names no rank schedule or plan (a dayparting floor, a legacy one, a delta). */
export const RELEASE_ACTOR: AdsActor = 'automation:rank-defend-release'
/** At most this many orphaned campaigns are given back per rank-defend run. */
export const SWEEP_LIMIT = 20

export type ReleaseOutcome = 'restored' | 'nothing' | 'kept-by-others' | 'failed' | 'deferred'
export interface CampaignRelease {
  campaignId: string
  outcome: ReleaseOutcome
  /** Bids that came back (floors and base-bid deltas). */
  writes: number
  /** The floor's owner when it was not ours (`kept-by-others`). */
  floorBy?: string | null
}
export interface ReleaseReport {
  /** Campaigns whose floors and base-bid changes came back. */
  restored: number
  /** Campaigns floored by someone else: left as they are. */
  keptByOthers: number
  /** Campaigns where not every bid was taken back; the memory is kept and the next run retries. */
  failed: number
  /** Campaigns whose give-back waits for Resume, or for Rank & Dayparting to be switched back on. */
  deferred: number
  /** Why they wait, in words; null when nothing waits. */
  deferredWhy: string | null
  /** Bids that came back. */
  writes: number
  campaigns: CampaignRelease[]
}

export const emptyRelease = (): ReleaseReport => ({ restored: 0, keptByOthers: 0, failed: 0, deferred: 0, deferredWhy: null, writes: 0, campaigns: [] })

/** Add one report into another (the tick adds its in-tick releases and its sweep). */
export function addRelease(into: ReleaseReport, r: ReleaseReport): ReleaseReport {
  into.restored += r.restored; into.keptByOthers += r.keptByOthers; into.failed += r.failed; into.deferred += r.deferred
  into.writes += r.writes; into.deferredWhy = into.deferredWhy ?? r.deferredWhy; into.campaigns.push(...r.campaigns)
  return into
}

interface CampaignState {
  campaignId: string
  name: string
  floored: boolean
  floorBy: string | null
  floorCents: number | null
  /** Entities holding a remembered pre-floor bid. */
  flooredBids: number
  /** Entities holding a base-bid delta baseline. */
  deltaBids: number
  placements: { top: number; rest: number; product: number }
}

/** What each campaign holds that a release would give back. Campaigns that do not exist are left out. */
async function readStates(campaignIds: string[]): Promise<Map<string, CampaignState>> {
  const out = new Map<string, CampaignState>()
  const ids = [...new Set(campaignIds)]
  if (!ids.length) return out
  const [camps, groups, targets] = await Promise.all([
    prisma.campaign.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, bidsSuppressedAt: true, bidsSuppressedBy: true, bidsSuppressedFloorCents: true, dynamicBidding: true } }),
    prisma.adGroup.findMany({ where: { campaignId: { in: ids } }, select: { id: true, campaignId: true, suppressedFromBidCents: true, baseBidFromCents: true } }),
    prisma.adTarget.findMany({
      where: { adGroup: { campaignId: { in: ids } }, OR: [{ suppressedFromBidCents: { not: null } }, { baseBidFromCents: { not: null } }] },
      select: { adGroupId: true, suppressedFromBidCents: true, baseBidFromCents: true },
    }),
  ])
  for (const c of camps) {
    const placement = (p: string) => ((c.dynamicBidding ?? {}) as { placementBidding?: Array<{ placement: string; percentage: number }> }).placementBidding?.find((x) => x.placement === p)?.percentage ?? 0
    out.set(c.id, {
      campaignId: c.id, name: c.name, floored: !!c.bidsSuppressedAt, floorBy: c.bidsSuppressedBy ?? null, floorCents: c.bidsSuppressedFloorCents ?? null,
      flooredBids: 0, deltaBids: 0,
      placements: { top: placement('PLACEMENT_TOP'), rest: placement('PLACEMENT_REST_OF_SEARCH'), product: placement('PLACEMENT_PRODUCT_PAGE') },
    })
  }
  const campByGroup = new Map(groups.map((g) => [g.id, g.campaignId]))
  const bump = (campaignId: string | undefined, floored: boolean, delta: boolean) => {
    const s = campaignId ? out.get(campaignId) : undefined
    if (!s) return
    if (floored) s.flooredBids++
    if (delta) s.deltaBids++
  }
  for (const g of groups) bump(g.campaignId, g.suppressedFromBidCents != null, g.baseBidFromCents != null)
  for (const t of targets) bump(campByGroup.get(t.adGroupId), t.suppressedFromBidCents != null, t.baseBidFromCents != null)
  return out
}

/** What a release would do to one campaign now, before the brakes. */
function plan(s: CampaignState | undefined): 'restore' | 'kept-by-others' | 'nothing' {
  if (!s) return 'nothing'
  if (s.floored && !isRankOwnedFloor(s.floorBy)) return 'kept-by-others'
  return s.floored || s.deltaBids > 0 ? 'restore' : 'nothing'
}

/**
 * Give back Rank & Dayparting's own floors and base-bid deltas on these campaigns.
 *
 * `guard` asks for each campaign's permit once, as the engines do; a campaign with nothing to give back never asks.
 * `waitWhy` (Rank & Dayparting switched off) defers every give-back without asking. A floor is restored first and the
 * delta is reverted only once the floor is fully back — reverting under a half-restored floor would raise floored bids.
 */
export async function releaseCampaigns(
  targets: Array<{ campaignId: string; actor: AdsActor }>,
  opts: { reason: string; guard: EngineGuard | null; waitWhy?: string | null },
): Promise<ReleaseReport> {
  const report = emptyRelease()
  const states = await readStates(targets.map((t) => t.campaignId))
  const seen = new Set<string>()
  for (const t of targets) {
    if (seen.has(t.campaignId)) continue
    seen.add(t.campaignId)
    const s = states.get(t.campaignId)
    const what = plan(s)
    if (what === 'nothing') { report.campaigns.push({ campaignId: t.campaignId, outcome: 'nothing', writes: 0 }); continue }
    if (what === 'kept-by-others') {
      report.keptByOthers++
      report.campaigns.push({ campaignId: t.campaignId, outcome: 'kept-by-others', writes: 0, floorBy: s!.floorBy })
      continue
    }
    const permit = opts.waitWhy || !opts.guard ? null : opts.guard.permit()
    if (!permit?.restore) {
      if (permit && opts.guard) { const held = nothingHeld(); held.restore = true; opts.guard.settle(permit, 0, held) }
      report.deferred++
      report.deferredWhy = report.deferredWhy ?? opts.waitWhy ?? `ads automation is stopped (${opts.guard?.report().why ?? 'no reading'})`
      report.campaigns.push({ campaignId: t.campaignId, outcome: 'deferred', writes: 0 })
      continue
    }
    let writes = 0
    try {
      if (s!.floored) writes += await restoreCampaignBids(t.campaignId, { actor: t.actor, reason: opts.reason })
      const after = await prisma.campaign.findUnique({ where: { id: t.campaignId }, select: { bidsSuppressedAt: true } })
      if (!after?.bidsSuppressedAt && s!.deltaBids > 0) writes += await revertBaseBidDelta(t.campaignId, { actor: t.actor, reason: opts.reason })
    } catch (e) { logger.warn('[rank-release] give-back threw — kept for the next run', { campaignId: t.campaignId, error: (e as Error).message }) }
    opts.guard!.settle(permit, writes, nothingHeld())
    const left = (await readStates([t.campaignId])).get(t.campaignId)
    const outcome: ReleaseOutcome = left && (left.floored || left.deltaBids > 0) ? 'failed' : 'restored'
    if (outcome === 'failed') report.failed++
    else report.restored++
    report.writes += writes
    report.campaigns.push({ campaignId: t.campaignId, outcome, writes })
  }
  if (report.restored || report.failed || report.deferred) {
    logger.info('[rank-release] give-back', { reason: opts.reason, restored: report.restored, failed: report.failed, deferred: report.deferred, keptByOthers: report.keptByOthers, writes: report.writes })
  }
  return report
}

type ScheduleEngine = 'rank-defend' | 'dayparting'

/** Why a give-back would wait right now, in words; null when it would run. Never throws. */
export async function releaseWaitWhy(engine: ScheduleEngine): Promise<string | null> {
  const { posture, why } = await readEnginePosture()
  if (posture === 'stopped') return `ads automation is stopped (${why})`
  return engine === 'rank-defend' ? rankSwitchedOff() : null
}

/** Owner S7: switched off for this business, Rank & Dayparting gives nothing back until it is switched on again. */
async function rankSwitchedOff(): Promise<string | null> {
  try {
    const { engineMode } = await import('../automation/engine-switch.service.js')
    const gate = await engineMode('rank-defend', 'AUTO')
    return gate.mode === 'OFF' ? 'Rank & Dayparting is switched off for this business' : null
  } catch (e) {
    // Unknown is not on: a switch that cannot be read never lets a switched-off engine raise bids.
    logger.warn('[rank-release] engine switch unreadable — give-back deferred', { error: (e as Error).message })
    return 'whether Rank & Dayparting is switched on could not be read'
  }
}

export interface ScheduleMember { scheduleId: string; campaignId: string; windows: unknown; defaultTargetKey: string | null }

/**
 * A person stopped these schedules holding their campaigns (deleted, paused, disabled, or removed the campaign): give
 * back what each floored. A goal-mode schedule releases as rank-defend (`automation:rank-defend-<id>`, its caps), a
 * classic one as dayparting (`automation:dayparting-<id>`). Call it AFTER the schedule is gone or disabled, so a tick
 * that starts meanwhile cannot floor the campaign again.
 */
export async function releaseScheduleMembers(members: ScheduleMember[], why: string): Promise<ReleaseReport> {
  const report = emptyRelease()
  if (!members.length) return report
  try {
    const { isGoalMode } = await import('../../jobs/ad-rank-defend.job.js')
    for (const engine of ['rank-defend', 'dayparting'] as const) {
      const mine = members.filter((m) => isGoalMode(m.windows, m.defaultTargetKey) === (engine === 'rank-defend'))
      if (!mine.length) continue
      const waitWhy = engine === 'rank-defend' ? await rankSwitchedOff() : null
      const guard = waitWhy ? null : await openEngineGuard(engine)
      const targets = mine.map((m) => ({ campaignId: m.campaignId, actor: `automation:${engine}-${m.scheduleId}` as AdsActor }))
      addRelease(report, await releaseCampaigns(targets, { reason: `rank release — ${why}`, guard, waitWhy }))
    }
    return report
  } catch (e) {
    return couldNotRun(members.length, e)
  }
}

/**
 * A give-back that could not run (the database did not answer) never fails the delete, pause or save that asked for
 * it: the schedule no longer holds those campaigns, so the next rank-defend run's orphan sweep gives the bids back on
 * the paused ones, and the live ones wait on the Hourly Bids list for a person.
 */
function couldNotRun(campaigns: number, e: unknown): ReleaseReport {
  logger.warn('[rank-release] give-back could not run — the next rank-defend run gives it back', { campaigns, error: (e as Error)?.message ?? String(e) })
  return { ...emptyRelease(), deferred: campaigns, deferredWhy: 'the give-back could not run just now; the rank loop\'s next run gives the bids back on paused campaigns, and live ones wait on the Hourly Bids list for a person to give them back' }
}

/**
 * The schedule rows a release needs: a group's members (or those whose campaign is not in `campaignIdNotIn`), or one
 * schedule. Read BEFORE the rows are deleted.
 */
export async function readScheduleMembers(where: { groupId: string; campaignIdNotIn?: string[] } | { id: string }): Promise<ScheduleMember[]> {
  const filter = 'id' in where
    ? { id: where.id }
    : { groupId: where.groupId, ...(where.campaignIdNotIn ? { campaignId: { notIn: where.campaignIdNotIn.length ? where.campaignIdNotIn : ['__none__'] } } : {}) }
  const rows = await prisma.adSchedule.findMany({ where: filter, select: { id: true, campaignId: true, windows: true, defaultTargetKey: true } })
  return rows.map((r) => ({ scheduleId: r.id, campaignId: r.campaignId, windows: r.windows, defaultTargetKey: r.defaultTargetKey }))
}

/** A group was paused: give back what each member floored. */
export async function releaseGroupMembers(groupId: string, why: string): Promise<ReleaseReport> {
  let members: ScheduleMember[]
  try { members = await readScheduleMembers({ groupId }) } catch (e) { return couldNotRun(0, e) }
  return releaseScheduleMembers(members, why)
}

/**
 * The orphan sweep, at the end of every live rank-defend run: Rank & Dayparting floors and base-bid deltas on campaigns
 * no enabled schedule (goal-mode or classic) and no enabled product plan holds any more. It is what gives back a
 * release that waited (halted, switched off), a plan that auto-paused, and anything a path outside this file dropped.
 * Oldest floor first, at most `limit` campaigns a run. `governed` = the campaigns this run's enabled plans resolved to.
 * Paused and draft campaigns only (Owner, 2026-10-04): a live one is never changed by the sweep, only listed for a
 * person (`listEnabledOrphans`); archived ones are left out.
 */
export async function sweepOrphanReleases(opts: { guard: EngineGuard; governed: Set<string>; limit?: number }): Promise<ReleaseReport & { orphans: number }> {
  const limit = opts.limit ?? SWEEP_LIMIT
  const held = new Set<string>(opts.governed)
  for (const s of await prisma.adSchedule.findMany({ where: { enabled: true }, select: { campaignId: true } })) held.add(s.campaignId)
  const picked = await pickOrphans(held, false, limit)
  if (!picked.size) return { ...emptyRelease(), orphans: 0 }
  // The floor's own schedule or plan when it names one (its history shows the give-back), the release actor otherwise.
  const actorFor = (by: string | null): AdsActor =>
    by && (by.startsWith('automation:rank-defend-') || by.startsWith('automation:rank-plan-')) ? by as AdsActor : RELEASE_ACTOR
  const targets = [...picked].map(([campaignId, by]) => ({ campaignId, actor: actorFor(by) }))
  const r = await releaseCampaigns(targets, { reason: 'rank release — no schedule or plan holds this campaign any more', guard: opts.guard })
  return { ...r, orphans: picked.size }
}

/**
 * The orphans `held` leaves out: Rank & Dayparting's own floors (oldest first), then base-bid deltas on campaigns
 * nobody floors. `live` false = paused or draft campaigns (the sweep); true = live ones (the review list). Archived
 * campaigns are never picked. At most `limit` campaigns when it is given. Value = the floor's owner (null: a delta).
 */
async function pickOrphans(held: Set<string>, live: boolean, limit?: number): Promise<Map<string, string | null>> {
  const notHeld = held.size ? { id: { notIn: [...held] } } : {}
  const floored = await prisma.campaign.findMany({
    where: { ...notHeld, status: live ? 'ENABLED' : { notIn: ['ARCHIVED', 'ENABLED'] }, bidsSuppressedAt: { not: null }, OR: [{ bidsSuppressedBy: null }, { bidsSuppressedBy: '' }, ...RANK_OWNER_PREFIXES.map((p) => ({ bidsSuppressedBy: { startsWith: p } }))] },
    select: { id: true, bidsSuppressedBy: true }, orderBy: { bidsSuppressedAt: 'asc' }, take: limit,
  })
  const picked = new Map<string, string | null>(floored.map((c) => [c.id, c.bidsSuppressedBy ?? null]))
  if (limit == null || picked.size < limit) {
    // A base-bid delta on a campaign nobody floors now. One floored by someone else is left out: reverting it would
    // raise their floor, and it would take a slot every run.
    const [g, t] = await Promise.all([
      prisma.adGroup.findMany({ where: { baseBidFromCents: { not: null } }, select: { campaignId: true }, distinct: ['campaignId'] }),
      prisma.adTarget.findMany({ where: { baseBidFromCents: { not: null } }, select: { adGroup: { select: { campaignId: true } } } }),
    ])
    const deltaIds = [...new Set([...g.map((x) => x.campaignId), ...t.map((x) => x.adGroup?.campaignId).filter(Boolean) as string[]])]
      .filter((id) => !held.has(id) && !picked.has(id))
    if (deltaIds.length) {
      const free = await prisma.campaign.findMany({
        where: { id: { in: deltaIds }, status: live ? 'ENABLED' : { notIn: ['ARCHIVED', 'ENABLED'] }, bidsSuppressedAt: null },
        select: { id: true }, orderBy: { id: 'asc' }, take: limit == null ? undefined : limit - picked.size,
      })
      for (const c of free) picked.set(c.id, null)
    }
  }
  return picked
}

// ── Live campaigns the sweep leaves alone: listed for a person, given back one at a time (Owner, 2026-10-04) ────────

/**
 * Campaigns Rank & Dayparting holds right now, decided as the tick decides it: every enabled schedule (goal-mode or
 * classic) and each enabled product plan's family, resolved live, its excluded campaigns left out. `unknown` = a
 * family could not be resolved, so the set may be short and nothing may be called an orphan.
 */
async function rankHeldNow(): Promise<{ held: Set<string>; unknown: boolean }> {
  const [schedules, plans] = await Promise.all([
    prisma.adSchedule.findMany({ where: { enabled: true }, select: { campaignId: true } }),
    prisma.productRankPlan.findMany({ where: { enabled: true }, select: { id: true, productId: true, marketplace: true, excludeCampaignIds: true } }),
  ])
  const held = new Set<string>(schedules.map((s) => s.campaignId))
  let unknown = false
  if (plans.length) {
    const { resolveProductFamily } = await import('./ads-dayparting-refresh.service.js')
    for (const p of plans) {
      try {
        const excluded = new Set<string>(Array.isArray(p.excludeCampaignIds) ? (p.excludeCampaignIds as string[]) : [])
        for (const c of (await resolveProductFamily({ parentProductId: p.productId, marketplace: p.marketplace })).campaigns ?? []) if (!excluded.has(c.id)) held.add(c.id)
      } catch (e) { unknown = true; logger.warn('[rank-release] plan family unreadable — live orphans not decided', { planId: p.id, error: (e as Error).message }) }
    }
  }
  return { held, unknown }
}

const PLANS_UNREAD = 'Could not read which campaigns the rank plans hold just now, so no live campaign could be checked. Nothing was changed; try again in a minute.'

export interface EnabledOrphanBid {
  kind: 'ad-group' | 'target'
  id: string
  /** The ad group's name (its default bid), or the target: keyword and match type, ASIN or category. */
  label: string
  adGroup: string
  currentCents: number
  /** The bid a give-back sets: the remembered pre-floor bid, or the base-bid baseline where there is one (it is
   *  reverted once the floor is back). */
  backCents: number
}
export interface EnabledOrphan {
  campaignId: string
  name: string
  marketplace: string | null
  /** Why it is listed, in words: a stranded floor (who set it, since when), a leftover base-bid change. */
  reasons: string[]
  floor: { by: string | null; byWords: string; since: string; floorCents: number | null } | null
  /** Bids carrying a base-bid change rank made. */
  deltaBids: number
  /** Ad groups whose default bid would change, and targets whose bid would. */
  adGroups: number
  targets: number
  bids: EnabledOrphanBid[]
}
export interface EnabledOrphanList {
  campaigns: number
  bids: number
  /** Why a give-back would wait right now (ads automation stopped, Rank & Dayparting switched off); null = at once. */
  waitWhy: string | null
  items: EnabledOrphan[]
}

/** Who set a floor Rank & Dayparting owns, in words. */
function rankFloorSource(by: string | null): string {
  if (!by) return 'Rank & Dayparting (before owners were recorded)'
  if (by.startsWith('automation:rank-defend-')) return 'a rank schedule'
  if (by.startsWith('automation:rank-plan-')) return 'a rank plan'
  if (by.startsWith('automation:dayparting-')) return 'a dayparting schedule'
  return floorOwnerWords(by)
}

/** Each campaign's bids now and what a give-back would set them to (the order of `ids` is kept). */
async function describeOrphans(ids: string[]): Promise<EnabledOrphan[]> {
  if (!ids.length) return []
  const [camps, groups, targets] = await Promise.all([
    prisma.campaign.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, marketplace: true, bidsSuppressedAt: true, bidsSuppressedBy: true, bidsSuppressedFloorCents: true } }),
    prisma.adGroup.findMany({ where: { campaignId: { in: ids } }, orderBy: { name: 'asc' }, select: { id: true, campaignId: true, name: true, defaultBidCents: true, suppressedFromBidCents: true, baseBidFromCents: true } }),
    prisma.adTarget.findMany({
      where: { adGroup: { campaignId: { in: ids } }, OR: [{ suppressedFromBidCents: { not: null } }, { baseBidFromCents: { not: null } }] },
      orderBy: { expressionValue: 'asc' },
      select: { id: true, adGroupId: true, kind: true, expressionType: true, expressionValue: true, bidCents: true, suppressedFromBidCents: true, baseBidFromCents: true },
    }),
  ])
  const out = new Map<string, EnabledOrphan>()
  for (const c of camps) {
    out.set(c.id, {
      campaignId: c.id, name: c.name, marketplace: c.marketplace ?? null, reasons: [],
      floor: c.bidsSuppressedAt ? { by: c.bidsSuppressedBy ?? null, byWords: rankFloorSource(c.bidsSuppressedBy ?? null), since: c.bidsSuppressedAt.toISOString(), floorCents: c.bidsSuppressedFloorCents ?? null } : null,
      deltaBids: 0, adGroups: 0, targets: 0, bids: [],
    })
  }
  // As releaseCampaigns does it: a floor comes back to the remembered bid, then a delta to its baseline; with no floor,
  // only the delta moves (a remembered pre-floor bid without a floor is not touched).
  const back = (o: EnabledOrphan, from: number | null, base: number | null) => (o.floor ? base ?? from : base)
  const groupById = new Map(groups.map((g) => [g.id, g]))
  for (const g of groups) {
    const o = out.get(g.campaignId)
    const to = o ? back(o, g.suppressedFromBidCents, g.baseBidFromCents) : null
    if (!o || to == null) continue
    o.bids.push({ kind: 'ad-group', id: g.id, label: g.name, adGroup: g.name, currentCents: g.defaultBidCents, backCents: to })
    o.adGroups++
    if (g.baseBidFromCents != null) o.deltaBids++
  }
  for (const t of targets) {
    const g = groupById.get(t.adGroupId)
    const o = g ? out.get(g.campaignId) : undefined
    const to = o ? back(o, t.suppressedFromBidCents, t.baseBidFromCents) : null
    if (!o || to == null) continue
    const label = t.kind === 'KEYWORD' ? `${t.expressionValue} (${t.expressionType.toLowerCase()})` : t.expressionValue
    o.bids.push({ kind: 'target', id: t.id, label, adGroup: g!.name, currentCents: t.bidCents, backCents: to })
    o.targets++
    if (t.baseBidFromCents != null) o.deltaBids++
  }
  for (const o of out.values()) {
    if (o.floor) o.reasons.push(`stranded bid floor set by ${o.floor.byWords} since ${o.floor.since.slice(0, 10)}`)
    if (o.deltaBids) o.reasons.push(`leftover base-bid change on ${plural(o.deltaBids, 'bid')}`)
  }
  return ids.map((id) => out.get(id)).filter((o): o is EnabledOrphan => !!o)
}

/**
 * GET /advertising/rank-release/enabled-orphans — the live campaigns no schedule or plan holds that still carry Rank &
 * Dayparting's floor or base-bid change: why each is listed, and per ad group and target the bid now and the bid a
 * give-back would set. Nothing is written.
 */
export async function listEnabledOrphans(): Promise<ServiceOutcome<EnabledOrphanList>> {
  const { held, unknown } = await rankHeldNow()
  if (unknown) return refused(503, { error: PLANS_UNREAD })
  const items = await describeOrphans([...(await pickOrphans(held, true)).keys()])
  return done({
    campaigns: items.length,
    bids: items.reduce((n, o) => n + o.bids.length, 0),
    waitWhy: items.length ? await releaseWaitWhy('rank-defend') : null,
    items,
  })
}

export interface EnabledOrphanRelease {
  campaignId: string
  name: string
  outcome: ReleaseOutcome
  /** Bids that came back. */
  writes: number
  /** Why it waits (`deferred`): nothing changed. */
  deferredWhy: string | null
}

/**
 * POST /advertising/rank-release/enabled-orphans/:campaignId/release — a person gives back the bids on ONE listed
 * campaign, as themselves, through `releaseCampaigns`: deferred while ads automation is stopped or Rank & Dayparting is
 * switched off, counted against rank-defend's caps and never refused by one. Refused when the campaign is not (or no
 * longer) a live orphan: a schedule or plan holds it, it is not live, or it carries nothing of Rank & Dayparting's.
 */
export async function releaseEnabledOrphan(campaignId: string, actor: AdsActor): Promise<ServiceOutcome<EnabledOrphanRelease>> {
  const camp = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { id: true, name: true, status: true } })
  if (!camp) return refused(404, { error: 'not found' })
  const { held, unknown } = await rankHeldNow()
  if (unknown) return refused(503, { error: PLANS_UNREAD })
  const nothingChanged = 'Nothing was changed.'
  if (held.has(campaignId)) return refused(409, { error: `A rank schedule or plan holds "${camp.name}" again, so the rank loop manages its bids. ${nothingChanged}` })
  if (camp.status !== 'ENABLED') {
    return refused(409, { error: camp.status === 'ARCHIVED'
      ? `"${camp.name}" is archived; no bid is given back on an archived campaign. ${nothingChanged}`
      : `"${camp.name}" is not live any more; the rank loop gives its bids back by itself (at most ${SWEEP_LIMIT} campaigns a run). ${nothingChanged}` })
  }
  const s = (await readStates([campaignId])).get(campaignId)
  const what = plan(s)
  if (what === 'kept-by-others') return refused(409, { error: `"${camp.name}" holds a bid floor set by ${floorOwnerWords(s!.floorBy)}, not by Rank & Dayparting, so it stays as it is. ${nothingChanged}` })
  if (what === 'nothing') return refused(409, { error: `"${camp.name}" no longer carries bids Rank & Dayparting changed. ${nothingChanged}` })
  const waitWhy = await rankSwitchedOff()
  const guard = waitWhy ? null : await openEngineGuard('rank-defend')
  const r = await releaseCampaigns([{ campaignId, actor }], { reason: 'rank release — a person gave back the bids on a live campaign no schedule or plan holds', guard, waitWhy })
  return done({ campaignId, name: camp.name, outcome: r.campaigns[0]?.outcome ?? 'nothing', writes: r.writes, deferredWhy: r.deferredWhy })
}

/** The A10 catalog's scope line: how many live campaigns wait for a person ({} when none, or when it cannot be read). */
export async function enabledOrphanScope(): Promise<{ scope?: string }> {
  try {
    const { held, unknown } = await rankHeldNow()
    if (unknown) return {}
    const n = (await pickOrphans(held, true)).size
    if (!n) return {}
    return { scope: `${plural(n, 'live campaign')} still ${n === 1 ? 'carries' : 'carry'} bids it changed and no schedule or plan holds ${n === 1 ? 'it' : 'them'}: it never changes a live campaign by itself, so ${n === 1 ? 'it waits' : 'they wait'} for a person to give the bids back on the Hourly Bids list.` }
  } catch (e) {
    logger.warn('[rank-release] live orphan count unreadable', { error: (e as Error).message })
    return {}
  }
}

/**
 * Campaigns Rank & Dayparting holds right now: an enabled goal-mode schedule, or an enabled product plan's family as its
 * last run resolved it (read off `lastSummary`, as the schedules list does — resolving families live is expensive).
 * Group 4 uses it so another engine (Top-of-search defense) leaves these alone.
 */
export async function rankOwnedCampaignIds(): Promise<Set<string>> {
  const { isGoalMode } = await import('../../jobs/ad-rank-defend.job.js')
  const out = new Set<string>()
  const [schedules, plans] = await Promise.all([
    prisma.adSchedule.findMany({ where: { enabled: true }, select: { campaignId: true, windows: true, defaultTargetKey: true } }),
    prisma.productRankPlan.findMany({ where: { enabled: true }, select: { lastSummary: true } }),
  ])
  for (const s of schedules) if (isGoalMode(s.windows, s.defaultTargetKey)) out.add(s.campaignId)
  for (const p of plans) for (const d of (p.lastSummary as { decisions?: Array<{ campaignId?: string }> } | null)?.decisions ?? []) if (d?.campaignId) out.add(d.campaignId)
  return out
}

// ── The release preview: what a delete, pause or switch-off would give back, read before it happens ─────────────────

export interface ReleasePreviewCampaign {
  campaignId: string
  name: string
  outcome: 'restore' | 'kept-by-others' | 'nothing'
  /** Bids that would come back (floored ones plus base-bid deltas). */
  bids: number
  /** The floor it holds now, in cents (null = not floored, or a legacy 2¢ floor). */
  floorCents: number | null
  /** Who set the floor, in words, when it is not ours. */
  floorBy: string | null
  /** Placement percentages now; they stay as they are (Owner S6). */
  placements: { top: number; rest: number; product: number }
}
export interface ReleasePreview {
  campaigns: number
  /** Campaigns whose bids would come back. */
  restore: number
  /** Bids that would come back across them. */
  bids: number
  keptByOthers: number
  nothing: number
  /** Why the give-back would wait now (ads automation stopped, Rank & Dayparting switched off); null = at once. */
  waitWhy: string | null
  items: ReleasePreviewCampaign[]
}

export async function previewRelease(campaignIds: string[], engine: ScheduleEngine = 'rank-defend'): Promise<ReleasePreview> {
  const states = await readStates(campaignIds)
  const items: ReleasePreviewCampaign[] = [...new Set(campaignIds)].map((id) => {
    const s = states.get(id)
    const outcome = plan(s)
    return {
      campaignId: id, name: s?.name ?? id, outcome,
      bids: outcome === 'restore' ? s!.flooredBids + s!.deltaBids : 0,
      floorCents: s?.floored ? s.floorCents : null,
      floorBy: outcome === 'kept-by-others' ? floorOwnerWords(s!.floorBy) : null,
      placements: s?.placements ?? { top: 0, rest: 0, product: 0 },
    }
  })
  const restore = items.filter((i) => i.outcome === 'restore')
  return {
    campaigns: items.length,
    restore: restore.length,
    bids: restore.reduce((n, i) => n + i.bids, 0),
    keptByOthers: items.filter((i) => i.outcome === 'kept-by-others').length,
    nothing: items.filter((i) => i.outcome === 'nothing').length,
    waitWhy: restore.length ? await releaseWaitWhy(engine) : null,
    items,
  }
}

/** A rank schedule group's preview (GET /advertising/rank-schedule-groups/:id/release-preview); null = no such group. */
export async function previewGroupRelease(groupId: string): Promise<ReleasePreview | null> {
  const group = await prisma.rankScheduleGroup.findUnique({ where: { id: groupId }, select: { id: true } })
  if (!group) return null
  return previewRelease((await readScheduleMembers({ groupId })).map((m) => m.campaignId))
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** A preview in one plain sentence (the switch texts). */
export function releaseSentence(p: ReleasePreview): string {
  if (!p.restore) return p.keptByOthers ? `nothing it floored is floored now (${plural(p.keptByOthers, 'campaign')} floored by someone else stay floored)` : 'nothing it floored is floored now'
  const what = `the ${plural(p.bids, 'bid')} it floored on ${plural(p.restore, 'campaign')} ${p.bids === 1 ? 'comes' : 'come'} back`
  // Owner 2026-10-04 — after the wait, the sweep gives back on a paused campaign only; a live one waits for a person.
  return p.waitWhy ? `${what} on the first run after that changes if the campaign is paused, or when a person gives them back on the Hourly Bids list if it is live (${p.waitWhy})` : `${what} at once`
}

/**
 * Classic dayparting's per-schedule switch (A6): switched off, a schedule floors nothing more and gives back what it
 * floored. Its placements and the campaign's status stay as they are.
 */
export async function scheduleSwitchBrake(scheduleId: string): Promise<string> {
  const base = 'switched off, it floors no more bids in closed windows'
  try {
    const s = await prisma.adSchedule.findUnique({ where: { id: scheduleId }, select: { campaignId: true, originalBids: true } })
    if (!s) return base
    // 2d — and its bid multiplier comes off (ad-dayparting.job.ts giveBackMultiplier).
    const { readSnapshot, multiplierWaitWhy } = await import('../../jobs/ad-dayparting.job.js')
    const snap = readSnapshot(s.originalBids)
    const mult = Object.keys(snap.base).length
      ? `, its bid multiplier${snap.mult != null ? ` (${snap.mult > 0 ? '+' : ''}${snap.mult}%)` : ''} comes off the bids still at the window's level ${(await multiplierWaitWhy(s)) ? 'on the first run after Resume' : 'at once'} (a bid a person changed in the window stays)`
      : ''
    return `${base}${mult}, and ${releaseSentence(await previewRelease([s.campaignId], 'dayparting'))}; placement percentages and the campaign's status stay as they are`
  } catch (e) {
    logger.warn('[rank-release] schedule switch text unreadable', { scheduleId, error: (e as Error).message })
    return base
  }
}

/** The engine switch (Owner S7): switched off, its floors freeze; the text says how many campaigns hold one now. */
export async function rankSwitchBrake(base: string | null): Promise<string | null> {
  try {
    // Its own floors (schedules and plans) and legacy ones with no owner; classic dayparting's run on without it.
    const n = await prisma.campaign.count({
      where: { bidsSuppressedAt: { not: null }, OR: [{ bidsSuppressedBy: null }, { bidsSuppressedBy: '' }, { bidsSuppressedBy: { startsWith: 'automation:rank-defend-' } }, { bidsSuppressedBy: { startsWith: 'automation:rank-plan-' } }] },
    })
    const now = n
      ? `${plural(n, 'campaign')} ${n === 1 ? 'holds' : 'hold'} a bid floor it set right now: switched off, ${n === 1 ? 'it stays' : 'they stay'} floored until it is switched back on, and its first run then gives back every floor no schedule holds on a paused campaign (a live one waits for a person on the Hourly Bids list)`
      : 'no campaign holds a bid floor it set right now'
    return base ? `${base}; ${now}` : now
  } catch (e) {
    logger.warn('[rank-release] engine switch text unreadable', { error: (e as Error).message })
    return base
  }
}
