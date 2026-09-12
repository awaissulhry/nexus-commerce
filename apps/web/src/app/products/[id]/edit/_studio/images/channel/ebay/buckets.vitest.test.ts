/**
 * PES.7 — eBay buckets. The load-bearing test is the one-bucket invariant: eBay does not de-dupe,
 * so a photo in two buckets surfaces twice in one gallery.
 */
import { describe, expect, it } from 'vitest'

import {
  buildBuckets, bucketWarnings, DEFAULT_BUCKET_ID, EBAY_MAX_PER_BUCKET,
  ebayRows, placeInBucket, renumber, type EbayRow,
} from './buckets'

const row = (p: Partial<EbayRow> & { id: string; url: string }): EbayRow => ({
  productId: 'p1', scope: 'PLATFORM', platform: 'EBAY',
  variantGroupKey: null, variantGroupValue: null, position: 0, role: 'GALLERY', ...p,
})

const ROWS: EbayRow[] = [
  row({ id: 'd0', url: 'cover', position: 0, role: 'MAIN' }),
  row({ id: 'd1', url: 'common', position: 1 }),
  row({ id: 'n0', url: 'nero-a', position: 0, variantGroupKey: 'Color', variantGroupValue: 'Nero' }),
  row({ id: 'g0', url: 'giallo-a', position: 0, variantGroupKey: 'Color', variantGroupValue: 'Giallo' }),
]

describe('buildBuckets', () => {
  it('puts Default first — it is what a buyer sees before choosing', () => {
    const b = buildBuckets({ rows: ROWS, axisValues: ['Nero', 'Giallo'] })
    expect(b.map((x) => x.id)).toEqual([DEFAULT_BUCKET_ID, 'Nero', 'Giallo'])
    expect(b[0].groupValue).toBeNull()
  })

  it('orders photos by position, because position 1 is the search thumbnail', () => {
    const jumbled = [row({ id: 'b', url: 'second', position: 1 }), row({ id: 'a', url: 'first', position: 0 })]
    expect(buildBuckets({ rows: jumbled, axisValues: [] })[0].photos.map((p) => p.url))
      .toEqual(['first', 'second'])
  })

  it('shows a stored bucket the axis no longer lists rather than hiding live photos', () => {
    const withGhost = [...ROWS, row({ id: 'r0', url: 'rosso-a', variantGroupKey: 'Color', variantGroupValue: 'Rosso' })]
    const b = buildBuckets({ rows: withGhost, axisValues: ['Nero'] })
    expect(b.map((x) => x.id)).toContain('Rosso')
    expect(b.find((x) => x.id === 'Rosso')!.label).toMatch(/not in the current axis/)
  })

  it('marks a bucket full at eBay’s ceiling', () => {
    const many = Array.from({ length: EBAY_MAX_PER_BUCKET }, (_, i) => row({ id: `x${i}`, url: `u${i}`, position: i }))
    expect(buildBuckets({ rows: many, axisValues: [] })[0].full).toBe(true)
  })

  it('ignores rows belonging to another channel', () => {
    const mixed = [...ROWS, row({ id: 'z', url: 'amz', platform: 'AMAZON' })]
    expect(ebayRows(mixed)).toHaveLength(4)
  })
})

describe('🔴 placeInBucket — the one-bucket invariant', () => {
  it('MOVES a photo out of its old bucket rather than copying it', () => {
    // eBay does not collapse duplicates; the same picture in Default and in Nero shows twice.
    const buckets = buildBuckets({ rows: ROWS, axisValues: ['Nero'] })
    const nero = buckets.find((b) => b.id === 'Nero')!
    const out = placeInBucket({ url: 'common', target: nero, groupKey: 'Color', allRows: ROWS })
    expect(out.kind).toBe('move')
    if (out.kind === 'move') {
      expect(out.removeRowId).toBe('d1')          // the Default row is removed
      expect(out.upsert.variantGroupValue).toBe('Nero')
    }
  })

  it('is a plain add when the photo lives nowhere yet', () => {
    const buckets = buildBuckets({ rows: ROWS, axisValues: ['Nero'] })
    const out = placeInBucket({ url: 'brand-new', target: buckets[0], groupKey: 'Color', allRows: ROWS })
    expect(out.kind).toBe('add')
  })

  it('refuses a photo already in the target bucket instead of duplicating it there', () => {
    const buckets = buildBuckets({ rows: ROWS, axisValues: [] })
    const out = placeInBucket({ url: 'cover', target: buckets[0], groupKey: null, allRows: ROWS })
    expect(out.kind).toBe('refused')
    if (out.kind === 'refused') expect(out.reason).toMatch(/already in this bucket/)
  })

  it('refuses past eBay’s 12-per-variation cap, and names it', () => {
    const many = Array.from({ length: EBAY_MAX_PER_BUCKET }, (_, i) => row({ id: `x${i}`, url: `u${i}`, position: i }))
    const full = buildBuckets({ rows: many, axisValues: [] })[0]
    const out = placeInBucket({ url: 'one-more', target: full, groupKey: null, allRows: many })
    expect(out.kind).toBe('refused')
    if (out.kind === 'refused') expect(out.reason).toMatch(/12 pictures per variation/)
  })

  it('the first Default photo becomes MAIN — it is the cover', () => {
    const empty = buildBuckets({ rows: [], axisValues: [] })[0]
    const out = placeInBucket({ url: 'first', target: empty, groupKey: null, allRows: [] })
    if (out.kind === 'add') expect(out.upsert.role).toBe('MAIN')
  })

  it('a colour bucket’s first photo is not a cover', () => {
    const buckets = buildBuckets({ rows: [], axisValues: ['Nero'] })
    const out = placeInBucket({ url: 'first', target: buckets[1], groupKey: 'Color', allRows: [] })
    if (out.kind === 'add') expect(out.upsert.role).toBe('GALLERY')
  })

  it('never attaches a bucket key to the Default bucket', () => {
    const buckets = buildBuckets({ rows: [], axisValues: [] })
    const out = placeInBucket({ url: 'x', target: buckets[0], groupKey: 'Color', allRows: [] })
    if (out.kind === 'add') {
      expect(out.upsert.variantGroupValue).toBeNull()
      expect(out.upsert.variantGroupKey).toBeNull()
    }
  })
})

describe('renumber', () => {
  it('closes a gap so the cover is never ambiguous', () => {
    const gapped = [row({ id: 'a', url: 'a', position: 0 }), row({ id: 'b', url: 'b', position: 3 })]
    expect(renumber(gapped)).toEqual([{ id: 'b', position: 1 }])
  })

  it('rewrites only what moved', () => {
    const fine = [row({ id: 'a', url: 'a', position: 0 }), row({ id: 'b', url: 'b', position: 1 })]
    expect(renumber(fine)).toEqual([])
  })
})

describe('bucketWarnings', () => {
  it('warns when Default is empty, because that is the search thumbnail', () => {
    const empty = buildBuckets({ rows: [], axisValues: [] })[0]
    expect(bucketWarnings(empty)[0]).toMatch(/search thumbnail/)
  })

  it('says how many photos eBay will actually publish when a bucket is over', () => {
    const many = Array.from({ length: 14 }, (_, i) => row({ id: `x${i}`, url: `u${i}`, position: i }))
    const over = buildBuckets({ rows: many, axisValues: [] })[0]
    expect(bucketWarnings(over).some((w) => /only the first 12/.test(w))).toBe(true)
  })

  it('says nothing about a healthy colour bucket', () => {
    const b = buildBuckets({ rows: ROWS, axisValues: ['Nero'] }).find((x) => x.id === 'Nero')!
    expect(bucketWarnings(b)).toEqual([])
  })
})
