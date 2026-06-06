/**
 * M2 verifier — adopt-first reconcile categorization + slot→role mapping.
 */

import { describe, it, expect } from 'vitest'
import { categorizeReconcile, slotToRole } from '../images/amazon-adopt.service.js'

describe('slotToRole', () => {
  it('maps known slots to ListingImage roles', () => {
    expect(slotToRole('MAIN')).toBe('MAIN')
    expect(slotToRole('SWCH')).toBe('SWATCH')
    expect(slotToRole('PS01')).toBe('INFOGRAPHIC')
    expect(slotToRole('PT03')).toBe('GALLERY')
  })
})

describe('categorizeReconcile', () => {
  it('flags onlyOnAmazon / onlyInNexus / urlMismatch and counts inSync', () => {
    const live = [
      { sku: 'A', slot: 'MAIN', url: 'https://m.media-amazon.com/images/I/aaa.jpg' },
      { sku: 'A', slot: 'PT01', url: 'https://m.media-amazon.com/images/I/bbb.jpg' },
      { sku: 'A', slot: 'PT02', url: 'https://m.media-amazon.com/images/I/ccc.jpg' }, // only on Amazon
    ]
    const nexus = [
      { sku: 'A', slot: 'MAIN', url: 'https://m.media-amazon.com/images/I/aaa.jpg' }, // in sync
      { sku: 'A', slot: 'PT01', url: 'https://m.media-amazon.com/images/I/zzz.jpg' }, // mismatch
      { sku: 'A', slot: 'PT05', url: 'https://m.media-amazon.com/images/I/ddd.jpg' }, // only in Nexus
    ]
    const r = categorizeReconcile(live, nexus)
    expect(r.onlyOnAmazon.map((x) => x.slot)).toEqual(['PT02'])
    expect(r.urlMismatch.map((x) => x.slot)).toEqual(['PT01'])
    expect(r.onlyInNexus.map((x) => x.slot)).toEqual(['PT05'])
    expect(r.inSync).toBe(1)
  })

  it('ignores Amazon size-modifier differences (URL-normalized)', () => {
    const live = [{ sku: 'A', slot: 'MAIN', url: 'https://m.media-amazon.com/images/I/aaa._SL75_.jpg' }]
    const nexus = [{ sku: 'A', slot: 'MAIN', url: 'https://m.media-amazon.com/images/I/aaa.jpg' }]
    const r = categorizeReconcile(live, nexus)
    expect(r.urlMismatch).toHaveLength(0)
    expect(r.inSync).toBe(1)
  })
})
