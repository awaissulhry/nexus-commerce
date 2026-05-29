/**
 * Producer: pull bid contexts from the primary app, run the inventory-elasticity
 * formula, and enqueue only material changes (idempotent job ids so the same
 * target→bid move never double-queues).
 */
import { bidQueue, JOB_SET_BID } from './queue.js'
import { PrimaryClient } from './primary-client.js'
import { computeBid, isMaterialChange } from './bidding.js'
import type { BidContext, OptimizeResult } from './types.js'

const primary = new PrimaryClient()

export async function optimizeFromPrimary(opts: { marketplace?: string; limit?: number } = {}): Promise<OptimizeResult> {
  const contexts = await primary.fetchContexts(opts)
  return optimizeContexts(contexts)
}

export async function optimizeContexts(contexts: BidContext[]): Promise<OptimizeResult> {
  let queued = 0
  let skippedDeadband = 0
  for (const c of contexts) {
    const next = computeBid(c)
    if (!isMaterialChange(next, c.currentBidMinor)) { skippedDeadband++; continue }
    await bidQueue.add(
      JOB_SET_BID,
      { bridgeId: c.bridgeId, externalId: c.externalId, accountRef: c.accountRef, bidMinor: next, prevBidMinor: c.currentBidMinor },
      { jobId: `bid:${c.externalId}:${next}` }, // dedupe identical target→bid moves
    )
    queued++
  }
  return { evaluated: contexts.length, queued, skippedDeadband }
}
