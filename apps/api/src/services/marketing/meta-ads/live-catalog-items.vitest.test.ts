/**
 * Meta step 35 — the live pieces of the item and feed changes: an item's READ names turned into the WRITE names a change
 * sends (and what cannot be read back exactly), Meta's catalog price text, the feeds Nexus made (its own records, this
 * catalog and ad account only), and "Nexus alone writes this catalog" (its app and its own feeds; anything else refuses).
 * Made-up ids only.
 */
import { describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ rows: [] as Array<{ after: unknown }> }))
vi.mock('../../../db.js', () => ({ default: { agentChange: { findMany: vi.fn(async () => h.rows) } } }))

import { catalogPriceText, nexusAloneProblem, ownCatalogFeedIds, writeStateOf } from './live-catalog-items.js'
import type { CatalogWriter, ReadableCatalog } from './catalog-rule.js'

const catalog = (more: Partial<ReadableCatalog> = {}): ReadableCatalog => ({ catalogId: '120000000000100', portfolioId: '120000000000090', relation: 'owned', ownerBusinessId: '120000000000090', name: 'Catalog A', vertical: 'commerce', productCount: 3, isSegment: false, ...more })
const writer = (evidence: CatalogWriter['evidence'], more: Partial<CatalogWriter> = {}): CatalogWriter => ({
  catalogId: '120000000000100', writer: 'feed', shopifyWrites: false, nexusMayWriteItems: false, sentence: 'A data feed writes these items.', evidence, commerceAccountId: null, ownership: 'owned', deep: true, notRead: [], ...more,
})
const feed = (id: string, kind: 'feed' | 'shopify' | 'partner' = 'feed') => ({ from: 'feed' as const, id, name: 'Feed', kind, supplementary: false, detail: '' })

describe('catalogPriceText — Meta\'s "<amount> <ISO>" from minor units', () => {
  it('writes the currency\'s own decimals, a period, the code; refuses what is not whole', () => {
    expect(catalogPriceText(4990, 'EUR')).toBe('49.90 EUR')
    expect(catalogPriceText(5, 'EUR')).toBe('0.05 EUR')
    expect(catalogPriceText(490, 'JPY')).toBe('490 JPY')
    expect(catalogPriceText(1250, 'BHD')).toBe('1.250 BHD')
    expect(catalogPriceText(-1, 'EUR')).toBeNull()
    expect(catalogPriceText(49.9, 'EUR')).toBeNull()
    expect(catalogPriceText(4990, 'eur')).toBeNull()
    expect(catalogPriceText(4990, null)).toBeNull()
  })
})

describe('writeStateOf — an item\'s write fields from Meta\'s read names', () => {
  it('maps the read names, keeps none as null and what Nexus cannot read back exactly as undefined', () => {
    const state = writeStateOf({
      id: '120000000000120', retailer_id: 'SKU-A', name: 'Jacket A', description: 'A jacket.', availability: 'in stock', condition: 'new', price: '€49,90', currency: 'EUR',
      sale_price: null, url: 'https://shop.example.com/a', image_url: 'https://shop.example.com/a.jpg', additional_image_urls: ['https://shop.example.com/b.jpg'],
      manufacturer_part_number: 'MPN-1', retailer_product_group_id: 'GROUP-A', tags: ['summer'], custom_label_0: 'Sale', custom_number_1: '7',
      capabilities_disabled_by_user: ['da'], visibility: 'staging', shipping_weight_value: 1.5, shipping_weight_unit: 'kg', additional_variant_attributes: { Scent: 'Fruity' },
    })
    expect(state).toMatchObject({
      title: 'Jacket A', price: '49.90 EUR', sale_price: null, link: 'https://shop.example.com/a', image: [{ url: 'https://shop.example.com/a.jpg' }, { url: 'https://shop.example.com/b.jpg' }],
      mpn: 'MPN-1', item_group_id: 'GROUP-A', internal_label: ['summer'], custom_label_0: 'Sale', custom_label_1: null, custom_number_1: 7, disabled_capabilities: ['da'],
      status: 'archived', shipping_weight: '1.5 kg', additional_variant_attribute: 'Scent:Fruity',
    })
    expect(state.google_product_category).toBeUndefined()
    expect(state.shipping).toBeUndefined()
    expect('google_product_category' in state).toBe(true)
    expect(writeStateOf({ price: 'about fifty', currency: 'EUR' }).price).toBeUndefined()
    expect(writeStateOf({ availability: 'pending' }).availability).toBeUndefined()
    expect(writeStateOf({ tags: ["it's"] }).internal_label).toBeUndefined()
    expect(writeStateOf({}).internal_label).toEqual([])
    expect(writeStateOf({ sale_price_start_date: '2026-11-01T00:00:00+0100', sale_price_end_date: '2026-11-30T23:59:00+0100' }).sale_price_effective_date).toBe('2026-10-31T23:00+0000/2026-11-30T22:59+0000')
  })
})

describe('ownCatalogFeedIds — the feeds Nexus made on this catalog of this ad account, from its own records', () => {
  it('only creates of set-meta-catalog-feed on the same catalog and ad account, with a Meta id', async () => {
    h.rows = [
      { after: { op: 'create', catalogId: '120000000000100', adAccountId: '1234567890', feedId: '120000000000131' } },
      { after: { op: 'create', catalogId: '120000000000100', adAccountId: '1234567890', feedId: null } },
      { after: { op: 'create', catalogId: '120000000000102', adAccountId: '1234567890', feedId: '120000000000132' } },
      { after: { op: 'create', catalogId: '120000000000100', adAccountId: '9999999999', feedId: '120000000000133' } },
      { after: { op: 'labels', catalogId: '120000000000100', adAccountId: '1234567890', feedId: '120000000000134' } },
    ]
    expect(await ownCatalogFeedIds('120000000000100', '1234567890')).toEqual(['120000000000131'])
  })
})

describe('nexusAloneProblem — a catalog only Nexus writes (its app, its own feeds)', () => {
  it('passes with Nexus\'s own feeds and app only; refuses a foreign feed, Shopify, a segment, anything unread', () => {
    expect(nexusAloneProblem(catalog(), writer([feed('120000000000131')]), ['120000000000131'])).toBeNull()
    expect(nexusAloneProblem(catalog(), writer([{ from: 'data source', id: '9', name: null, kind: 'api', supplementary: false, detail: '', nexusApp: true }]), [])).toBeNull()
    expect(nexusAloneProblem(catalog(), writer([feed('120000000000131'), feed('120000000000139')]), ['120000000000131'])).toMatch(/feed 120000000000139 \(feed\) is not/)
    expect(nexusAloneProblem(catalog(), writer([feed('120000000000131', 'shopify')]), ['120000000000131'])).toMatch(/^Shopify owns these items/)
    expect(nexusAloneProblem(catalog({ isSegment: null }), writer([]), [])).toMatch(/segment/)
    expect(nexusAloneProblem(catalog(), writer([], { notRead: ['feeds: refused'] }), [])).toMatch(/could not read everything/)
    expect(nexusAloneProblem(catalog(), writer([], { ownership: 'shared', sentence: 'shared' }), [])).toBe('shared')
  })
})
