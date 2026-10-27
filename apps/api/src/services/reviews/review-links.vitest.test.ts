/**
 * Reviews — where our review e-mail's button goes (Owner, 2026-10-27; audit B5, B6): this business's own shop; no shop =
 * no button (never `#`). eBay buyers get no e-mail from Nexus, so no link either.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({ stores: [] as Array<{ region: string | null; isPrimary: boolean; workspaceId: string | null }>, website: null as string | null }))
vi.mock('../../db.js', () => ({
  default: {
    channelConnection: { findMany: vi.fn(async () => db.stores) },
    brandSettings: { findFirst: vi.fn(async () => (db.website === null ? null : { websiteUrl: db.website })) },
  },
}))
vi.mock('../connection-resolver.service.js', () => ({ isOwnConnection: (row: { workspaceId?: string | null }) => row.workspaceId !== 'other-business' }))

import { readShopReviewPage, reviewLinkFor, shopOrigin, shopReviewHeld } from './review-links.service.js'

beforeEach(() => {
  db.stores = []
  db.website = null
})

describe('eBay: no e-mail, so no link (Owner, 2026-10-27: eBay asks its buyers itself)', () => {
  it('an eBay order has no review link, even when the business has a shop', () => {
    expect(reviewLinkFor('EBAY', { url: 'https://x.test/pages/reviews', source: 'website' })).toBeNull()
  })
})

describe('Shopify: this business\'s own shop', () => {
  it('its own connected store first (never another business\'s), then the website in Settings › Company', async () => {
    db.stores = [{ region: 'other.myshopify.com', isPrimary: true, workspaceId: 'other-business' }, { region: 'mine.myshopify.com', isPrimary: false, workspaceId: 'mine' }]
    db.website = 'https://www.example-shop.test/about'
    expect(await readShopReviewPage()).toEqual({ url: 'https://mine.myshopify.com/pages/reviews', source: 'shopify_store' })
    db.stores = []
    expect(await readShopReviewPage()).toEqual({ url: 'https://www.example-shop.test/pages/reviews', source: 'website' })
  })

  it('two stores of its own and none primary: no guess — the website, or no button', async () => {
    db.stores = [{ region: 'a.myshopify.com', isPrimary: false, workspaceId: 'mine' }, { region: 'b.myshopify.com', isPrimary: false, workspaceId: 'mine' }]
    expect(await readShopReviewPage()).toEqual({ url: null, source: null })
  })

  it('no shop: no link (the e-mail has no button) and Settings says why', () => {
    expect(reviewLinkFor('SHOPIFY', { url: null, source: null })).toBeNull()
    expect(shopReviewHeld({ url: null, source: null })).toMatch(/without a review button/)
    expect(shopReviewHeld({ url: 'https://x.test/pages/reviews', source: 'website' })).toBeNull()
    expect(reviewLinkFor('AMAZON', { url: 'https://x.test/pages/reviews', source: 'website' })).toBeNull()
  })

  it('reads a website setting into its origin', () => {
    expect(shopOrigin('shop.example.test')).toBe('https://shop.example.test')
    expect(shopOrigin('HTTP://Shop.Example.test/x?y=1')).toBe('https://shop.example.test')
    expect(shopOrigin('localhost')).toBeNull()
    expect(shopOrigin('')).toBeNull()
  })
})
