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

import { createOutboundRow, createOutboundRows } from './outbound-rows.js'

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
