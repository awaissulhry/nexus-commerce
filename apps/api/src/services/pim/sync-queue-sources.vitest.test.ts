import { beforeEach, expect, it, vi } from 'vitest'
const s = vi.hoisted(() => ({ rows: vi.fn(), issues: vi.fn(), suppressions: vi.fn() }))
vi.mock('../../db.js', () => ({ default: {
  product: { findFirst: async () => ({ id: 'p', parentId: null }), findMany: async () => [{ id: 'p' }] },
  channelListing: { findMany: async () => [] },
  outboundSyncQueue: { count: async () => 0, groupBy: async () => [], findMany: s.rows },
  listingIssue: { findMany: s.issues }, amazonSuppression: { findMany: s.suppressions },
} }))
import { getProductSyncQueue } from './sync-queue.service.js'
beforeEach(() => { vi.clearAllMocks(); s.rows.mockResolvedValue([]) })
it('names actual queue coverage without claiming other issue stores were read', async () => {
  const page = await getProductSyncQueue({ productId: 'p' })
  expect(page).toMatchObject({ sources: [
    { source: 'OutboundSyncQueue', queried: true, status: 'ok' },
    { source: 'ListingIssue', queried: false, status: 'not-queried' },
    { source: 'AmazonSuppression', queried: false, status: 'not-queried' },
    { source: 'ChannelListing.validationStatus', queried: false, status: 'not-queried' },
  ] })
  expect(s.rows).toHaveBeenCalledOnce()
  expect(s.issues).not.toHaveBeenCalled()
  expect(s.suppressions).not.toHaveBeenCalled()
})
it('propagates a failed queue read instead of returning empty successful coverage', async () => {
  s.rows.mockRejectedValue(new Error('queue read unavailable'))
  await expect(getProductSyncQueue({ productId: 'p' })).rejects.toThrow('queue read unavailable')
})
