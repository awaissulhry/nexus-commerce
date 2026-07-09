/**
 * EFX P7 — assign/copy/cap semantics for the eBay images drawer buckets.
 *
 * The load-bearing invariants:
 *   - the same URL may live in MULTIPLE buckets (reuse allowed — P7)
 *   - a URL never repeats within ONE bucket (first occurrence wins)
 *   - no op grows a bucket past the cap; overflow rejects the whole
 *     per-bucket op and names it in `blocked` (no silent truncation)
 *
 * Run: npx vitest run apps/web/src/app/products/ebay-flat-file/imageBuckets.vitest.test.ts
 */
import { describe, it, expect } from 'vitest'
import { EBAY_BUCKET_CAP, assignImage, copyImageAt, copySetTo, type Buckets } from './imageBuckets.pure'

const SHARED = '__shared__'

function make(entries: Record<string, string[]>): Buckets {
  return new Map(Object.entries(entries))
}

function urls(n: number, prefix = 'u'): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`)
}

describe('assignImage', () => {
  it('appends to the target bucket WITHOUT removing the URL from other buckets (reuse allowed)', () => {
    const b = make({ [SHARED]: ['a'], Rosso: ['a', 'b'], Nero: [] })
    const { next, blocked, applied } = assignImage(b, 'Nero', null, 'a')
    expect(blocked).toEqual([])
    expect(applied).toEqual(['Nero'])
    expect(next.get('Nero')).toEqual(['a'])
    // the other buckets keep their copies
    expect(next.get(SHARED)).toEqual(['a'])
    expect(next.get('Rosso')).toEqual(['a', 'b'])
  })

  it('replaceIndex replaces in place', () => {
    const b = make({ Rosso: ['a', 'b', 'c'] })
    const { next } = assignImage(b, 'Rosso', 1, 'x')
    expect(next.get('Rosso')).toEqual(['a', 'x', 'c'])
  })

  it('keeps IN-bucket dedup: appending a URL already in the bucket is a no-op', () => {
    const b = make({ Rosso: ['a', 'b'] })
    const { next, applied } = assignImage(b, 'Rosso', null, 'a')
    expect(next.get('Rosso')).toEqual(['a', 'b'])
    expect(applied).toEqual([])
    expect(next).toBe(b) // unchanged input returned as-is
  })

  it('keeps IN-bucket dedup on replace: first occurrence wins', () => {
    const b = make({ Rosso: ['a', 'b', 'c'] })
    const { next } = assignImage(b, 'Rosso', 2, 'a') // 'a' already at index 0
    expect(next.get('Rosso')).toEqual(['a', 'b'])
  })

  it('blocks an append that would exceed the cap (no silent truncation)', () => {
    const b = make({ Rosso: urls(EBAY_BUCKET_CAP) })
    const { next, blocked, applied } = assignImage(b, 'Rosso', null, 'overflow')
    expect(blocked).toEqual(['Rosso'])
    expect(applied).toEqual([])
    expect(next).toBe(b)
    expect(next.get('Rosso')).toHaveLength(EBAY_BUCKET_CAP)
  })

  it('does NOT block at the cap when the URL is already in the bucket (dedup keeps size)', () => {
    const full = urls(EBAY_BUCKET_CAP)
    const b = make({ Rosso: full })
    const { blocked } = assignImage(b, 'Rosso', null, full[0])
    expect(blocked).toEqual([])
  })

  it('replace at the cap never blocks (size unchanged)', () => {
    const b = make({ Rosso: urls(EBAY_BUCKET_CAP) })
    const { next, blocked } = assignImage(b, 'Rosso', 3, 'fresh')
    expect(blocked).toEqual([])
    expect(next.get('Rosso')![3]).toBe('fresh')
    expect(next.get('Rosso')).toHaveLength(EBAY_BUCKET_CAP)
  })
})

describe('copyImageAt (Alt/Option-drag copy)', () => {
  it('copies into the target at the index and leaves the source bucket untouched', () => {
    const b = make({ Rosso: ['a', 'b'], Nero: ['c'] })
    const { next, applied } = copyImageAt(b, 'a', 'Nero', 0)
    expect(next.get('Nero')).toEqual(['a', 'c'])
    expect(next.get('Rosso')).toEqual(['a', 'b']) // source keeps its copy
    expect(applied).toEqual(['Nero'])
  })

  it('repositions when the target already contains the URL (no duplicate in one bucket)', () => {
    const b = make({ Nero: ['a', 'b', 'c'] })
    const { next, blocked } = copyImageAt(b, 'a', 'Nero', 2)
    expect(blocked).toEqual([])
    expect(next.get('Nero')).toEqual(['b', 'c', 'a'])
  })

  it('blocks a copy into a bucket already at the cap', () => {
    const b = make({ Rosso: ['x'], Nero: urls(EBAY_BUCKET_CAP) })
    const { next, blocked, applied } = copyImageAt(b, 'x', 'Nero', 5)
    expect(blocked).toEqual(['Nero'])
    expect(applied).toEqual([])
    expect(next).toBe(b)
  })

  it('clamps an out-of-range index to the end', () => {
    const b = make({ Nero: ['a', 'b'] })
    const { next } = copyImageAt(b, 'x', 'Nero', 99)
    expect(next.get('Nero')).toEqual(['a', 'b', 'x'])
  })
})

describe('copySetTo (Copy this set to… / Duplicate to all values)', () => {
  it('merge-appends the source set into each target, preserving target-first order', () => {
    const b = make({ [SHARED]: ['s1', 's2'], Rosso: ['s2', 'r1'], Nero: [] })
    const { next, blocked, applied } = copySetTo(b, SHARED, ['Rosso', 'Nero'])
    expect(blocked).toEqual([])
    expect(applied).toEqual(['Rosso', 'Nero'])
    expect(next.get('Rosso')).toEqual(['s2', 'r1', 's1']) // keeps own images, gains only missing
    expect(next.get('Nero')).toEqual(['s1', 's2'])
    expect(next.get(SHARED)).toEqual(['s1', 's2']) // source untouched
  })

  it('skips the source bucket even when listed as a target', () => {
    const b = make({ Rosso: ['a'], Nero: [] })
    const { next } = copySetTo(b, 'Rosso', ['Rosso', 'Nero'])
    expect(next.get('Rosso')).toEqual(['a'])
    expect(next.get('Nero')).toEqual(['a'])
  })

  it('rejects a target that would exceed the cap WHOLE (no partial fill) while other targets still apply', () => {
    const b = make({
      Rosso: ['a', 'b'],
      Nero: urls(EBAY_BUCKET_CAP - 1), // 11 + 2 missing → 13 → blocked
      Blu: ['a'],                       // 1 + 1 missing → 2 → applied
    })
    const { next, blocked, applied } = copySetTo(b, 'Rosso', ['Nero', 'Blu'])
    expect(blocked).toEqual(['Nero'])
    expect(applied).toEqual(['Blu'])
    expect(next.get('Nero')).toEqual(urls(EBAY_BUCKET_CAP - 1)) // untouched, not truncated
    expect(next.get('Blu')).toEqual(['a', 'b'])
  })

  it('a target already containing the whole set is neither applied nor blocked', () => {
    const b = make({ Rosso: ['a', 'b'], Nero: ['b', 'a'] })
    const { next, blocked, applied } = copySetTo(b, 'Rosso', ['Nero'])
    expect(blocked).toEqual([])
    expect(applied).toEqual([])
    expect(next).toBe(b)
  })

  it('exactly filling a target to the cap is allowed', () => {
    const b = make({ Rosso: ['x'], Nero: urls(EBAY_BUCKET_CAP - 1) })
    const { next, blocked, applied } = copySetTo(b, 'Rosso', ['Nero'])
    expect(blocked).toEqual([])
    expect(applied).toEqual(['Nero'])
    expect(next.get('Nero')).toHaveLength(EBAY_BUCKET_CAP)
  })
})
