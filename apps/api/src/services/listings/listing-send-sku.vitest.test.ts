/**
 * S3 — the SKU a sender names for one listing (`listingSendSku`) and the per-seller-SKU EU check
 * (`sharesAmazonSellerSku`). Parity first: a listing with no SKU of its own names the product SKU, exactly as every
 * sender did before.
 */
import { describe, expect, it } from 'vitest'
import { CHANNEL_SKU_UNRESOLVED, listingSendSku, sharesAmazonSellerSku } from './listing-send-sku.js'
import type { ChannelSkuListing } from './channel-sku.pure.js'

const LIVE = { listingStatus: 'ACTIVE', isPublished: true, externalListingId: 'B0LIVE' } as const
const DRAFT = { listingStatus: 'DRAFT', isPublished: false, externalListingId: null } as const
const amazon = (facts: Partial<ChannelSkuListing> = {}): ChannelSkuListing => ({ channel: 'AMAZON', productId: 'p1', aliasKey: '', ...LIVE, ...facts })
const offer = (sku: string, isActive = true, fulfillmentMethod = 'FBM') => ({ sku, isActive, fulfillmentMethod })

describe('listingSendSku — parity: no SKU of its own → the product SKU', () => {
  it.each([
    ['a bare live listing', amazon()],
    ['empty columns and blank stores', amazon({ channelSku: null, liveChannelSku: '  ', platformAttributes: { sellerSku: '' }, flatFileSnapshot: {} })],
    ['an offer under the product SKU', amazon({ offers: [offer('P-1')] })],
    ['a mirror key equal to the product SKU', amazon({ platformAttributes: { seller_sku: 'P-1' }, flatFileSnapshot: { item_sku: 'P-1' } })],
    ['an inactive offer under another SKU (not live)', amazon({ offers: [offer('OLD', false)] })],
  ])('%s', (_name, listing) => {
    expect(listingSendSku(listing, 'P-1', 'P-1')).toEqual({ sku: 'P-1', source: expect.any(String), refusal: null, code: null })
    expect(listingSendSku(listing, 'P-1', 'P-1').sku).toBe('P-1')
  })

  it('eBay, Shopify and Etsy rows with no SKU of their own name the product SKU too', () => {
    for (const channel of ['EBAY', 'SHOPIFY', 'ETSY']) expect(listingSendSku({ channel, ...LIVE }, 'P-1', 'P-1').sku).toBe('P-1')
  })
})

describe('listingSendSku — a listing with its own SKU names that SKU', () => {
  it('the confirmed live SKU wins over the wanted one (the channel holds the live one until a publish moves it)', () => {
    expect(listingSendSku(amazon({ liveChannelSku: 'LIVE-DE', channelSku: 'WANT-DE' }), 'P-1', 'P-1')).toMatchObject({ sku: 'LIVE-DE', source: 'live' })
  })
  it('an old store\'s one value (an active offer, a mirror key, the flat-file snapshot)', () => {
    expect(listingSendSku(amazon({ offers: [offer('OFF-DE')] }), 'P-1', 'P-1')).toMatchObject({ sku: 'OFF-DE', source: 'offer' })
    expect(listingSendSku(amazon({ platformAttributes: { sellerSku: 'PA-DE' } }), 'P-1', 'P-1')).toMatchObject({ sku: 'PA-DE', source: 'attributes' })
    expect(listingSendSku(amazon({ flatFileSnapshot: { item_sku: 'FF-DE' } }), 'P-1', 'P-1')).toMatchObject({ sku: 'FF-DE', source: 'flatFile' })
  })
})

describe('listingSendSku — a still-draft listing, or none, names what the sender named before', () => {
  it('a draft with its own wanted SKU still names the fallback: its own SKU is Publish\'s to send, never a push\'s', () => {
    expect(listingSendSku(amazon({ ...DRAFT, channelSku: 'WANT-DE' }), 'P-1', 'P-1')).toEqual({ sku: 'P-1', source: 'fallback', refusal: null, code: null })
  })
  it('no listing: the fallback (e.g. a queue row\'s external id)', () => {
    expect(listingSendSku(null, 'P-1', 'EXT-9')).toMatchObject({ sku: 'EXT-9', source: 'fallback' })
  })
  it('no SKU anywhere (no product SKU, no store): the fallback, as before', () => {
    expect(listingSendSku(amazon(), null, 'EXT-9')).toMatchObject({ sku: 'EXT-9', source: 'fallback', refusal: null })
  })
})

describe('listingSendSku — two SKUs on record: nothing is sent, with the resolver\'s sentence', () => {
  it('two active offers', () => {
    const answer = listingSendSku(amazon({ offers: [offer('A'), offer('B', true, 'FBA')] }), 'P-1', 'P-1')
    expect(answer).toEqual({ sku: null, source: null, code: 'MULTIPLE_ACTIVE_OFFERS', refusal: 'P-1 has multiple seller SKUs. Select its offer before publishing. Nothing was sent.' })
  })
  it('two different stored identities', () => {
    expect(listingSendSku(amazon({ platformAttributes: { sellerSku: 'A' }, flatFileSnapshot: { item_sku: 'B' } }), 'P-1', 'P-1'))
      .toMatchObject({ sku: null, code: 'CONFLICTING_SKUS' })
  })
  it('an Amazon extra listing with no seller SKU of its own (it would otherwise write the main listing\'s offer)', () => {
    expect(listingSendSku(amazon({ aliasKey: 'alias-1' }), 'P-1', 'P-1')).toMatchObject({ sku: null, code: 'ALIAS_NEEDS_OWN_SKU' })
  })
  it('a listing\'s own SKU ends the conflict', () => {
    expect(listingSendSku(amazon({ liveChannelSku: 'OWN', offers: [offer('A'), offer('B')] }), 'P-1', 'P-1').sku).toBe('OWN')
  })
  it('the error code senders report', () => expect(CHANNEL_SKU_UNRESOLVED).toBe('CHANNEL_SKU_UNRESOLVED'))
})

describe('sharesAmazonSellerSku — the EU shared quantity is one per seller SKU', () => {
  it('parity: siblings with no SKU of their own all share the product SKU', () => {
    expect(sharesAmazonSellerSku({ ...LIVE }, 'P-1', 'P-1')).toBe(true)
    expect(sharesAmazonSellerSku({ ...LIVE, offers: [offer('P-1')] }, 'P-1', ' P-1 ')).toBe(true)
  })
  it('a sibling under another seller SKU holds another quantity', () => {
    expect(sharesAmazonSellerSku({ ...LIVE, liveChannelSku: 'P-1-DE' }, 'P-1', 'P-1')).toBe(false)
    expect(sharesAmazonSellerSku({ ...LIVE, liveChannelSku: 'P-1-DE' }, 'P-1', 'P-1-DE')).toBe(true)
    expect(sharesAmazonSellerSku({ ...LIVE, platformAttributes: { sellerSku: 'OLD-FR' } }, 'P-1', 'P-1')).toBe(false)
  })
  it('a sibling whose SKU cannot be told shares it (the guard fails closed)', () => {
    expect(sharesAmazonSellerSku({ ...LIVE, offers: [offer('A'), offer('B')] }, 'P-1', 'P-1')).toBe(true)
    expect(sharesAmazonSellerSku({ ...LIVE }, null, 'P-1')).toBe(true)
  })
  it('a still-draft sibling counts under the SKU it will be listed with', () => {
    expect(sharesAmazonSellerSku({ ...DRAFT }, 'P-1', 'P-1')).toBe(true)
    expect(sharesAmazonSellerSku({ ...DRAFT, channelSku: 'NEW-ES' }, 'P-1', 'P-1')).toBe(false)
    expect(sharesAmazonSellerSku({ ...DRAFT, channelSku: 'NEW-ES' }, 'P-1', 'NEW-ES')).toBe(true)
  })
  it('the row\'s own channel label is ignored: every sibling is read by the Amazon rule', () => {
    expect(sharesAmazonSellerSku({ ...LIVE, channel: 'EBAY', platformAttributes: { sellerSku: 'X' } } as never, 'P-1', 'P-1')).toBe(false)
  })
})
