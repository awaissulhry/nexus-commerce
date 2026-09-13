import { describe, expect, it } from 'vitest'

import { previewCoordinates } from './fixtures'
import { filterCoordinates, filterNote, MASTER_SCOPE_ID, visibleCoordinateKeys } from './filters'

const COORDS = previewCoordinates([
  { channel: 'AMAZON', market: 'IT', label: 'Amazon · IT', connected: true, accountId: 'a' },
  { channel: 'AMAZON', market: 'DE', label: 'Amazon · DE', connected: true, accountId: 'a' },
  { channel: 'AMAZON', market: 'UK', label: 'Amazon · UK', connected: true, accountId: 'a' },
  { channel: 'EBAY', market: 'IT', label: 'eBay · IT', connected: true, accountId: 'e' },
  { channel: 'EBAY', market: 'DE', label: 'eBay · DE', connected: true, accountId: 'e' },
  { channel: 'SHOPIFY', market: 'GLOBAL', label: 'Shopify', connected: true, accountId: 's' },
  { channel: 'ETSY', market: 'GLOBAL', label: 'Etsy', connected: false, accountId: null },
])

describe('filterCoordinates — the scope bar FILTERS the groups; it never switches surfaces', () => {
  it('master = every coordinate, in the read\'s own order (unconnected ones included)', () => {
    const out = filterCoordinates(COORDS, { scope: MASTER_SCOPE_ID, market: 'IT' })
    expect(out.map(c => c.key)).toEqual(COORDS.map(c => c.key))
    expect(out).not.toBe(COORDS)
  })
  it('a channel chip = that channel\'s groups, the region-inventory group included', () => {
    const out = filterCoordinates(COORDS, { scope: 'AMAZON', market: null })
    expect(out.map(c => c.key)).toEqual(['AMAZON:EU', 'AMAZON:IT', 'AMAZON:DE', 'AMAZON:UK'])
  })
  it('channel + market = that market\'s group PLUS the region group that carries its inventory, by KEY', () => {
    const out = filterCoordinates(COORDS, { scope: 'AMAZON', market: 'DE' })
    expect(out.map(c => c.key)).toEqual(['AMAZON:EU', 'AMAZON:DE'])
    /* UK is outside the shared set: its own group only, no region group. */
    expect(filterCoordinates(COORDS, { scope: 'AMAZON', market: 'UK' }).map(c => c.key)).toEqual(['AMAZON:UK'])
  })
  it('eBay + IT = the market group and its alias group (the alias is a coordinate of the same market)', () => {
    const out = filterCoordinates(COORDS, { scope: 'EBAY', market: 'IT' })
    expect(out.map(c => c.key)).toEqual(['EBAY:IT', 'EBAY:IT#preview-alias'])
  })
  it('a market the channel serves on NO coordinate falls back to the channel (never an empty grid)', () => {
    const out = filterCoordinates(COORDS, { scope: 'EBAY', market: 'FR' })
    expect(out.map(c => c.key)).toEqual(['EBAY:IT', 'EBAY:IT#preview-alias', 'EBAY:DE'])
  })
  it('an unknown channel shows nothing, and says so through the note', () => {
    expect(filterCoordinates(COORDS, { scope: 'WOOCOMMERCE', market: null })).toEqual([])
    expect(filterNote(COORDS, { scope: 'WOOCOMMERCE', market: null })).toMatch(/hidden by the scope bar/)
  })
})

describe('filterNote / visibleCoordinateKeys', () => {
  it('is null when nothing is hidden', () => { expect(filterNote(COORDS, { scope: MASTER_SCOPE_ID, market: 'IT' })).toBeNull() })
  it('names the count, the channel label and the market', () => {
    const note = filterNote(COORDS, { scope: 'AMAZON', market: 'DE' }, ch => (ch === 'AMAZON' ? 'Amazon' : ch))
    expect(note).toBe(`${COORDS.length - 2} more coordinates hidden by the scope bar — showing Amazon · DE. Choose Shared product to see them all.`)
  })
  it('the key set matches the filtered list exactly', () => {
    const keys = visibleCoordinateKeys(COORDS, { scope: 'EBAY', market: null })
    expect([...keys].sort()).toEqual(['EBAY:DE', 'EBAY:IT', 'EBAY:IT#preview-alias'])
  })
})
