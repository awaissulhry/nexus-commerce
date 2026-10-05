/**
 * P1.3 — the listing-claim check (BP.S3, shared seller accounts) runs for every queue row now, not only
 * in the one enqueue function it lived in: a coordinate another business holds never becomes a row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ blocked: true, notified: [] as unknown[] }))
vi.mock('./listing-claim.service.js', () => ({
  // Answers for the ids it is ASKED about — the gate may ask with the accounts the rows
  // name (P1.3) or with the accounts their listings sit on, and only 'ebay-shared' is shared.
  sharedConnectionIds: vi.fn(async (ids: string[] = []) => new Set(ids.filter(id => id === 'ebay-shared'))),
  claimCoordinate: vi.fn(async () => (h.blocked ? { result: 'blocked', reason: 'That SKU belongs to another business profile.', heldBy: { workspaceName: 'Other' } } : { result: 'acquired' })),
}))
vi.mock('./publish-refusal-notify.service.js', () => ({ notifyPublishRefused: vi.fn(async (b: unknown) => { h.notified.push(b) }) }))

import { createOutboundRow, createOutboundRows, reserveSharedCoordinates } from './outbound-rows.js'
import { claimCoordinate } from './listing-claim.service.js'
import { identitySellerSku, offerOrProductSku, sellerSkuForClaim } from './listing-claim-identity.js'

const created: unknown[] = []
const db = {
  channelListing: { findMany: vi.fn(async ({ where }: any) => (where.id?.in ?? []).map((id: string) => ({ id, marketplace: 'IT', channelConnectionId: 'ebay-shared', product: { sku: 'SKU-1' }, offers: [] }))) },
  channelAccountGrant: { findMany: vi.fn(async () => [{ connectionId: 'ebay-shared' }]) },
  outboundSyncQueue: {
    create: vi.fn(async ({ data }: any) => { created.push(data); return { id: 'q1' } }),
    createMany: vi.fn(async ({ data }: any) => { created.push(...data); return { count: data.length } }),
  },
}

beforeEach(() => { vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1'); created.length = 0; h.notified.length = 0; h.blocked = true })
afterEach(() => vi.unstubAllEnvs())

describe('P1.3 — every queue row passes the listing-claim check', () => {
  it('a single row for a coordinate another business holds: refused (409), nothing written, the owners told', async () => {
    await expect(createOutboundRow(db, { data: { channelListingId: 'L-1', targetChannel: 'EBAY', syncType: 'PRICE_UPDATE', payload: {} } }))
      .rejects.toMatchObject({ code: 'listing_coordinate_claimed' })
    expect(created).toHaveLength(0)
    expect(h.notified).toHaveLength(1)
  })
  it('a claim this business holds: written, with its account', async () => {
    h.blocked = false
    await createOutboundRow(db, { data: { channelListingId: 'L-1', targetChannel: 'EBAY', syncType: 'PRICE_UPDATE', payload: {} } })
    expect(created).toEqual([expect.objectContaining({ channelListingId: 'L-1', channelConnectionId: 'ebay-shared' })])
  })
  it('a row that NAMES a shared account is still claimed — the named-account shortcut never skips the gate', async () => {
    await expect(createOutboundRow(db, { data: { channelListingId: 'L-1', channelConnectionId: 'ebay-shared', targetChannel: 'EBAY', syncType: 'PRICE_UPDATE', payload: {} } }))
      .rejects.toMatchObject({ code: 'listing_coordinate_claimed' })
    expect(created).toHaveLength(0)
    expect(h.notified).toHaveLength(1)
  })
  it('a row that names an account NOBODY shares: the gate answers from the grant read alone, with no listing read', async () => {
    db.channelListing.findMany.mockClear()
    await createOutboundRow(db, { data: { channelListingId: 'L-1', channelConnectionId: 'ebay-solo', targetChannel: 'EBAY', syncType: 'PRICE_UPDATE', payload: {} } })
    expect(created).toEqual([expect.objectContaining({ channelListingId: 'L-1', channelConnectionId: 'ebay-solo' })])
    // The listing read is a join over product + offers; a single-business install must not pay
    // it per row — creation sites call this inside chunked transactions (follow-master, P2028).
    expect(db.channelListing.findMany).not.toHaveBeenCalled()
  })
  it('profiles OFF (one business): no check at all', async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '')
    await createOutboundRows(db, { data: [{ channelListingId: 'L-1', targetChannel: 'EBAY', syncType: 'PRICE_UPDATE', payload: {} }] })
    expect(created).toHaveLength(1)
    expect(db.channelAccountGrant.findMany).not.toHaveBeenCalled()
  })
})

/**
 * S8 — a listing may carry its own channel SKU (per channel AND market). The claim reserves the coordinate a push writes
 * into, so it is keyed on the SKU publish SENDS (`wantedChannelSku`), not "the active offer, else the product SKU".
 */
describe('S8 — the claim names the SKU publish sends', () => {
  const sharedListing = (extra: Record<string, unknown>) => ({ id: 'L-1', productId: 'P', channel: 'AMAZON', marketplace: 'IT', channelConnectionId: 'ebay-shared', aliasKey: '', product: { sku: 'SKU-1' }, offers: [], ...extra })
  const claimedWith = async (extra: Record<string, unknown>) => {
    h.blocked = false
    vi.mocked(claimCoordinate).mockClear()
    db.channelListing.findMany.mockResolvedValueOnce([sharedListing(extra)] as never)
    const out = await reserveSharedCoordinates(db, [{ channelListingId: 'L-1' }])
    return { out, calls: vi.mocked(claimCoordinate).mock.calls.map(c => c[0]) }
  }
  it('parity: no SKU of its own → the product SKU, as before', async () => {
    const { calls } = await claimedWith({})
    expect(calls).toEqual([{ connectionId: 'ebay-shared', marketplace: 'IT', sellerSku: 'SKU-1', channelListingId: 'L-1' }])
  })
  it('its own SKU (wanted, not yet live) → that SKU: the one publish sends', async () => {
    const { calls } = await claimedWith({ channelSku: 'SKU-1-IT', liveChannelSku: 'SKU-1' })
    expect(calls.map(c => c.sellerSku)).toEqual(['SKU-1-IT'])
  })
  it('the old stores Publish reads (an Amazon mirror key) are used, where the old rule took the product SKU', async () => {
    const { calls } = await claimedWith({ platformAttributes: { seller_sku: 'ATTR-SKU' } })
    expect(calls.map(c => c.sellerSku)).toEqual(['ATTR-SKU'])
  })
  it('no single SKU (two on record): blocked with the resolver\'s sentence, no claim is taken', async () => {
    const { out, calls } = await claimedWith({ platformAttributes: { seller_sku: 'ATTR-SKU' }, offers: [{ sku: 'OFFER-SKU', isActive: true, fulfillmentMethod: 'FBM' }] })
    expect(calls).toEqual([])
    expect(out.allowed).toEqual([])
    expect(out.blocked).toEqual([expect.objectContaining({ channelListingId: 'L-1', sellerSku: null, reason: 'SKU-1: conflicting Amazon seller SKUs. Reconcile this listing\'s identity before publishing.' })])
  })
  it('the listing read selects what the resolver needs', async () => {
    await claimedWith({})
    expect(db.channelListing.findMany.mock.calls.at(-1)![0].select).toMatchObject({ channel: true, channelSku: true, liveChannelSku: true, platformAttributes: true, flatFileSnapshot: true, alias: { select: { sku: true, productId: true } } })
  })
})

describe('S8 — the seller-SKU rules side by side', () => {
  const base = { channel: 'AMAZON', aliasKey: '', product: { sku: 'P1' }, offers: [] as Array<{ sku: string; isActive: boolean; fulfillmentMethod: string }> }
  it('offerOrProductSku is the old rule, unchanged', () => {
    expect(offerOrProductSku(base)).toBe('P1')
    expect(offerOrProductSku({ ...base, offers: [{ sku: 'O1', isActive: true, fulfillmentMethod: 'FBM' }] })).toBe('O1')
    expect(offerOrProductSku({ ...base, offers: [{ sku: 'O1', isActive: true, fulfillmentMethod: 'FBM' }, { sku: 'O2', isActive: true, fulfillmentMethod: 'FBA' }] })).toBeNull()
  })
  it('identitySellerSku: the confirmed SKU, else the own SKU, else the old rule (the identity audit\'s order)', () => {
    expect(identitySellerSku(base)).toBe('P1')
    expect(identitySellerSku({ ...base, channelSku: ' OWN ' })).toBe('OWN')
    expect(identitySellerSku({ ...base, channelSku: 'OWN', liveChannelSku: 'LIVE' })).toBe('LIVE')
  })
  it('sellerSkuForClaim: the wanted SKU (own SKU first; an Amazon extra listing with none is refused)', () => {
    expect(sellerSkuForClaim(base)).toBe('P1')
    expect(sellerSkuForClaim({ ...base, channelSku: 'OWN', liveChannelSku: 'LIVE' })).toBe('OWN')
    expect(sellerSkuForClaim({ ...base, aliasKey: 'extra' })).toBeNull()
    // Another channel: its own SKU, else an extra listing's own alias SKU, else the product SKU.
    expect(sellerSkuForClaim({ ...base, channel: 'EBAY', productId: 'P', aliasKey: 'a1', alias: { sku: 'ALIAS-SKU', productId: 'P' } })).toBe('ALIAS-SKU')
  })
})
