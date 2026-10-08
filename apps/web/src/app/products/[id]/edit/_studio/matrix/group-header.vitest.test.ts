import { describe, expect, it } from 'vitest'

import { previewCoordinates } from './fixtures'
import { absentHint, drawnCells, notListedLine, placesText, stripTag, stripTitle } from './columns'
import type { MatrixCoordinate } from './contract'

/**
 * 2026-09-30 — a one-column channel group keeps its NAME readable (matrix.module.css moves the count tag off the
 * line at ≤160px). The counts must then still be somewhere a person can reach: the strip's tooltip carries them.
 */
const COORDS = [
  { channel: 'EBAY', market: 'IT', label: 'eBay · IT', connected: true, accountId: 'acc-e' },
]
const coord = (over: Record<string, unknown>) => ({ ...previewCoordinates(COORDS).find(c => c.key === 'EBAY:IT')!, listed: 20, draft: 0, ...over }) as never

describe('the channel group strip', () => {
  it('the tag counts listings, and adds drafts only when there are some', () => {
    expect(stripTag(coord({}))).toBe('20 listed')
    expect(stripTag(coord({ listed: 0, draft: 1 }))).toBe('0 listed · 1 not listed')
    expect(stripTag(undefined)).toBeNull()
  })
  it('the tooltip carries the whole name AND the counts a narrow group moves off its line', () => {
    // eBay serves no Sale cell: 7 of the 8 kinds — and the Sync kind is not drawn (Owner 2026-10-08): 6 cells on screen.
    expect(stripTitle(coord({}), 'eBay · IT')).toBe('eBay · IT — 6 cells · 20 listed')
    expect(stripTitle(coord({ listed: 0, draft: 1 }), 'eBay · IT')).toBe('eBay · IT — 6 cells · 0 listed · 1 not listed')
    expect(stripTitle(undefined, 'Shared')).toBe('Shared')
  })
})

/* Owner 2026-10-08 — no Sync column, Not listed in one footer line, the Customise hint grouped by cell. */
const c = (key: string, label: string, over: Partial<MatrixCoordinate> = {}): MatrixCoordinate => ({
  key, kind: 'market', channel: key.split(':')[0]!, market: key.split(':')[1]!, label, region: null, alias: null, accountId: 'a', currency: 'EUR',
  connected: true, listed: 1, draft: 0, cells: ['listing', 'syncMode', 'syncQty', 'syncBuffer', 'syncState', 'price'], absent: [], sharedInventoryWith: null, inventoryOn: null,
  vocabulary: { fulfilment: null }, ...over,
})

describe('the simplified chrome (2026-10-08)', () => {
  it('a group draws every kind it serves but the Sync kind (the server still serves it, for the Edit dialog\'s Stock sync)', () => {
    expect(drawnCells(c('EBAY:IT', 'eBay · IT'))).toEqual(['listing', 'syncMode', 'syncQty', 'syncBuffer', 'price'])
  })
  it('the Not listed coordinates are named in ONE line, by channel, in the read\'s order; none → null', () => {
    const coords = [
      c('AMAZON:IT', 'Amazon · IT'),
      c('AMAZON:NL', 'Amazon · NL', { cells: [] }), c('AMAZON:BE', 'Amazon · BE', { cells: [] }),
      c('EBAY:FR', 'eBay · FR', { cells: [] }), c('EBAY:IT#a1', 'eBay · IT ②', { cells: [] }),
      c('WOOCOMMERCE:GLOBAL', 'WooCommerce', { connected: false, cells: [] }),
    ]
    expect(notListedLine(coords)).toBe('Not listed: Amazon NL BE · eBay FR IT ② · WooCommerce')
    expect(notListedLine([c('AMAZON:IT', 'Amazon · IT')])).toBeNull()
    expect(placesText([c('AMAZON:IT', 'Amazon · IT'), c('AMAZON:DE', 'Amazon · DE'), c('SHOPIFY:GLOBAL', 'Shopify')])).toBe('Amazon IT DE · Shopify')
  })
  it('🔴 the Customise hint is grouped by CELL: one group per cell (cells with the same places and words merge), each place said once per reason', () => {
    const b2b = 'Amazon has not enabled business pricing for this account (checked against the OUTERWEAR schema)'
    const coords = [
      c('AMAZON:IT', 'Amazon · IT', { absent: [{ cell: 'businessPrice', reason: b2b }, { cell: 'businessTiers', reason: b2b }] }),
      c('AMAZON:DE', 'Amazon · DE', { absent: [{ cell: 'businessPrice', reason: b2b }, { cell: 'businessTiers', reason: b2b }] }),
      c('EBAY:IT', 'eBay · IT', { absent: [{ cell: 'salePrice', reason: 'eBay sale prices are promotions — Volume pricing' }] }),
      c('ETSY:GLOBAL', 'Etsy', { absent: [{ cell: 'salePrice', reason: 'Etsy has no sale price on a listing' }, { cell: 'fulfilment', reason: 'Etsy has no fulfilment method' }] }),
      c('SHOPIFY:GLOBAL', 'Shopify', { absent: [{ cell: 'fulfilment', reason: 'Shopify has no fulfilment method' }] }),
    ]
    expect(absentHint(coords)).toBe(
      `Not offered here: B2B price, Tiers — Amazon IT DE: ${b2b}`
      + ' · Sale — eBay IT: eBay sale prices are promotions — Volume pricing; Etsy: Etsy has no sale price on a listing'
      + ' · Fulfilment — Etsy: Etsy has no fulfilment method; Shopify: Shopify has no fulfilment method',
    )
    expect(absentHint([c('EBAY:IT', 'eBay · IT')])).toBeNull()
  })
})
