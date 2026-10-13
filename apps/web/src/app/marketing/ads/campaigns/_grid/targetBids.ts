/**
 * Editing correctness (group 3, "one save line for every grid") — the ad group's Targets tab saves its bids the way the Bid
 * page's Change bid does: every bid of one save in ONE request (POST /api/advertising/ad-targets/bulk-bid), not one PATCH
 * per row fired all at once. A status stays its own write per row. Pure, tested in Node.
 */
import type { EachResult } from '../../_shared/adsWrite'
import { readAmount } from '../../_shared/budgetInput'
import type { SentBid } from '../../rules-automation/bid/bids/suggestedModel'

/** One Edit Targets row as the grid hands it over: only the fields that changed (collectEdits). */
export interface TargetEdit { id: string; values: Record<string, string> }

export interface TargetEditPlan {
  /** The bids, for one bulk-bid request. */
  bids: Array<{ id: string; bidCents: number }>
  /** The statuses, one write per row. */
  statuses: Array<{ id: string; status: string }>
  /** Rows whose bid box holds no bid: nothing of them is sent. */
  invalid: Array<{ id: string; reason: string }>
}

export const BID_NOT_A_NUMBER = 'Enter the bid as a number above 0, for example 0.45. Nothing of this row was sent.'

/** An Edit Targets save → its bids (one request), its statuses, and the rows it sends nothing for. */
export function splitTargetEdits(edits: readonly TargetEdit[]): TargetEditPlan {
  const plan: TargetEditPlan = { bids: [], statuses: [], invalid: [] }
  for (const e of edits) {
    const bid = e.values.bid
    if (bid != null) {
      const n = readAmount(bid)
      if (n == null || n <= 0) { plan.invalid.push({ id: e.id, reason: BID_NOT_A_NUMBER }); continue }
      plan.bids.push({ id: e.id, bidCents: Math.round(n * 100) })
    }
    if (e.values.status != null) plan.statuses.push({ id: e.id, status: e.values.status })
  }
  return plan
}

/** The bulk-bid answer, row by row, as the tabs' toast reads it (eachSummary). */
export function eachOfSent(sent: readonly SentBid[]): EachResult {
  return {
    done: sent.filter((s) => s.ok).map((s) => s.targetId),
    queued: sent.filter((s) => s.ok && s.queued).length,
    failed: sent.filter((s) => !s.ok).map((s) => ({ id: s.targetId, reason: s.words })),
  }
}

/** Several writes of the same save, one answer per row: a row changed when each of its writes did; its first refusal says why. */
export function mergeEach(...results: readonly EachResult[]): EachResult {
  const failed = new Map<string, string>()
  for (const r of results) for (const f of r.failed) if (!failed.has(f.id)) failed.set(f.id, f.reason)
  const done = [...new Set(results.flatMap((r) => r.done))].filter((id) => !failed.has(id))
  const queued = Math.min(done.length, results.reduce((n, r) => n + r.queued, 0))
  return { done, queued, failed: [...failed].map(([id, reason]) => ({ id, reason })) }
}
