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
 * Before LIVE, the campaign must be Sponsored Products, on the live-write allowlist, and free of a writer the brain
 * does not take over: a classic dayparting schedule, a running autopilot plan or an older family plan (ProductRankPlan)
 * — switch it off first. BB-7 — an hourly bid plan joins as the brain's input (bid-brain/plan-hour.ts), unless one of
 * its hours sets the ad groups' base bid (the brain sets the bids from the goal). And it must be serving: a campaign a
 * Min-bid hour, a stop or the stock check holds at its floor right now waits until its bids are given back (the
 * snapshot is then the serving bids, and no floor is left that only its old owner would lift).
 */
import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import prisma from '../../../db.js'
import { strategyMarket } from '../ads-strategy/bids.js'
import { brainLiveCeiling } from './live.js'
import { bidBrainMode } from './shadow.js'

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
 */
export async function flooredNow(campaignId: string): Promise<string | null> {
  const [campaign, flooredGroups, flooredTargets] = await Promise.all([
    prisma.campaign.findFirst({ where: { id: campaignId }, select: { bidsSuppressedAt: true, bidsSuppressedBy: true } }),
    prisma.adGroup.count({ where: { campaignId, bidsSuppressedAt: { not: null } } }),
    prisma.adTarget.count({ where: { adGroup: { campaignId }, suppressedFromBidCents: { not: null }, retiredAt: null } }),
  ])
  if (!campaign?.bidsSuppressedAt && !flooredGroups && !flooredTargets) return null
  return `its bids are held at a floor now${campaign?.bidsSuppressedBy ? ` (by ${campaign.bidsSuppressedBy})` : ''}: put it under the brain while its bids serve (after a Min-bid hour, a stop or the stock check gave them back)`
}

/** Everything the enrollment tool shows and checks; null when the campaign is not in this business. */
export async function enrollmentFacts(campaignId: string, opts: { plansJoin?: boolean } = {}): Promise<EnrollmentFacts | null> {
  const c = await prisma.campaign.findFirst({
    where: { id: campaignId },
    select: { id: true, name: true, marketplace: true, status: true, adProduct: true, liveBidWritesEnabled: true, pinBids: true },
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
  }
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

/** What a give-back would put back now: the bids that differ from the snapshot, and how many of them rise. */
export async function giveBackPlan(campaignId: string, snapshot: EnrollmentSnapshot): Promise<{
  targets: Array<{ id: string; fromCents: number; toCents: number }>
  adGroups: Array<{ id: string; fromCents: number; toCents: number }>
  placements: { from: Array<{ placement: string; percentage: number }>; to: Array<{ placement: string; percentage: number }> } | null
  raises: number
}> {
  const now = await takeSnapshot(campaignId)
  const nowTargets = new Map(now.targets.map((t) => [t.id, t.bidCents]))
  const nowGroups = new Map(now.adGroups.map((g) => [g.id, g.defaultBidCents]))
  const targets = snapshot.targets.flatMap((t) => (nowTargets.has(t.id) && nowTargets.get(t.id) !== t.bidCents ? [{ id: t.id, fromCents: nowTargets.get(t.id)!, toCents: t.bidCents }] : []))
  const adGroups = snapshot.adGroups.flatMap((g) => (nowGroups.has(g.id) && nowGroups.get(g.id) !== g.defaultBidCents ? [{ id: g.id, fromCents: nowGroups.get(g.id)!, toCents: g.defaultBidCents }] : []))
  const key = (list: Array<{ placement: string; percentage: number }>) => JSON.stringify([...list].filter((p) => p.percentage).sort((a, b) => a.placement.localeCompare(b.placement)))
  const placements = key(now.placements) !== key(snapshot.placements) ? { from: now.placements, to: snapshot.placements } : null
  const raises = targets.filter((t) => t.toCents > t.fromCents).length + adGroups.filter((g) => g.toCents > g.fromCents).length
    + (placements && placements.to.some((p) => p.percentage > (placements.from.find((f) => f.placement === p.placement)?.percentage ?? 0)) ? 1 : 0)
  return { targets, adGroups, placements, raises }
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
  return { from, to: next.to, snapshot }
}

/** True when LIVE takes effect now (the env ceiling is `live`). */
export const liveTakesEffect = (): boolean => brainLiveCeiling()

/**
 * BB-7 review — the keywords the brain holds at a floor (its newest decision lowered them by a stop, stock, the phase or a
 * Min-bid hour, and the bid still sits there) with no memory of their bid before (`AdTarget.suppressedFromBidCents`).
 * Handed back like this, no engine would give them back: `op: shadow` refuses until they have one (shadow.ts
 * rememberFloors keeps it for every floor the brain writes) — give-back puts back the snapshot instead.
 */
export async function floorsWithoutMemory(campaignId: string): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ n: number }>>(Prisma.sql`
    SELECT count(*)::int AS n FROM (
      SELECT DISTINCT ON (d."targetId") d."targetId", d.layer, d."decidedCents"
        FROM "BidBrainDecision" d
       WHERE d."campaignId" = ${campaignId}
       ORDER BY d."targetId", d."createdAt" DESC) last
      JOIN "AdTarget" t ON t.id = last."targetId"
     WHERE last.layer IN ('stop', 'stock', 'phase', 'min_bid_hour')
       AND t."bidCents" <= last."decidedCents" AND t."suppressedFromBidCents" IS NULL AND t."retiredAt" IS NULL`)
  return rows[0]?.n ?? 0
}
