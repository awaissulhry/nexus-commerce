/**
 * CX review 2026-09-26 — the Inventory-API variation writers (full group publish and the offers-only update).
 *
 *   A. every offer lookup that carries quantity takes the ONE FIXED_PRICE offer of the market — never `offers[0]`,
 *      which is the auction offer whenever eBay lists it first (getOffers returns both when both exist);
 *   B. an accepted price write is confirmed by ONE GetItem per published listing (every variation's StartPrice comes
 *      back in that one answer — the Trading sweep's own parser), bounded and never retried; an OUT_OF_STOCK
 *      listing is live; nothing is read or recorded when the publication itself failed. Report-only.
 *
 * The transport is a fixture: no request leaves the process.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  send: vi.fn(), listings: [] as any[], offerLists: {} as Record<string, any[]>, full: {} as Record<string, any>,
  publishId: '123456789012' as string | null, item25004: new Set<string>(), updateMany: vi.fn(async () => ({ count: 2 })),
  getItem: vi.fn(), itemXml: {} as Record<string, string>, hangGetItem: false, record: vi.fn(), failPublish: false, failOffer: '',
  /** Answers per GetItem call, in order (then `itemXml`); `hangOnCall` = the call number that never answers. */
  itemXmlSeq: [] as string[], hangOnCall: 0, getItemCalls: 0,
  /** getOffers answers for another market, keyed `${sku}|${marketplace_id}` (the base lists answer EBAY_IT only). */
  marketLists: {} as Record<string, any[]>,
  /** Step 7 — the write-back records through the one live-listing rule. */
  recordLive: vi.fn(async (_tx: unknown, input: any) => input.rows.map((r: any, i: number) => ({ id: `listing-${i}`, productId: r.productId, version: 1, created: false, adopted: false, unpaused: false }))),
}))
vi.mock('./pim/live-listing.service.js', () => ({ recordLiveListings: (...args: unknown[]) => (h.recordLive as any)(...args) }))
vi.mock('../db.js', () => ({ default: {
  $transaction: async (work: (tx: unknown) => unknown) => work({}),
  channelListing: {
    findMany: vi.fn(async (args: any) => args.where.channel === 'AMAZON' ? [] : h.listings),
    findFirst: vi.fn(async () => null), updateMany: h.updateMany, createMany: vi.fn(async () => ({ count: 0 })), update: vi.fn(async () => ({})),
  },
  product: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
  marketplace: { findFirst: vi.fn(async () => ({ currency: 'EUR', languages: ['it'], language: 'it' })) },
} }))
vi.mock('./gateway/ebay.js', () => ({ ebayTransport: () => h.send }))
vi.mock('./gateway/channels.js', () => ({ ebayListingLanguage: async () => 'it-IT' }))
vi.mock('./ebay-publish-gate.service.js', () => ({ ebayWriteRefusal: () => null, ebayHostOf: () => 'fixture.invalid' }))
vi.mock('./ebay-presentation-consumer.service.js', () => ({ assertLegacyPresentationPublishAllowed: async () => {} }))
vi.mock('./pim/publish-review-gate.js', () => ({ assertListingContentReviewed: async () => {} }))
vi.mock('./listing-activation-sync.service.js', () => ({ syncActivatedListings: async () => {} }))
vi.mock('./ebay-policy-reconcile.service.js', () => ({ reconcileEbayPolicies: async () => ({ policies: { fulfillmentPolicyId: 'fulfill', paymentPolicyId: 'pay', returnPolicyId: 'return', merchantLocationKey: 'here' } }) }))
vi.mock('./listing-issue-recorder.service.js', () => ({ recordEbayOfferRejection: async () => {} }))
vi.mock('./ebay-trading-api.service.js', async (original) => {
  const real = await original<typeof import('./ebay-trading-api.service.js')>()
  h.getItem.mockImplementation(async (itemId: string, ctx: { signal?: AbortSignal }) => {
    h.getItemCalls++
    if (h.hangGetItem || h.hangOnCall === h.getItemCalls) return new Promise((_resolve, reject) => ctx.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
    return real.parseGetItemQuantities(h.itemXmlSeq.length ? h.itemXmlSeq.shift()! : (h.itemXml[itemId] ?? ''))
  })
  return { ...real, getItemQuantities: (...args: unknown[]) => h.getItem(...args) }
})
vi.mock('./ebay-price-readback.service.js', async (original) => ({ ...await original<typeof import('./ebay-price-readback.service.js')>(), recordEbayPriceUnconfirmed: (...args: unknown[]) => h.record(...args) }))

const { pushVariationGroup, pushOffersOnly } = await import('./ebay-variation-push.service.js')

const rows = () => [
  { sku: 'SKU-A', _productId: 'product-a', price: 10, quantity: 2, aspect_Taglia: 'S', image_1: 'https://fixture.invalid/a.jpg' },
  { sku: 'SKU-B', _productId: 'product-b', price: 20, quantity: 0, aspect_Taglia: 'M', image_1: 'https://fixture.invalid/b.jpg' },
]
const offer = (sku: string, format = 'FIXED_PRICE', listingId = '123456789012') => ({ offerId: `${format === 'AUCTION' ? 'au' : 'fp'}-${sku}`, sku, marketplaceId: 'EBAY_IT', format,
  status: 'PUBLISHED', availableQuantity: 0, listing: { listingId, listingStatus: 'ACTIVE' }, pricingSummary: { price: { value: '1.00', currency: 'EUR' } } })
const response = (body: any, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status })
const call = (mode: 'group' | 'offers', input: Array<Record<string, unknown>> = rows()) => mode === 'offers'
  ? pushOffersOnly(input, 'IT', 'synthetic-token', 'account-a', {}, 'https://fixture.invalid', 'EBAY_IT', (_pid, _sku, qty) => qty)
  : pushVariationGroup('group', input, 'IT', 'synthetic-token', 'account-a', {}, 'https://fixture.invalid', 'EBAY_IT', (_pid, _sku, qty) => qty,
    undefined, undefined, undefined, undefined, { parentContent: { title: 'Fixture family', subtitle: '', description: '<p>Fixture</p>' } })
/** A GetItem answer: every variation's StartPrice in one response. */
const itemXml = (vars: Array<{ sku: string; price: string; currency?: string; qty?: number; sold?: number }>, status = 'Active') =>
  `<GetItemResponse><Ack>Success</Ack><Item><Quantity>9</Quantity><SellingStatus><ListingStatus>${status}</ListingStatus></SellingStatus><StartPrice currencyID="EUR">1.00</StartPrice><Variations>`
  + vars.map((v) => `<Variation><SKU>${v.sku}</SKU><StartPrice currencyID="${v.currency ?? 'EUR'}">${v.price}</StartPrice><Quantity>${v.qty ?? 2}</Quantity><SellingStatus><QuantitySold>${v.sold ?? 0}</QuantitySold></SellingStatus></Variation>`).join('')
  + '</Variations></Item></GetItemResponse>'
const offerPuts = () => h.send.mock.calls.filter(([url, init]) => init?.method === 'PUT' && /\/offer\/[^/]+$/.test(new URL(url).pathname))
  .map(([url, init]) => ({ id: new URL(url).pathname.split('/').pop(), body: JSON.parse(init.body) }))

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('No live request permitted') }))
  h.publishId = '123456789012'; h.item25004 = new Set(); h.hangGetItem = false; h.failPublish = false; h.failOffer = ''
  h.itemXmlSeq = []; h.hangOnCall = 0; h.getItemCalls = 0; h.marketLists = {}
  vi.stubEnv('NEXUS_EBAY_PRICE_REREAD_DELAY_MS', '10') // the settle wait before the one re-read, short in tests
  h.itemXml = { '123456789012': itemXml([{ sku: 'SKU-A', price: '10.00' }, { sku: 'SKU-B', price: '20.00', qty: 0 }]) }
  h.record.mockResolvedValue('logged')
  // eBay lists the auction offer FIRST; the fixed-price offer is the one this push prices.
  h.offerLists = { 'SKU-A': [offer('SKU-A', 'AUCTION', '999999999999'), offer('SKU-A')], 'SKU-B': [offer('SKU-B', 'AUCTION', '999999999999'), offer('SKU-B')] }
  h.full = Object.fromEntries(Object.values(h.offerLists).flat().map((o) => [o.offerId, o]))
  // No cached offer ids: every offer is looked up by SKU.
  h.listings = rows().map(row => ({ id: `listing-${row.sku}`, productId: row._productId, product: { sku: row.sku }, marketplace: 'IT', region: 'IT', channelConnectionId: 'account-a',
    externalListingId: '123456789012', platformAttributes: {}, flatFileSnapshot: { sku: row.sku } }))
  h.send.mockImplementation(async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname
    if (init.method === 'PUT' && path.startsWith('/sell/inventory/v1/inventory_item/')) {
      const sku = decodeURIComponent(path.split('/').pop()!)
      if (h.item25004.has(sku)) { h.item25004.delete(sku); return response({ errors: [{ errorId: 25004 }] }, 400) }
      return response({}, 204)
    }
    if (init.method === 'PUT') return response({}, h.failOffer && path.endsWith(h.failOffer) ? 400 : 204)
    if (path.endsWith('/publish_by_inventory_item_group')) return h.failPublish ? response({ errors: [{ errorId: 25002 }] }, 400) : response(h.publishId ? { listingId: h.publishId } : {}, 200)
    if (path === '/sell/inventory/v1/offer' && init.method === 'POST') return response({ offerId: `created-${JSON.parse(init.body as string).sku}` }, 201)
    if (path === '/sell/inventory/v1/offer') {
      const q = new URL(url).searchParams
      const market = q.get('marketplace_id') ?? 'EBAY_IT'
      return response({ offers: h.marketLists[`${q.get('sku')}|${market}`] ?? (market === 'EBAY_IT' ? h.offerLists[q.get('sku')!] ?? [] : []) })
    }
    if (init.method === 'DELETE') return response({}, 204)
    const id = path.split('/').pop()!
    if (h.full[id]) return response(h.full[id])
    throw new Error(`Unexpected fixture request ${init.method ?? 'GET'} ${url}`)
  })
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('A — the FIXED_PRICE offer, never offers[0]', () => {
  it.each(['group', 'offers'] as const)('%s: the price/quantity offer write goes to the fixed-price offer, not the auction listed first', async (mode) => {
    const result = await call(mode)
    expect(result.map((r) => r.status)).toEqual(['PUSHED', 'PUSHED'])
    expect(offerPuts().map((p) => p.id)).toEqual(['fp-SKU-A', 'fp-SKU-B'])
    expect(offerPuts().map((p) => p.body.availableQuantity)).toEqual([2, 0])
  })
  it('offers-only: two fixed-price offers on the market → refused for that SKU, never "the first"', async () => {
    h.offerLists['SKU-A'] = [offer('SKU-A'), { ...offer('SKU-A'), offerId: 'fp-SKU-A-2' }]
    const result = await call('offers')
    expect(result[0]).toMatchObject({ sku: 'SKU-A', status: 'ERROR', message: expect.stringMatching(/No existing offer/) })
    expect(offerPuts().map((p) => p.id)).toEqual(['fp-SKU-B'])
  })
  it('group: the 25004 heal raises the parked fixed-price offer, never the auction listed first', async () => {
    h.item25004.add('SKU-A')
    const result = await call('group')
    expect(result.find((r) => r.sku === 'SKU-A')?.status).toBe('PUSHED')
    const heal = offerPuts().filter((p) => p.body.availableQuantity === 2 && !p.body.pricingSummary?.price?.value?.startsWith('10'))
    expect(heal.map((p) => p.id)).toEqual(['fp-SKU-A'])
    expect(offerPuts().some((p) => p.id?.startsWith('au-'))).toBe(false)
  })
  it('group: a re-publish with no listingId in the answer takes the fixed-price offer\'s listing, not the auction\'s', async () => {
    h.publishId = null
    const result = await call('group')
    expect(result.map((r) => (r as { itemId?: string }).itemId)).toEqual(['123456789012', '123456789012'])
    expect(h.recordLive).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ channel: 'EBAY', market: 'IT', accountId: 'account-a',
      rows: expect.arrayContaining([expect.objectContaining({ listingStatus: 'ACTIVE', externalListingId: '123456789012' })]) }))
  })
})

describe('B — one GetItem per published listing confirms every written variation price (report-only)', () => {
  it.each(['group', 'offers'] as const)('%s: ONE bounded, un-retried GetItem for the listing; each SKU confirmed from its own variation', async (mode) => {
    const result = await call(mode)
    expect(result.map((r) => r.status)).toEqual(['PUSHED', 'PUSHED'])
    expect(result.map((r) => r.message)).toEqual([expect.stringMatching(/Price confirmed on eBay: EUR 10\.00/), expect.stringMatching(/Price confirmed on eBay: EUR 20\.00/)])
    expect(h.getItem).toHaveBeenCalledTimes(1)
    const [itemId, ctx] = h.getItem.mock.calls[0]
    expect(itemId).toBe('123456789012')
    expect(ctx).toMatchObject({ oauthToken: 'synthetic-token', connectionId: 'account-a', market: 'IT', maxTransientRetries: 0, max429Retries: 0 })
    expect(ctx.timeoutMs).toBeGreaterThan(0); expect(ctx.timeoutMs).toBeLessThanOrEqual(8_000)
    expect(ctx.signal).toBeInstanceOf(AbortSignal)
    expect(h.record).not.toHaveBeenCalled()
  })
  it('a large family is one read, not one per SKU: 40 variations, one GetItem, 40 confirmations', async () => {
    const family = Array.from({ length: 40 }, (_, i) => ({ sku: `SKU-${i}`, _productId: `product-${i}`, price: 10 + i, quantity: 1, aspect_Taglia: `T${i}`, image_1: 'https://fixture.invalid/x.jpg' }))
    for (const row of family) h.offerLists[row.sku] = [offer(row.sku)]
    h.full = Object.fromEntries(Object.values(h.offerLists).flat().map((o) => [o.offerId, o]))
    h.listings = family.map((row) => ({ id: `listing-${row.sku}`, productId: row._productId, product: { sku: row.sku }, marketplace: 'IT', region: 'IT', channelConnectionId: 'account-a', externalListingId: '123456789012', platformAttributes: {}, flatFileSnapshot: { sku: row.sku } }))
    h.itemXml['123456789012'] = itemXml(family.map((row) => ({ sku: row.sku, price: row.price.toFixed(2) })))
    const result = await call('offers', family)
    expect(h.getItem).toHaveBeenCalledTimes(1)
    expect(result.filter((r) => /Price confirmed on eBay/.test(r.message))).toHaveLength(40)
    expect(h.record).not.toHaveBeenCalled()
  })
  it('a per-variation mismatch is recorded for that SKU only; nothing is rewritten', async () => {
    h.itemXml['123456789012'] = itemXml([{ sku: 'SKU-A', price: '10.00' }, { sku: 'SKU-B', price: '25.00' }])
    const result = await call('offers')
    expect(result[0].message).toMatch(/Price confirmed on eBay/)
    expect(result[1].message).toMatch(/Price unconfirmed/)
    expect(h.record).toHaveBeenCalledTimes(1)
    expect(h.record.mock.calls[0][0]).toMatchObject({ source: 'VARIATION_GETITEM', marketplace: 'EBAY_IT', ref: 'item:123456789012/SKU-B', outcome: 'PRICE_MISMATCH', sku: 'SKU-B', productId: 'product-b', localData: { sentPrice: 20, currency: 'EUR' } })
    expect(offerPuts()).toHaveLength(2)
  })
  it('each SKU is matched by its SKU, not by its position in eBay\'s answer', async () => {
    h.itemXml['123456789012'] = itemXml([{ sku: 'SKU-B', price: '20.00' }, { sku: 'SKU-A', price: '10.00' }])
    const result = await call('offers')
    expect(result.map((r) => r.message)).toEqual([expect.stringMatching(/Price confirmed on eBay: EUR 10\.00/), expect.stringMatching(/Price confirmed on eBay: EUR 20\.00/)])
    expect(h.record).not.toHaveBeenCalled()
  })
  it('another currency, or a SKU missing from the answer, is its own unconfirmed finding', async () => {
    h.itemXml['123456789012'] = itemXml([{ sku: 'SKU-A', price: '10.00', currency: 'GBP' }])
    await call('offers')
    expect(h.record.mock.calls.map((c) => [c[0].sku, c[0].outcome])).toEqual([['SKU-A', 'CURRENCY_MISMATCH'], ['SKU-B', 'UNREADABLE']])
  })
  it('OUT_OF_STOCK is live: a quantity-0 deactivate of every variant still confirms its prices', async () => {
    const zero = rows().map((row) => ({ ...row, quantity: 0 }))
    h.itemXml['123456789012'] = itemXml([{ sku: 'SKU-A', price: '10.00', qty: 3, sold: 3 }, { sku: 'SKU-B', price: '20.00', qty: 1, sold: 1 }])
    const result = await call('offers', zero)
    expect(offerPuts().map((p) => p.body.availableQuantity)).toEqual([0, 0])
    expect(result.map((r) => r.message)).toEqual([expect.stringMatching(/Price confirmed/), expect.stringMatching(/Price confirmed/)])
    expect(h.record).not.toHaveBeenCalled()
  })
  it('an ended listing is not a price finding: not checked, nothing recorded', async () => {
    h.itemXml['123456789012'] = itemXml([{ sku: 'SKU-A', price: '99.00' }], 'Completed')
    const result = await call('offers')
    expect(result.map((r) => r.message)).toEqual([expect.stringMatching(/not checked/i), expect.stringMatching(/not checked/i)])
    expect(h.record).not.toHaveBeenCalled()
  })
  it('a GetItem that never answers is abandoned at the deadline: one listing-level READ_FAILED record, the push still answers', async () => {
    vi.stubEnv('NEXUS_EBAY_PRICE_READBACK_TIMEOUT_MS', '300')
    h.hangGetItem = true
    const t0 = Date.now()
    const operation = call('offers')
    let observation: ReturnType<typeof setTimeout> | undefined
    // Observed independently: a missing deadline fails this assertion rather than timing the test out.
    const completed = await Promise.race([operation.then(() => true), new Promise<boolean>((resolve) => { observation = setTimeout(() => resolve(false), 2_500) })])
    clearTimeout(observation)
    expect(completed, 'the push must answer within its read deadline').toBe(true)
    const result = await operation
    expect(Date.now() - t0).toBeLessThan(2_500)
    expect(result.map((r) => r.status)).toEqual(['PUSHED', 'PUSHED'])
    expect(result.map((r) => r.message)).toEqual([expect.stringMatching(/Price unconfirmed/), expect.stringMatching(/Price unconfirmed/)])
    expect(h.record).toHaveBeenCalledTimes(1)
    expect(h.record.mock.calls[0][0]).toMatchObject({ source: 'VARIATION_GETITEM', ref: 'item:123456789012', outcome: 'READ_FAILED' })
  })
  it('no published listing id known for the SKUs (offers-only): nothing is read or recorded, and the row says so', async () => {
    for (const row of h.listings) row.externalListingId = null
    const result = await call('offers')
    expect(h.getItem).not.toHaveBeenCalled()
    expect(h.record).not.toHaveBeenCalled()
    expect(result.map((r) => r.message)).toEqual([expect.stringMatching(/not checked/i), expect.stringMatching(/not checked/i)])
  })
  it('the publication failed: nothing is read, nothing is recorded, no price sentence', async () => {
    h.failPublish = true
    const result = await call('group')
    expect(result.every((r) => r.status === 'ERROR')).toBe(true)
    expect(h.getItem).not.toHaveBeenCalled()
    expect(h.record).not.toHaveBeenCalled()
    expect(result.some((r) => /Price (un)?confirmed/i.test(r.message))).toBe(false)
  })
  it('an offer write failed (publication skipped): nothing is read or recorded', async () => {
    h.failOffer = 'fp-SKU-B'
    const result = await call('group')
    expect(result.find((r) => r.sku === 'SKU-B')?.status).toBe('ERROR')
    expect(h.getItem).not.toHaveBeenCalled()
    expect(h.record).not.toHaveBeenCalled()
  })
  it('no Trading answer at all (the dry-run\'s empty body outside production): rows unchanged, nothing recorded', async () => {
    h.itemXml = {}
    const result = await call('group')
    expect(result.map((r) => r.message)).toEqual(['pushed as variation group', 'pushed as variation group'])
    expect(h.record).not.toHaveBeenCalled()
  })
})

describe('C — a mismatch read right after the write is re-read once before it is recorded (main-session ruling 2026-09-26)', () => {
  const agree = itemXml([{ sku: 'SKU-A', price: '10.00' }, { sku: 'SKU-B', price: '20.00' }])
  const lagging = itemXml([{ sku: 'SKU-A', price: '10.00' }, { sku: 'SKU-B', price: '25.00' }])
  it('first read differs, the re-read agrees → confirmed, nothing recorded', async () => {
    h.itemXmlSeq = [lagging, agree]
    const result = await call('offers')
    expect(h.getItem).toHaveBeenCalledTimes(2)
    expect(result.map((r) => r.message)).toEqual([expect.stringMatching(/Price confirmed on eBay: EUR 10\.00/), expect.stringMatching(/Price confirmed on eBay: EUR 20\.00/)])
    expect(h.record).not.toHaveBeenCalled()
  })
  it('still different on the re-read → recorded once, from the re-read', async () => {
    h.itemXmlSeq = [lagging, itemXml([{ sku: 'SKU-A', price: '10.00' }, { sku: 'SKU-B', price: '26.00' }])]
    const result = await call('offers')
    expect(h.getItem).toHaveBeenCalledTimes(2)
    expect(result[1].message).toMatch(/Price unconfirmed/)
    expect(h.record).toHaveBeenCalledTimes(1)
    expect(h.record.mock.calls[0][0]).toMatchObject({ sku: 'SKU-B', outcome: 'PRICE_MISMATCH', remoteData: { ebayPrice: 26 } })
  })
  it('no mismatch → no re-read (one GetItem)', async () => {
    await call('offers')
    expect(h.getItem).toHaveBeenCalledTimes(1)
  })
  it('one re-read per listing however many SKUs differ; the re-read is bounded like the first', async () => {
    h.itemXmlSeq = [itemXml([{ sku: 'SKU-A', price: '11.00' }, { sku: 'SKU-B', price: '25.00' }]), agree]
    await call('offers')
    expect(h.getItem).toHaveBeenCalledTimes(2)
    const ctx = h.getItem.mock.calls[1][1]
    expect(ctx).toMatchObject({ maxTransientRetries: 0, max429Retries: 0 })
    expect(ctx.signal).toBeInstanceOf(AbortSignal)
  })
  it('a re-read that never answers: the mismatch is NOT recorded as one — it is "unconfirmed" (read failed)', async () => {
    vi.stubEnv('NEXUS_EBAY_PRICE_READBACK_TIMEOUT_MS', '300')
    h.itemXmlSeq = [lagging]
    h.hangOnCall = 2
    const operation = call('offers')
    let observation: ReturnType<typeof setTimeout> | undefined
    const completed = await Promise.race([operation.then(() => true), new Promise<boolean>((resolve) => { observation = setTimeout(() => resolve(false), 2_500) })])
    clearTimeout(observation)
    expect(completed, 'the re-read must end at its deadline').toBe(true)
    const result = await operation
    expect(result[1].message).toMatch(/Price unconfirmed/)
    expect(h.record).toHaveBeenCalledTimes(1)
    expect(h.record.mock.calls[0][0]).toMatchObject({ sku: 'SKU-B', outcome: 'READ_FAILED', ref: 'item:123456789012/SKU-B' })
    expect(h.record.mock.calls[0][0].message).toMatch(/EUR 25\.00/)
  })
})

describe('D — the publish-failure diagnostics read the FIXED_PRICE offer, never offers[0] (main-session ruling 2026-09-26)', () => {
  const valid = { listingPolicies: { fulfillmentPolicyId: 'fulfill' }, merchantLocationKey: 'here', availableQuantity: 1 }
  const deletes = () => h.send.mock.calls.filter(([, init]) => init?.method === 'DELETE').map(([url]) => new URL(url).pathname.split('/').pop())
  it('the per-variant probe names the fixed-price offer\'s problem, not the auction listed first', async () => {
    h.failPublish = true
    h.offerLists = {
      'SKU-A': [{ ...offer('SKU-A', 'AUCTION'), ...valid, availableQuantity: 0 }, offer('SKU-A')],
      'SKU-B': [{ ...offer('SKU-B', 'AUCTION'), ...valid, availableQuantity: 0 }, offer('SKU-B')],
    }
    const result = await call('group')
    expect(result[0].message).toMatch(/SKU-A: no fulfillment policy/)
  })
  it('the cross-market draft sweep never deletes an auction draft', async () => {
    h.failPublish = true
    h.offerLists = { 'SKU-A': [{ ...offer('SKU-A'), ...valid }], 'SKU-B': [{ ...offer('SKU-B'), ...valid }] }
    h.marketLists = { 'SKU-A|EBAY_DE': [{ ...offer('SKU-A', 'AUCTION'), offerId: 'au-SKU-A-de', marketplaceId: 'EBAY_DE', status: 'UNPUBLISHED' }] }
    await call('group')
    expect(deletes()).toEqual([])
  })
  it('the sweep finds and removes the fixed-price draft even when eBay lists a published auction first', async () => {
    h.failPublish = true
    h.offerLists = { 'SKU-A': [{ ...offer('SKU-A'), ...valid }], 'SKU-B': [{ ...offer('SKU-B'), ...valid }] }
    h.marketLists = { 'SKU-A|EBAY_DE': [
      { ...offer('SKU-A', 'AUCTION'), offerId: 'au-SKU-A-de', marketplaceId: 'EBAY_DE', status: 'PUBLISHED' },
      { ...offer('SKU-A'), offerId: 'fp-SKU-A-de', marketplaceId: 'EBAY_DE', status: 'UNPUBLISHED' },
    ] }
    await call('group')
    expect(deletes()).toEqual(['fp-SKU-A-de'])
  })
})
