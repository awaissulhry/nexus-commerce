/**
 * BID.S2 — the state vocabulary, pinned.
 *
 * This resolver is the page's shared language: S3–S9 import it rather than re-deriving "is this at
 * the floor". Three properties have to hold for that to be safe, and each one fails silently:
 *
 *   1. **Precedence.** Most rows qualify for several chips; the order decides which two an operator
 *      sees. Reorder it by accident and the grid quietly starts leading with "No data" on a bid
 *      that is above its ceiling.
 *   2. **Mutual exclusion of the three floor states.** `at-floor` is DEFINED as the absence of the
 *      other two. If a row could ever be both `suppressed` and `at-floor`, the page would be
 *      telling the operator a bid restores itself and also that nothing will bring it back.
 *   3. **The filter sees the whole list, the cell sees two.** `hasBidState` must not inherit the
 *      cap, or a chip's filter returns fewer rows than the chip's own count — the NEG.1 defect.
 */

import { describe, it, expect } from 'vitest'
import {
  resolveBidStates, hasBidState, BID_STATE_KEYS, BID_STATE_LABEL, SUPPRESSION_FLOOR_CENTS,
  type BidStateInput, type BidStateKey,
} from './bidState'

/** A row that earns no chip at all: healthy, measured, in auction, owned by a schedule. */
const clean: BidStateInput = {
  bidCents: 34,
  status: 'ENABLED',
  campaignStatus: 'ENABLED',
  minBidCents: null,
  maxBidCents: null,
  suppressedFromBidCents: null,
  inMinBidWindow: false,
  lastAuditedCents: 34,
  unrecorded: false,
  bidder: 'schedule',
  derived: false,
  measured: true,
}
const row = (p: Partial<BidStateInput>): BidStateInput => ({ ...clean, ...p })
const keys = (t: BidStateInput, max?: number) => resolveBidStates(t, max).map((c) => c.key)

describe('resolveBidStates — the clean row', () => {
  it('earns no chip when nothing is wrong', () => {
    expect(keys(clean)).toEqual([])
  })
})

describe('each chip fires on its own condition', () => {
  const cases: Array<[BidStateKey, Partial<BidStateInput>]> = [
    ['out-of-band', { bidCents: 232, maxBidCents: 80 }],
    ['unrecorded', { unrecorded: true, lastAuditedCents: 2, bidCents: 241 }],
    ['suppressed', { suppressedFromBidCents: 28, bidCents: 2 }],
    ['min-bid-window', { inMinBidWindow: true, bidCents: 2 }],
    ['at-floor', { bidCents: 2 }],
    ['no-bidder', { bidder: 'none' }],
    ['not-in-auction', { campaignStatus: 'PAUSED' }],
    ['unnamed', { derived: true }],
    ['no-data', { measured: false }],
  ]
  for (const [key, patch] of cases) {
    it(`${key}`, () => {
      expect(keys(row(patch), Number.MAX_SAFE_INTEGER)).toContain(key)
    })
  }

  it('covers every key in BID_STATE_KEYS — no chip is unreachable', () => {
    expect(new Set(cases.map(([k]) => k))).toEqual(new Set(BID_STATE_KEYS))
  })

  it('every key has a label', () => {
    for (const k of BID_STATE_KEYS) expect(BID_STATE_LABEL[k], k).toBeTruthy()
  })
})

describe('🔴 the three floor states are mutually exclusive', () => {
  it('suppressed wins over at-floor — a remembered value means it comes back', () => {
    const r = row({ bidCents: 2, suppressedFromBidCents: 28 })
    const k = keys(r, Number.MAX_SAFE_INTEGER)
    expect(k).toContain('suppressed')
    expect(k).not.toContain('at-floor')
    expect(k).not.toContain('min-bid-window')
  })

  it('a min-bid window wins over at-floor — the schedule restores it', () => {
    const k = keys(row({ bidCents: 2, inMinBidWindow: true }), Number.MAX_SAFE_INTEGER)
    expect(k).toContain('min-bid-window')
    expect(k).not.toContain('at-floor')
  })

  it('at-floor fires ONLY when neither of the other two does', () => {
    const k = keys(row({ bidCents: 2 }), Number.MAX_SAFE_INTEGER)
    expect(k).toContain('at-floor')
    expect(k).not.toContain('suppressed')
    expect(k).not.toContain('min-bid-window')
  })

  it('never returns more than one of the three, whatever the combination', () => {
    const floors = new Set<BidStateKey>(['suppressed', 'min-bid-window', 'at-floor'])
    for (const supp of [null, 28]) {
      for (const win of [false, true]) {
        for (const bid of [1, 2, 3, 34]) {
          const k = keys(row({ bidCents: bid, suppressedFromBidCents: supp, inMinBidWindow: win }), Number.MAX_SAFE_INTEGER)
          expect(k.filter((x) => floors.has(x)).length, `bid=${bid} supp=${supp} win=${win}`).toBeLessThanOrEqual(1)
        }
      }
    }
  })

  it('uses the SUPPRESSION floor (2¢), not the handlers\' 5¢', () => {
    expect(keys(row({ bidCents: SUPPRESSION_FLOOR_CENTS }), 9)).toContain('at-floor')
    expect(keys(row({ bidCents: SUPPRESSION_FLOOR_CENTS + 1 }), 9)).not.toContain('at-floor')
    expect(keys(row({ bidCents: 5 }), 9)).not.toContain('at-floor')
  })
})

describe('precedence', () => {
  it('is exactly the documented order', () => {
    // A row that earns every chip at once.
    const everything = row({
      bidCents: 2, maxBidCents: 1, unrecorded: true, lastAuditedCents: 99,
      suppressedFromBidCents: 28, bidder: 'none', status: 'ENABLED', campaignStatus: 'PAUSED',
      derived: true, measured: false,
    })
    expect(keys(everything, Number.MAX_SAFE_INTEGER)).toEqual([
      'out-of-band', 'unrecorded', 'suppressed', 'no-bidder', 'not-in-auction', 'unnamed', 'no-data',
    ])
  })

  it('caps at two by default, keeping the two most decision-changing', () => {
    const everything = row({
      bidCents: 2, maxBidCents: 1, unrecorded: true, lastAuditedCents: 99,
      bidder: 'none', campaignStatus: 'PAUSED', derived: true, measured: false,
    })
    expect(resolveBidStates(everything)).toHaveLength(2)
    expect(keys(everything)).toEqual(['out-of-band', 'unrecorded'])
  })

  it('never leads with no-data when something actionable is true', () => {
    const k = keys(row({ measured: false, bidCents: 232, maxBidCents: 80 }))
    expect(k[0]).toBe('out-of-band')
  })
})

describe('🔴 hasBidState ignores the cap', () => {
  it('finds a chip the cell would have dropped', () => {
    const r = row({
      bidCents: 232, maxBidCents: 80, unrecorded: true, lastAuditedCents: 2,
      measured: false, derived: true,
    })
    // The cell shows two.
    expect(keys(r)).toEqual(['out-of-band', 'unrecorded'])
    // The filter must still match the ones it dropped, or `state=no-data` would return fewer rows
    // than the `no-data` count claims.
    expect(hasBidState(r, 'no-data')).toBe(true)
    expect(hasBidState(r, 'unnamed')).toBe(true)
    expect(hasBidState(r, 'suppressed')).toBe(false)
  })

  it('agrees with the uncapped resolver for every key', () => {
    const r = row({ bidCents: 2, bidder: 'none', measured: false, campaignStatus: 'ARCHIVED' })
    const all = new Set(keys(r, Number.MAX_SAFE_INTEGER))
    for (const k of BID_STATE_KEYS) expect(hasBidState(r, k), k).toBe(all.has(k))
  })
})

describe('the unrecorded chip needs a value to compare against', () => {
  it('does not fire when there is no audited value, even if flagged', () => {
    // A never-audited row cannot be "changed since the last record" — there is no last record.
    expect(keys(row({ unrecorded: true, lastAuditedCents: null }), 9)).not.toContain('unrecorded')
  })

  it('names both numbers in the title, so the chip is self-explaining', () => {
    const c = resolveBidStates(row({ unrecorded: true, lastAuditedCents: 2, bidCents: 241 }), 9)
      .find((x) => x.key === 'unrecorded')!
    expect(c.title).toContain('€0.02')
    expect(c.title).toContain('€2.41')
  })
})
