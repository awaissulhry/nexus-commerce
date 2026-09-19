/**
 * P1.3 — the listing-claim check (BP.S3, shared seller accounts) runs for every queue row now, not only
 * in the one enqueue function it lived in: a coordinate another business holds never becomes a row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ blocked: true, notified: [] as unknown[] }))
vi.mock('./listing-claim.service.js', () => ({
  sharedConnectionIds: vi.fn(async () => new Set(['ebay-shared'])),
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
  it('profiles OFF (one business): no check at all', async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '')
    await createOutboundRows(db, { data: [{ channelListingId: 'L-1', targetChannel: 'EBAY', syncType: 'PRICE_UPDATE', payload: {} }] })
    expect(created).toHaveLength(1)
    expect(db.channelAccountGrant.findMany).not.toHaveBeenCalled()
  })
})
