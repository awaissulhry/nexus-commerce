/**
 * 🔴 A-24 (R-20) — the Amazon queue push takes its market from the row's own LISTING.
 *
 * It was `payload.marketplaceId ?? AMAZON_DEFAULT_MARKETPLACE ?? "IT"`. No producer but the mapping
 * cascade sets `marketplaceId` and the variable is defined nowhere, so every price, content and stock
 * row was built and submitted for ITALY. Production had 256 German and Spanish stock rows marked sent
 * that way on 2026-09-08. The harness is P1.7's (`...amazon-preview.p17.vitest.test.ts`): live mode,
 * every outside call faked, `submitListingPayload` records what would go out.
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
    // P4.4a — the Amazon price attribute reads Marketplace.currency.
    marketplace: { currency: 'EUR', languages: ['it'], language: 'it' },
  }
  const table = (model: string) => ({
    findUnique: model === 'channelListing' ? m.read : vi.fn(async () => rows[model] ?? null),
    findMany: model === 'channelListing' ? m.many : vi.fn(async () => []),
    findFirst: vi.fn(async () => rows[model] ?? null),
    findUniqueOrThrow: vi.fn(async () => rows[model] ?? {}),
    findFirstOrThrow: vi.fn(async () => rows[model] ?? {}),
    create: vi.fn(async () => ({})), update: vi.fn(async () => ({})), updateMany: vi.fn(async () => ({ count: 0 })),
    upsert: vi.fn(async () => ({})), count: vi.fn(async () => 0), aggregate: vi.fn(async () => ({ _sum: { quantity: null } })), // the stock path reads a real aggregate shape
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

const IDS = { IT: 'APJ6JRA9NG5V4', DE: 'A1PA6795UKMFR9', ES: 'A1RKKUPIHCS9HS' }
const listingOn = (marketplace: string | null) => m.read.mockResolvedValue(marketplace === null ? null
  : { id: 'l', marketplace, platformAttributes: {}, syncPaused: false, productType: 'OUTERWEAR' })

describe('A-24 — the listing decides the Amazon market, never a default', () => {
  // The market is decided once, before any row-type branch, so price rows prove it for every type. (A stock
  // row also needs a routed stock location; its own guard already names the listing's market.)
  it.each([
    ['PRICE_UPDATE', { price: 12, productType: 'OUTERWEAR' }],
    ['PRICE_UPDATE with a sale', { price: 12, salePrice: 10, salePriceStart: '2026-10-01', salePriceEnd: '2026-10-05', productType: 'OUTERWEAR' }],
  ])('a %s row on a DE listing with no marketplaceId goes to DE, not Italy', async (_type, payload) => {
    listingOn('DE')
    const result = await service.syncToAmazon(row('PRICE_UPDATE', { ...payload, marketplace: 'DE' }))
    expect(result, JSON.stringify(result)).toMatchObject({ success: true })
    expect(m.submit).toHaveBeenCalledTimes(1)
    expect(m.submit.mock.calls[0][0].marketplaceId).toBe(IDS.DE)
    expect(JSON.stringify(m.submit.mock.calls[0][0].payload)).not.toContain(IDS.IT)
  })

  it('control: an IT listing still goes to IT', async () => {
    listingOn('IT')
    await service.syncToAmazon(row('PRICE_UPDATE', { price: 12, productType: 'OUTERWEAR', marketplace: 'IT' }))
    expect(m.submit.mock.calls[0][0].marketplaceId).toBe(IDS.IT)
  })

  it('the mapping cascade (payload.marketplaceId agrees with the listing) is unchanged', async () => {
    listingOn('ES')
    await service.syncToAmazon(row('PRICE_UPDATE', { price: 12, productType: 'OUTERWEAR', marketplaceId: 'ES' }))
    expect(m.submit.mock.calls[0][0].marketplaceId).toBe(IDS.ES)
  })

  it.each([
    ['a market with no id (TR)', 'TR', {}, 'Amazon · TR has no marketplace id in the push, so nothing was sent.'],
    ['a payload that disagrees with its listing', 'DE', { marketplaceId: 'IT' }, 'This row asks for IT, but its listing is on DE, so nothing was sent.'],
    ['no listing and no marketplaceId', null, {}, 'This row names no Amazon market and has no listing to take one from, so nothing was sent.'],
  ])('refuses %s, and sends nothing', async (_name, market, extra, sentence) => {
    listingOn(market as string | null)
    const result = await service.syncToAmazon(row('PRICE_UPDATE', { price: 12, productType: 'OUTERWEAR', ...extra }))
    expect(result).toMatchObject({ success: false, status: 'FAILED', errorCode: 'AMAZON_MARKET_UNRESOLVED', error: sentence, retryable: false })
    expect(m.submit).not.toHaveBeenCalled()
    expect(m.validate).not.toHaveBeenCalled()
  })
})
