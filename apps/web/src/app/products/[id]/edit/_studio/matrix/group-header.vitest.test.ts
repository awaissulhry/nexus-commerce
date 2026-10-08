import { describe, expect, it } from 'vitest'

import { previewCoordinates } from './fixtures'
import { absentHint, absentLine, buildMatrixColumns, channelTone, drawnCells, MATRIX_GROUP_TONES, notListedLine, placesText, stripTag, stripTitle } from './columns'
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

/* Owner 2026-10-08 — the groups wear colours "just like the product information page", one per channel; Customise's
   hint is one short line with the reasons on its info tip. */
describe('the group colours', () => {
  const flat = (list: readonly unknown[]): Array<Record<string, unknown>> => list.flatMap((d) => { const r = d as Record<string, unknown>; return Array.isArray(r.children) ? flat(r.children) : [r] })
  const headerOf = (def: Record<string, unknown>, before: string | null) => {
    const fn = def.headerClass as (p: unknown) => string[]
    return fn({ column: { getColId: () => def.colId }, api: { getDisplayedColBefore: () => (before ? { getColId: () => before } : null) } })
  }
  it('one colour per channel, the same everywhere; any other channel is cyan', () => {
    expect([channelTone('AMAZON'), channelTone('ebay'), channelTone('SHOPIFY'), channelTone('ETSY'), channelTone('WOOCOMMERCE'), channelTone('OTTO'), channelTone(null)])
      .toEqual(['orange', 'blue', 'purple', 'pink', 'violet', 'cyan', 'cyan'])
    expect(MATRIX_GROUP_TONES).toEqual({ progress: 'slate', shared: 'emerald' })
  })
  it('each group header and each column name under it wear the group\'s tone; the first column draws the edge', () => {
    const coords = previewCoordinates([
      { channel: 'AMAZON', market: 'IT', label: 'Amazon · IT', connected: true, accountId: 'a' },
      { channel: 'EBAY', market: 'IT', label: 'eBay · IT', connected: true, accountId: 'e' },
    ])
    const defs = buildMatrixColumns({ coordinates: coords, cellsOf: () => null, rowOf: () => null, tracker: { get: () => undefined, subscribe: () => () => undefined }, sheetColumns: [], locale: 'it', market: 'IT',
      axesRef: { current: [] }, rowMenuRef: { current: () => [] }, onPickFulfilment: () => undefined, rowsRef: { current: [] } } as never) as Array<Record<string, unknown>>
    const byGroup = new Map(defs.map((g) => [g.groupId as string, g]))
    expect(byGroup.get('grp-product')!.headerClass).toEqual([])
    expect(byGroup.get('grp-progress')!.headerClass).toEqual(['nds-ag-head-tone', 'nds-ag-head-tone--slate', 'nds-ag-head-tone--start'])
    expect(byGroup.get('grp-shared')!.headerClass).toEqual(['nds-ag-head-tone', 'nds-ag-head-tone--emerald', 'nds-ag-head-tone--start'])
    expect(byGroup.get('grp-AMAZON:IT')!.headerClass).toContain('nds-ag-head-tone--orange')
    expect(byGroup.get('grp-EBAY:IT')!.headerClass).toContain('nds-ag-head-tone--blue')
    // Every group's label sits at its start edge, in the one Matrix header.
    for (const g of defs) expect(g.headerGroupComponent).toBeTruthy()
    const ebay = flat([byGroup.get('grp-EBAY:IT')!])
    expect(headerOf(ebay[0], 'AMAZON:IT.salePrice')).toEqual(['nds-ag-head-tone', 'nds-ag-head-tone--blue', 'nds-ag-head-tone--start'])
    expect(headerOf(ebay[1], ebay[0].colId as string)).toEqual(['nds-ag-head-tone', 'nds-ag-head-tone--blue'])
    const identity = flat([byGroup.get('grp-product')!])[0]
    expect(headerOf(identity, null)).toEqual([])
  })
  it('Customise: one short line naming the cells some channels do not offer; null when none', () => {
    const coords = [
      c('AMAZON:IT', 'Amazon · IT', { absent: [{ cell: 'businessPrice', reason: 'x' }, { cell: 'businessTiers', reason: 'x' }] }),
      c('EBAY:IT', 'eBay · IT', { absent: [{ cell: 'salePrice', reason: 'y' }] }),
    ]
    expect(absentLine(coords)).toBe('Not on every channel: B2B price, Tiers, Sale')
    expect(absentLine([c('EBAY:IT', 'eBay · IT')])).toBeNull()
  })
})
