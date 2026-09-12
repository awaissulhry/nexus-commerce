// P-RT.2 — verify Shopify product/* webhook handlers fan out to the
// SSE listing-events bus via productEventService so the /products
// grid + edit page refresh sub-200ms after an external Shopify
// admin edit, instead of waiting for the 30s usePolledList tick.
//
// We mock the prisma calls (findFirst + update + productEvent.create)
// so dispatchShopifyWebhook runs end-to-end without a DB. The bus
// is in-process; assertions fire synchronously after the awaited
// dispatch.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Mock prisma + the read-cache queue before the SUT imports.
const productFindFirst = vi.fn()
const productUpdate = vi.fn()
const productEventCreate = vi.fn().mockResolvedValue({})
const listingFindMany = vi.fn().mockResolvedValue([])
const listingUpdateMany = vi.fn().mockResolvedValue({ count: 1 })

vi.mock('../../db.js', () => ({
  default: {
    channelListing: { findMany: (...args: unknown[]) => listingFindMany(...args), updateMany: (...args: unknown[]) => listingUpdateMany(...args) },
    product: {
      findFirst: (...args: unknown[]) => productFindFirst(...args),
      update: (...args: unknown[]) => productUpdate(...args),
    },
    productEvent: {
      create: (...args: unknown[]) => productEventCreate(...args),
      createMany: vi.fn().mockResolvedValue({}),
    },
  },
}))
vi.mock('../../lib/queue.js', () => ({
  readCacheQueue: {
    add: vi.fn().mockResolvedValue({}),
  },
  // FFT.6 made product-event emit use addJobSafely; partial mock must provide it
  addJobSafely: vi.fn().mockResolvedValue({ enqueued: true }),
}))

import { dispatchShopifyWebhook } from '../shopify-webhooks.js'
import { subscribeListingEvents } from '../../services/listing-events.service.js'

describe('Shopify webhooks → SSE bus (P-RT.2)', () => {
  let received: any[]
  let unsubscribe: () => void

  beforeEach(() => {
    received = []
    unsubscribe = subscribeListingEvents((e) => { received.push(e) })
    productFindFirst.mockReset()
    productUpdate.mockReset()
    productEventCreate.mockClear()
    listingFindMany.mockReset().mockResolvedValue([])
    listingUpdateMany.mockClear()
  })
  afterEach(() => {
    unsubscribe()
  })

  it('product/update on a known product publishes product.updated', async () => {
    productFindFirst.mockResolvedValueOnce({ id: 'prod_xavia_42', shopifyProductId: '9876543210' })
    productUpdate.mockResolvedValueOnce({})

    await dispatchShopifyWebhook('product/update', {
      id: '9876543210',
      title: 'Xavia Glove — Updated by Shopify admin',
    })

    expect(productFindFirst).toHaveBeenCalledTimes(1)
    expect(productUpdate).toHaveBeenCalledTimes(1)
    expect(productEventCreate).toHaveBeenCalledTimes(1)

    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      type: 'product.updated',
      productId: 'prod_xavia_42',
      reason: 'PRODUCT_UPDATED',
    })
  })

  it('product/update for an unknown product publishes nothing', async () => {
    productFindFirst.mockResolvedValueOnce(null)

    await dispatchShopifyWebhook('product/update', {
      id: 'unmapped_999',
      title: 'Anything',
    })

    expect(productUpdate).not.toHaveBeenCalled()
    expect(productEventCreate).not.toHaveBeenCalled()
    expect(received).toHaveLength(0)
  })
  it('marks managed remote edits for review without overwriting the family master', async () => {
    listingFindMany.mockResolvedValueOnce([{ id: 'native', version: 4, platformAttributes: { _nexusContent: { version: 1 }, _nexusContentPublish: { status: 'VERIFIED', remoteUpdatedAt: '2026-09-08T10:00:00Z' } } }])
    await dispatchShopifyWebhook('product/update', { id: '9876543210', title: 'Remote edit', updated_at: '2026-09-08T11:00:00Z' })
    expect(productUpdate).not.toHaveBeenCalled()
    expect(listingUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ platformAttributes: expect.objectContaining({ _nexusContentPublish: expect.objectContaining({ status: 'REMOTE_CHANGED' }) }) }) }))
  })

  it('product/delete on a known product publishes product.deleted', async () => {
    productFindFirst.mockResolvedValueOnce({ id: 'prod_xavia_43', shopifyProductId: '111' })
    productUpdate.mockResolvedValueOnce({})

    await dispatchShopifyWebhook('product/delete', { id: '111' })

    expect(productUpdate).toHaveBeenCalledTimes(1)
    expect(productEventCreate).toHaveBeenCalledTimes(1)
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      type: 'product.deleted',
      productId: 'prod_xavia_43',
    })
  })

  it('product/delete for an unknown product publishes nothing', async () => {
    productFindFirst.mockResolvedValueOnce(null)

    await dispatchShopifyWebhook('product/delete', { id: 'missing' })

    expect(productUpdate).not.toHaveBeenCalled()
    expect(productEventCreate).not.toHaveBeenCalled()
    expect(received).toHaveLength(0)
  })

  it('unknown eventType throws and publishes nothing', async () => {
    await expect(dispatchShopifyWebhook('product/spaghetti', {})).rejects.toThrow(
      /Unknown Shopify eventType/,
    )
    expect(received).toHaveLength(0)
  })
})
