import { beforeEach, expect, it, vi } from 'vitest'

/**
 * PLAN A-39 slice b2 (R-43) — "ours" for one eBay ItemID owner is the builder's own listing input. Here the builder and
 * the facts are stubbed: what is pinned is the ROUTING — a shell never reaches the builder, a refusal is the reason, the
 * reader passes the market's currency, and a builder that targets another ItemID is not compared.
 */
const m = vi.hoisted(() => ({
  listing: null as any,
  facts: vi.fn(async () => ({ destination: { currency: 'EUR' } })),
  build: vi.fn(async () => ({ itemId: '111', shared: { title: 'Giacca FAM', itemSpecifics: { Marca: 'Xavia' } } }) as any),
}))
vi.mock('../../db.js', () => ({ default: { channelListing: { findUnique: async () => m.listing } } }))
vi.mock('../pim/studio-publication-plan.js', () => ({ readPublicationFacts: m.facts }))
vi.mock('../pim/studio-publication-ebay.js', () => ({ buildEbayListingInput: m.build }))

import { ebayContentOurs } from './ebay-content-ours.js'
import { EBAY_SHELL_REASON } from './ebay-content-compare.js'

const owner = (over: Record<string, unknown> = {}) => ({ id: 'l1', productId: 'p1', marketplace: 'IT', channelConnectionId: 'acc', externalListingId: '111',
  product: { productType: 'OUTERWEAR', parentId: null, deletedAt: null }, ...over })

beforeEach(() => { m.facts.mockClear(); m.build.mockClear() })

it('an owner: the builder\'s title and item specifics, with the market\'s currency passed and the listing pinned', async () => {
  m.listing = owner()
  expect(await ebayContentOurs('l1')).toEqual({ ok: true, ours: { listingId: 'l1', itemId: '111', accountId: 'acc', market: 'IT', title: 'Giacca FAM', itemSpecifics: { Marca: 'Xavia' } } })
  expect(m.facts).toHaveBeenCalledWith('p1', { channel: 'EBAY', marketplace: 'IT', accountId: 'acc', listingId: 'l1' })
  expect(m.build).toHaveBeenCalledWith(expect.anything(), { currency: 'EUR' })
})

it('a shell owner: the exact reason, and the builder is never asked', async () => {
  m.listing = owner({ product: { productType: 'EBAY_LISTING_SHELL', parentId: null, deletedAt: null } })
  expect(await ebayContentOurs('l1')).toEqual({ ok: false, reason: EBAY_SHELL_REASON })
  expect(m.facts).not.toHaveBeenCalled()
  expect(m.build).not.toHaveBeenCalled()
})

it('a variant\'s listing is never the unit', async () => {
  m.listing = owner({ product: { productType: 'OUTERWEAR', parentId: 'p0', deletedAt: null } })
  expect(await ebayContentOurs('l1')).toMatchObject({ ok: false, reason: expect.stringContaining('not the ItemID\'s owner listing') })
  expect(m.build).not.toHaveBeenCalled()
})

it('a builder refusal is the reason, word for word', async () => {
  m.listing = owner()
  m.build.mockRejectedValueOnce(new Error('These products belong to different eBay listings. Choose one listing alias before publishing.'))
  expect(await ebayContentOurs('l1')).toEqual({ ok: false, reason: 'the eBay builder refused: These products belong to different eBay listings. Choose one listing alias before publishing.' })
})

it('a builder that targets another ItemID is not compared', async () => {
  m.listing = owner({ externalListingId: '222' })
  expect(await ebayContentOurs('l1')).toEqual({ ok: false, reason: 'the builder targets ItemID 111, not 222' })
})
