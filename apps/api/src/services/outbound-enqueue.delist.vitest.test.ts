import { beforeEach, expect, it, vi } from 'vitest'
const m = vi.hoisted(() => ({ add: vi.fn(), read: vi.fn(), members: vi.fn(), create: vi.fn(), survivors: vi.fn() }))
vi.mock('../lib/queue.js', () => ({ outboundSyncQueue: null, addJobSafely: m.add }))
const { enqueueDelistCascade, dispatchCommittedDelistRows } = await import('./outbound-enqueue.js')
const listing = (channel = 'AMAZON', extra = {}) => ({ id: 'listing-original', productId: 'product-original', channel, marketplace: 'IT', region: 'IT', channelConnectionId: 'account-owner', aliasKey: 'alias-A', externalListingId: 'FAKE-ASIN', externalParentId: null, fulfillmentMethod: 'FBM', product: { sku: 'SELLER-SKU', parentId: null }, offers: [], ...extra })
const db: any = { channelListing: { findMany: m.read }, sharedListingMembership: { findMany: m.members }, outboundSyncQueue: { createManyAndReturn: m.create, findMany: m.survivors } }
beforeEach(() => { vi.clearAllMocks(); m.read.mockResolvedValue([listing()]); m.members.mockResolvedValue([]); m.create.mockImplementation(async ({ data }) => data.map((row: any, i: number) => ({ ...row, id: `q-${i}` }))); m.add.mockResolvedValue({ enqueued: true }) })
it('capture retains every coordinate and seller SKU, nulls only cascade FKs and holds five minutes', async () => {
  const before = Date.now(), result = await enqueueDelistCascade(db, ['product-original'], 'delete', 'operator')
  const row = m.create.mock.calls[0][0].data[0]
  expect(row).toMatchObject({ productId: null, channelListingId: null, targetChannel: 'AMAZON', targetRegion: 'IT', externalListingId: 'FAKE-ASIN', syncType: 'DELETE_LISTING', payload: { productId: 'product-original', channelListingId: 'listing-original', channel: 'AMAZON', marketplace: 'IT', channelConnectionId: 'account-owner', aliasKey: 'alias-A', sellerSku: 'SELLER-SKU', actor: 'operator' } })
  expect(row.holdUntil.getTime()).toBeGreaterThanOrEqual(before + 300_000)
  expect(m.read.mock.calls[0][0].where).toEqual({ productId: { in: ['product-original'] }, listingStatus: { in: ['ACTIVE', 'INACTIVE'] }, externalListingId: { not: null } })
  expect(m.add).not.toHaveBeenCalled(); expect(result.channelCascadeEnqueued).toBe(1)
})
it('Etsy and Woo coordinates are returned by name and receive no job', async () => {
  m.read.mockResolvedValue([listing('ETSY'), listing('WOOCOMMERCE')])
  const result = await enqueueDelistCascade(db, ['product-original'], 'delete', 'operator')
  expect(result.channelSkipped.map(row => row.channel)).toEqual(['ETSY', 'WOOCOMMERCE'])
  for (const row of result.channelSkipped) expect(row).toMatchObject({ channelConnectionId: 'account-owner', aliasKey: 'alias-A', externalListingId: 'FAKE-ASIN', reason: expect.any(String) })
  expect(m.create).not.toHaveBeenCalled()
})
it('an eBay variation child cannot enqueue a whole-ItemID end', async () => {
  m.read.mockResolvedValue([listing('EBAY', { product: { sku: 'CHILD', parentId: 'parent' } })])
  expect((await enqueueDelistCascade(db, ['product-original'], 'delete', 'operator')).channelSkipped[0].reason).toContain('variation child')
  expect(m.create).not.toHaveBeenCalled()
})
it('surviving eBay references hold the whole ItemID; a no-reference control queues it', async () => {
  m.read.mockResolvedValueOnce([listing('EBAY')]).mockResolvedValueOnce([{ id: 'surviving-alias' }])
  expect((await enqueueDelistCascade(db, ['product-original'], 'delete', 'operator')).entries).toHaveLength(0)
  m.read.mockResolvedValueOnce([listing('EBAY')]).mockResolvedValueOnce([])
  expect((await enqueueDelistCascade(db, ['product-original'], 'delete', 'operator')).entries).toHaveLength(1)
})
it('post-commit count uses actual survivors, fires only pending jobs with their own delay', async () => {
  const holdUntil = new Date(Date.now() + 300_000)
  m.survivors.mockResolvedValue([{ id: 'survived', syncStatus: 'PENDING', syncType: 'DELETE_LISTING', holdUntil }, { id: 'cancelled', syncStatus: 'CANCELLED' }])
  expect(await dispatchCommittedDelistRows(db, [{ id: 'survived' }, { id: 'cancelled' }, { id: 'lost-to-cascade' }])).toEqual({ channelCascadeDispatched: 1, channelCascadeRetained: 2, channelCascadePartial: true, channelCascadeQueueIds: ['survived', 'cancelled'] })
  expect(m.add).toHaveBeenCalledOnce(); expect(m.add.mock.calls[0][3].delay).toBeGreaterThan(299_000)
})

it('failed post-commit read preserves a receipt with unknown counts and cancellable committed IDs', async () => {
  m.survivors.mockRejectedValueOnce(new Error('database temporarily unavailable'))
  expect(await dispatchCommittedDelistRows(db, [{ id: 'committed-queue' }])).toEqual({
    channelCascadeDispatched: null, channelCascadeRetained: null, channelCascadePartial: true,
    channelCascadeQueueIds: ['committed-queue'], channelCascadeDispatchError: expect.stringContaining('DELIST_DISPATCH_EVIDENCE_UNAVAILABLE'),
  })
  expect(m.add).not.toHaveBeenCalled()
})

it('two selected aliases of one eBay ItemID enqueue once and retain both coordinates', async () => {
  m.read.mockResolvedValueOnce([listing('EBAY'), listing('EBAY', { id: 'alias-second', aliasKey: 'alias-B' })]).mockResolvedValue([])
  const result = await enqueueDelistCascade(db, ['product-original'], 'delete', 'operator')
  expect(result.entries).toHaveLength(1)
  expect((m.create.mock.calls[0][0].data[0].payload as any).coordinates.map((c: any) => c.aliasKey)).toEqual(['alias-A', 'alias-B'])
})
