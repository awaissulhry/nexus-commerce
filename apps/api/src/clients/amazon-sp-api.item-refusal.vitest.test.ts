/**
 * The Listings PATCH says when Amazon refused THIS item (`itemLevel`), so one listing's problem is not counted against
 * the whole market's circuit (MOSS IT 2026-10-12, `listing-publish.service.ts`). Item-level: errors in Amazon's
 * `issues[]` answer, or HTTP 404 (no such SKU). Every other HTTP failure may be the account's or the request's for
 * every item, so it is not item-level. The HTTP call, token, FBA guard and issue filing are faked: nothing is sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/amazon-sp-client.js', async (original) => ({
  ...(await original<object>()),
  amazonAccount: vi.fn(async () => ({ id: 'amz-A', externalAccountId: 'A1', channelType: 'AMAZON', isActive: true, authStatus: 'connected' })),
  getAmazonRegion: async () => 'eu',
}))
vi.mock('../db.js', () => ({
  default: {
    channelListing: { findMany: vi.fn(async () => []) },
    channelConnection: { findMany: vi.fn(async () => [{ id: 'amz-A', displayName: 'Amazon IT', externalAccountId: 'A1' }]) },
  },
}))

import { AmazonSpApiClient, amazonSpApiClient } from './amazon-sp-api.client.js'

const answer = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
let http: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  vi.stubEnv('NEXUS_ENABLE_AMAZON_PUBLISH', '1')
  vi.stubEnv('AMAZON_PUBLISH_MODE', 'live')
  const proto = AmazonSpApiClient.prototype as any
  vi.spyOn(proto, 'getAccessToken').mockResolvedValue('token')
  vi.spyOn(proto, 'guardFbaQtyFlip').mockImplementation(async (_sku: unknown, payload: unknown) => ({ payload, blocked: false }))
  vi.spyOn(proto, 'fileListingIssues').mockResolvedValue(undefined)
  http = vi.spyOn(proto, 'fetchWithRetry')
})
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

const submit = () => amazonSpApiClient.submitListingPayload({
  sellerId: 'A1', sku: 'TEST-SKU-1', marketplaceId: 'APJ6JRA9NG5V4',
  payload: { productType: '', patches: [{ op: 'replace', path: '/attributes/fulfillment_availability', value: [] }] } as never,
})

describe('Amazon refused THIS item', () => {
  it('errors in its issues[] answer (the MOSS 4000003 refusal)', async () => {
    http.mockResolvedValue(answer(200, { sku: 'TEST-SKU-1', status: 'INVALID', issues: [{ code: '4000003', message: 'The Amazon product type specified is invalid or not supported.', severity: 'ERROR' }] }))
    const r = await submit()
    expect(r).toMatchObject({ success: false, itemLevel: true })
    expect(r.error).toContain('4000003')
  })

  it('HTTP 404: no such SKU for this seller', async () => {
    http.mockResolvedValue(answer(404, { errors: [{ code: 'NOT_FOUND', message: 'not found' }] }))
    expect(await submit()).toMatchObject({ success: false, itemLevel: true })
  })
})

describe('not item-level: the account, the request or Amazon itself', () => {
  it.each([400, 401, 403, 429, 500, 503])('HTTP %i', async (status) => {
    http.mockResolvedValue(answer(status, { errors: [{ code: 'X', message: 'y' }] }))
    const r = await submit()
    expect(r.success).toBe(false)
    expect(r.itemLevel).toBeUndefined()
  })

  it('no answer (network)', async () => {
    http.mockRejectedValue(new Error('socket hang up'))
    const r = await submit()
    expect(r.success).toBe(false)
    expect(r.itemLevel).toBeUndefined()
  })

  it('an accepted item is a success, with no itemLevel', async () => {
    http.mockResolvedValue(answer(200, { sku: 'TEST-SKU-1', status: 'ACCEPTED', issues: [] }))
    const r = await submit()
    expect(r).toMatchObject({ success: true, status: 'ACCEPTED' })
    expect(r.itemLevel).toBeUndefined()
  })
})
