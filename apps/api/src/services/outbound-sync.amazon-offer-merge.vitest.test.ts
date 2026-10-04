/**
 * An Amazon price push changes ONLY what Nexus means to change in the live offer (2026-09-30).
 *
 * `buildAmazonListingPatch` emits `op: replace` on `/attributes/purchasable_offer` with one instance holding `currency`,
 * `our_price` and `marketplace_id`. Before this fix it went out as built, so a master price change could take with it
 * whatever Nexus does not send: a sale set in Seller Central, `map_price`, the min/max seller-allowed prices, the offer
 * dates, the B2B instance. Now `syncToAmazon` reads the live offer (through the gateway client) right before the write
 * and sends ONE `merge` on the instance it prices (`amazon/purchasable-offer.ts`), the op Amazon documents for changing
 * single sub-attributes: https://developer-docs.amazon/sp-api/docs/manage-purchasable-offer.
 *
 * The harness is P1.7's (`outbound-sync.amazon-preview.p17.vitest.test.ts`): live mode, every outside call faked,
 * `submitListingPayload` records what would go out and `getListingsItem` answers the live offer. Nothing reaches Amazon.
 * All SKUs and ASINs are fake; marketplace ids are Amazon's public ones.
 *
 * The merge ships behind `NEXUS_AMAZON_OFFER_MERGE=1` (OFF by default, Owner 2026-09-30). Every arm below runs with the
 * switch ON except "the switch", which pins OFF to exactly what `main` sent: the builder's replace and no live read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => {
  const outbound = vi.fn(() => { throw new Error('Unexpected outbound fetch') }); vi.stubGlobal('fetch', outbound)
  return {
    outbound,
    read: vi.fn(), many: vi.fn(), seller: vi.fn(), audit: vi.fn(),
    get: vi.fn(), validate: vi.fn(), submit: vi.fn(), windows: vi.fn(),
  }
})
// Any model this lane happens to read answers "nothing"; the rows it must find are explicit.
vi.mock('../db.js', () => {
  const rows: Record<string, unknown> = {
    channelListing: { id: 'l', marketplace: 'IT', platformAttributes: {}, syncPaused: false, translations: [] },
    product: { id: 'p', sku: 'TEST-SKU-1', name: 'Jacket', translations: [], parent: null },
    marketplace: { currency: 'EUR', languages: ['it'], language: 'it' },
  }
  const table = (model: string) => ({
    findUnique: model === 'channelListing' ? m.read : vi.fn(async () => rows[model] ?? null),
    findMany: model === 'channelListing' ? m.many : vi.fn(async () => []),
    findFirst: vi.fn(async () => rows[model] ?? null),
    findUniqueOrThrow: vi.fn(async () => rows[model] ?? {}),
    findFirstOrThrow: vi.fn(async () => rows[model] ?? {}),
    create: vi.fn(async () => ({})), update: vi.fn(async () => ({})), updateMany: vi.fn(async () => ({ count: 0 })),
    upsert: vi.fn(async () => ({})), count: vi.fn(async () => 0), aggregate: vi.fn(async () => ({ _sum: { quantity: null } })),
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
// The listing's stored sale window (MX.1) — the raw-SQL columns are not in this fake database.
vi.mock('./pim/sale-window.js', async (original) => ({ ...(await original<object>()), readSaleWindows: m.windows }))
vi.mock('../clients/amazon-sp-api.client.js', () => ({
  amazonSpApiClient: {
    getListingsItem: vi.fn(async (options: any) => m.get(options)),
    validateListing: vi.fn(async (options: any) => { m.validate(options); return { ok: true, available: true, errors: null, warnings: [] } }),
    submitListingPayload: vi.fn(async (options: any) => { m.submit(options); return { success: true } }),
  },
}))

const { OutboundSyncService, buildAmazonListingPatch, computeFailureDisposition } = await import('./outbound-sync.service.js')
const { IT, applyToOffer, liveOffer, liveRead, sellerCentralSale } = await import('../test-support/amazon-offer-model.js')
const { amazonPriceOfferPlan } = await import('./amazon/purchasable-offer.js')
const service: any = new OutboundSyncService()

const SKU = 'TEST-SKU-1'

const row = (syncType: string, payload: Record<string, unknown>) => ({
  id: 'q', channelListingId: 'l', channelConnectionId: 'amz-1', targetChannel: 'AMAZON', targetRegion: 'IT', syncType,
  product: { id: 'p', sku: SKU, productType: 'OUTERWEAR' }, payload,
})
const masterPrice = (price: number) => row('PRICE_UPDATE', { source: 'MASTER_PRICE_CHANGE', price, oldPrice: 120, masterPrice: price, productType: 'OUTERWEAR' })
const priceWrite = (extra: Record<string, unknown>) => row('PRICE_UPDATE', { source: 'CHANNEL_PRICE_WRITE', marketplace: 'IT', price: 115, salePrice: null, salePriceStart: null, salePriceEnd: null, productType: 'OUTERWEAR', ...extra })

const submitted = () => m.submit.mock.calls[0][0].payload
const onlyPatch = () => {
  const { patches } = submitted()
  expect(patches).toHaveLength(1)
  return patches[0]
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NEXUS_ENABLE_AMAZON_PUBLISH', 'true'); vi.stubEnv('AMAZON_PUBLISH_MODE', 'live')
  vi.stubEnv('NEXUS_AMAZON_OFFER_MERGE', '1') // the switch ON; the OFF arms unset it
  m.seller.mockResolvedValue('seller')
  m.read.mockResolvedValue({ id: 'l', marketplace: 'IT', platformAttributes: {}, syncPaused: false, productType: 'OUTERWEAR', fulfillmentMethod: 'FBM', salePrice: null })
  m.many.mockResolvedValue([])
  m.windows.mockResolvedValue(new Map())
  m.get.mockResolvedValue(liveRead(liveOffer()))
})
afterEach(() => { vi.unstubAllEnvs() })

describe('a price push changes only our_price of the right instance', () => {
  it.each([
    ['the listing holds no sale', null, new Map()],
    ['the listing holds a promotion sale with no window (never sent to Amazon)', 89, new Map([['l', { start: null, end: null }]])],
  ])('Seller Central sale, map_price, min/max, dates, B2B and DE instances all stay — %s', async (_label, salePrice, windows) => {
    m.read.mockResolvedValue({ id: 'l', marketplace: 'IT', platformAttributes: {}, syncPaused: false, productType: 'OUTERWEAR', fulfillmentMethod: 'FBM', salePrice })
    m.windows.mockResolvedValue(windows)
    const result = await service.syncToAmazon(masterPrice(115))
    expect(result, JSON.stringify(result)).toMatchObject({ success: true, status: 'SUCCESS' })

    // One live read, through the client (so through the gateway), for THIS market.
    expect(m.get).toHaveBeenCalledExactlyOnceWith({ sellerId: 'seller', sku: SKU, marketplaceId: IT, includedData: ['attributes', 'summaries'] })
    expect(m.submit.mock.calls[0][0].marketplaceId).toBe(IT)
    // ONE merge on the default-audience IT instance: its selectors and the new our_price, nothing else.
    const patch = onlyPatch()
    expect(patch).toEqual({
      op: 'merge', path: '/attributes/purchasable_offer',
      value: [{ currency: 'EUR', audience: 'ALL', marketplace_id: IT, our_price: [{ schedule: [{ value_with_tax: 115 }] }] }],
    })

    // Applied as Amazon documents it: our_price of the IT/ALL instance changes; every other byte stays.
    const before = liveOffer()
    const after = applyToOffer(before, patch)
    expect(after[0]).toEqual({ ...before[0], our_price: [{ schedule: [{ value_with_tax: 115 }] }] })
    expect(JSON.stringify({ ...after[0], our_price: null })).toBe(JSON.stringify({ ...before[0], our_price: null }))
    expect(JSON.stringify(after[1])).toBe(JSON.stringify(before[1]))
    expect(JSON.stringify(after[2])).toBe(JSON.stringify(before[2]))
    expect(after).toHaveLength(3)
  })

  it('never sends a quantity: no fulfillment_availability, no quantity anywhere in the body', async () => {
    await service.syncToAmazon(masterPrice(115))
    const body = JSON.stringify(submitted())
    expect(body).not.toContain('fulfillment_availability')
    expect(body).not.toMatch(/"quantity"/)
  })
})

describe('the sale rule', () => {
  const nexusSale = [{ schedule: [{ start_at: '2026-10-01', end_at: '2026-10-15', value_with_tax: 95 }] }]

  it('Nexus owns a sale (value + window on the row): discounted_price is sent, in the shape the builder always sent', async () => {
    await service.syncToAmazon(priceWrite({ salePrice: 95, salePriceStart: '2026-10-01', salePriceEnd: '2026-10-15' }))
    const built = await buildAmazonListingPatch({ price: 115, salePrice: 95, salePriceStart: '2026-10-01', salePriceEnd: '2026-10-15' } as never, 'IT', 'OUTERWEAR')
    expect(onlyPatch().value[0].discounted_price).toEqual(built.patches[0].value[0].discounted_price)
    expect(onlyPatch().value[0].discounted_price).toEqual(nexusSale)
    expect(applyToOffer(liveOffer(), onlyPatch())[0].discounted_price).toEqual(nexusSale)
  })

  it('Nexus owns a sale (stored on the listing, a legacy row that carries none): it is filled and sent, as before', async () => {
    m.read.mockResolvedValue({ id: 'l', marketplace: 'IT', platformAttributes: {}, syncPaused: false, productType: 'OUTERWEAR', fulfillmentMethod: 'FBM', salePrice: 95 })
    m.windows.mockResolvedValue(new Map([['l', { start: '2026-10-01', end: '2026-10-15' }]]))
    await service.syncToAmazon(masterPrice(115))
    expect(onlyPatch().value[0]).toEqual({ currency: 'EUR', audience: 'ALL', marketplace_id: IT, our_price: [{ schedule: [{ value_with_tax: 115 }] }], discounted_price: nexusSale })
  })

  it('Nexus has no sale and never set one: Amazon\'s live sale is not touched (no discounted_price key at all)', async () => {
    await service.syncToAmazon(priceWrite({}))
    expect('discounted_price' in onlyPatch().value[0]).toBe(false)
    expect(applyToOffer(liveOffer(), onlyPatch())[0].discounted_price).toEqual(sellerCentralSale)
  })

  it('a person removed Nexus\'s sale on purpose (saleRemoved): the sale is deleted on Amazon, and only the sale', async () => {
    await service.syncToAmazon(priceWrite({ saleRemoved: true }))
    const patch = onlyPatch()
    expect(patch.value[0]).toEqual({ currency: 'EUR', audience: 'ALL', marketplace_id: IT, our_price: [{ schedule: [{ value_with_tax: 115 }] }], discounted_price: null })
    const before = liveOffer()
    const after = applyToOffer(before, patch)
    expect('discounted_price' in after[0]).toBe(false)
    const { discounted_price: _gone, our_price: _price, ...rest } = before[0]
    expect(after[0]).toEqual({ ...rest, our_price: [{ schedule: [{ value_with_tax: 115 }] }] })
    expect(after.slice(1)).toEqual(before.slice(1))
  })

  it('a removal when Amazon shows no sale sends no delete', async () => {
    const [standard, ...others] = liveOffer()
    const { discounted_price: _none, ...noSale } = standard
    m.get.mockResolvedValue(liveRead([noSale, ...others]))
    await service.syncToAmazon(priceWrite({ saleRemoved: true }))
    expect('discounted_price' in onlyPatch().value[0]).toBe(false)
  })
})

describe('a failed live read sends nothing and fails the row retryably', () => {
  it.each([
    ['answers success:false', () => m.get.mockResolvedValue({ success: false, sku: SKU, asin: null, status: null, error: 'Amazon listing read failed (500)' }), 'Amazon listing read failed (500)'],
    ['throws', () => m.get.mockRejectedValue(new Error('socket hang up')), 'socket hang up'],
  ])('the read %s', async (_label, arrange, cause) => {
    arrange()
    const result = await service.syncToAmazon(masterPrice(115))
    expect(m.submit).not.toHaveBeenCalled()
    expect(m.validate).not.toHaveBeenCalled()
    expect(result).toMatchObject({ success: false, status: 'FAILED', errorCode: 'AMAZON_OFFER_READ_FAILED', retryable: true })
    expect(result.error).toContain(cause)
    expect(result.error).toMatch(/could not be read.*so the price was not sent.*It will be retried/)
    // The queue retries it (backoff), it is not dead-lettered.
    expect(computeFailureDisposition({ retryCount: 0, maxRetries: 3 }, result.error, { errorCode: result.errorCode, retryable: result.retryable }).kind).toBe('retry')
  })
})

describe('no live offer in this market yet (a first offer): today\'s behaviour, the builder\'s replace', () => {
  it.each([
    ['the listing read answers 404', { success: true, sku: SKU, asin: null, status: null }],
    ['the attributes carry no purchasable_offer', liveRead(undefined)],
    ['the only instance is another market\'s', liveRead([liveOffer()[2]])],
  ])('%s', async (_label, answer) => {
    m.get.mockResolvedValue(answer)
    await service.syncToAmazon(masterPrice(115))
    expect(submitted()).toEqual(await buildAmazonListingPatch({ source: 'MASTER_PRICE_CHANGE', price: 115, oldPrice: 120, masterPrice: 115, productType: 'OUTERWEAR' } as never, 'IT', 'OUTERWEAR', 'FBM'))
    expect(onlyPatch().op).toBe('replace')
  })
})

describe('an offer the push cannot name is refused, not overwritten', () => {
  it.each([
    ['only a B2B offer in this market', [liveOffer()[1]]],
    ['the standard offer is in another currency', [{ ...liveOffer()[0], currency: 'GBP' }]],
  ])('%s → nothing sent, terminal', async (_label, instances) => {
    m.get.mockResolvedValue(liveRead(instances))
    const result = await service.syncToAmazon(masterPrice(115))
    expect(m.submit).not.toHaveBeenCalled()
    expect(result).toMatchObject({ success: false, status: 'FAILED', errorCode: 'AMAZON_OFFER_NOT_MATCHED', retryable: false })
    expect(result.error).toMatch(/so the price was not sent/)
  })
})

describe('the switch (NEXUS_AMAZON_OFFER_MERGE)', () => {
  it.each([['unset', undefined], ['0', '0'], ['true', 'true'], ['on', 'on']])('%s → OFF: no live read, and the patch is byte-identical to main\'s (the builder\'s replace)', async (_label, value) => {
    vi.stubEnv('NEXUS_AMAZON_OFFER_MERGE', value as string)
    await service.syncToAmazon(masterPrice(115))
    expect(m.get).not.toHaveBeenCalled()
    expect(submitted()).toEqual(await buildAmazonListingPatch({ source: 'MASTER_PRICE_CHANGE', price: 115, oldPrice: 120, masterPrice: 115, productType: 'OUTERWEAR' } as never, 'IT', 'OUTERWEAR', 'FBM'))
    expect(onlyPatch().op).toBe('replace')
  })
  it('OFF with a Nexus sale and a removal flag on the row: still exactly the builder\'s replace (the flag is inert)', async () => {
    vi.stubEnv('NEXUS_AMAZON_OFFER_MERGE', '')
    await service.syncToAmazon(priceWrite({ salePrice: 95, salePriceStart: '2026-10-01', salePriceEnd: '2026-10-15', saleRemoved: true }))
    expect(m.get).not.toHaveBeenCalled()
    expect(submitted()).toEqual(await buildAmazonListingPatch({ price: 115, salePrice: 95, salePriceStart: '2026-10-01', salePriceEnd: '2026-10-15' } as never, 'IT', 'OUTERWEAR', 'FBM'))
  })
  it('OFF, the live read failing does not matter: no read is made, the replace goes as before', async () => {
    vi.stubEnv('NEXUS_AMAZON_OFFER_MERGE', '')
    m.get.mockRejectedValue(new Error('socket hang up'))
    expect(await service.syncToAmazon(masterPrice(115))).toMatchObject({ success: true, status: 'SUCCESS' })
    expect(m.get).not.toHaveBeenCalled()
  })
  it('is read at send time: the same service turns it on and off between two pushes', async () => {
    vi.stubEnv('NEXUS_AMAZON_OFFER_MERGE', '')
    await service.syncToAmazon(masterPrice(115))
    vi.stubEnv('NEXUS_AMAZON_OFFER_MERGE', '1')
    await service.syncToAmazon(masterPrice(115))
    expect(m.submit.mock.calls.map((c: any[]) => c[0].payload.patches[0].op)).toEqual(['replace', 'merge'])
    expect(m.get).toHaveBeenCalledTimes(1)
  })
})

describe('what does not change', () => {
  it.each([['gated', undefined, undefined], ['dry-run', 'true', 'dry-run'], ['sandbox', 'true', 'sandbox']])('%s mode, switch ON: no live read, as before', async (_mode, flag, mode) => {
    vi.unstubAllEnvs()
    vi.stubEnv('NEXUS_AMAZON_OFFER_MERGE', '1')
    if (flag) vi.stubEnv('NEXUS_ENABLE_AMAZON_PUBLISH', flag)
    if (mode) vi.stubEnv('AMAZON_PUBLISH_MODE', mode)
    await service.syncToAmazon(masterPrice(115))
    expect(m.get).not.toHaveBeenCalled()
    // Sandbox reaches the (faked) submit, which the real client answers as a dry run; the others never get there.
    if (mode === 'sandbox') expect(onlyPatch().op).toBe('replace')
    else expect(m.submit).not.toHaveBeenCalled()
  })

  it('a content-only row reads no offer', async () => {
    await service.syncToAmazon(row('CONTENT_UPDATE', { title: 'New title', productType: 'OUTERWEAR' }))
    expect(m.get).not.toHaveBeenCalled()
    expect(submitted().patches.every((p: { op: string }) => p.op === 'replace')).toBe(true)
  })

  it('content + price: the content patch is untouched, and Amazon\'s preview sees the exact merge that is sent', async () => {
    await service.syncToAmazon(row('FULL_SYNC', { title: 'New title', price: 115, productType: 'OUTERWEAR' }))
    const { patches } = submitted()
    expect(m.validate.mock.calls[0][0].patches).toEqual(patches)
    expect(patches.find((p: { path: string }) => p.path === '/attributes/item_name').op).toBe('replace')
    expect(patches.find((p: { path: string }) => p.path === '/attributes/purchasable_offer').op).toBe('merge')
  })
})

describe('amazonPriceOfferPlan — the instance it names', () => {
  const built = { currency: 'EUR', our_price: [{ schedule: [{ value_with_tax: 10 }] }], marketplace_id: IT }
  it('an instance that names no market is this market\'s (the read is scoped to it); a missing audience is ALL', () => {
    const plan = amazonPriceOfferPlan({ built, live: [{ currency: 'EUR', our_price: [] }], marketplaceId: IT, saleRemoved: false })
    expect(plan).toEqual({ kind: 'merge', patch: { op: 'merge', path: '/attributes/purchasable_offer', value: [{ currency: 'EUR', audience: 'ALL', marketplace_id: IT, our_price: built.our_price }] } })
  })
  it('the live selectors are sent as Amazon holds them', () => {
    const plan = amazonPriceOfferPlan({ built, live: [{ marketplace_id: IT, currency: 'eur', audience: 'all' }], marketplaceId: IT, saleRemoved: false })
    expect(plan).toMatchObject({ kind: 'merge', patch: { value: [{ currency: 'eur', audience: 'all', marketplace_id: IT }] } })
  })
})

describe('Amazon sheet gaps — the merge carries the offer leaves Nexus holds live', () => {
  const scheduled = (n: number) => [{ schedule: [{ value_with_tax: n }] }]
  const held = (platformAttributes: Record<string, unknown>) =>
    m.read.mockResolvedValue({ id: 'l', marketplace: 'IT', platformAttributes, syncPaused: false, productType: 'OUTERWEAR', fulfillmentMethod: 'FBM', salePrice: null })

  it('min/max/MAP, the offer window and the rule from Nexus\'s own store replace Amazon\'s; the sale, B2B and DE stay', async () => {
    held({ amazonOffer: { minimum_seller_allowed_price: 95, maximum_seller_allowed_price: 140, map_price: 100, start_at: '2026-02-01', end_at: '2027-06-30', automated_pricing_rule_id: 'R1' } })
    await service.syncToAmazon(masterPrice(115))
    const patch = onlyPatch()
    expect(patch).toEqual({ op: 'merge', path: '/attributes/purchasable_offer', value: [{
      currency: 'EUR', audience: 'ALL', marketplace_id: IT, our_price: scheduled(115),
      minimum_seller_allowed_price: scheduled(95), maximum_seller_allowed_price: scheduled(140), map_price: scheduled(100),
      start_at: { value: '2026-02-01' }, end_at: { value: '2027-06-30' },
      automated_pricing_merchandising_rule_plan: [{ merchandising_rule: { rule_id: 'R1' } }],
    }] })
    const before = liveOffer()
    const after = applyToOffer(before, patch)
    expect(after[0].discounted_price).toEqual(sellerCentralSale)
    expect(after.slice(1)).toEqual(before.slice(1))
  })

  it('a leaf Nexus cleared (null) is deleted — only because Amazon\'s live offer still has it', async () => {
    held({ amazonOffer: { map_price: null, automated_pricing_rule_id: null } })
    await service.syncToAmazon(masterPrice(115))
    const value = onlyPatch().value[0]
    // The live fixture carries map_price but no Automate Pricing rule: one delete, no null for what is not there.
    expect(value).toEqual({ currency: 'EUR', audience: 'ALL', marketplace_id: IT, our_price: scheduled(115), map_price: null })
    expect('map_price' in applyToOffer(liveOffer(), onlyPatch())[0]).toBe(false)
  })

  it('a value Amazon reported (the pull\'s mirror) is not Nexus\'s: it is not sent, Amazon\'s live value stays', async () => {
    held({ attributes: { purchasable_offer: [{ marketplace_id: IT, currency: 'EUR', map_price: scheduled(70), minimum_seller_allowed_price: scheduled(60) }] } })
    await service.syncToAmazon(masterPrice(115))
    expect(onlyPatch().value[0]).toEqual({ currency: 'EUR', audience: 'ALL', marketplace_id: IT, our_price: scheduled(115) })
    expect(applyToOffer(liveOffer(), onlyPatch())[0].map_price).toEqual(scheduled(110))
  })

  it('a draft waiting for Publish is never sent by the job', async () => {
    held({ amazonOffer: { map_price: 100 }, amazonOfferDraft: { v: 1, leaves: { map_price: { value: 105, base: 100, savedAt: '', savedBy: '' }, minimum_seller_allowed_price: { value: 99, base: null, savedAt: '', savedBy: '' } } } })
    await service.syncToAmazon(masterPrice(115))
    expect(onlyPatch().value[0]).toEqual({ currency: 'EUR', audience: 'ALL', marketplace_id: IT, our_price: scheduled(115), map_price: scheduled(100) })
  })

  it('amazonPriceOfferPlan: price and sale never come from `held` (the built instance carries them)', async () => {
    const { readAmazonOfferFacts } = await import('./amazon/offer-facts.js')
    const facts = readAmazonOfferFacts({ marketplace: 'IT', price: 1, salePrice: 2, saleWindow: { start: '2026-10-01', end: '2026-10-02' }, platformAttributes: { amazonOffer: { map_price: 3 } } }, 'job')
    const built = { currency: 'EUR', our_price: scheduled(10), marketplace_id: IT }
    const plan = amazonPriceOfferPlan({ built, live: liveOffer(), marketplaceId: IT, saleRemoved: false, held: { facts, leaves: ['our_price', 'sale', 'map_price'] } })
    expect(plan).toEqual({ kind: 'merge', patch: { op: 'merge', path: '/attributes/purchasable_offer', value: [{ currency: 'EUR', audience: 'ALL', marketplace_id: IT, our_price: scheduled(10), map_price: scheduled(3) }] } })
  })
})
