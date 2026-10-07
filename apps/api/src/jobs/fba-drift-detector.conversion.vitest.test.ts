/**
 * Amazon fulfilment conversion (2026-10-07) — the FBA drift detector never reverts an operator's FBM conversion.
 *
 * The detector reads Amazon's merchant listings report and auto-restores FBA (`restoreFbaListings`) for a SKU it expects
 * FBA that Amazon reports as FBM. A SKU an operator converted to FBM from the Matrix (its newest conversion is to FBM and
 * was not refused) is the operator's choice: alerted, NEVER restored. Conversions that cannot be read restore nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ restore: vi.fn(), converted: vi.fn(), catalog: vi.fn() }))
vi.mock('@nexus/database', async (original) => {
  const prisma = {
    stockLevel: { findMany: async () => [{ productId: 'pA' }, { productId: 'pB' }] },
    channelListing: { findMany: async () => [
      { id: 'lA', marketplace: 'IT', channel: 'AMAZON', product: { sku: 'SKU-A' } },
      { id: 'lB', marketplace: 'IT', channel: 'AMAZON', product: { sku: 'SKU-B' } },
    ] },
  }
  return { ...(await original<object>()), prisma, default: prisma }
})
vi.mock('../utils/cron-observability.js', () => ({ recordCronRun: async (_job: string, fn: () => Promise<unknown>) => fn() }))
vi.mock('../services/marketplaces/amazon.service.js', () => ({ AmazonService: class { isConfigured = async () => true; fetchActiveCatalog = h.catalog } }))
vi.mock('../services/fba-restore.service.js', () => ({ restoreFbaListings: h.restore }))
vi.mock('../services/pim/fulfilment-conversion.service.js', () => ({ operatorFbmConversions: h.converted }))
vi.mock('../services/listings/reported-sku.js', async (original) => ({ ...(await original<object>()), amazonAccountIdFor: async () => null, onAccount: () => ({}) }))
vi.mock('../lib/cron/clustered.js', () => ({ default: { schedule: vi.fn(), validate: () => true } }))

import { runFbaDriftDetector } from './fba-drift-detector.job.js'

const IT = 'APJ6JRA9NG5V4'
beforeEach(() => {
  h.restore.mockReset().mockResolvedValue({ dryRun: false, processed: 1, sent: 1, skippedNoFba: 0, skippedKeptCode: 0, results: [] })
  h.catalog.mockReset().mockResolvedValue([{ sku: 'SKU-A', fulfillmentChannel: 'DEFAULT' }, { sku: 'SKU-B', fulfillmentChannel: 'DEFAULT' }])
})

describe('fba-drift-detector and operator conversions', () => {
  it('restores real drift only: a SKU an operator converted to FBM is alerted, never restored', async () => {
    h.converted.mockReset().mockResolvedValue(new Set([`SKU-A|${IT}`]))
    await runFbaDriftDetector()
    expect(h.converted).toHaveBeenCalledWith([{ sku: 'SKU-A', marketplaceId: IT }, { sku: 'SKU-B', marketplaceId: IT }])
    expect(h.restore).toHaveBeenCalledTimes(1)
    expect(h.restore.mock.calls[0][0]).toMatchObject({ skus: ['SKU-B'], marketplaces: ['IT'], dryRun: false })
  })

  it('every drifted SKU was an operator\'s conversion: nothing is restored', async () => {
    h.converted.mockReset().mockResolvedValue(new Set([`SKU-A|${IT}`, `SKU-B|${IT}`]))
    await runFbaDriftDetector()
    expect(h.restore).not.toHaveBeenCalled()
  })

  it('the conversions cannot be read: nothing is restored (an operator\'s conversion is never reverted on a guess)', async () => {
    h.converted.mockReset().mockRejectedValue(new Error('db down'))
    await runFbaDriftDetector()
    expect(h.restore).not.toHaveBeenCalled()
  })
})
