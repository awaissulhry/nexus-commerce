import { describe, expect, it, vi } from 'vitest'
import { linkedState, writeLinkedState } from './linked-products.service.js'
import type { WorkspaceDestination } from '../pim/workspace-destination.js'
describe('Shopify draft destination storage', () => {
  it('reads and creates only the requested store, market and listing alias', async () => {
    const tx = { product: { findFirst: vi.fn().mockResolvedValue({ id: 'family', name: 'Family', children: [{ id: 'variant' }] }) }, channelListing: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn() } }
    const destination = { productId: 'variant', familyId: 'family', accountId: 'store-b', marketplace: 'GLOBAL', aliasKey: 'alias-b', listing: null } as WorkspaceDestination
    const state = await linkedState(tx as any, destination)
    expect(tx.channelListing.findMany).toHaveBeenCalledWith({ where: { productId: { in: ['family', 'variant'] }, channel: 'SHOPIFY', channelConnectionId: 'store-b', marketplace: 'GLOBAL', aliasKey: 'alias-b' } })
    await writeLinkedState(tx as any, destination, state, { saved: true })
    expect(tx.channelListing.create).toHaveBeenCalledWith({ data: expect.objectContaining({ productId: 'family', channelConnectionId: 'store-b', marketplace: 'GLOBAL', aliasKey: 'alias-b', aliasId: 'alias-b', platformAttributes: { saved: true } }) })
  })
  it('refuses a stale listing version without replacing another editor’s draft', async () => {
    const tx = { channelListing: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) } }
    await expect(writeLinkedState(tx as any, {} as any, { listing: { id: 'listing', version: 4 }, pa: { unrelated: false } } as any, { saved: true })).rejects.toThrow('Another editor')
    expect(tx.channelListing.updateMany).toHaveBeenCalledWith({ where: { id: 'listing', version: 4 }, data: { platformAttributes: { unrelated: false, saved: true }, version: { increment: 1 } } })
  })
})
