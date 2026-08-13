/**
 * KT.6 — the I/O half: load a row, resolve its ceiling, raise a proposal.
 *
 * The arithmetic lives in `kt6-bid-action.ts` and `kt6-spend-ceiling.ts` and is tested without a
 * database. This file only fetches, persists and hands off.
 *
 * 🔴 **Nothing here writes to Amazon.** `proposeBidChange` records a `KeywordBidProposal` and stops.
 * There is deliberately no apply path in this file: applying is a live bid write, it must go through
 * `checkAdsWriteGate` and `updateAdTargetWithSync` like every other write in the account, and
 * `graduationCeiling` puts a keyword-creating rule at PROPOSE anyway. A proposal is a row in a table;
 * it is not a queued mutation.
 */

import prisma from '../../db.js'
import {
  computeBlastRadius, blastRadiusSentence, KT6_BID_FLOOR_CENTS,
  type Kt6Target, type Kt6BlastRadius,
} from './kt6-bid-action.js'
import {
  resolveCeiling, checkCeiling, commitmentCents,
  type Kt6Ceiling, type Kt6CeilingCheck, type Kt6CeilingGrain,
} from './kt6-spend-ceiling.js'
import { chooseViewPeriod } from './keyword-tracker.service.js'

/** normalise a term the same way the write gate and the watchlist do */
export function normTerm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}

export interface Kt6RowContext {
  term: string
  marketplace: string
  targets: Kt6Target[]
  /** the portfolio and line ids the row touches, for ceiling resolution */
  portfolioIds: string[]
  lineIds: string[]
  shareAgeDays: number | null
}

/**
 * Every keyword target behind one row of the Keyword Tracker, with the campaign facts the blast
 * radius needs.
 *
 * 🔴 Matched on `isNegative: false` and a READ-TIME normalised `expressionValue`, never on
 * `expressionType`: that column is the MATCH TYPE and two crons rewrite it at ~65 rows/min, so a
 * single-spelling filter loses rows. Negativity is `isNegative`.
 */
export async function loadRow(term: string, marketplace: string): Promise<Kt6RowContext> {
  const wanted = normTerm(term)
  const campaigns = await prisma.campaign.findMany({
    where: { marketplace },
    select: {
      id: true, name: true, portfolioId: true,
      liveBidWritesEnabled: true, maxBidCents: true, minBidCents: true,
    },
  })
  const byId = new Map(campaigns.map((c) => [c.id, c]))
  const rows = await prisma.adTarget.findMany({
    where: { isNegative: false, kind: 'KEYWORD', adGroup: { campaign: { marketplace } } },
    select: {
      id: true, expressionValue: true, expressionType: true, bidCents: true,
      suppressedFromBidCents: true, adGroup: { select: { campaignId: true } },
    },
  })

  const targets: Kt6Target[] = []
  for (const t of rows) {
    if (normTerm(t.expressionValue) !== wanted) continue
    const c = t.adGroup ? byId.get(t.adGroup.campaignId) : null
    if (!c) continue
    targets.push({
      id: t.id, expressionValue: t.expressionValue, matchType: t.expressionType,
      bidCents: t.bidCents, suppressedFromBidCents: t.suppressedFromBidCents,
      campaignId: c.id, campaignName: c.name, writable: c.liveBidWritesEnabled,
      maxBidCents: c.maxBidCents, minBidCents: c.minBidCents,
    })
  }

  const touched = new Set(targets.map((t) => t.campaignId))
  const portfolioIds = [...new Set(campaigns.filter((c) => touched.has(c.id) && c.portfolioId).map((c) => c.portfolioId!))]
  // The product LINE for a keyword row is the set of products advertised by the campaigns it touches.
  const lineIds = touched.size
    ? [...new Set((await prisma.adProductAd.findMany({
        where: { adGroup: { campaignId: { in: [...touched] } } }, select: { productId: true },
      })).map((a) => a.productId).filter((p): p is string => !!p))]
    : []

  return { term, marketplace, targets, portfolioIds, lineIds, shareAgeDays: await shareAgeDays(marketplace) }
}

/**
 * How old the share on this row is, in days, measured from the END of the week the grid shows.
 *
 * The end, not the start, because the question is "how old is the newest data behind this". The KT
 * page's own `chooseViewPeriod` picks the week, so this cannot disagree with what is on screen.
 * Measured 2026-08-13: 18 days for IT/DE, 25 for ES/FR.
 */
export interface Kt6ShareAge { days: number | null; label: string | null }

/** e.g. 19 Jul — the same spelling the KT.4 drawer header uses, so the two cannot disagree. */
function weekLabel(d: Date): string {
  return `${d.getUTCDate()} ${d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })}`
}

export async function shareAgeDays(marketplace: string): Promise<number | null> {
  const groups = await prisma.searchQueryPerformance.groupBy({
    by: ['startDate'], where: { marketplace }, _count: { _all: true },
  })
  if (!groups.length) return null
  const chosen = chooseViewPeriod(groups.map((g) => ({ start: g.startDate, rows: g._count._all })))
  if (!chosen.start) return null
  const weekEnd = +chosen.start + 6 * 86_400_000
  return Math.floor((Date.now() - weekEnd) / 86_400_000)
}

/** The age AND the week's label, so the confirmation can name the week the header names. */
export async function shareAge(marketplace: string): Promise<Kt6ShareAge> {
  const groups = await prisma.searchQueryPerformance.groupBy({
    by: ['startDate'], where: { marketplace }, _count: { _all: true },
  })
  if (!groups.length) return { days: null, label: null }
  const chosen = chooseViewPeriod(groups.map((g) => ({ start: g.startDate, rows: g._count._all })))
  if (!chosen.start) return { days: null, label: null }
  const weekEnd = +chosen.start + 6 * 86_400_000
  return { days: Math.floor((Date.now() - weekEnd) / 86_400_000), label: weekLabel(chosen.start) }
}

/** UTC day start — the ledger's bucket, matching the write gate's `utcDayKey`. */
function todayStart(): Date {
  const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d
}

export interface Kt6Committed {
  /** applied today AND NOT SINCE UNDONE, in cents — the number the ceiling compares against */
  committedCents: number
  /** the raw APPLIED sum, ignoring reversals. Carried so the two can be shown to differ. */
  committedBeforeReversalsCents: number
  /** raised but not yet decided, shown separately so a queue of proposals cannot hide */
  pendingCents: number
  pendingCount: number
  amazonSpendCents: number | null
  amazonSpendDate: string | null
}

/**
 * What has already been committed today for a marketplace.
 *
 * APPLIED counts toward the ceiling; PROPOSED does not, because a proposal spends nothing. But
 * pending proposals are returned alongside, because five proposals each under the cap can add up to
 * more than the cap, and an operator approving them one at a time deserves to see that coming.
 */
export async function committedToday(marketplace: string): Promise<Kt6Committed> {
  const since = todayStart()

  // 🔴 A commitment that has been UNDONE is not committed.
  //
  // Found by KT.7's §6 gate: the one-target write was applied and then reversed, and this figure
  // still counted its €0.52 — so the ceiling would have refused a later write on the strength of
  // money that had been given back. `status` stays APPLIED after an undo (the proposal WAS applied;
  // that is history), so the reversal has to be read from the action log, which is where
  // `rolledBackAt` lives. A change set whose rows are all rolled back contributes nothing.
  const appliedRows = await prisma.keywordBidProposal.findMany({
    where: { marketplace, status: 'APPLIED', decidedAt: { gte: since }, executionId: { not: null } },
    select: { id: true, executionId: true, commitmentCents: true },
  })
  let committedCents = 0
  for (const r of appliedRows) {
    const live = await prisma.advertisingActionLog.count({
      where: { executionId: r.executionId as string, rolledBackAt: null },
    })
    if (live > 0) committedCents += r.commitmentCents
  }
  // Proposals applied before executionId was stamped, or with no change set, still count in full.
  const untagged = await prisma.keywordBidProposal.aggregate({
    where: { marketplace, status: 'APPLIED', decidedAt: { gte: since }, executionId: null },
    _sum: { commitmentCents: true },
  })
  committedCents += untagged._sum.commitmentCents ?? 0

  const [applied, pending] = await Promise.all([
    prisma.keywordBidProposal.aggregate({
      where: { marketplace, status: 'APPLIED', decidedAt: { gte: since } },
      _sum: { commitmentCents: true },
    }),
    prisma.keywordBidProposal.aggregate({
      where: { marketplace, status: 'PROPOSED' },
      _sum: { commitmentCents: true }, _count: { _all: true },
    }),
  ])

  // Amazon's own figure, for context only, and always with the date it covers. Measured 2+ days
  // behind, which is exactly why it is not the number the ceiling uses.
  let amazonSpendCents: number | null = null
  let amazonSpendDate: string | null = null
  const latest = await prisma.amazonAdsDailyPerformance.findFirst({
    where: { entityType: 'CAMPAIGN' }, orderBy: { date: 'desc' }, select: { date: true },
  })
  if (latest) {
    amazonSpendDate = latest.date.toISOString().slice(0, 10)
    const ids = (await prisma.campaign.findMany({ where: { marketplace }, select: { id: true } })).map((c) => c.id)
    const agg = await prisma.amazonAdsDailyPerformance.aggregate({
      where: { entityType: 'CAMPAIGN', date: latest.date, localEntityId: { in: ids } },
      _sum: { costMicros: true },
    })
    amazonSpendCents = Math.round(Number(agg._sum.costMicros ?? 0n) / 10000)
  }

  return {
    // the reversal-aware figure, not the raw sum
    committedCents,
    /** what the raw sum would have said, so a discrepancy is visible rather than silent */
    committedBeforeReversalsCents: applied._sum.commitmentCents ?? 0,
    pendingCents: pending._sum.commitmentCents ?? 0,
    pendingCount: pending._count._all,
    amazonSpendCents, amazonSpendDate,
  }
}

/** Load the ceilings that could bind this row, cheapest query that covers all four grains. */
export async function ceilingsFor(row: Kt6RowContext, campaignIds: string[]): Promise<Kt6Ceiling[]> {
  const rows = await prisma.adSpendCeiling.findMany({
    where: {
      enabled: true,
      OR: [
        { grain: 'MARKET', scopeId: row.marketplace },
        { grain: 'LINE', scopeId: { in: row.lineIds } },
        { grain: 'PORTFOLIO', scopeId: { in: row.portfolioIds } },
        { grain: 'CAMPAIGN', scopeId: { in: campaignIds } },
      ],
    },
  })
  return rows.map((r) => ({
    grain: r.grain as Kt6CeilingGrain, scopeId: r.scopeId, label: r.label,
    dailyCapCents: r.dailyCapCents, enabled: r.enabled,
  }))
}

export interface Kt6Preview {
  term: string
  marketplace: string
  requestedBidCents: number
  radius: Kt6BlastRadius
  ceiling: Kt6CeilingCheck
  committed: Kt6Committed
  commitmentCents: number
  shareAgeDays: number | null
  confirmationText: string
  floorCents: number
  /** true when the proposal may be raised at all */
  canPropose: boolean
  /** per-campaign detail, so the drawer can name what it already lists */
  byCampaign: Array<{ campaignId: string; campaignName: string; changing: number; excluded: number; maxBidCents: number | null }>
}

/**
 * The read-only preview: exactly what a proposal WOULD do, with nothing recorded.
 *
 * This is what the drawer renders before the operator commits to anything, and it is the same code
 * path `proposeBidChange` re-runs, so the confirmation cannot describe one thing and the proposal
 * record another.
 */
export async function previewBidChange(args: {
  term: string
  marketplace: string
  requestedBidCents: number
  includeSuppressed?: boolean
}): Promise<Kt6Preview> {
  const row = await loadRow(args.term, args.marketplace)
  const radius = computeBlastRadius(row.targets, args.requestedBidCents, {
    includeSuppressed: args.includeSuppressed,
  })
  const campaignIds = [...new Set(row.targets.map((t) => t.campaignId))]
  const ceilings = await ceilingsFor(row, campaignIds)
  const committed = await committedToday(args.marketplace)
  const commitment = commitmentCents(radius.actionable.length, args.requestedBidCents)

  // The scope for resolution: the narrowest level that is UNAMBIGUOUS. A row touching 17 campaigns
  // has no single campaign ceiling, so campaign/portfolio/line only bind when the row resolves to
  // exactly one of them — otherwise the honest answer is the market's ceiling. Picking one of 17
  // campaigns' ceilings and calling it the row's would be inventing a bound.
  const ceiling = checkCeiling(
    resolveCeiling({
      campaignId: campaignIds.length === 1 ? campaignIds[0] : null,
      portfolioId: row.portfolioIds.length === 1 ? row.portfolioIds[0] : null,
      lineId: row.lineIds.length === 1 ? row.lineIds[0] : null,
      marketplace: args.marketplace,
    }, ceilings),
    committed,
    commitment,
  )

  const age = await shareAge(args.marketplace)
  const confirmationText = blastRadiusSentence(radius, {
    term: args.term, marketplace: args.marketplace,
    shareAgeDays: age.days, shareWeekLabel: age.label, undoWindowHours: 24, proposeOnly: true,
  })

  const byCampaign = campaignIds.map((id) => {
    const mine = row.targets.filter((t) => t.campaignId === id)
    return {
      campaignId: id,
      campaignName: mine[0]?.campaignName ?? id,
      changing: radius.actionable.filter((t) => t.campaignId === id).length,
      excluded: radius.excluded.filter((e) => e.target.campaignId === id).length,
      maxBidCents: mine[0]?.maxBidCents ?? null,
    }
  }).sort((a, b) => b.changing - a.changing || a.campaignName.localeCompare(b.campaignName))

  return {
    term: args.term, marketplace: args.marketplace, requestedBidCents: args.requestedBidCents,
    radius, ceiling, committed, commitmentCents: commitment,
    shareAgeDays: row.shareAgeDays, confirmationText, floorCents: KT6_BID_FLOOR_CENTS,
    canPropose: radius.actionable.length > 0 && ceiling.verdict !== 'REFUSED',
    byCampaign,
  }
}

/**
 * Raise the proposal. Records a row and returns it; writes nothing to Amazon and queues nothing.
 *
 * Re-computes the preview rather than trusting a client-supplied radius — the client's numbers are
 * minutes old at best, bids move hourly, and a proposal that records what the browser believed
 * rather than what the database holds is a proposal that cannot be audited.
 */
/**
 * One shape rather than a discriminated union: apps/api's tsconfig is not strict, and narrowing on
 * `!result.ok` did not discriminate a `{ok:true}|{ok:false}` union — it compiled to an error on the
 * refusal branch. A single interface with optional fields is narrowing-independent.
 */
export interface Kt6ProposalOutcome {
  ok: boolean
  /** set when ok */
  id?: string
  /** set when NOT ok — the refusal sentence, already operator-ready */
  reason?: string
  preview: Kt6Preview
}

export async function proposeBidChange(args: {
  term: string
  marketplace: string
  requestedBidCents: number
  includeSuppressed?: boolean
  proposedBy?: string | null
}): Promise<Kt6ProposalOutcome> {
  const preview = await previewBidChange(args)

  if (preview.ceiling.verdict === 'REFUSED') {
    return { ok: false, reason: preview.ceiling.message, preview }
  }
  if (preview.radius.actionable.length === 0) {
    return { ok: false, reason: preview.confirmationText, preview }
  }

  const row = await prisma.keywordBidProposal.create({
    data: {
      marketplace: args.marketplace,
      term: args.term,
      requestedBidCents: args.requestedBidCents,
      matchedTargets: preview.radius.matchedTargets,
      matchedCampaigns: preview.radius.matchedCampaigns,
      actionableTargets: preview.radius.actionable.length,
      actionableCampaigns: preview.radius.actionableCampaigns,
      excludedByReason: preview.radius.byReason as never,
      targetIds: preview.radius.actionable.map((t) => t.id) as never,
      commitmentCents: preview.commitmentCents,
      ceilingVerdict: preview.ceiling.verdict,
      ceilingGrain: preview.ceiling.bound?.grain ?? null,
      ceilingScopeId: preview.ceiling.bound?.scopeId ?? null,
      ceilingCapCents: preview.ceiling.bound?.dailyCapCents ?? null,
      ceilingMessage: preview.ceiling.message,
      committedCents: preview.committed.committedCents,
      shareAgeDays: preview.shareAgeDays,
      confirmationText: preview.confirmationText,
      status: 'PROPOSED',
      proposedBy: args.proposedBy ?? null,
    },
    select: { id: true },
  })
  return { ok: true, id: row.id, preview }
}

/** The proposals raised for a row, newest first — what the drawer shows under the control. */
export async function proposalsFor(term: string, marketplace: string, limit = 10) {
  return prisma.keywordBidProposal.findMany({
    where: { marketplace, term },
    orderBy: { proposedAt: 'desc' },
    take: limit,
    select: {
      id: true, requestedBidCents: true, actionableTargets: true, actionableCampaigns: true,
      matchedTargets: true, commitmentCents: true, status: true, proposedAt: true, decidedAt: true,
      ceilingVerdict: true, confirmationText: true, shareAgeDays: true, executionId: true,
    },
  })
}
