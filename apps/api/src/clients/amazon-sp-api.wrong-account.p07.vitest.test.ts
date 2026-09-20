/**
 * P0.7 — the Amazon client refuses a listing write for a SKU that belongs only to another Amazon
 * account, before any request; reads are not checked. Runs through the exported `amazonSpApiClient`
 * (the proxy every caller uses), with business profiles ON and OFF. `request` is spied on the
 * prototype, so "0 requests" and "1 request" are counted on the same instrument.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ owners: {} as Record<string, string> }))
vi.mock('../lib/amazon-sp-client.js', async (original) => ({
  ...(await original<object>()),
  amazonAccount: vi.fn(async () => ({ id: 'amz-A', externalAccountId: 'A1', channelType: 'AMAZON', isActive: true, authStatus: 'connected' })),
  getAmazonRegion: async () => 'eu',
}))
vi.mock('../db.js', () => ({
  default: {
    channelListing: {
      findMany: vi.fn(async ({ where }: any) => {
        const skus: string[] = where?.product?.sku?.in ?? where?.OR?.flatMap((w: any) => w.AND?.[0]?.product?.sku?.in ?? w.product?.sku?.in ?? []) ?? []
        return skus.filter((sku) => h.owners[sku]).map((sku) => ({ channelConnectionId: h.owners[sku], product: { sku } }))
      }),
    },
    channelConnection: { findMany: vi.fn(async () => [{ id: 'amz-A', displayName: 'Amazon IT', externalAccountId: 'A1' }, { id: 'amz-B', displayName: 'Amazon second', externalAccountId: 'B2' }]) },
  },
}))

import { AmazonSpApiClient, amazonSpApiClient } from './amazon-sp-api.client.js'

let request: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  vi.stubEnv('NEXUS_ENABLE_AMAZON_PUBLISH', '1')
  vi.stubEnv('AMAZON_PUBLISH_MODE', 'live')
  h.owners = {}
  request = vi.spyOn(AmazonSpApiClient.prototype, 'request').mockResolvedValue({ status: 'ACCEPTED', submissionId: 'stub' } as never)
})
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe.each([['ON', '1'], ['OFF', '0']])('P0.7 — Amazon client, business profiles %s', (_label, profiles) => {
  beforeEach(() => { vi.stubEnv('NEXUS_WORKSPACES_ENABLED', profiles) })
  const remove = () => amazonSpApiClient.deleteListingsItem({ sellerId: 'A1', sku: 'SKU-1', marketplaceId: 'APJ6JRA9NG5V4' })

  it('a SKU of the second account: refused, 0 requests', async () => {
    h.owners['SKU-1'] = 'amz-B'
    await expect(remove()).rejects.toMatchObject({ code: 'WRONG_ACCOUNT_WRITE', message: expect.stringMatching(/Nothing was sent to Amazon: .*"Amazon second"/) })
    expect(request).not.toHaveBeenCalled()
  })
  it('positive control: a SKU of the account in use is sent (1 request)', async () => {
    h.owners['SKU-1'] = 'amz-A'
    await expect(remove()).resolves.toMatchObject({ success: true })
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('a SKU with no recorded account is sent (nothing to contradict)', async () => {
    await expect(remove()).resolves.toMatchObject({ success: true })
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('the batch refuses when any SKU belongs to the second account, before any item is sent', async () => {
    h.owners['SKU-1'] = 'amz-A'; h.owners['SKU-2'] = 'amz-B'
    await expect(amazonSpApiClient.submitListingPayloadBatch([
      { sellerId: 'A1', sku: 'SKU-1', payload: { productType: 'COAT', patches: [] } as never, marketplaceId: 'APJ6JRA9NG5V4' },
      { sellerId: 'A1', sku: 'SKU-2', payload: { productType: 'COAT', patches: [] } as never, marketplaceId: 'APJ6JRA9NG5V4' },
    ])).rejects.toMatchObject({ code: 'WRONG_ACCOUNT_WRITE', message: expect.stringMatching(/SKU-2/) })
    expect(request).not.toHaveBeenCalled()
  })
})
