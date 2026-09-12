/**
 * PES.7 — the mirror diff's safety reading. The load-bearing test is the empty-cache one: a diff
 * computed against nothing reports "0 deletes", which reads as safe and is not.
 */
import { describe, expect, it } from 'vitest'

import { asinsLosingImages, readMirrorDiff, type MirrorDiff } from './mirrorPlan'

const diff = (over: Partial<MirrorDiff['totals']> = {}, perAsin: MirrorDiff['perAsin'] = []): MirrorDiff => ({
  perAsin,
  totals: { adds: 3, replaces: 1, deletes: 2, asins: 4, skipped: 0, ...over },
})

describe('🔴 an empty live cache is never presented as a clean diff', () => {
  it('withholds the totals entirely when nothing has been read back', () => {
    const r = readMirrorDiff({ diff: diff({ deletes: 0 }), liveRowCount: 0 })
    expect(r.trust).toBe('unknown')
    // The numbers are NOT shown — "0 deletes" beside the word deletes is the misreading.
    expect(r.totals).toBeNull()
    expect(r.canDescribePublish).toBe(false)
  })

  it('says what a mirror publish DOES, and that we cannot say what it would remove', () => {
    const r = readMirrorDiff({ diff: diff(), liveRowCount: 0 })
    expect(r.statement).toMatch(/REMOVES any slot Amazon has/)
    expect(r.statement).toMatch(/do not know what Amazon has/)
    expect(r.statement).toMatch(/Check Amazon first/)
  })

  it('treats an unrun comparison as unknown too, not as clean', () => {
    const r = readMirrorDiff({ diff: null, liveRowCount: 12 })
    expect(r.trust).toBe('unknown')
    expect(r.canDescribePublish).toBe(false)
  })
})

describe('a comparable diff', () => {
  it('reports the three numbers with removal named in the clear', () => {
    const r = readMirrorDiff({ diff: diff(), liveRowCount: 12 })
    expect(r.trust).toBe('comparable')
    expect(r.canDescribePublish).toBe(true)
    expect(r.statement).toMatch(/3 slots added, 1 replaced, 2 REMOVED from Amazon/)
  })

  it('explains skipped ASINs as protected rather than as failures', () => {
    // Skipped means Nexus has no MAIN, so the mirror leaves that listing alone instead of wiping it.
    const r = readMirrorDiff({ diff: diff({ skipped: 2 }), liveRowCount: 12 })
    expect(r.statement).toMatch(/left untouched rather than wiped/)
    expect(r.skipped).toBe(2)
  })

  it('handles singulars without reading like a template', () => {
    const r = readMirrorDiff({ diff: diff({ adds: 1, replaces: 0, deletes: 0, skipped: 1 }), liveRowCount: 4 })
    expect(r.statement).toMatch(/1 slot added/)
    expect(r.statement).toMatch(/1 ASIN is skipped/)
  })
})

describe('asinsLosingImages', () => {
  it('names only the ASINs that would actually lose something', () => {
    const rows: MirrorDiff['perAsin'] = [
      { sku: 'A', asin: 'B01', skipped: false, adds: [], replaces: [], deletes: [{ slot: 'PT01', url: 'u' }], unchanged: 3 },
      { sku: 'B', asin: 'B02', skipped: false, adds: [{ slot: 'PT02', url: 'v' }], replaces: [], deletes: [], unchanged: 2 },
    ]
    expect(asinsLosingImages(diff({}, rows)).map((a) => a.asin)).toEqual(['B01'])
  })

  it('returns nothing when there is no diff to read', () => {
    expect(asinsLosingImages(null)).toEqual([])
  })
})
