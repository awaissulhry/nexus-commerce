/**
 * Editing correctness (group 3) — the ad group's Targets tab saves its bids in ONE request (bulk-bid, the Bid page's
 * route), not one PATCH per row fired all at once; a status stays its own write. Made-up ids.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BID_NOT_A_NUMBER, eachOfSent, mergeEach, splitTargetEdits } from './targetBids'

const tab = readFileSync(join(__dirname, '..', '[id]', 'ad-groups', '[agId]', 'tabs', 'TargetsTab.tsx'), 'utf8')

describe('an Edit Targets save', () => {
  it('puts every bid in one list (cents), and each status apart', () => {
    const plan = splitTargetEdits([
      { id: 't-a', values: { bid: '0.45' } },
      { id: 't-b', values: { bid: '1,20', status: 'PAUSED' } },
      { id: 't-c', values: { status: 'ENABLED' } },
    ])
    expect(plan.bids).toEqual([{ id: 't-a', bidCents: 45 }, { id: 't-b', bidCents: 120 }])
    expect(plan.statuses).toEqual([{ id: 't-b', status: 'PAUSED' }, { id: 't-c', status: 'ENABLED' }])
    expect(plan.invalid).toEqual([])
  })
  it('a bid box with no bid sends nothing of that row, and says why', () => {
    const plan = splitTargetEdits([{ id: 't-a', values: { bid: 'abc', status: 'PAUSED' } }, { id: 't-b', values: { bid: '0' } }])
    expect(plan.bids).toEqual([])
    expect(plan.statuses).toEqual([])
    expect(plan.invalid).toEqual([{ id: 't-a', reason: BID_NOT_A_NUMBER }, { id: 't-b', reason: BID_NOT_A_NUMBER }])
  })
})

describe('the answers, row by row', () => {
  it('the bulk-bid answer: sent, saved, refused with the server\'s words', () => {
    expect(eachOfSent([
      { targetId: 't-a', ok: true, words: 'Sent', actionLogId: 'l1', queued: true },
      { targetId: 't-b', ok: true, words: 'Saved', actionLogId: 'l2', queued: false },
      { targetId: 't-c', ok: false, words: 'Nexus refuses bids under 5 cents.', actionLogId: null },
    ])).toEqual({ done: ['t-a', 't-b'], queued: 1, failed: [{ id: 't-c', reason: 'Nexus refuses bids under 5 cents.' }] })
  })
  it('a row changed only when each of its writes did; its first refusal says why', () => {
    const bids = { done: ['t-a', 't-b'], queued: 2, failed: [] }
    const statuses = { done: ['t-a'], queued: 1, failed: [{ id: 't-b', reason: 'Refused.' }] }
    const invalid = { done: [], queued: 0, failed: [{ id: 't-c', reason: BID_NOT_A_NUMBER }] }
    expect(mergeEach(invalid, bids, statuses)).toEqual({
      done: ['t-a'], queued: 1, failed: [{ id: 't-c', reason: BID_NOT_A_NUMBER }, { id: 't-b', reason: 'Refused.' }],
    })
  })
})

describe('the Targets tab sends its bids through bulk-bid', () => {
  it('Edit Targets: the bids in one bulkBid, each status its own write', () => {
    expect(tab).toContain("const bids = await bulkBid(plan.bids, 'Edit Targets inline')")
    expect(tab).not.toMatch(/body\.bidCents = /)
  })
  it('Adjust Bid: one bulkBid for the selection, never a PATCH per row', () => {
    expect(tab).toContain("bulkBid(ids.map((id) => ({ id, bidCents })), 'Bulk adjust bid')")
    expect(tab).not.toMatch(/patchEach\(adjustBid\.ids, \{ bidCents/)
  })
})
