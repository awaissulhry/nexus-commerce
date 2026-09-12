import { beforeEach, describe, expect, it, vi } from 'vitest'

const f = vi.hoisted(() => {
  const state = { listing: {} as any, snapshots: [] as any[], race: false }
  const db: any = {
    channelListing: { findUnique: vi.fn(async () => structuredClone(state.listing)), update: vi.fn(async ({ where, data }: any) => {
      if (state.race || Object.entries(where).some(([key, value]) => state.listing[key] !== value)) throw Object.assign(new Error('conflict'), { code: 'P2025' })
      state.listing = { ...state.listing, ...data, version: state.listing.version + 1 }
      return { version: state.listing.version }
    }) },
    channelListingSnapshot: {
      findUnique: vi.fn(async ({ where }: any) => state.snapshots.find(s => s.id === where.id)),
      create: vi.fn(async ({ data }: any) => { const row = { id: `snap-${state.snapshots.length}`, ...data }; state.snapshots.push(row); return row }),
      update: vi.fn(async ({ where, data }: any) => Object.assign(state.snapshots.find(s => s.id === where.id), data)),
    },
    $transaction: vi.fn(async (run: any) => {
      const before = structuredClone(state)
      try { return await run(db) } catch (e) { Object.assign(state, before); throw e }
    }),
  }
  return { state, db }
})
vi.mock('../../db.js', () => ({ default: f.db }))
vi.mock('../listing-events.service.js', () => ({ publishListingEvent: vi.fn() }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emit: vi.fn() } }))
import { restoreToDraft } from './listing-snapshot.service.js'

const request = { productId: 'p', accountId: 'b', listingId: 'b-alt', snapshotId: 'saved', expectedVersion: 3 }
beforeEach(() => {
  vi.clearAllMocks()
  f.state.race = false
  f.state.listing = { id: 'b-alt', productId: 'p', channel: 'EBAY', marketplace: 'IT', channelConnectionId: 'b', aliasKey: 'alt', version: 3, title: 'Current', quantity: 8, isPublished: true }
  f.state.snapshots = [{ id: 'saved', channelListingId: 'b-alt', channel: 'EBAY', marketplace: 'IT', aliasKey: 'alt', payload: { __capturedFrom: 'listing-state', state: { ...f.state.listing, title: 'Saved' } } }]
})
describe('snapshot restore preserves destination and atomic conflict checks', () => {
  it.each([{ productId: 'foreign' }, { accountId: 'a' }, { listingId: 'a-alt' }, { expectedVersion: 2 }, { expectedVersion: undefined }])('refuses %j without a write', async patch => {
    await expect(restoreToDraft({ ...request, ...patch })).rejects.toThrow()
    expect(f.db.$transaction).not.toHaveBeenCalled()
    expect(f.state.listing.title).toBe('Current')
  })
  it.each(['a', undefined])('refuses snapshots with another or unknown account: %s', async account => {
    f.state.snapshots[0].payload.state.channelConnectionId = account
    await expect(restoreToDraft(request)).rejects.toThrow('attribution')
    expect(f.db.$transaction).not.toHaveBeenCalled()
  })
  it('rolls back the undo snapshot when a competing write wins after the read', async () => {
    f.state.race = true
    await expect(restoreToDraft(request)).rejects.toThrow('changed while restoring')
    expect(f.state.listing).toMatchObject({ title: 'Current', version: 3 })
    expect(f.state.snapshots).toHaveLength(1)
    expect(f.state.snapshots[0].restoredAt).toBeUndefined()
    expect(f.db.channelListing.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'b-alt', productId: 'p', channelConnectionId: 'b', version: 3 } }))
  })
  it('restores only its own draft and captures the replaced state', async () => {
    expect(await restoreToDraft(request)).toMatchObject({ restored: true, isPublished: false, currentVersion: 4 })
    expect(f.state.listing).toMatchObject({ id: 'b-alt', title: 'Saved', quantity: 8, isPublished: false, version: 4 })
    expect(f.state.snapshots[1].payload.state).toMatchObject({ title: 'Current', channelConnectionId: 'b', version: 3 })
  })
})
