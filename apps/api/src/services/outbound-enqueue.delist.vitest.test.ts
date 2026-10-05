import { beforeEach, describe, expect, it, vi } from 'vitest'
const m = vi.hoisted(() => ({ add: vi.fn(), read: vi.fn(), members: vi.fn(), create: vi.fn(), survivors: vi.fn() }))
vi.mock('../lib/queue.js', () => ({ outboundSyncQueue: null, addJobSafely: m.add }))
const { enqueueDelistCascade, dispatchCommittedDelistRows, sellerSkuForDelist } = await import('./outbound-enqueue.js')
const listing = (channel = 'AMAZON', extra = {}) => ({ id: 'listing-original', productId: 'product-original', channel, marketplace: 'IT', region: 'IT', channelConnectionId: 'account-owner', aliasKey: 'alias-A', externalListingId: 'FAKE-ASIN', externalParentId: null, fulfillmentMethod: 'FBM', product: { sku: 'SELLER-SKU', parentId: null }, offers: [], ...extra })
const db: any = { channelListing: { findMany: m.read }, sharedListingMembership: { findMany: m.members }, outboundSyncQueue: { createManyAndReturn: m.create, findMany: m.survivors } }
beforeEach(() => { vi.clearAllMocks(); m.read.mockResolvedValue([listing()]); m.members.mockResolvedValue([]); m.create.mockImplementation(async ({ data }) => data.map((row: any, i: number) => ({ ...row, id: `q-${i}` }))); m.add.mockResolvedValue({ enqueued: true }) })
it('capture retains every coordinate and seller SKU, nulls only cascade FKs and holds five minutes', async () => {
  // S8 — this Amazon extra listing ('alias-A') carries its seller SKU on its own offer (see below for one with none).
  m.read.mockResolvedValue([listing('AMAZON', { offers: [{ sku: 'SELLER-SKU', fulfillmentMethod: 'FBM', isActive: true }] })])
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

describe('S8 — a delete names the SKU the channel HOLDS (liveChannelSku)', () => {
  const primary = (extra = {}) => listing('AMAZON', { aliasKey: '', ...extra })
  const captured = async (row: Record<string, unknown>) => {
    m.read.mockResolvedValue([row])
    await enqueueDelistCascade(db, ['product-original'], 'delete', 'operator')
    return (m.create.mock.calls.at(-1)![0].data[0].payload as any).sellerSku
  }
  it('parity: no SKU of its own and nothing in the old stores → the product SKU, as before', async () => {
    expect(await captured(primary())).toBe('SELLER-SKU')
    expect(await captured(primary({ offers: [{ sku: 'OFFER-SKU', fulfillmentMethod: 'FBM', isActive: true }] }))).toBe('OFFER-SKU')
  })
  it('a confirmed own SKU is deleted, not the product SKU; a wanted one not yet live is not', async () => {
    expect(await captured(primary({ channelSku: 'OWN-IT', liveChannelSku: 'OWN-IT' }))).toBe('OWN-IT')
    // Renamed in Nexus, not published yet: Amazon still holds the product SKU.
    expect(await captured(primary({ channelSku: 'NEW-IT', liveChannelSku: null }))).toBe('SELLER-SKU')
  })
  it('the capture reads the facts the resolver needs', async () => {
    await captured(primary())
    expect(m.read.mock.calls[0][0].select).toMatchObject({ channelSku: true, liveChannelSku: true, listingStatus: true, isPublished: true, platformAttributes: true, flatFileSnapshot: true, alias: { select: { sku: true, productId: true } } })
  })
  it('an Amazon extra listing with no SKU of its own: none (the product SKU names the main listing) — never a guess', async () => {
    expect(await captured(listing('AMAZON'))).toBeNull()
  })
})

describe('S8 — sellerSkuForDelist', () => {
  const row = (extra = {}) => ({ channel: 'AMAZON', aliasKey: '', product: { sku: 'P1' }, offers: [] as Array<{ sku: string; fulfillmentMethod: string; isActive: boolean }>, ...extra })
  it('parity with the old rule where it applied: one active offer, else the product SKU; two offers → null; the offer scope', () => {
    expect(sellerSkuForDelist(row())).toBe('P1')
    expect(sellerSkuForDelist(row({ offers: [{ sku: 'P1-FBM', fulfillmentMethod: 'FBM', isActive: true }, { sku: 'OLD', fulfillmentMethod: 'FBM', isActive: false }] }))).toBe('P1-FBM')
    const two = row({ offers: [{ sku: 'P1-FBM', fulfillmentMethod: 'FBM', isActive: true }, { sku: 'P1-FBA', fulfillmentMethod: 'FBA', isActive: true }] })
    expect(sellerSkuForDelist(two)).toBeNull()
    expect(sellerSkuForDelist(two, 'FBA')).toBe('P1-FBA')
  })
  it('the old stores Publish reads count (the Amazon mirror keys), and two different values are a conflict', () => {
    expect(sellerSkuForDelist(row({ platformAttributes: { seller_sku: 'ATTR-SKU' } }))).toBe('ATTR-SKU')
    expect(sellerSkuForDelist(row({ platformAttributes: { seller_sku: 'ATTR-SKU' }, offers: [{ sku: 'OFFER', fulfillmentMethod: 'FBM', isActive: true }] }))).toBeNull()
  })
  it('a still-draft listing is on no channel: nothing to delete', () => {
    expect(sellerSkuForDelist(row({ listingStatus: 'DRAFT', isPublished: false, externalListingId: null, channelSku: 'OWN' }))).toBeNull()
  })
})
