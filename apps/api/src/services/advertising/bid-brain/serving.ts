/**
 * BID BRAIN BB-18 — the bid that served each keyword's window clicks, for r̂ (paid CPC ÷ bid). Measured against today's
 * bid, r̂ follows the bid's own moves: a cut this morning paid for no settled click yet, so the window's CPC ÷ the new bid
 * reads high, the goal bid falls, and the next cut follows (the bid optimiser's review, 2026-10-08, PR #504).
 *
 * The same helper the bid optimiser reads (ads-bid-window.ts windowBidCents — imported, never copied), over the brain's
 * own window: the moves since its first day (CampaignBidHistory, a stop's sub-floor values left out), each day's serving
 * bid weighted by that day's clicks × the brain's 30-day decay (estimator.ts decayWeight), so the serving bid is taken
 * over exactly the clicks the brain's CPC is. A keyword whose bid never moved is absent (today's bid served them all).
 */
import prisma from '../../../db.js'
import { isServingMove, windowBidCents, type BidMove, type ClickDay } from '../ads-bid-window.js'
import { decayWeight } from './estimator.js'

/** Bid history values under the 5¢ engine floor: a stop's low bid or its restore, never a serving move. */
const SUB_FLOOR_VALUES = ['0', '1', '2', '3', '4']
const DAY_MS = 86_400_000

/** Per keyword that moved inside the window: the bid that served its clicks there, in cents (unrounded). */
export async function loadServingBids(targets: ReadonlyArray<{ id: string; bidCents: number }>, window: { since: Date; until: Date }): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (!targets.length) return out
  const rows = await prisma.campaignBidHistory.findMany({
    where: {
      entityType: 'AD_TARGET', field: 'bid', entityId: { in: targets.map((t) => t.id) }, changedAt: { gte: window.since },
      oldValue: { notIn: SUB_FLOOR_VALUES }, newValue: { notIn: SUB_FLOOR_VALUES },
    },
    select: { entityId: true, oldValue: true, newValue: true, changedAt: true },
  })
  const moves = new Map<string, BidMove[]>()
  for (const r of rows) {
    const move = { at: r.changedAt, fromCents: Number(r.oldValue), toCents: Number(r.newValue) }
    if (isServingMove(move.fromCents, move.toCents)) moves.set(r.entityId, [...(moves.get(r.entityId) ?? []), move])
  }
  if (!moves.size) return out
  const until = Date.UTC(window.until.getUTCFullYear(), window.until.getUTCMonth(), window.until.getUTCDate())
  const perDay = await prisma.amazonAdsDailyPerformance.findMany({
    where: { entityType: 'AD_TARGET', adProduct: 'SPONSORED_PRODUCTS', localEntityId: { in: [...moves.keys()] }, clicks: { gt: 0 }, date: { gte: window.since, lte: window.until } },
    select: { localEntityId: true, date: true, clicks: true },
  })
  const days = new Map<string, ClickDay[]>()
  for (const d of perDay) {
    if (!d.localEntityId) continue
    const daysAgo = Math.round((until - d.date.getTime()) / DAY_MS)
    days.set(d.localEntityId, [...(days.get(d.localEntityId) ?? []), { date: d.date, clicks: d.clicks * decayWeight(daysAgo) }])
  }
  for (const t of targets) {
    const m = moves.get(t.id)
    if (!m) continue
    out.set(t.id, windowBidCents(t.bidCents, m, days.get(t.id) ?? [], window).cents)
  }
  return out
}
