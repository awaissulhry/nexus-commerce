/**
 * Amazon sheet gaps — "Add child → copy from" copies the Amazon offer facts with their copy group (price bounds with
 * "pricing", handling time / restock with "attributes") and NEVER the sibling's offer draft.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./draft-listing.service.js', () => ({
  DraftListingError: class extends Error {},
  draftListingFields: () => ({}),
  ensureDraftListings: async () => [{ id: 'draft-1' }],
}))
vi.mock('./listing-alias.service.js', () => ({ validateAliasWriteTargets: async () => {} }))
vi.mock('../connection-resolver.service.js', () => ({ AmbiguousConnectionError: class extends Error {} }))
vi.mock('../shopify/content-workspace.service.js', () => ({ PUBLISH_KEY: '_nexusContentPublish' }))

import { copySiblingListings } from './variant-listing-copy.service.js'

const sibling = {
  id: 'sib', productId: 'src', channel: 'AMAZON', marketplace: 'IT', channelConnectionId: 'acc', aliasKey: '',
  title: 'Jacket', description: 'D', bulletPointsOverride: [], price: 50, pricingRule: 'FIXED', priceAdjustmentPercent: null,
  variationTheme: 'COLOR', stockBuffer: 1,
  platformAttributes: {
    productType: 'OUTERWEAR',
    amazonOffer: { minimum_seller_allowed_price: 30, map_price: 40 },
    amazonFulfillment: { lead_time_to_ship_max_days: 2 },
    amazonOfferDraft: { v: 1, leaves: { map_price: { value: 42, base: 40, savedAt: 't', savedBy: 'u' } } },
    attributes: { item_name: [{ value: 'Jacket' }], purchasable_offer: [{ our_price: [] }] },
  },
}
let written: any
const tx = { channelListing: { findMany: async () => [sibling], update: async ({ data }: any) => { written = data; return {} } } } as never

beforeEach(() => { written = undefined })

describe('copySiblingListings — Amazon offer facts', () => {
  it('all groups: offer facts and fulfilment settings come across; the draft never does', async () => {
    await copySiblingListings(tx, { sourceProductId: 'src', productId: 'new', groups: new Set(['content', 'attributes', 'pricing']) })
    expect(written.platformAttributes).toEqual({
      productType: 'OUTERWEAR',
      amazonOffer: { minimum_seller_allowed_price: 30, map_price: 40 },
      amazonFulfillment: { lead_time_to_ship_max_days: 2 },
      attributes: { item_name: [{ value: 'Jacket' }] },
    })
  })

  it('"pricing" alone: the offer facts, not the fulfilment settings; "attributes" alone: the reverse', async () => {
    await copySiblingListings(tx, { sourceProductId: 'src', productId: 'new', groups: new Set(['pricing']) })
    expect(written.platformAttributes).toHaveProperty('amazonOffer')
    expect(written.platformAttributes).not.toHaveProperty('amazonFulfillment')
    expect(written.platformAttributes).not.toHaveProperty('amazonOfferDraft')
    await copySiblingListings(tx, { sourceProductId: 'src', productId: 'new', groups: new Set(['attributes']) })
    expect(written.platformAttributes).toHaveProperty('amazonFulfillment')
    expect(written.platformAttributes).not.toHaveProperty('amazonOffer')
    expect(written.platformAttributes).not.toHaveProperty('amazonOfferDraft')
  })
})
