/**
 * P1.3 — the destination account of an outbound queue row (services/outbound-destination.ts), rule by
 * rule, with the arm that must not happen: a row is never given "the primary" when two accounts hold it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ active: [] as Array<{ id: string; channelType: string; isActive: boolean; isPrimary: boolean }>, listFails: false }))
vi.mock('./connection-resolver.service.js', async (original) => ({
  ...(await original<object>()),
  listActiveConnections: vi.fn(async (channel: string) => {
    if (h.listFails) throw new Error('database unavailable')
    return h.active.filter((c) => c.channelType === channel)
  }),
}))

import { resolveDestinations, noDestinationSentence } from './outbound-destination.js'

const listings = [
  { id: 'L-A', productId: 'P1', channel: 'EBAY', marketplace: 'IT', region: 'IT', channelConnectionId: 'ebay-A' },
  { id: 'L-B', productId: 'P1', channel: 'EBAY', marketplace: 'DE', region: 'DE', channelConnectionId: 'ebay-B' },
  { id: 'L-C', productId: 'P2', channel: 'EBAY', marketplace: 'IT', region: 'IT', channelConnectionId: 'ebay-A' },
  { id: 'L-D', productId: 'P2', channel: 'EBAY', marketplace: 'IT', region: 'IT', channelConnectionId: 'ebay-B' },
  { id: 'L-UK', productId: 'P3', channel: 'EBAY', marketplace: 'UK', region: 'UK', channelConnectionId: 'ebay-A' },
  { id: 'L-NULL', productId: 'P4', channel: 'AMAZON', marketplace: 'IT', region: 'IT', channelConnectionId: null },
]
const reads: unknown[] = []
const db = {
  channelListing: {
    findMany: vi.fn(async ({ where }: any) => {
      reads.push(where)
      if (where.id?.in) return listings.filter((l) => where.id.in.includes(l.id))
      return listings.filter((l) => where.productId.in.includes(l.productId) && where.channel.in.includes(l.channel) && l.channelConnectionId)
    }),
  },
}

beforeEach(() => {
  reads.length = 0; h.listFails = false
  h.active = [
    { id: 'ebay-A', channelType: 'EBAY', isActive: true, isPrimary: true },
    { id: 'ebay-B', channelType: 'EBAY', isActive: true, isPrimary: false },
    { id: 'amz-1', channelType: 'AMAZON', isActive: true, isPrimary: true },
  ]
})

describe('P1.3 — which account a queue row goes to', () => {
  it('1. the account the row names wins, with no read', async () => {
    expect(await resolveDestinations(db, [{ channelConnectionId: 'ebay-B', channelListingId: 'L-A' }, { payload: { channelConnectionId: 'ebay-A' } }]))
      .toEqual([{ connectionId: 'ebay-B', reason: 'NAMED' }, { connectionId: 'ebay-A', reason: 'NAMED' }])
    expect(reads).toHaveLength(0)
  })

  it('2. the listing\'s own account — the SECOND account\'s listing goes to the second account', async () => {
    expect(await resolveDestinations(db, [{ channelListingId: 'L-B' }, { payload: { channelListingId: 'L-A' } }]))
      .toEqual([{ connectionId: 'ebay-B', reason: 'LISTING' }, { connectionId: 'ebay-A', reason: 'LISTING' }])
  })

  it('3. a product-only row: the one account holding it in this market (UK and GB are one market)', async () => {
    expect(await resolveDestinations(db, [
      { productId: 'P1', targetChannel: 'EBAY', targetRegion: 'DE' },
      { productId: 'P3', targetChannel: 'EBAY', targetRegion: 'GB' },
    ])).toEqual([{ connectionId: 'ebay-B', reason: 'PRODUCT_IN_MARKET' }, { connectionId: 'ebay-A', reason: 'PRODUCT_IN_MARKET' }])
  })

  it('3. two accounts hold the product in this market → NO account (ambiguous), never the primary', async () => {
    expect(await resolveDestinations(db, [{ productId: 'P2', targetChannel: 'EBAY', targetRegion: 'IT' }])).toEqual([{ connectionId: null, reason: 'AMBIGUOUS' }])
  })

  it('4. nothing to go by: the channel\'s ONLY account; two accounts → none', async () => {
    expect(await resolveDestinations(db, [{ targetChannel: 'AMAZON' }, { productId: 'P4', targetChannel: 'AMAZON', targetRegion: 'IT' }]))
      .toEqual([{ connectionId: 'amz-1', reason: 'ONLY_ACCOUNT' }, { connectionId: 'amz-1', reason: 'ONLY_ACCOUNT' }])
    expect(await resolveDestinations(db, [{ targetChannel: 'EBAY', productId: 'P9', targetRegion: 'FR' }])).toEqual([{ connectionId: null, reason: 'AMBIGUOUS' }])
  })

  it('an unreadable account list or a client without listings leaves the row unresolved — the save does not fail', async () => {
    h.listFails = true
    expect(await resolveDestinations(db, [{ targetChannel: 'AMAZON' }])).toEqual([{ connectionId: null, reason: 'NO_ACCOUNT' }])
    h.listFails = false
    expect(await resolveDestinations({} as never, [{ channelListingId: 'L-A', targetChannel: 'AMAZON' }])).toEqual([{ connectionId: 'amz-1', reason: 'ONLY_ACCOUNT' }])
  })

  it('many rows, few reads', async () => {
    await resolveDestinations(db, Array.from({ length: 50 }, (_, i) => ({ channelListingId: i % 2 ? 'L-A' : 'L-B', productId: 'P1', targetChannel: 'EBAY' })))
    expect(reads).toHaveLength(1)
  })

  it('the refusal sentence names the reason', () => {
    expect(noDestinationSentence('eBay', 'AMBIGUOUS')).toMatch(/more than one eBay account holds this product/)
  })
})
