/**
 * BID BRAIN BB-6 — a campaign's place in the brain (BidBrainEnrollment), as `set-bid-brain-enrollment` changes it.
 *
 *   live       SHADOW → LIVE: the brain becomes the campaign's one bid writer (while the env ceiling is `live`). Every bid
 *              and placement of the campaign is kept first (`snapshot`), for a give-back. A big door: the approver's code.
 *   shadow     LIVE or HELD → SHADOW: the brain stops writing; the bids stay where they are and today's engines resume.
 *   give-back  LIVE or HELD → SHADOW, and the snapshot is put back (bids, ad group default bids, placements) as the
 *              person who approved it — day-to-day: it can raise bids, so it lists them.
 *   hold       LIVE → HELD until a date: the brain raises nothing (a stop still applies); auto-undo holds this way too.
 *   release    HELD → LIVE.
 *
 * Before LIVE (and on release), the campaign must be Sponsored Products, not kept off by the Owner (AB-1: an exclusion
 * or a lock of its whole bids lever, brain/owner-brakes.ts), on the live-write allowlist, and free of a writer the brain
 * does not take over: a classic dayparting schedule, a running autopilot plan or an older family plan (ProductRankPlan)
 * — switch it off first. BB-7 — an hourly bid plan joins as the brain's input (bid-brain/plan-hour.ts), unless one of
 * its hours sets the ad groups' base bid (the brain sets the bids from the goal). And it must be serving: a campaign a
 * Min-bid hour, a stop or the stock check holds at its floor right now waits until its bids are given back (the
 * snapshot is then the serving bids, and no floor is left that only its old owner would lift).
 * AB-2 — the stop recipe's memory (the lanes and the bidding strategy a stop saved, stop-memory.ts) is read only while the
 * brain owns the campaign, so every way out gives it back and clears it (the tool, as the approver): op shadow puts the
 * saved lanes and strategy back; give-back puts the LIVE-time placements and the saved strategy back; op live gives an
 * old memory back first — setEnrollment refuses LIVE while one is still owed, and drops only a settled one.
 */
import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import { strategyMarket } from '../ads-strategy/bids.js'
import { ownerBrakes } from '../brain/owner-brakes.js'
import { STOP_HOLD_KIND } from './facts.js'
import { brainLiveCeiling } from './live.js'
import { bidBrainMode } from './shadow.js'
import { DOWN_ONLY, readSavedLanes, stopMemoryOwed, UP_AND_DOWN } from './stop-recipe.js'
import { owedWords } from './stop-memory.js'

export const ENROLL_OPS = ['live', 'shadow', 'give-back', 'hold', 'release'] as const
export type EnrollOp = (typeof ENROLL_OPS)[number]
export type EnrollMode = 'SHADOW' | 'LIVE' | 'HELD'

/** How long a hold lasts when the request names no days. */
export const DEFAULT_HOLD_DAYS = 7

export interface EnrollmentSnapshot {
  takenAt: string
  adGroups: Array<{ id: string; defaultBidCents: number }>
  targets: Array<{ id: string; bidCents: number }>
  placements: Array<{ placement: string; percentage: number }>
}

export interface EnrollmentFacts {
  campaign: { id: string; name: string; marketplace: string | null; market: string | null; status: string; adProduct: string | null; allowlisted: boolean; pinBids: boolean }
  /** Null: no row (the brain decides it in shadow while it is allowlisted). */
  enrollment: { mode: EnrollMode; heldUntil: string | null; heldBy: string | null; snapshot: EnrollmentSnapshot | null; updatedAt: string } | null
  /** The env ceiling: whether LIVE takes effect now. */
  ceiling: 'off' | 'shadow' | 'live'
  /** Writers the brain does not take over yet: each refuses LIVE until it is switched off. */
  blockers: string[]
  /** BB-7 — a floor in force now (flooredNow): refuses LIVE until the bids serve again. */
  floored?: string | null
  /** BB-7 review — keywords at a floor the brain set with no memory of their bid (floorsWithoutMemory): refuses op shadow. */
  floorsWithoutMemory?: number
  /** AB-1 review — the Owner keeps the bid brain off it (an exclusion, or its whole bids lever locked): refuses op live and release. */
  ownerBrake?: string | null
  /** AB-2 — what a stop's memory still owes the campaign (stop-recipe.ts stopMemoryOwed), in words; null: nothing owed. */
  stopMemory?: { lanes: boolean; strategy: boolean; savedStrategy: string | null; words: string } | null
}

const placementsOf = (dynamicBidding: unknown): Array<{ placement: string; percentage: number }> =>
  (((dynamicBidding ?? {}) as { placementBidding?: Array<{ placement: string; percentage: number }> }).placementBidding ?? [])
    .filter((p) => typeof p?.placement === 'string' && Number.isFinite(Number(p.percentage)))
    .map((p) => ({ placement: p.placement, percentage: Number(p.percentage) }))

/** The stored snapshot, or null when the row holds none (or not in this shape). */
export function readSnapshot(raw: unknown): EnrollmentSnapshot | null {
  const s = raw as Partial<EnrollmentSnapshot> | null
  if (!s || !Array.isArray(s.targets) || !Array.isArray(s.adGroups)) return null
  return { takenAt: String(s.takenAt ?? ''), adGroups: s.adGroups, targets: s.targets, placements: Array.isArray(s.placements) ? s.placements : [] }
}

/**
 * Writers the brain does not take over on this campaign, and why it cannot go LIVE now. BB-7 — an hourly plan becomes
 * the brain's input, so it no longer blocks (`plansJoin`), unless an hour of it sets a base bid; a classic dayparting
 * schedule, a running autopilot plan and an older family plan still do, and so does a floor in force now.
 */
export async function brainBlockers(campaignId: string, opts: { plansJoin?: boolean } = {}): Promise<string[]> {
  const out: string[] = []
  const schedules = await prisma.adSchedule.findMany({ where: { campaignId, enabled: true }, select: { windows: true, defaultTargetKey: true, targetOverrides: true } })
  const { applyTargetOverrides, isGoalMode, toSpec } = await import('../../../jobs/ad-rank-defend.job.js')
  const goal = schedules.filter((s) => isGoalMode(s.windows, s.defaultTargetKey))
  if (schedules.length > goal.length) out.push('a classic dayparting schedule runs it: switch that schedule off first (the brain does not take classic dayparting over)')
  if (!opts.plansJoin) {
    const { rankOwnedCampaignIds } = await import('../rank-release.service.js')
    if (goal.length || (await rankOwnedCampaignIds()).has(campaignId)) out.push('an hourly bid plan holds it: a campaign joins the brain with its hourly plan from BB-7 (the plan becomes the brain\'s input)')
  } else {
    // BB-7 — every target the plan's week names (its windows and its baseline), with this campaign's overrides.
    const keys = new Set<string>()
    for (const s of goal) {
      if (s.defaultTargetKey) keys.add(s.defaultTargetKey)
      for (const w of Array.isArray(s.windows) ? (s.windows as Array<{ targetKey?: unknown }>) : []) if (typeof w?.targetKey === 'string') keys.add(w.targetKey)
    }
    const targets = keys.size ? await prisma.rankTarget.findMany({ where: { key: { in: [...keys] } } }) : []
    const { setsBaseBid } = await import('./plan-hour.js')
    const baseBid = targets.filter((t) => goal.some((s) => setsBaseBid(applyTargetOverrides(toSpec(t as never), s.targetOverrides as never))))
    if (baseBid.length) out.push(`its hourly plan sets the ad groups' base bid in some hours (${baseBid.map((t) => t.key).join(', ')}): the brain sets the bids from the goal — change those hours to hold the base bid first`)
    // The older family plan (ProductRankPlan): the brain reads only the hourly plans of the Hourly Bids page.
    const family = await prisma.productRankPlan.findMany({ where: { enabled: true }, select: { lastSummary: true } })
    if (family.some((p) => ((p.lastSummary as { decisions?: Array<{ campaignId?: string }> } | null)?.decisions ?? []).some((d) => d?.campaignId === campaignId))) {
      out.push('an older family rank plan runs it: switch that plan off or leave this campaign out of it first (the brain reads the hourly plans of the Hourly Bids page)')
    }
  }
  const { RUNNING_AUTOPILOT_PLANS } = await import('../../../jobs/ad-autopilot.job.js')
  const plans = await prisma.autopilotPlan.findMany({ where: RUNNING_AUTOPILOT_PLANS, select: { name: true, campaignIds: true } })
  const plan = plans.find((p) => Array.isArray(p.campaignIds) && (p.campaignIds as unknown[]).map(String).includes(campaignId))
  if (plan) out.push(`the autopilot plan "${plan.name}" runs it: switch that plan off first`)
  return out
}

/**
 * BB-7 — why the campaign cannot go LIVE right now: a floor in force (a Min-bid hour, a stop, the stock check). The
 * snapshot would keep the floored bids, and only the floor's old owner would lift it. Null: its bids serve.
 * #513 review — a stop still declared as a STOP hold counts too: going LIVE would floor the campaign at once.
 */
export async function flooredNow(campaignId: string): Promise<string | null> {
  const [campaign, flooredGroups, flooredTargets, stops] = await Promise.all([
    prisma.campaign.findFirst({ where: { id: campaignId }, select: { bidsSuppressedAt: true, bidsSuppressedBy: true } }),
    prisma.adGroup.count({ where: { campaignId, bidsSuppressedAt: { not: null } } }),
    prisma.adTarget.count({ where: { adGroup: { campaignId }, suppressedFromBidCents: { not: null }, retiredAt: null } }),
    prisma.bidHold.findMany({ where: { campaignId, targetId: null, kind: STOP_HOLD_KIND, endedAt: null }, select: { by: true }, orderBy: { createdAt: 'asc' } }),
  ])
  if (!campaign?.bidsSuppressedAt && !flooredGroups && !flooredTargets && !stops.length) return null
  const by = [...new Set([...(campaign?.bidsSuppressedAt && campaign.bidsSuppressedBy ? [campaign.bidsSuppressedBy] : []), ...stops.map((h) => h.by)])]
  return `its bids are held at a floor now${by.length ? ` (by ${by.join(', ')})` : ''}: put it under the brain while its bids serve (after a Min-bid hour, a stop or the stock check gave them back)`
}

/** Everything the enrollment tool shows and checks; null when the campaign is not in this business. */
export async function enrollmentFacts(campaignId: string, opts: { plansJoin?: boolean; checkOwnerBrake?: boolean } = {}): Promise<EnrollmentFacts | null> {
  const c = await prisma.campaign.findFirst({
    where: { id: campaignId },
    select: { id: true, name: true, marketplace: true, status: true, adProduct: true, liveBidWritesEnabled: true, pinBids: true, dynamicBidding: true, biddingStrategy: true, suppressedFromPlacements: true, suppressedFromBiddingStrategy: true },
  })
  if (!c) return null
  const row = await prisma.bidBrainEnrollment.findFirst({ where: { campaignId }, select: { mode: true, heldUntil: true, heldBy: true, snapshot: true, updatedAt: true } })
  const mode = bidBrainMode()
  return {
    campaign: { id: c.id, name: c.name, marketplace: c.marketplace, market: strategyMarket(c.marketplace), status: String(c.status), adProduct: c.adProduct, allowlisted: c.liveBidWritesEnabled, pinBids: c.pinBids },
    enrollment: row ? { mode: row.mode as EnrollMode, heldUntil: row.heldUntil?.toISOString() ?? null, heldBy: row.heldBy, snapshot: readSnapshot(row.snapshot), updatedAt: row.updatedAt.toISOString() } : null,
    ceiling: mode,
    blockers: await brainBlockers(c.id, opts),
    floored: await flooredNow(c.id),
    floorsWithoutMemory: row && row.mode !== 'SHADOW' ? await floorsWithoutMemory(c.id) : 0,
    // AB-1 review — read only for op live and release (checkOwnerBrake): nothing about the brain's overrides may stand in the
    // way of the way back out (shadow, give-back, hold). The product's brain resolves them itself, on the state after its change.
    ownerBrake: opts.checkOwnerBrake ? (await ownerBrakes([c.id])).get(c.id) ?? null : null,
    stopMemory: stopMemoryOf(c),
  }
}

/** AB-2 — what a campaign's stop memory still owes it, in words; null when nothing is owed (none, or settled). */
export function stopMemoryOf(c: { dynamicBidding: unknown; biddingStrategy: unknown; suppressedFromPlacements: unknown; suppressedFromBiddingStrategy: unknown }): EnrollmentFacts['stopMemory'] {
  const savedStrategy = c.suppressedFromBiddingStrategy ? String(c.suppressedFromBiddingStrategy) : null
  const owed = stopMemoryOwed({ placements: placementsOf(c.dynamicBidding), biddingStrategy: c.biddingStrategy ? String(c.biddingStrategy) : null, savedPlacements: readSavedLanes(c.suppressedFromPlacements), savedStrategy })
  const words = owedWords(owed, savedStrategy)
  return words ? { ...owed, savedStrategy, words } : null
}

/** BB-7 — an hourly plan joins as the brain's input instead of blocking LIVE (bid-brain/plan-hour.ts). */
export const PLANS_JOIN_THE_BRAIN = true

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/**
 * Why an op cannot run on this campaign now; null: it can. One rule for set-bid-brain-enrollment and for a product's bids
 * lever (brain/enrollment.ts), which puts the product's campaigns LIVE or back to shadow one by one with it.
 */
export function enrollRefusal(f: EnrollmentFacts, op: EnrollOp): string | null {
  const c = f.campaign
  if (c.adProduct && c.adProduct !== 'SPONSORED_PRODUCTS') return `${c.name} is not a Sponsored Products campaign: the bid brain decides Sponsored Products keyword bids only.`
  // AB-2 follow-up — a give-back whose placement write was refused kept a stop's saved lanes: it may run again from shadow.
  if (op === 'give-back' && giveBackAgain(f)) return null
  const next = nextMode(op, f.enrollment?.mode ?? null)
  if ('refusal' in next) return `${c.name}: ${next.refusal}.`
  if (op === 'live' || op === 'release') {
    if (f.ownerBrake) return `${c.name} cannot go LIVE: ${f.ownerBrake}. The bid brain stays off it until that override is ended.`
    if (!c.allowlisted) return `${c.name} is not on the live-write allowlist: no automatic write reaches Amazon for it (set-campaign-live-writes first).`
    if (f.blockers.length) return `${c.name} cannot go LIVE yet: ${f.blockers.join('; ')}.`
  }
  if (op === 'live' && f.floored) return `${c.name} cannot go LIVE now: ${f.floored}.`
  // BB-7 review — back to shadow only when every floor the brain holds can be given back by the engines that take over.
  if (op === 'shadow' && f.floorsWithoutMemory) return `${c.name} cannot go back to shadow now: ${plural(f.floorsWithoutMemory, 'keyword')} ${f.floorsWithoutMemory === 1 ? 'sits' : 'sit'} at a floor the bid brain set that no engine would give back after it (no memory of the bid before, or none an owner's floor mark points at). Use op give-back (it puts back the bids and placements the campaign had when it went LIVE), or try again once the floor has lifted.`
  if (op === 'give-back' && !f.enrollment?.snapshot) return `${c.name} has no snapshot to give back (it never went LIVE).`
  return null
}

/**
 * AB-2 follow-up — a give-back may run again on a campaign already back in shadow while a stop's saved lanes are still
 * owed (its placement write was refused: the lanes kept at 0 %, their memory kept) and the LIVE-time snapshot is there.
 */
export function giveBackAgain(f: Pick<EnrollmentFacts, 'enrollment' | 'stopMemory'>): boolean {
  return f.enrollment?.mode === 'SHADOW' && !!f.enrollment.snapshot && !!f.stopMemory?.lanes
}

/** The mode an op leads to, or why it cannot from here. */
export function nextMode(op: EnrollOp, from: EnrollMode | null): { to: EnrollMode } | { refusal: string } {
  const now = from ?? 'SHADOW'
  switch (op) {
    case 'live': return now === 'SHADOW' ? { to: 'LIVE' } : { refusal: now === 'LIVE' ? 'it is already LIVE' : 'it is HELD: release the hold instead (op release)' }
    case 'shadow': return now !== 'SHADOW' ? { to: 'SHADOW' } : { refusal: 'it is already in shadow' }
    case 'give-back': return now !== 'SHADOW' ? { to: 'SHADOW' } : { refusal: 'it is in shadow: the brain wrote nothing to give back' }
    case 'hold': return now === 'LIVE' ? { to: 'HELD' } : { refusal: now === 'HELD' ? 'it is already HELD' : 'only a LIVE campaign can be held' }
    case 'release': return now === 'HELD' ? { to: 'LIVE' } : { refusal: 'only a HELD campaign can be released' }
  }
}

/** Every bid and placement of the campaign now: what a give-back puts back. */
export async function takeSnapshot(campaignId: string, now = new Date()): Promise<EnrollmentSnapshot> {
  const [campaign, groups, targets] = await Promise.all([
    prisma.campaign.findFirst({ where: { id: campaignId }, select: { dynamicBidding: true } }),
    prisma.adGroup.findMany({ where: { campaignId }, select: { id: true, defaultBidCents: true }, orderBy: { id: 'asc' } }),
    prisma.adTarget.findMany({ where: { adGroup: { campaignId }, isNegative: false, retiredAt: null }, select: { id: true, bidCents: true }, orderBy: { id: 'asc' } }),
  ])
  return { takenAt: now.toISOString(), adGroups: groups, targets, placements: placementsOf(campaign?.dynamicBidding) }
}

/**
 * What a give-back would put back now: the bids that differ from the snapshot, and how many of them rise. AB-2 — and the
 * bidding strategy a stop switched from, while the strategy is still the stop's down only (up and down counts as a raise:
 * Amazon may then lift a bid up to +100 %).
 */
export async function giveBackPlan(campaignId: string, snapshot: EnrollmentSnapshot): Promise<{
  targets: Array<{ id: string; fromCents: number; toCents: number }>
  adGroups: Array<{ id: string; fromCents: number; toCents: number }>
  placements: { from: Array<{ placement: string; percentage: number }>; to: Array<{ placement: string; percentage: number }> } | null
  biddingStrategy?: { from: string; to: string } | null
  raises: number
}> {
  const now = await takeSnapshot(campaignId)
  const strategy = await prisma.campaign.findFirst({ where: { id: campaignId }, select: { biddingStrategy: true, suppressedFromBiddingStrategy: true } })
  const biddingStrategy = strategy?.suppressedFromBiddingStrategy && String(strategy.biddingStrategy) === DOWN_ONLY && strategy.suppressedFromBiddingStrategy !== strategy.biddingStrategy
    ? { from: String(strategy.biddingStrategy), to: String(strategy.suppressedFromBiddingStrategy) }
    : null
  const nowTargets = new Map(now.targets.map((t) => [t.id, t.bidCents]))
  const nowGroups = new Map(now.adGroups.map((g) => [g.id, g.defaultBidCents]))
  const targets = snapshot.targets.flatMap((t) => (nowTargets.has(t.id) && nowTargets.get(t.id) !== t.bidCents ? [{ id: t.id, fromCents: nowTargets.get(t.id)!, toCents: t.bidCents }] : []))
  const adGroups = snapshot.adGroups.flatMap((g) => (nowGroups.has(g.id) && nowGroups.get(g.id) !== g.defaultBidCents ? [{ id: g.id, fromCents: nowGroups.get(g.id)!, toCents: g.defaultBidCents }] : []))
  const key = (list: Array<{ placement: string; percentage: number }>) => JSON.stringify([...list].filter((p) => p.percentage).sort((a, b) => a.placement.localeCompare(b.placement)))
  const placements = key(now.placements) !== key(snapshot.placements) ? { from: now.placements, to: snapshot.placements } : null
  const raises = targets.filter((t) => t.toCents > t.fromCents).length + adGroups.filter((g) => g.toCents > g.fromCents).length
    + (placements && placements.to.some((p) => p.percentage > (placements.from.find((f) => f.placement === p.placement)?.percentage ?? 0)) ? 1 : 0)
    + (biddingStrategy?.to === UP_AND_DOWN ? 1 : 0)
  return { targets, adGroups, placements, biddingStrategy, raises }
}

/** A short fingerprint of the enrollment row: an approval made on another state of it does not run. */
export function enrollmentBasis(f: Pick<EnrollmentFacts, 'enrollment'>): string {
  const e = f.enrollment
  return createHash('sha256').update(JSON.stringify(e ? [e.mode, e.heldUntil, e.updatedAt] : null)).digest('base64url').slice(0, 16)
}

/** Write the new mode (and, for LIVE, the snapshot). Returns the row's mode before and after. */
export async function setEnrollment(args: {
  campaignId: string
  marketplace: string
  op: EnrollOp
  by: string
  holdDays?: number | null
  reason?: string | null
  now?: Date
}): Promise<{ from: EnrollMode | null; to: EnrollMode; snapshot: EnrollmentSnapshot | null }> {
  const now = args.now ?? new Date()
  const row = await prisma.bidBrainEnrollment.findFirst({ where: { campaignId: args.campaignId }, select: { id: true, mode: true } })
  const from = (row?.mode as EnrollMode | undefined) ?? null
  const next = nextMode(args.op, from)
  if ('refusal' in next) throw new Error(`the campaign ${next.refusal}`)
  // AB-2 — going LIVE over a stop recipe's memory from an earlier time: refused while it still owes the campaign something
  // (it still runs on the stop's down only, or its lanes at the stop's 0 %) — never dropped unseen; the tool gives it back
  // first. A settled memory owes nothing and is dropped: the snapshot is the campaign now.
  if (args.op === 'live') {
    const c = await prisma.campaign.findFirst({ where: { id: args.campaignId }, select: { dynamicBidding: true, biddingStrategy: true, suppressedFromPlacements: true, suppressedFromBiddingStrategy: true } })
    const owed = c ? stopMemoryOf(c) : null
    if (owed) throw new Error(`the campaign cannot go LIVE yet: ${owed.words} — give them back first (set-bid-brain-enrollment op live does, as the approver)`)
    if (c && (c.suppressedFromPlacements != null || c.suppressedFromBiddingStrategy != null)) {
      await prisma.campaign.updateMany({ where: { id: args.campaignId }, data: { suppressedFromPlacements: Prisma.DbNull, suppressedFromBiddingStrategy: null } })
    }
  }
  const snapshot = args.op === 'live' ? await takeSnapshot(args.campaignId, now) : null
  const data = {
    mode: next.to,
    ...(snapshot ? { snapshot: snapshot as unknown as Prisma.InputJsonObject, enrolledBy: args.by } : {}),
    ...(next.to === 'HELD'
      ? { heldUntil: new Date(now.getTime() + Math.max(1, args.holdDays ?? DEFAULT_HOLD_DAYS) * 86_400_000), heldBy: args.by, heldReason: args.reason?.slice(0, 500) ?? null }
      : { heldUntil: null, heldBy: null, heldReason: null }),
  }
  if (row) await prisma.bidBrainEnrollment.update({ where: { id: row.id }, data })
  else await prisma.bidBrainEnrollment.create({ data: { campaignId: args.campaignId, marketplace: args.marketplace, enrolledBy: args.by, ...data } })
  // #513 review — leaving the brain (op shadow, give-back), a stop still declared as a STOP hold is never left to the brain
  // alone: with the mark free it takes the mark (handMarkToStopHold), which today's engines, the screens and its owner's
  // lift all read; one behind another owner's mark stays declared and takes the mark when that owner lifts.
  if (next.to === 'SHADOW') {
    const mark = await prisma.campaign.findFirst({ where: { id: args.campaignId }, select: { bidsSuppressedAt: true } })
    if (mark && !mark.bidsSuppressedAt) {
      const { handMarkToStopHold } = await import('../ads-bid-suppression.service.js')
      await handMarkToStopHold(args.campaignId, args.by)
    }
  }
  return { from, to: next.to, snapshot }
}

/** True when LIVE takes effect now (the env ceiling is `live`). */
export const liveTakesEffect = (): boolean => brainLiveCeiling()

/**
 * BID BRAIN BB-10 — the auto-undo hook (design §5): hold campaigns the brain owns, and release them. A hold is the HELD
 * mode until `until`: the brain raises nothing there (a stop still lowers, and lowering is still allowed); past
 * `until` the loader reads it as LIVE again (load.ts). Auto-undo decides; the brain never undoes itself.
 *
 *   holdCampaigns  LIVE → HELD until `until`; a campaign HELD now keeps the later end of the two (and its holder); a
 *                  HELD whose end has passed is held anew (the new holder and reason). SHADOW or not enrolled: nothing to
 *                  hold (left out of the answer). Compare-and-set on the row as read: a person's op in between wins.
 *   releaseHold    HELD → LIVE. Anything else: left as it is.
 * Both answer the campaigns they changed.
 */
export async function holdCampaigns(args: { campaignIds: readonly string[]; until: Date; by: string; reason: string; now?: Date }): Promise<string[]> {
  if (!args.campaignIds.length) return []
  const now = args.now ?? new Date()
  const rows = await prisma.bidBrainEnrollment.findMany({
    where: { campaignId: { in: [...new Set(args.campaignIds)] }, mode: { in: ['LIVE', 'HELD'] } },
    select: { id: true, campaignId: true, mode: true, heldUntil: true },
  })
  const held: string[] = []
  for (const r of rows) {
    const active = r.mode === 'HELD' && r.heldUntil != null && r.heldUntil > now
    if (active && r.heldUntil! >= args.until) continue
    const moved = await prisma.bidBrainEnrollment.updateMany({
      where: { id: r.id, mode: r.mode, heldUntil: r.heldUntil },
      data: { mode: 'HELD', heldUntil: args.until, ...(active ? {} : { heldBy: args.by, heldReason: args.reason.slice(0, 500) }) },
    })
    if (moved.count) held.push(r.campaignId)
  }
  if (held.length) logger.info('[bid-brain] campaigns held', { by: args.by, until: args.until.toISOString(), campaignIds: held, reason: args.reason.slice(0, 200) })
  return held
}

export async function releaseHold(args: { campaignIds: readonly string[]; by: string }): Promise<string[]> {
  if (!args.campaignIds.length) return []
  const rows = await prisma.bidBrainEnrollment.findMany({ where: { campaignId: { in: [...new Set(args.campaignIds)] }, mode: 'HELD' }, select: { id: true, campaignId: true } })
  const released: string[] = []
  for (const r of rows) {
    const moved = await prisma.bidBrainEnrollment.updateMany({ where: { id: r.id, mode: 'HELD' }, data: { mode: 'LIVE', heldUntil: null, heldBy: null, heldReason: null } })
    if (moved.count) released.push(r.campaignId)
  }
  if (released.length) logger.info('[bid-brain] hold released', { by: args.by, campaignIds: released })
  return released
}

/**
 * BB-7 review — the keywords the brain holds at a floor (its newest decision lowered them by a stop, stock, the phase or a
 * Min-bid hour, and the bid still sits there) — floors it wrote itself — that no engine would give back after a hand-back: no memory of their bid
 * before (`AdTarget.suppressedFromBidCents`), or a memory no owner's mark points at (neither the campaign nor the ad
 * group is marked floored — a stock or phase floor the brain read from its source sets none). A give-back still waiting
 * (its newest decision a `restore`, the bid still at the floor it left — refused at the gate) counts too. `op: shadow`
 * refuses while any is left; give-back puts back the snapshot instead.
 */
export async function floorsWithoutMemory(campaignId: string): Promise<number> {
  // Only floors the brain wrote itself (a floor or give-back write since the keyword's last decision no override lowered):
  // a stop someone else wrote, which the brain only held, is that owner's to give back, and a hand-back changes nothing.
  const kept = ['goal', 'band', 'limit', 'no_goal', 'pin', 'freeze']
  const rows = await prisma.$queryRaw<Array<{ n: number }>>(Prisma.sql`
    WITH last AS (
      SELECT DISTINCT ON (d."targetId") d."targetId", d.layer, d."decidedCents", d."currentCents"
        FROM "BidBrainDecision" d
       WHERE d."campaignId" = ${campaignId}
       ORDER BY d."targetId", d."createdAt" DESC),
    unlowered AS (
      SELECT d."targetId", max(d."createdAt") AS at FROM "BidBrainDecision" d
       WHERE d."campaignId" = ${campaignId} AND d.layer = ANY(${kept}::text[])
       GROUP BY d."targetId"),
    wrote AS (
      SELECT DISTINCT d."targetId" FROM "BidBrainDecision" d
        LEFT JOIN unlowered u ON u."targetId" = d."targetId"
       WHERE d."campaignId" = ${campaignId} AND d.action = 'write'
         AND d.layer IN ('stop', 'stock', 'phase', 'min_bid_hour', 'restore')
         AND (u.at IS NULL OR d."createdAt" > u.at))
    SELECT count(*)::int AS n FROM last
      JOIN wrote w ON w."targetId" = last."targetId"
      JOIN "AdTarget" t ON t.id = last."targetId"
      JOIN "AdGroup" g ON g.id = t."adGroupId"
      JOIN "Campaign" c ON c.id = g."campaignId"
     WHERE ((last.layer IN ('stop', 'stock', 'phase', 'min_bid_hour') AND t."bidCents" <= last."decidedCents")
            -- a give-back still waiting (refused at the gate): the keyword sits at the floor it left
            OR (last.layer = 'restore' AND t."bidCents" <= last."currentCents"))
       AND t."retiredAt" IS NULL
       AND (t."suppressedFromBidCents" IS NULL OR (c."bidsSuppressedAt" IS NULL AND g."bidsSuppressedAt" IS NULL))`)
  return rows[0]?.n ?? 0
}
