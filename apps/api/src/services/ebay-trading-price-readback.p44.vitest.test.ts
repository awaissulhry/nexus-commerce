/**
 * P4.4 (CX) B2 — the Trading sweep checks the PRICE it already reads, and heals nothing.
 *
 *   A. GetItem asks for Item.StartPrice; the parser reads StartPrice + currencyID per variation and for
 *      the item into an optional `prices` field — quantity parsing byte-for-byte as before; a variation's
 *      price is never taken from the item level (eBay sets Item.StartPrice to the LOWEST variation price);
 *   B. the sweep compares eBay's StartPrice with SharedListingMembership.price only for memberships of
 *      the account whose token made the read (others counted as skipped); a null membership price is
 *      compared with the product's eBay listing price it falls back to (counted as null only when there is
 *      no single such price); followPool=false variants are compared too (D); a currency mismatch is its own finding; CHANNEL_PRICE_READBACK, 24 h
 *      dedupe per (source, marketplace, item/SKU, outcome class); NO enqueueSharedTradingFanout, NO
 *      createOutboundRow(s), NO enqueueOutboundRowsInstant, no extra channel call;
 *   C. the price counts' line, "(heal off)" (the cron line itself: jobs/ebay-readback.price-line.p44).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  memberships: [] as Array<Record<string, unknown>>,
  listings: [] as Array<Record<string, unknown>>,
  xml: {} as Record<string, string>,
  existing: new Set<string>(),
  logConflict: null as unknown as ReturnType<typeof import('vitest').vi.fn>,
  enqueue: null as unknown as ReturnType<typeof import('vitest').vi.fn>,
  createOutboundRow: null as unknown as ReturnType<typeof import('vitest').vi.fn>,
  createOutboundRows: null as unknown as ReturnType<typeof import('vitest').vi.fn>,
  enqueueInstant: null as unknown as ReturnType<typeof import('vitest').vi.fn>,
  getItemQuantities: null as unknown as ReturnType<typeof import('vitest').vi.fn>,
  findFirst: null as unknown as ReturnType<typeof import('vitest').vi.fn>,
}))
h.logConflict = vi.fn(async () => ({ id: 'log' }))
h.enqueue = vi.fn(async () => ({ created: 0 }))
h.createOutboundRow = vi.fn(async () => ({ id: 'row' }))
h.createOutboundRows = vi.fn(async () => ({ count: 1 }))
h.enqueueInstant = vi.fn(async () => undefined)
h.findFirst = vi.fn(async ({ where }: any) => (h.existing.has(String(where?.conflictData?.equals)) ? { id: 'old' } : null))

vi.mock('../db.js', () => ({
  default: {
    // Honours the query's followPool filter, as PostgreSQL would.
    sharedListingMembership: { findMany: vi.fn(async ({ where }: any = {}) => h.memberships.filter((row) => where?.followPool === undefined || (row.followPool ?? true) === where.followPool)), updateMany: vi.fn(async () => ({ count: 0 })) },
    channelListing: { findMany: vi.fn(async ({ where }: any) => h.listings.filter((l) => (where?.productId?.in ?? []).includes(l.productId) && (!where?.channel || l.channel === where.channel))) },
    syncHealthLog: { findFirst: (...a: unknown[]) => h.findFirst(...a), updateMany: vi.fn(async () => ({ count: 0 })) },
    marketplace: {
      findMany: vi.fn(async () => [
        { channel: 'EBAY', code: 'IT', currency: 'EUR' },
        { channel: 'EBAY', code: 'DE', currency: 'EUR' },
        { channel: 'EBAY', code: 'UK', currency: 'GBP' },
      ]),
    },
  },
}))
vi.mock('./marketplaces/ebay.service.js', () => ({ EbayService: class {} }))
vi.mock('./channel-stock-event.service.js', () => ({ recordChannelStockEvent: vi.fn() }))
vi.mock('./available-to-publish.service.js', () => ({ computeAvailableToPublish: vi.fn() }))
vi.mock('./ebay-auth.service.js', () => ({ ebayAuthService: { getValidToken: vi.fn(async (id: string) => `token-${id}`) } }))
vi.mock('./connection-resolver.service.js', () => ({ tryResolveConnection: vi.fn(async () => ({ id: 'conn-A', channelType: 'EBAY', isPrimary: true })) }))
vi.mock('./sync-control-policy.service.js', () => ({ loadChannelPolicies: async () => new Map(), policyFor: () => null }))
// No counted pool: the QUANTITY arm compares nothing and heals nothing, so any heal call is the price arm's.
vi.mock('./stock-pool/sync-ledgers.js', () => ({ loadSyncLedgers: vi.fn(async () => new Map()), ledgerInputs: () => ({ ledger: [], uncountedIsZero: false }) }))
vi.mock('./ebay-shared-fanout.service.js', () => ({ enqueueSharedTradingFanout: (...a: unknown[]) => h.enqueue(...a) }))
vi.mock('./outbound-rows.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./outbound-rows.js')>()),
  createOutboundRow: (...a: unknown[]) => h.createOutboundRow(...a),
  createOutboundRows: (...a: unknown[]) => h.createOutboundRows(...a),
}))
vi.mock('./outbound-enqueue.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./outbound-enqueue.js')>()),
  enqueueOutboundRowsInstant: (...a: unknown[]) => h.enqueueInstant(...a),
}))
vi.mock('./sync-health.service.js', () => ({ syncHealthService: { logConflict: (...a: unknown[]) => h.logConflict(...a) } }))
vi.mock('./ebay-trading-api.service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./ebay-trading-api.service.js')>()
  h.getItemQuantities = vi.fn(async (itemId: string) => real.parseGetItemQuantities(h.xml[itemId] ?? ''))
  return { ...real, getItemQuantities: (...a: unknown[]) => h.getItemQuantities(...a) }
})

import { parseGetItemQuantities, buildGetItemQuantitiesXml } from './ebay-trading-api.service.js'
import { readBackEbayTradingQuantities } from './ebay-inventory-readback.service.js'
import { diffTradingPriceReadback, tradingPriceSummary } from './ebay-price-readback.service.js'

const VARIATIONS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<GetItemResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Success</Ack>
  <Item>
    <Quantity>40</Quantity>
    <SellingStatus><CurrentPrice currencyID="EUR">24.90</CurrentPrice><QuantitySold>3</QuantitySold><ListingStatus>Active</ListingStatus></SellingStatus>
    <StartPrice currencyID="EUR">24.90</StartPrice>
    <Variations>
      <Variation><SKU>V-M</SKU><StartPrice currencyID="EUR">29.90</StartPrice><Quantity>12</Quantity><SellingStatus><QuantitySold>2</QuantitySold></SellingStatus></Variation>
      <Variation><SKU>V-L</SKU><StartPrice currencyID="EUR">24.90</StartPrice><Quantity>7</Quantity><SellingStatus><QuantitySold>0</QuantitySold></SellingStatus></Variation>
      <Variation><SKU>V-XL</SKU><Quantity>1</Quantity><SellingStatus><QuantitySold>5</QuantitySold></SellingStatus></Variation>
      <Variation><SKU>V-XXL</SKU><StartPrice currencyID="EUR">0.00</StartPrice><Quantity>3</Quantity></Variation>
      <Variation><SKU>V-N</SKU><StartPrice currencyID="EUR">15.00</StartPrice><Quantity>2</Quantity></Variation>
    </Variations>
  </Item>
</GetItemResponse>`
// The same variations and no item-level StartPrice at all: nothing may be read at the item level.
const VARIATIONS_NO_ITEM_PRICE_XML = VARIATIONS_XML.replace('<StartPrice currencyID="EUR">24.90</StartPrice>\n    <Variations>', '<Variations>')
const SINGLE_XML = `<GetItemResponse><Item>
  <Quantity>9</Quantity>
  <SellingStatus><CurrentPrice currencyID="EUR">19.90</CurrentPrice><QuantitySold>4</QuantitySold><ListingStatus>Active</ListingStatus></SellingStatus>
  <StartPrice currencyID="EUR">19.90</StartPrice>
</Item></GetItemResponse>`
const SINGLE_NO_PRICE_XML = `<GetItemResponse><Item>
  <Quantity>9</Quantity>
  <SellingStatus><QuantitySold>4</QuantitySold><ListingStatus>Active</ListingStatus></SellingStatus>
</Item></GetItemResponse>`
// A <Variations> block whose variation carries no SKU: still a variation listing — its item price is the lowest variation's.
const NO_SKU_VARIATIONS_XML = `<GetItemResponse><Item>
  <Quantity>9</Quantity>
  <SellingStatus><QuantitySold>0</QuantitySold><ListingStatus>Active</ListingStatus></SellingStatus>
  <StartPrice currencyID="EUR">9.90</StartPrice>
  <Variations><Variation><StartPrice currencyID="EUR">9.90</StartPrice><Quantity>9</Quantity></Variation></Variations>
</Item></GetItemResponse>`
const SINGLE_GBP_XML = SINGLE_XML.replace('<StartPrice currencyID="EUR">19.90</StartPrice>', '<StartPrice currencyID="GBP">19.90</StartPrice>')

// ── A. the parser ────────────────────────────────────────────────────────────────────────────────
describe('B2 A — GetItem carries StartPrice; the parser reads it without touching quantity', () => {
  it('the request asks for Item.StartPrice beside the quantity selectors', () => {
    const xml = buildGetItemQuantitiesXml('123')
    expect(xml).toContain('<OutputSelector>Item.StartPrice</OutputSelector>')
    expect(xml).toContain('<OutputSelector>Item.Variations</OutputSelector>')
    expect(xml).toContain('<OutputSelector>Item.Quantity</OutputSelector>')
  })
  it('multi-variation EUR: each variation its OWN StartPrice + currencyID; a missing one is null, "0.00" is 0', () => {
    expect(parseGetItemQuantities(VARIATIONS_XML).prices?.variations).toEqual([
      { sku: 'V-M', value: 29.9, currency: 'EUR' },
      { sku: 'V-L', value: 24.9, currency: 'EUR' },
      { sku: 'V-XL', value: null, currency: null },
      { sku: 'V-XXL', value: 0, currency: 'EUR' },
      { sku: 'V-N', value: 15, currency: 'EUR' },
    ])
  })
  it('the item level is read OUTSIDE the variations: absent there → null, never a variation\'s price', () => {
    expect(parseGetItemQuantities(VARIATIONS_XML).prices?.item).toEqual({ value: 24.9, currency: 'EUR' })
    expect(parseGetItemQuantities(VARIATIONS_NO_ITEM_PRICE_XML).prices?.item).toBeNull()
  })
  it('single-SKU: the item price; missing → null (not 0); CurrentPrice is not StartPrice', () => {
    expect(parseGetItemQuantities(SINGLE_XML).prices).toEqual({ item: { value: 19.9, currency: 'EUR' }, variations: [], hasVariations: false })
    expect(parseGetItemQuantities(SINGLE_NO_PRICE_XML).prices).toEqual({ item: null, variations: [], hasVariations: false })
    expect(parseGetItemQuantities(VARIATIONS_XML).prices?.hasVariations).toBe(true)
    expect(parseGetItemQuantities(NO_SKU_VARIATIONS_XML).prices).toEqual({ item: { value: 9.9, currency: 'EUR' }, variations: [], hasVariations: true })
    expect(parseGetItemQuantities(SINGLE_GBP_XML).prices?.item).toEqual({ value: 19.9, currency: 'GBP' })
  })
  it('quantity parsing is unchanged with prices present', () => {
    const r = parseGetItemQuantities(VARIATIONS_XML)
    expect(r.variations).toEqual([
      { sku: 'V-M', available: 10 }, { sku: 'V-L', available: 7 }, { sku: 'V-XL', available: 0 },
      { sku: 'V-XXL', available: 3 }, { sku: 'V-N', available: 2 },
    ])
    expect(r.itemAvailable).toBeNull()
    expect(parseGetItemQuantities(SINGLE_XML)).toMatchObject({ itemAvailable: 5, variations: [], listingStatus: 'Active' })
    expect(parseGetItemQuantities('')).toEqual({ listingStatus: null, variations: [], itemAvailable: null })
  })
})

// ── B. the sweep ─────────────────────────────────────────────────────────────────────────────────
const m = (sku: string, itemId: string, productId: string | null, price: number | null, channelConnectionId: string | null = 'conn-A', marketplace = 'IT', followPool = true) =>
  ({ sku, itemId, marketplace, productId, lastPushedAt: null, stockBuffer: 0, pinnedQuantity: null, price: price === null ? null : { valueOf: () => String(price.toFixed(2)), toString: () => price.toFixed(2) }, channelConnectionId, followPool })
const cl = (productId: string, region: string, price: number | null, channelConnectionId: string | null = 'conn-A') =>
  ({ productId, channel: 'EBAY', region, marketplace: region, price: price === null ? null : { toString: () => price.toFixed(2) }, channelConnectionId })

beforeEach(() => {
  h.xml = { '111': VARIATIONS_XML, '222': VARIATIONS_XML, '333': SINGLE_GBP_XML, '444': SINGLE_NO_PRICE_XML }
  h.memberships = [
    m('V-M', '111', 'p-m', 29.9), // agrees
    m('V-L', '111', 'p-l', 26.9), // eBay 24.90 → drift
    m('V-XL', '111', 'p-xl', 19.9), // no StartPrice → unread
    m('V-XXL', '111', 'p-xxl', 19.9), // eBay 0.00 → drift to zero, reported
    m('V-N', '111', 'p-n', null), // no membership price → counted, not compared
    m('V-M', '222', 'p-m2', 99, 'conn-B'), // ANOTHER account's listing, drifted → skipped, never compared
    m('S-1', '333', 'p-s', 19.9), // GBP on IT → currency mismatch
    m('S-2', '444', 'p-s2', 19.9), // single SKU, no StartPrice → unread
  ]
  h.existing = new Set()
  h.listings = []
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  h.logConflict.mockClear(); h.enqueue.mockClear(); h.createOutboundRow.mockClear(); h.getItemQuantities.mockClear(); h.findFirst.mockClear()
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no channel call may leave this sweep except getItemQuantities') }))
})
afterEach(() => { vi.unstubAllGlobals() })

describe('B2 B — the sweep compares prices it already read, for the token\'s own account only', () => {
  it('counts, findings and logs', async () => {
    const r = await readBackEbayTradingQuantities()
    expect(r.price).toEqual({ compared: 4, mismatches: 2, currencyMismatches: 1, logged: 3, skipped: 1, nullPrice: 1, fallback: 0, unread: 2 })
    const logged = h.logConflict.mock.calls.map((c) => c[0] as any)
    expect(logged.map((l) => l.productId).sort()).toEqual(['p-l', 'p-s', 'p-xxl'])
    for (const l of logged) expect(l).toMatchObject({ channel: 'EBAY', conflictType: 'CHANNEL_PRICE_READBACK' })
    const byProduct = Object.fromEntries(logged.map((l) => [l.productId, l]))
    expect(byProduct['p-l'].message).toMatch(/^Price unconfirmed on eBay \(item 111, IT\): eBay shows EUR 24\.90 for V-L but the listing intends EUR 26\.90\./)
    expect(byProduct['p-l'].remoteData).toMatchObject({ health: 'PRICE_UNCONFIRMED', source: 'TRADING_GETITEM', outcome: 'PRICE_MISMATCH', ebayPrice: 24.9, itemId: '111', accountId: 'conn-A' })
    expect(byProduct['p-l'].localData).toMatchObject({ membershipPrice: 26.9 })
    expect(byProduct['p-xxl'].remoteData).toMatchObject({ outcome: 'PRICE_MISMATCH', ebayPrice: 0 })
    expect(byProduct['p-s'].remoteData).toMatchObject({ outcome: 'CURRENCY_MISMATCH', ebayCurrency: 'GBP', expectedCurrency: 'EUR' })
  })
  it('reads with ONE account\'s token, once per listing, and makes no other channel call', async () => {
    await readBackEbayTradingQuantities()
    expect(h.getItemQuantities).toHaveBeenCalledTimes(4)
    for (const call of h.getItemQuantities.mock.calls) expect(call[1]).toMatchObject({ connectionId: 'conn-A', oauthToken: 'token-conn-A' })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('another account\'s membership is never compared, even when its price differs', async () => {
    h.memberships = [m('V-M', '222', 'p-m2', 99, 'conn-B'), m('V-L', '111', 'p-l', 24.9, null)]
    const r = await readBackEbayTradingQuantities()
    expect(r.price).toMatchObject({ compared: 0, mismatches: 0, skipped: 2, logged: 0 })
    expect(h.logConflict).not.toHaveBeenCalled()
  })
  it('🔴 the price arm heals NOTHING: no fan-out, no queue row', async () => {
    const r = await readBackEbayTradingQuantities()
    expect(r.price.mismatches).toBeGreaterThan(0)
    expect(h.enqueue).not.toHaveBeenCalled()
    expect(h.createOutboundRow).not.toHaveBeenCalled()
    expect(h.createOutboundRows).not.toHaveBeenCalled()
    expect(h.enqueueInstant).not.toHaveBeenCalled()
    expect(r.healedProducts).toBe(0)
  })
  it('24 h dedupe on source + marketplace + item/SKU + outcome class: a match suppresses only that finding', async () => {
    h.existing = new Set(['TRADING_GETITEM|IT|item:111/V-L|PRICE'])
    const r = await readBackEbayTradingQuantities()
    expect(r.price.logged).toBe(2)
    expect(h.logConflict.mock.calls.map((c) => (c[0] as any).productId).sort()).toEqual(['p-s', 'p-xxl'])
    const where = (h.findFirst.mock.calls.find((c) => (c[0] as any).where.productId === 'p-l')![0] as any).where
    expect(where).toMatchObject({ channel: 'EBAY', conflictType: 'CHANNEL_PRICE_READBACK', resolutionStatus: 'UNRESOLVED', conflictData: { path: ['remote', 'dedupeKey'], equals: 'TRADING_GETITEM|IT|item:111/V-L|PRICE' } })
    expect(Date.now() - (where.createdAt.gte as Date).getTime()).toBeGreaterThan(24 * 3600e3 - 60_000)
  })
  it('another class on the same SKU does not suppress a price finding', async () => {
    h.existing = new Set(['TRADING_GETITEM|IT|item:111/V-L|CURRENCY', 'TRADING_GETITEM|IT|item:111/V-L|UNCONFIRMED'])
    const r = await readBackEbayTradingQuantities()
    expect(r.price.logged).toBe(3)
  })
  it('one product drifted on two listings: one record per listing (the key names the item)', async () => {
    h.xml['555'] = VARIATIONS_XML
    h.memberships = [m('V-L', '111', 'p-l', 26.9), m('V-L', '555', 'p-l', 26.9)]
    const r = await readBackEbayTradingQuantities()
    expect(r.price).toMatchObject({ compared: 2, mismatches: 2, logged: 2 })
    expect(h.logConflict.mock.calls.map((c) => (c[0] as any).remoteData.dedupeKey).sort()).toEqual(['TRADING_GETITEM|IT|item:111/V-L|PRICE', 'TRADING_GETITEM|IT|item:555/V-L|PRICE'])
  })
  it('a <Variations> block with no parsed SKU is still a variation listing: its item price is never compared', async () => {
    h.xml['666'] = NO_SKU_VARIATIONS_XML
    h.memberships = [m('X-1', '666', 'p-x', 12.5)]
    const r = await readBackEbayTradingQuantities()
    expect(r.price).toMatchObject({ compared: 0, unread: 1, mismatches: 0, logged: 0 })
  })
  it('an agreeing price reports nothing', async () => {
    h.memberships = [m('V-M', '111', 'p-m', 29.9), m('V-L', '111', 'p-l', 24.9)]
    const r = await readBackEbayTradingQuantities()
    expect(r.price).toMatchObject({ compared: 2, mismatches: 0, currencyMismatches: 0, logged: 0 })
    expect(h.logConflict).not.toHaveBeenCalled()
  })
})

describe('B2 B pure — diffTradingPriceReadback compares to the cent', () => {
  const key = (itemId: string, sku: string) => `${itemId}|${sku}`
  const entry = { sku: 'A', itemId: '1', marketplace: 'IT', productId: 'p', price: 24.9, channelConnectionId: 'conn-A' }
  const run = (value: number) => diffTradingPriceReadback([entry], new Map([[key('1', 'A'), { value, currency: 'EUR' }]]), { accountId: 'conn-A', keyOf: key, currencyOf: () => 'EUR' })
  it('a double-typed StartPrice a hair off the cent is not a drift; a cent is', () => {
    expect(run(24.899999999)).toMatchObject({ compared: 1, findings: [] })
    expect(run(24.89).findings).toEqual([expect.objectContaining({ kind: 'PRICE_MISMATCH', drift: { channelPrice: 24.89, intendedPrice: 24.9, difference: -0.01 } })])
  })
})

// ── D. CX review 2026-09-26: null-price memberships and followPool=false ─────────────────────────────
describe('B2 D — a NULL membership price is compared with the product price it falls back to', () => {
  it('no per-listing price: compared with the product\'s eBay listing price on that market (schema: "null → fall back to child Product price")', async () => {
    h.memberships = [m('V-L', '111', 'p-l', null)]
    h.listings = [cl('p-l', 'IT', 26.9), cl('p-l', 'DE', 99)]
    const r = await readBackEbayTradingQuantities()
    expect(r.price).toMatchObject({ compared: 1, mismatches: 1, logged: 1, nullPrice: 0, fallback: 1 })
    const logged = h.logConflict.mock.calls[0][0] as any
    expect(logged.message).toMatch(/eBay shows EUR 24\.90 for V-L but the listing intends EUR 26\.90\./)
    expect(logged.message).toMatch(/no per-listing price/)
    expect(logged.localData).toMatchObject({ membershipPrice: null, listingPrice: 26.9 })
  })
  it('an agreeing fallback price reports nothing; UK memberships match a GB-region listing', async () => {
    h.xml['333'] = SINGLE_XML.replace('currencyID="EUR">19.90</StartPrice>', 'currencyID="GBP">19.90</StartPrice>')
    h.memberships = [m('V-L', '111', 'p-l', null), m('S-1', '333', 'p-s', null, 'conn-A', 'UK')]
    h.listings = [cl('p-l', 'IT', 24.9), cl('p-s', 'GB', 19.9)]
    const r = await readBackEbayTradingQuantities()
    expect(r.price).toMatchObject({ compared: 2, mismatches: 0, currencyMismatches: 0, nullPrice: 0, fallback: 2, logged: 0 })
  })
  it('no listing on the market, or two that disagree (none of the membership\'s account) → counted as null, never compared', async () => {
    h.memberships = [m('V-L', '111', 'p-l', null), m('V-M', '111', 'p-m', null)]
    h.listings = [cl('p-l', 'DE', 26.9), cl('p-m', 'IT', 29.9, 'conn-X'), cl('p-m', 'IT', 31, 'conn-Y')]
    const r = await readBackEbayTradingQuantities()
    expect(r.price).toMatchObject({ compared: 0, nullPrice: 2, fallback: 0, logged: 0 })
  })
  it('the membership\'s own account picks among listings of several accounts', async () => {
    h.memberships = [m('V-M', '111', 'p-m', null)]
    h.listings = [cl('p-m', 'IT', 35, 'conn-B'), cl('p-m', 'IT', 29.9, 'conn-A')]
    const r = await readBackEbayTradingQuantities()
    expect(r.price).toMatchObject({ compared: 1, mismatches: 0, fallback: 1 })
  })
})

describe('B2 D — followPool=false excludes a variant from the POOL, not from the price check', () => {
  it('an excluded variant\'s drifted price is compared and recorded; its quantity is neither compared nor healed', async () => {
    h.memberships = [m('V-M', '111', 'p-m', 29.9), m('V-L', '111', 'p-l', 26.9, 'conn-A', 'IT', false)]
    const r = await readBackEbayTradingQuantities()
    expect(r.price).toMatchObject({ compared: 2, mismatches: 1, logged: 1 })
    expect((h.logConflict.mock.calls[0][0] as any).productId).toBe('p-l')
    expect(r.skusChecked).toBe(1) // the quantity arm saw only the followed variant
    expect(h.enqueue).not.toHaveBeenCalled()
  })
  it('a listing whose every variant is excluded is still read — for its prices only', async () => {
    h.memberships = [m('V-L', '111', 'p-l', 26.9, 'conn-A', 'IT', false)]
    const r = await readBackEbayTradingQuantities()
    expect(h.getItemQuantities).toHaveBeenCalledTimes(1)
    expect(r.price).toMatchObject({ compared: 1, mismatches: 1 })
    expect(r.skusChecked).toBe(0)
  })
  it('a price-only read of an ENDED listing writes nothing (ending memberships stays the quantity sweep\'s call)', async () => {
    const prisma = (await import('../db.js')).default as any
    h.xml['777'] = SINGLE_XML.replace('<ListingStatus>Active</ListingStatus>', '<ListingStatus>Completed</ListingStatus>')
    h.memberships = [m('S-9', '777', 'p-9', 19.9, 'conn-A', 'IT', false)]
    const r = await readBackEbayTradingQuantities()
    expect(h.getItemQuantities).toHaveBeenCalledTimes(1) // positive control: it was read
    expect(prisma.sharedListingMembership.updateMany).not.toHaveBeenCalled()
    expect(r).toMatchObject({ endedMemberships: 0 })
    expect(r.price).toMatchObject({ compared: 0 })
  })
  it('the read cap keeps the quantity sweep\'s coverage: followed listings first, price-only listings after', async () => {
    vi.stubEnv('NEXUS_EBAY_TRADING_READBACK_MAX', '1')
    h.memberships = [m('V-L', '222', 'p-l', 26.9, 'conn-A', 'IT', false), m('V-M', '111', 'p-m', 29.9)]
    const r = await readBackEbayTradingQuantities()
    expect(h.getItemQuantities.mock.calls.map((c) => c[0])).toEqual(['111'])
    expect(r).toMatchObject({ capped: true, skusChecked: 1 })
  })
})

// ── C. the cron line ─────────────────────────────────────────────────────────────────────────────
describe('B2 C — the price counts\' line, heal off', () => {
  it('prints compared / mismatches / logged and "(heal off)"', () => {
    expect(tradingPriceSummary({ compared: 4, mismatches: 2, currencyMismatches: 1, logged: 3, skipped: 1, nullPrice: 1, fallback: 1, unread: 2 }))
      .toBe('price compared=4 mismatches=2 currency=1 logged=3 skipped=1 null=1 fallback=1 unread=2 (heal off)')
  })
})
