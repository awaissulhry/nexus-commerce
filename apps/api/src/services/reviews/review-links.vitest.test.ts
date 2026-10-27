/**
 * Reviews — where our review e-mail's button goes (Owner, 2026-10-27; audit B5, B6): the buyer's own eBay site, this
 * business's own shop; no shop = no button (never `#`).
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

import { ebayFeedbackUrl, readShopReviewPage, reviewLinkFor, shopOrigin, shopReviewHeld } from './review-links.service.js'

beforeEach(() => {
  db.stores = []
  db.website = null
})

describe('eBay: the buyer\'s own site (from the order\'s market)', () => {
  it('Germany → ebay.de, the UK → ebay.co.uk; no market → ebay.com, never always ebay.it', () => {
    expect(ebayFeedbackUrl('DE')).toBe('https://www.ebay.de/fdbk/leave_feedback')
    expect(ebayFeedbackUrl('it')).toBe('https://www.ebay.it/fdbk/leave_feedback')
    expect(ebayFeedbackUrl('UK')).toBe('https://www.ebay.co.uk/fdbk/leave_feedback')
    expect(ebayFeedbackUrl(null)).toBe('https://www.ebay.com/fdbk/leave_feedback')
    expect(reviewLinkFor('EBAY', 'FR', { url: null, source: null })).toBe('https://www.ebay.fr/fdbk/leave_feedback')
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
    expect(reviewLinkFor('SHOPIFY', 'IT', { url: null, source: null })).toBeNull()
    expect(shopReviewHeld({ url: null, source: null })).toMatch(/without a review button/)
    expect(shopReviewHeld({ url: 'https://x.test/pages/reviews', source: 'website' })).toBeNull()
    expect(reviewLinkFor('AMAZON', 'IT', { url: 'https://x.test/pages/reviews', source: 'website' })).toBeNull()
  })

  it('reads a website setting into its origin', () => {
    expect(shopOrigin('shop.example.test')).toBe('https://shop.example.test')
    expect(shopOrigin('HTTP://Shop.Example.test/x?y=1')).toBe('https://shop.example.test')
    expect(shopOrigin('localhost')).toBeNull()
    expect(shopOrigin('')).toBeNull()
  })
})
