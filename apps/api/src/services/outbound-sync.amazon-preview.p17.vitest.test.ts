/**
 * P1.7 — the outbound queue asks Amazon first for a CONTENT write. Before this it previewed only the
 * mapping source (`FM_CATALOG_CASCADE`), so an ordinary content row went straight to the Listings API.
 * A price- or stock-only row still needs no preview. `submitListingPayload` records what would go out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => {
  const outbound = vi.fn(() => { throw new Error('Unexpected outbound fetch') }); vi.stubGlobal('fetch', outbound)
  return {
    outbound,
    read: vi.fn(), many: vi.fn(), seller: vi.fn(), audit: vi.fn(),
    validate: vi.fn(), submit: vi.fn(),
    answer: { ok: true, available: true, errors: null as string | null },
  }
})
// Any model this lane happens to read answers "nothing"; the two rows it must find are explicit.
vi.mock('../db.js', () => {
  const rows: Record<string, unknown> = {
    channelListing: { id: 'l', marketplace: 'IT', platformAttributes: {}, syncPaused: false, translations: [] },
    product: { id: 'p', sku: 'SKU', name: 'Jacket', translations: [], parent: null },
  }
  const table = (model: string) => ({
    findUnique: model === 'channelListing' ? m.read : vi.fn(async () => rows[model] ?? null),
    findMany: model === 'channelListing' ? m.many : vi.fn(async () => []),
    findFirst: vi.fn(async () => rows[model] ?? null),
    findUniqueOrThrow: vi.fn(async () => rows[model] ?? {}),
    findFirstOrThrow: vi.fn(async () => rows[model] ?? {}),
    create: vi.fn(async () => ({})), update: vi.fn(async () => ({})), updateMany: vi.fn(async () => ({ count: 0 })),
    upsert: vi.fn(async () => ({})), count: vi.fn(async () => 0), aggregate: vi.fn(async () => ({})),
  })
  const cache = new Map<string, unknown>()
  return {
    default: new Proxy({}, {
      get: (_t, model: string) => {
        if (model === '$transaction') return async (run: any) => (typeof run === 'function' ? run({}) : run)
        if (!cache.has(model)) cache.set(model, table(model))
        return cache.get(model)
      },
    }),
  }
})
vi.mock('../lib/amazon-sp-client.js', () => ({ getAmazonSellerId: m.seller }))
vi.mock('../lib/queue.js', () => ({ addJobSafely: vi.fn(), outboundSyncQueue: null, readCacheQueue: null, searchIndexQueue: null, redis: { connection: null } }))
vi.mock('./sync-control-policy.service.js', () => ({ loadChannelPolicies: async () => new Map(), policyFor: () => null }))
vi.mock('./channel-publish-audit.service.js', () => ({ writeAttemptLog: m.audit, digestPayload: () => 'stub' }))
vi.mock('./pim/market-languages.js', async (original) => ({
  ...(await original<object>()),
  marketLanguages: vi.fn(async () => ['it']),
}))
vi.mock('../clients/amazon-sp-api.client.js', () => ({
  amazonSpApiClient: {
    validateListing: vi.fn(async (options: any) => { m.validate(options); return { ...m.answer, warnings: [] } }),
    submitListingPayload: vi.fn(async (options: any) => { m.submit(options); return { success: true } }),
  },
}))

const { OutboundSyncService } = await import('./outbound-sync.service.js')
const service: any = new OutboundSyncService()

const row = (syncType: string, payload: Record<string, unknown>) => ({
  id: 'q', channelListingId: 'l', channelConnectionId: 'amz-1', targetChannel: 'AMAZON', targetRegion: 'IT', syncType,
  product: { id: 'p', sku: 'SKU', productType: 'OUTERWEAR' }, payload,
})

beforeEach(() => {
  vi.clearAllMocks()
  m.answer = { ok: true, available: true, errors: null }
  vi.stubEnv('NEXUS_ENABLE_AMAZON_PUBLISH', 'true'); vi.stubEnv('AMAZON_PUBLISH_MODE', 'live')
  m.seller.mockResolvedValue('seller')
  m.read.mockResolvedValue({ id: 'l', marketplace: 'IT', platformAttributes: {}, syncPaused: false, productType: 'OUTERWEAR' })
  m.many.mockResolvedValue([])
})
afterEach(() => { vi.unstubAllEnvs() })

describe('P1.7 — the Amazon queue previews a content write', () => {
  it('DONE-WHEN: a content row is previewed with the same patches, then submitted', async () => {
    const result = await service.syncToAmazon(row('CONTENT_UPDATE', { title: 'New title', productType: 'OUTERWEAR' }))
    expect(m.validate).toHaveBeenCalledTimes(1)
    const preview = m.validate.mock.calls[0][0]
    const submitted = m.submit.mock.calls[0]?.[0]
    expect(preview).toMatchObject({ sellerId: 'seller', sku: 'SKU', productType: 'OUTERWEAR' })
    expect(preview.patches).toEqual(submitted.payload.patches)
    expect(result.status).toBe('SUCCESS')
  })
  it('Amazon refuses the content: nothing is submitted, and the row says why', async () => {
    m.answer = { ok: false, available: true, errors: 'Item specific Size is missing' }
    const result = await service.syncToAmazon(row('CONTENT_UPDATE', { title: 'New title', productType: 'OUTERWEAR' }))
    expect(m.submit).not.toHaveBeenCalled()
    expect(result.status).toBe('FAILED')
    expect(result.error).toMatch(/Item specific Size is missing/)
  })
  it('the preview cannot run: fail-closed, nothing is submitted', async () => {
    m.answer = { ok: true, available: false, errors: null }
    const result = await service.syncToAmazon(row('CONTENT_UPDATE', { title: 'New title', productType: 'OUTERWEAR' }))
    expect(m.submit).not.toHaveBeenCalled()
    expect(result.status).toBe('FAILED')
  })
  it('a price-only row is not content: no preview, still submitted', async () => {
    const result = await service.syncToAmazon(row('PRICE_UPDATE', { price: 19.9, productType: 'OUTERWEAR' }))
    expect(m.validate).not.toHaveBeenCalled()
    expect(m.submit).toHaveBeenCalledTimes(1)
    expect(result.status).toBe('SUCCESS')
  })
})
