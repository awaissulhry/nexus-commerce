/**
 * E2 (D5, Owner 2026-10-05) — ONE inventory write per Etsy listing for the queue's stock and price rows.
 *
 * End to end like `outbound-sync.etsy-price.vitest.test.ts`: `syncToEtsy` → `writeEtsyInventory` → the Etsy read and
 * write clients → the REAL channel gateway; only the network is fake (`fetch` holds one Etsy inventory and logs every
 * request). The queue table is an in-memory stand-in that applies the lane's own filters and compare-and-swaps, so a
 * row the lane must not touch shows up as touched.
 *
 * The rules held here: rows of one listing go in one locked read → PUT → read-back; each row passes its own checks and
 * gets its own answer, recorded exactly once (the lead's returned, each sibling's written by the lane); a refused
 * sibling is answered alone; the write's outcome is the same for every joined row; nothing is claimed while sending
 * is off; claimed rows are released on an unexpected throw; a second run re-sends nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type QueueRow = Record<string, any> & { id: string; syncStatus: string }

const m = vi.hoisted(() => ({
  read: vi.fn(), market: vi.fn(), audit: vi.fn(), alerts: vi.fn(), levels: vi.fn(), ingest: vi.fn(), alias: vi.fn(), bounds: vi.fn(),
  outcome: vi.fn(async () => undefined), emit: vi.fn(async () => undefined),
  queue: { findMany: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
}))
vi.mock('../db.js', () => ({ default: {
  channelListing: { findUnique: m.read, findMany: vi.fn(async () => []) },
  marketplace: { findFirst: m.market },
  product: { findUnique: m.bounds },
  outboundSyncQueue: m.queue,
  stockLevel: { findMany: m.levels },
  stockPoolLink: { findMany: vi.fn(async () => []) },
  etsyReceiptIngest: { findUnique: m.ingest },
  productListingAlias: { findUnique: m.alias },
} }))
vi.mock('../lib/queue.js', () => ({ addJobSafely: vi.fn(), outboundSyncQueue: null, readCacheQueue: null, searchIndexQueue: null, redis: { connection: null } }))
vi.mock('./sync-control-policy.service.js', () => ({ loadChannelPolicies: async () => new Map(), policyFor: () => null }))
vi.mock('./channel-publish-audit.service.js', () => ({ writeAttemptLog: m.audit, digestPayload: () => 'stub' }))
vi.mock('./listing-sync-outcome.js', () => ({ recordListingSyncOutcome: m.outcome }))
vi.mock('./product-event.service.js', () => ({ productEventService: { emit: m.emit } }))
vi.mock('./gateway/account.js', () => import('../test-support/gateway-stubs.js').then((s) => s.accountModule))
vi.mock('./gateway/ledger.js', () => import('../test-support/gateway-stubs.js').then((s) => s.ledgerModule))
vi.mock('./cx/token.service.js', () => ({ getAccessToken: vi.fn(async () => 'etsy-token') }))
vi.mock('./etsy/account.js', async (original) => ({
  ...(await original<typeof import('./etsy/account.js')>()),
  etsyAccount: vi.fn(async (accountId: string) => ({ accountId, shopId: '90000001', apiKey: 'keystring:secret' })),
}))
vi.mock('./cx/channel-alerts.service.js', async (original) => ({
  ...(await original<typeof import('./cx/channel-alerts.service.js')>()),
  raiseChannelAlert: m.alerts,
}))

import { gatewayLedger } from '../test-support/gateway-stubs.js'
import { __rateTest } from './gateway/rate.js'
import { toInventoryWrite, type EtsyInventoryWrite, type EtsyReadInventory } from './etsy/inventory.js'
import { ETSY_LISTING_LOCK_DEFAULTS, etsyListingLockKey, registerEtsyListingLockRedis, RELEASE_SCRIPT } from './etsy/listing-lock.js'
import { FakeLeaseRedis } from '../test-support/fake-lease-redis.js'

const leaseRedis = new FakeLeaseRedis()
registerEtsyListingLockRedis(() => leaseRedis)

const { OutboundSyncService } = await import('./outbound-sync.service.js')
const service: any = new OutboundSyncService()

const ACCOUNT = 'etsy-acct'
const LISTING_ID = '9000000001'
const money = (amount: number, currency_code = 'EUR') => ({ amount, divisor: 100, currency_code })
const colour = (id: number, name: string) => ({ property_id: 200, property_name: 'Colour', scale_id: null, scale_name: null, value_ids: [id], values: [name] })

/** Etsy's inventory: three colours, priced and stocked by colour. */
const etsyInventory = (): EtsyReadInventory => ({
  products: [1, 2, 3].map((n) => ({
    product_id: 10 + n, sku: `FAKE-SKU-${n}`, is_deleted: false, property_values: [colour(n, `Colour ${n}`)],
    offerings: [{ offering_id: 90 + n, quantity: n, is_enabled: true, is_deleted: false, price: money(2000 + n * 100), readiness_state_id: 7 }],
  })),
  price_on_property: [200], quantity_on_property: [200], sku_on_property: [200], readiness_state_on_property: [],
})

/** A fake Etsy holding one inventory: a GET answers what it holds, a PUT replaces it. Every request is logged. */
let etsy: { log: string[]; puts: EtsyInventoryWrite[]; held: EtsyReadInventory }
function fakeEtsy(initial: EtsyReadInventory = etsyInventory()) {
  const state = { log: [] as string[], puts: [] as EtsyInventoryWrite[], held: structuredClone(initial) }
  const toRead = (body: EtsyInventoryWrite): EtsyReadInventory => ({
    ...body,
    products: body.products.map((p, pi) => ({
      product_id: 11 + pi, sku: p.sku, is_deleted: false,
      property_values: p.property_values?.map((pv) => ({ ...pv, scale_name: null })),
      offerings: p.offerings.map((o, oi) => ({ offering_id: 91 + pi + oi, quantity: o.quantity, is_enabled: o.is_enabled, is_deleted: false,
        price: money(Math.round(o.price * 100)), ...(o.readiness_state_id !== undefined ? { readiness_state_id: o.readiness_state_id } : {}) })),
    })),
  })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (!new RegExp(`/listings/${LISTING_ID}/inventory$`).test(String(url))) throw new Error(`Unexpected request: ${init.method} ${url}`)
    state.log.push(String(init.method))
    if (init.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as EtsyInventoryWrite
      state.puts.push(body); state.held = toRead(body)
      return new Response('{}', { status: 200 })
    }
    return new Response(JSON.stringify(state.held), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
  etsy = state
  return state
}
const offering = (sku: string) => etsy.held.products!.find((p) => p.sku === sku)!.offerings![0]

// ── The queue table, in memory ────────────────────────────────────────────────────────────────────────────────────
let table: QueueRow[] = []
const rowById = (id: string) => table.find((row) => row.id === id)!
/** Hook: runs before a claim compare-and-swap on that row (another run taking it first). */
let beforeClaim: Record<string, () => void> = {}

function matches(row: QueueRow, where: Record<string, any>): boolean {
  for (const [key, want] of Object.entries(where)) {
    if (key === 'id') {
      if (typeof want === 'string') { if (row.id !== want) return false }
      else if (want?.not !== undefined) { if (row.id === want.not) return false }
      else if (Array.isArray(want?.in)) { if (!want.in.includes(row.id)) return false }
      else throw new Error(`Unhandled id filter ${JSON.stringify(want)}`)
    } else if (key === 'syncType') {
      if (typeof want === 'string') { if (row.syncType !== want) return false }
      else if (Array.isArray(want?.in)) { if (!want.in.includes(row.syncType)) return false }
      else throw new Error(`Unhandled syncType filter ${JSON.stringify(want)}`)
    } else if (key === 'channelListing') {
      for (const [field, value] of Object.entries(want as Record<string, unknown>)) if (row.channelListing?.[field] !== value) return false
    } else if (key === 'OR') {
      if (!(want as Array<Record<string, any>>).some((branch) => {
        if ('holdUntil' in branch && branch.holdUntil === null) return row.holdUntil == null
        if (branch.holdUntil?.lte) return row.holdUntil != null && row.holdUntil <= branch.holdUntil.lte
        throw new Error(`Unhandled OR branch ${JSON.stringify(branch)}`)
      })) return false
    } else if (['targetChannel', 'syncStatus', 'channelConnectionId'].includes(key)) {
      if (row[key] !== want) return false
    } else throw new Error(`Unhandled filter ${key}`)
  }
  return true
}

const at = (minute: number) => new Date(Date.UTC(2026, 9, 5, 12, minute))
const listing = (n: number, over: Record<string, unknown> = {}) => ({
  id: `cl-${n}`, productId: `p-${n}`, channel: 'ETSY', marketplace: 'GLOBAL', syncPaused: false, listingStatus: 'ACTIVE', isPublished: true,
  offerActive: true, offerClosedAt: null, externalListingId: LISTING_ID, channelConnectionId: ACCOUNT, ...over,
})
const queueRow = (n: number, kind: 'stock' | 'price', value: number, over: Record<string, any> = {}): QueueRow => ({
  id: `q-${kind}-${n}`, productId: `p-${n}`, channelListingId: `cl-${n}`, targetChannel: 'ETSY',
  syncType: kind === 'stock' ? 'QUANTITY_UPDATE' : 'PRICE_UPDATE', syncStatus: 'PENDING', channelConnectionId: ACCOUNT,
  holdUntil: null, retryCount: 0, maxRetries: 3, createdAt: at(n), errorMessage: null, errorCode: null,
  product: { id: `p-${n}`, sku: `FAKE-SKU-${n}`, etsySku: null },
  channelListing: listing(n),
  payload: kind === 'stock' ? { source: 'STOCK_MOVEMENT', quantity: value } : { source: 'CHANNEL_PRICE_WRITE', marketplace: 'GLOBAL', price: value },
  ...over,
})
/** The lead is IN_PROGRESS: its caller (the worker or the cron loop) claimed it before dispatching. */
const seed = (lead: QueueRow, ...siblings: QueueRow[]) => {
  table = [{ ...lead, syncStatus: 'IN_PROGRESS' }, ...siblings]
  return rowById(lead.id)
}
/** Every write the lane made to one queue row. */
const writesTo = (id: string) => [
  ...m.queue.updateMany.mock.calls.filter(([args]: any) => args.where.id === id || args.where.id?.in?.includes(id)).map(([args]: any) => args),
  ...m.queue.update.mock.calls.filter(([args]: any) => args.where.id === id).map(([args]: any) => args),
]

const live = () => { vi.stubEnv('NEXUS_ENABLE_ETSY_PUBLISH', 'true'); vi.stubEnv('ETSY_PUBLISH_MODE', 'live') }
const CONFIRMED = `Etsy listing ${LISTING_ID} updated and confirmed.`
const SUPERSEDED = 'A newer change to this SKU went to Etsy in the same write.'

beforeEach(() => {
  vi.clearAllMocks()
  __rateTest.useMemory(); gatewayLedger.length = 0
  table = []; beforeClaim = {}
  vi.stubEnv('NEXUS_ENABLE_ETSY_PUBLISH', ''); vi.stubEnv('ETSY_PUBLISH_MODE', '')
  vi.stubEnv('NEXUS_ENABLE_ETSY_ORDER_INGEST', '1')
  vi.stubEnv('NEXUS_SYNC_ORDERING_V2', '0')   // a stock row sends its payload number (the lane's own tests do the same)
  m.ingest.mockResolvedValue({ activatedAt: new Date('2026-10-01T00:00:00Z') })
  m.read.mockImplementation(async ({ where }: { where: { id: string } }) => table.find((row) => row.channelListing?.id === where.id)?.channelListing ?? null)
  m.levels.mockResolvedValue([])
  m.bounds.mockResolvedValue({ minPrice: null, maxPrice: null })
  // The Marketplace table stores GB as UK (market-currency.ts).
  m.market.mockImplementation(async ({ where }: { where: { code: string } }) => ({ currency: where.code === 'UK' ? 'GBP' : 'EUR' }))
  m.queue.findMany.mockImplementation(async ({ where, take, orderBy }: any) => {
    expect(orderBy).toEqual({ createdAt: 'asc' })
    return table.filter((row) => matches(row, where)).sort((a, b) => a.createdAt - b.createdAt).slice(0, take).map((row) => structuredClone(row))
  })
  m.queue.updateMany.mockImplementation(async ({ where, data }: any) => {
    if (typeof where.id === 'string' && where.syncStatus === 'PENDING') beforeClaim[where.id]?.()
    const hit = table.filter((row) => matches(row, where))
    for (const row of hit) Object.assign(row, data)
    return { count: hit.length }
  })
  m.queue.update.mockImplementation(async ({ where, data }: any) => {
    const row = rowById(where.id)
    if (!row) throw new Error(`No queue row ${where.id}`)
    Object.assign(row, data)
    return row
  })
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); __rateTest.reset() })

describe('🔴 one listing, one write', () => {
  it('three stock rows → one read, ONE PUT, one read-back; each row finished once with its own answer and attempt log', async () => {
    live(); fakeEtsy()
    const lead = seed(queueRow(1, 'stock', 5), queueRow(2, 'stock', 6), queueRow(3, 'stock', 7))
    const result = await service.syncToEtsy(lead)

    expect(etsy.log).toEqual(['GET', 'PUT', 'GET'])
    const expected = toInventoryWrite(etsyInventory())
    expected.products.forEach((product, i) => { product.offerings[0].quantity = [5, 6, 7][i] })
    expect(etsy.puts).toEqual([expected])
    // The lead's answer is returned (its caller writes it, as for every row); the lane never writes the lead.
    expect(result).toEqual({ success: true, queueId: 'q-stock-1', channel: 'ETSY', status: 'SUCCESS', message: CONFIRMED })
    expect(writesTo('q-stock-1')).toEqual([])
    // Each sibling: claimed once, then completed once, on the row this run holds.
    for (const id of ['q-stock-2', 'q-stock-3']) {
      expect(writesTo(id)).toEqual([
        { where: { id, syncStatus: 'PENDING' }, data: { syncStatus: 'IN_PROGRESS' } },
        { where: { id, syncStatus: 'IN_PROGRESS' }, data: { syncStatus: 'SUCCESS', syncedAt: expect.any(Date), errorCode: null, errorMessage: null, nextRetryAt: null } },
      ])
      expect(rowById(id).syncStatus).toBe('SUCCESS')
    }
    expect(m.outcome.mock.calls.map(([, args]: any) => args)).toEqual([
      { channelListingId: 'cl-2', productId: 'p-2', outcome: 'sent' },
      { channelListingId: 'cl-3', productId: 'p-3', outcome: 'sent' },
    ])
    expect(m.audit.mock.calls.map(([log]: any) => `${log.sku} ${log.outcome} ${log.productId}`)).toEqual(['FAKE-SKU-1 success p-1', 'FAKE-SKU-2 success p-2', 'FAKE-SKU-3 success p-3'])
    // One gateway write, journalled for the lead's product and listing.
    const writes = gatewayLedger.filter((row) => row.method === 'PUT')
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ operation: 'PUT /listings/:id/inventory', productId: 'p-1', listingId: 'cl-1', connectionId: ACCOUNT })
  }, 15_000)

  it('a price row and a stock row of one listing go in one PUT, each moving only its own field', async () => {
    live(); fakeEtsy()
    const lead = seed(queueRow(1, 'stock', 5), queueRow(2, 'price', 30))
    const result = await service.syncToEtsy(lead)
    expect(etsy.log).toEqual(['GET', 'PUT', 'GET'])
    expect(result).toMatchObject({ status: 'SUCCESS', message: CONFIRMED })
    expect(offering('FAKE-SKU-1')).toMatchObject({ quantity: 5, price: money(2100) })
    expect(offering('FAKE-SKU-2')).toMatchObject({ quantity: 2, price: money(3000) })
    expect(offering('FAKE-SKU-3')).toMatchObject({ quantity: 3, price: money(2300) })
    expect(rowById('q-price-2')).toMatchObject({ syncStatus: 'SUCCESS', errorMessage: null })
  }, 15_000)

  it('each stock row names only its own SKU\'s 999 clamp; a price row names its sale price staying in Nexus', async () => {
    live(); fakeEtsy()
    const lead = seed(queueRow(1, 'stock', 1500), queueRow(2, 'stock', 6), queueRow(3, 'price', 25, { payload: { price: 25, salePrice: 20 } }))
    // A completed row stores no message (completedSyncQueueData), so each sibling's answer is read where it is recorded.
    const finished = vi.spyOn(service, 'finishEtsySibling')
    const result = await service.syncToEtsy(lead)
    expect(result.message).toBe(`${CONFIRMED} Etsy holds at most 999 of an item, so 1500 was sent as 999.`)
    expect(finished.mock.calls.map(([row, answer]: any) => [row.id, answer.message])).toEqual([
      ['q-stock-2', CONFIRMED],
      ['q-price-3', `${CONFIRMED} Etsy has no per-listing sale price, so the sale price stays in Nexus only.`],
    ])
    expect(rowById('q-stock-2')).toMatchObject({ syncStatus: 'SUCCESS' })
    expect(etsy.puts[0].products.map((p) => p.offerings[0].quantity)).toEqual([999, 6, 3])
    expect(etsy.puts[0].products.map((p) => p.offerings[0].price)).toEqual([21, 22, 25])
  }, 15_000)
})

describe('🔴 each row keeps its own checks', () => {
  it('a held sibling (its own push lock) is answered alone with its lock sentence; the others are sent', async () => {
    live(); fakeEtsy()
    const held = queueRow(2, 'stock', 6, { channelListing: listing(2, { offerClosedAt: new Date('2026-10-05T10:00:00Z'), offerActive: false }) })
    const lead = seed(queueRow(1, 'stock', 5), held, queueRow(3, 'stock', 7))
    const result = await service.syncToEtsy(lead)
    expect(result).toMatchObject({ status: 'SUCCESS', message: CONFIRMED })
    expect(etsy.puts).toHaveLength(1)
    expect(etsy.puts[0].products.map((p) => p.offerings[0].quantity)).toEqual([5, 2, 7])   // FAKE-SKU-2 as Etsy holds it
    // Recorded as the lane records a push-locked row (not retried, dead-lettered), with the lock's own words.
    expect(rowById('q-stock-2')).toMatchObject({ syncStatus: 'FAILED', errorCode: 'PUSH_OFFER_CLOSED', isDead: true,
      errorMessage: 'This listing is Inactive here (selling is paused). Set it Active in the product sheet\'s Status column before sending changes.' })
    expect(rowById('q-stock-3')).toMatchObject({ syncStatus: 'SUCCESS' })
  }, 15_000)

  it('a sibling price above its ceiling fails alone (PRICE_OUT_OF_BOUNDS, not retried); the rest are sent', async () => {
    live(); fakeEtsy()
    m.bounds.mockImplementation(async ({ where }: { where: { id: string } }) => (where.id === 'p-2' ? { minPrice: null, maxPrice: 100 } : { minPrice: null, maxPrice: null }))
    const lead = seed(queueRow(1, 'stock', 5), queueRow(2, 'price', 500))
    const result = await service.syncToEtsy(lead)
    expect(result).toMatchObject({ status: 'SUCCESS' })
    expect(rowById('q-price-2')).toMatchObject({ syncStatus: 'FAILED', errorCode: 'PRICE_OUT_OF_BOUNDS', isDead: true })
    expect(rowById('q-price-2').errorMessage).toContain('ceiling')
    expect(offering('FAKE-SKU-2').price).toEqual(money(2200))
    expect(m.audit.mock.calls.map(([log]: any) => `${log.sku} ${log.outcome}`)).toEqual(['FAKE-SKU-2 failed', 'FAKE-SKU-1 success'])
  }, 15_000)

  it('Etsy order import off: a stock lead is SKIPPED with the import sentence and never gathers', async () => {
    live(); fakeEtsy(); vi.stubEnv('NEXUS_ENABLE_ETSY_ORDER_INGEST', '')
    const lead = seed(queueRow(1, 'stock', 5), queueRow(2, 'stock', 6))
    const result = await service.syncToEtsy(lead)
    expect(result).toMatchObject({ success: true, status: 'SKIPPED', errorCode: 'ETSY_ORDER_IMPORT_OFF' })
    expect(m.queue.findMany).not.toHaveBeenCalled()
    expect(rowById('q-stock-2').syncStatus).toBe('PENDING')
    expect(etsy.log).toEqual([])
  })
})

describe('🔴 the write\'s outcome is the same for every joined row', () => {
  it('🔴 review M1 — a combined write refused before its PUT: each row goes ALONE; valid stock rows are sent, only the bad row fails, with its own reason', async () => {
    live(); fakeEtsy()
    // A stock row (FAKE-SKU-1 → 0, a sale elsewhere) and a price row for a SKU Etsy does not hold, waiting together.
    const stranger = queueRow(9, 'price', 30, { product: { id: 'p-9', sku: 'FAKE-SKU-9', etsySku: null } })
    const lead = seed(queueRow(1, 'stock', 0), queueRow(2, 'stock', 6), stranger)
    const result = await service.syncToEtsy(lead)
    const sentence = 'Etsy has no product with SKU "FAKE-SKU-9" on this listing; nothing was sent.'
    // The combined read (refused, nothing sent), then the lead alone, the second stock row alone, the price row alone.
    expect(etsy.log).toEqual(['GET', 'GET', 'PUT', 'GET', 'GET', 'PUT', 'GET', 'GET'])
    expect(result).toEqual({ success: true, queueId: 'q-stock-1', channel: 'ETSY', status: 'SUCCESS', message: CONFIRMED })
    expect(offering('FAKE-SKU-1').quantity).toBe(0)
    expect(offering('FAKE-SKU-2').quantity).toBe(6)
    expect(rowById('q-stock-2')).toMatchObject({ syncStatus: 'SUCCESS', errorMessage: null })
    expect(rowById('q-price-9')).toMatchObject({ syncStatus: 'FAILED', errorMessage: sentence, errorCode: 'NON_RETRYABLE', isDead: true })
    // One attempt per row, each with its own outcome.
    expect(m.audit.mock.calls.map(([log]: any) => `${log.sku} ${log.outcome}`)).toEqual(['FAKE-SKU-1 success', 'FAKE-SKU-2 success', 'FAKE-SKU-9 failed'])
  }, 20_000)

  it('review M1 — when the LEAD is the bad row, the others still go alone and the lead fails alone', async () => {
    live(); fakeEtsy()
    const lead = seed(queueRow(9, 'price', 30, { product: { id: 'p-9', sku: 'FAKE-SKU-9', etsySku: null } }), queueRow(1, 'stock', 4))
    const result = await service.syncToEtsy(lead)
    expect(result).toMatchObject({ success: false, status: 'FAILED', message: 'Etsy has no product with SKU "FAKE-SKU-9" on this listing; nothing was sent.', retryable: false })
    expect(rowById('q-stock-1')).toMatchObject({ syncStatus: 'SUCCESS' })
    expect(offering('FAKE-SKU-1').quantity).toBe(4)
    expect(etsy.puts).toHaveLength(1)
  }, 20_000)

  it('a refusal at or after the PUT (a failed write) keeps ONE outcome for every joined row: it may have landed', async () => {
    live(); fakeEtsy()
    const lead = seed(queueRow(1, 'stock', 5), queueRow(2, 'stock', 6))
    // Etsy answers the PUT with a server error: not a pre-send refusal, so nothing is re-sent row by row.
    const real = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (url: any, init: any = {}) => (init.method === 'PUT' ? new Response('{"error":"boom"}', { status: 500 }) : real(url, init)))
    const result = await service.syncToEtsy(lead)
    expect(result).toMatchObject({ success: false, status: 'FAILED' })
    expect(rowById('q-stock-2')).toMatchObject({ syncStatus: 'FAILED', errorMessage: result.message })
    expect(m.audit.mock.calls.map(([log]: any) => `${log.sku} ${log.outcome}`)).toEqual(['FAKE-SKU-1 failed', 'FAKE-SKU-2 failed'])
  }, 20_000)

  it('🔴 the listing busy: every joined row waits its turn (ETSY_LISTING_BUSY deferral), no retry spent, nothing read or sent', async () => {
    live(); fakeEtsy()
    leaseRedis.hold(etsyListingLockKey(ACCOUNT, LISTING_ID), 'another-worker', 10_000)
    const saved = ETSY_LISTING_LOCK_DEFAULTS.waitMs
    ETSY_LISTING_LOCK_DEFAULTS.waitMs = 200
    try {
      const lead = seed(queueRow(1, 'stock', 5), queueRow(2, 'stock', 6, { retryCount: 2 }), queueRow(3, 'price', 30))
      const result = await service.syncToEtsy(lead)
      expect(result).toMatchObject({ success: false, status: 'FAILED', errorCode: 'ETSY_LISTING_BUSY', retryable: true })
      expect(etsy.log).toEqual([])
      for (const id of ['q-stock-2', 'q-price-3']) {
        const row = rowById(id)
        expect(row).toMatchObject({ syncStatus: 'FAILED', errorCode: 'ETSY_LISTING_BUSY', nextRetryAt: expect.any(Date), errorMessage: result.message })
        expect(row.isDead).toBeUndefined()
      }
      expect(rowById('q-stock-2').retryCount).toBe(2)   // a row with one retry left keeps it
    } finally {
      ETSY_LISTING_LOCK_DEFAULTS.waitMs = saved
      await leaseRedis.eval(RELEASE_SCRIPT, 1, etsyListingLockKey(ACCOUNT, LISTING_ID), 'another-worker')
    }
  }, 15_000)
})

describe('🔴 claims: only rows that are ours, only while sending is on', () => {
  it('a compare-and-swap lost to another run: that row is untouched and not in the write', async () => {
    live(); fakeEtsy()
    const lead = seed(queueRow(1, 'stock', 5), queueRow(2, 'stock', 6), queueRow(3, 'stock', 7))
    beforeClaim['q-stock-2'] = () => { rowById('q-stock-2').syncStatus = 'IN_PROGRESS' }   // another run took it first
    await service.syncToEtsy(lead)
    expect(writesTo('q-stock-2')).toEqual([{ where: { id: 'q-stock-2', syncStatus: 'PENDING' }, data: { syncStatus: 'IN_PROGRESS' } }])
    expect(rowById('q-stock-2').syncStatus).toBe('IN_PROGRESS')
    expect(etsy.puts[0].products.map((p) => p.offerings[0].quantity)).toEqual([5, 2, 7])
    expect(m.audit.mock.calls.map(([log]: any) => log.sku)).toEqual(['FAKE-SKU-1', 'FAKE-SKU-3'])
  }, 15_000)

  it('sending to Etsy off: the lead is SKIPPED with the switch names and NOTHING is read or claimed', async () => {
    fakeEtsy()
    const lead = seed(queueRow(1, 'stock', 5), queueRow(2, 'stock', 6))
    const result = await service.syncToEtsy(lead)
    expect(result).toMatchObject({ success: true, status: 'SKIPPED', dryRun: true })
    expect(m.queue.findMany).not.toHaveBeenCalled()
    expect(m.queue.updateMany).not.toHaveBeenCalled()
    expect(rowById('q-stock-2').syncStatus).toBe('PENDING')
    expect(etsy.log).toEqual([])
  })

  it('content rows, other listings, other accounts, other channels, held, failed and unjoinable rows are never claimed', async () => {
    live(); fakeEtsy()
    const sameNumberOtherShop = queueRow(4, 'stock', 1, { channelConnectionId: 'etsy-acct-2', channelListing: listing(4, { channelConnectionId: 'etsy-acct-2' }) })
    const untouched = [
      queueRow(2, 'stock', 6, { id: 'q-content', syncType: 'CONTENT_UPDATE', payload: { title: 'A title' } }),
      queueRow(3, 'stock', 7, { id: 'q-other-listing', channelListing: listing(3, { externalListingId: '9000000002' }) }),
      sameNumberOtherShop,
      queueRow(3, 'stock', 7, { id: 'q-other-account-row', channelConnectionId: 'etsy-acct-2' }),
      queueRow(3, 'stock', 7, { id: 'q-ebay', targetChannel: 'EBAY' }),
      queueRow(3, 'stock', 7, { id: 'q-held', holdUntil: new Date(Date.now() + 60_000) }),
      queueRow(3, 'stock', 7, { id: 'q-failed', syncStatus: 'FAILED' }),
      queueRow(3, 'stock', 7, { id: 'q-cascade', payload: { source: 'FM_CATALOG_CASCADE', quantity: 7 } }),
      queueRow(3, 'stock', 7, { id: 'q-unpublished', channelListing: listing(3, { isPublished: false }) }),
      queueRow(3, 'price', 31, { id: 'q-text', payload: { price: 31, title: 'Needs review' } }),
    ]
    const lead = seed(queueRow(1, 'stock', 5), queueRow(2, 'stock', 6), ...untouched)
    const before = structuredClone(untouched.map((row) => rowById(row.id)))
    await service.syncToEtsy(lead)
    expect(m.queue.findMany.mock.calls[0][0].where).toEqual({
      id: { not: 'q-stock-1' }, targetChannel: 'ETSY', syncStatus: 'PENDING', syncType: { in: ['QUANTITY_UPDATE', 'PRICE_UPDATE'] },
      channelConnectionId: ACCOUNT, channelListing: { externalListingId: LISTING_ID, channelConnectionId: ACCOUNT },
      OR: [{ holdUntil: null }, { holdUntil: { lte: expect.any(Date) } }],
    })
    expect(m.queue.findMany.mock.calls[0][0].take).toBe(20)   // review n2: the cap
    expect(untouched.map((row) => rowById(row.id))).toEqual(before)
    for (const row of untouched) expect(writesTo(row.id)).toEqual([])
    expect(rowById('q-stock-2').syncStatus).toBe('SUCCESS')
  }, 15_000)

  it('a content lead keeps its own call and never gathers', async () => {
    live()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('the content writer is not the subject here') }))
    const lead = seed(queueRow(1, 'stock', 5, { id: 'q-content-lead', syncType: 'CONTENT_UPDATE', payload: { title: 'A title' } }), queueRow(2, 'stock', 6))
    await service.syncToEtsy(lead)
    expect(m.queue.findMany).not.toHaveBeenCalled()
    expect(rowById('q-stock-2').syncStatus).toBe('PENDING')
  })
})

describe('🔴 duplicates and currencies', () => {
  it('two stock rows of one SKU: the newest is sent, the older answers ETSY_SUPERSEDED (sibling older)', async () => {
    live(); fakeEtsy()
    const older = queueRow(1, 'stock', 8, { id: 'q-stock-1-older', createdAt: at(0) })
    const lead = seed(queueRow(1, 'stock', 5, { createdAt: at(30) }), older)
    const result = await service.syncToEtsy(lead)
    expect(result).toMatchObject({ status: 'SUCCESS', message: CONFIRMED })
    expect(etsy.puts[0].products.map((p) => p.offerings[0].quantity)).toEqual([5, 2, 3])
    expect(rowById('q-stock-1-older')).toMatchObject({ syncStatus: 'SKIPPED', errorCode: 'ETSY_SUPERSEDED', errorMessage: SUPERSEDED, syncedAt: null })
    expect(m.audit).toHaveBeenCalledTimes(1)   // only the row that was sent is an attempt
  }, 15_000)

  it('…and when the LEAD is the older one, the lead\'s own answer is ETSY_SUPERSEDED and the newer row is sent', async () => {
    live(); fakeEtsy()
    const newer = queueRow(1, 'stock', 8, { id: 'q-stock-1-newer', createdAt: at(30) })
    const lead = seed(queueRow(1, 'stock', 5, { createdAt: at(0) }), newer)
    const result = await service.syncToEtsy(lead)
    expect(result).toEqual({ success: true, queueId: 'q-stock-1', channel: 'ETSY', status: 'SKIPPED', errorCode: 'ETSY_SUPERSEDED', message: SUPERSEDED })
    expect(etsy.puts[0].products.map((p) => p.offerings[0].quantity)).toEqual([8, 2, 3])
    expect(rowById('q-stock-1-newer')).toMatchObject({ syncStatus: 'SUCCESS' })
  }, 15_000)

  it('an older duplicate is never sent, and when the write did not land its sentence does not claim the newer one went', async () => {
    live(); fakeEtsy()
    leaseRedis.hold(etsyListingLockKey(ACCOUNT, LISTING_ID), 'another-worker', 10_000)
    const saved = ETSY_LISTING_LOCK_DEFAULTS.waitMs
    ETSY_LISTING_LOCK_DEFAULTS.waitMs = 200
    try {
      const older = queueRow(1, 'price', 20, { id: 'q-price-1-older', createdAt: at(0) })
      const lead = seed(queueRow(1, 'price', 25, { createdAt: at(30) }), older)
      const result = await service.syncToEtsy(lead)
      expect(result).toMatchObject({ errorCode: 'ETSY_LISTING_BUSY', retryable: true })
      expect(rowById('q-price-1-older')).toMatchObject({ syncStatus: 'SKIPPED', errorCode: 'ETSY_SUPERSEDED',
        errorMessage: 'A newer change to this SKU replaces this one; Nexus sends only the newer one.' })
      expect(etsy.log).toEqual([])
    } finally {
      ETSY_LISTING_LOCK_DEFAULTS.waitMs = saved
      await leaseRedis.eval(RELEASE_SCRIPT, 1, etsyListingLockKey(ACCOUNT, LISTING_ID), 'another-worker')
    }
  }, 15_000)

  it('a newer duplicate refused on its OWN checks (its ceiling) does not supersede: the older one is sent, as one by one before E2', async () => {
    live(); fakeEtsy()
    m.bounds.mockResolvedValue({ minPrice: null, maxPrice: 100 })
    const older = queueRow(1, 'price', 30, { id: 'q-price-1-older', createdAt: at(0) })
    // The newer price for the same SKU is outside the ceiling: refused alone, before any write.
    const lead = seed(queueRow(2, 'stock', 6, { createdAt: at(10) }), older, queueRow(1, 'price', 500, { id: 'q-price-1-newer', createdAt: at(30) }))
    await service.syncToEtsy(lead)
    // The refused newer row is answered on its own checks; the older one then wins its SKU and is sent.
    expect(rowById('q-price-1-newer')).toMatchObject({ syncStatus: 'FAILED', errorCode: 'PRICE_OUT_OF_BOUNDS' })
    expect(offering('FAKE-SKU-1').price).toEqual(money(3000))
  }, 20_000)

  it('🔴 review m5 — an older duplicate whose newer change the write refused for good: "…that newer change was not sent: <reason>."', async () => {
    live(); fakeEtsy()
    const gb = queueRow(2, 'price', 30, { channelListing: listing(2, { marketplace: 'GB' }) })
    const older = queueRow(1, 'price', 20, { id: 'q-price-1-older', createdAt: at(0) })
    const lead = seed(queueRow(1, 'price', 25, { createdAt: at(30) }), older, gb)
    await service.syncToEtsy(lead)
    expect(rowById('q-price-1-older')).toMatchObject({ syncStatus: 'SKIPPED', errorCode: 'ETSY_SUPERSEDED',
      errorMessage: 'A newer change to this SKU replaced this one, and that newer change was not sent: The price changes waiting for this Etsy listing are in different currencies (EUR, GBP); Nexus does not guess which one Etsy\'s prices are in, so no price was sent.' })
  }, 20_000)

  it('🔴 review m6 — each row of a combined write reads back its OWN SKU; drift nobody asked for is named on every row', async () => {
    live(); fakeEtsy()
    const lead = seed(queueRow(1, 'stock', 5), queueRow(2, 'stock', 6))
    // Etsy takes the PUT but its read-back shows FAKE-SKU-2 unchanged and FAKE-SKU-3's price blanked (trap 3).
    const real = vi.mocked(fetch).getMockImplementation()!
    let puts = 0
    vi.mocked(fetch).mockImplementation(async (url: any, init: any = {}) => {
      if (init.method === 'PUT') puts++
      const answer = await real(url, init)
      if (init.method !== 'GET' || puts === 0) return answer
      const held = await answer.json()
      held.products[1].offerings[0].quantity = 2
      held.products[2].offerings[0].price = money(0)
      return new Response(JSON.stringify(held), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const finished = vi.spyOn(service, 'finishEtsySibling')
    const result = await service.syncToEtsy(lead)
    expect(result.message).toBe(`Etsy listing ${LISTING_ID} updated and this change confirmed, but the read-back shows 1 other field(s) differ. An alert has been raised.`)
    expect(finished.mock.calls.map(([row, answer]: any) => [row.id, answer.message])).toEqual([
      ['q-stock-2', `Etsy listing ${LISTING_ID} updated, but the read-back did not match. 1 field(s) differ. An alert has been raised.`],
    ])
  }, 20_000)

  it('two price rows in different currencies: each FAILED (not retried, never guessed); the stock row still goes', async () => {
    live(); fakeEtsy()
    const gb = queueRow(2, 'price', 30, { channelListing: listing(2, { marketplace: 'GB' }) })
    const lead = seed(queueRow(1, 'price', 25), gb, queueRow(3, 'stock', 9))
    const result = await service.syncToEtsy(lead)
    const sentence = 'The price changes waiting for this Etsy listing are in different currencies (EUR, GBP); Nexus does not guess which one Etsy\'s prices are in, so no price was sent.'
    expect(result).toMatchObject({ success: false, status: 'FAILED', errorCode: 'ETSY_PRICE_CURRENCY_CONFLICT', retryable: false, message: sentence })
    expect(rowById('q-price-2')).toMatchObject({ syncStatus: 'FAILED', errorCode: 'ETSY_PRICE_CURRENCY_CONFLICT', errorMessage: sentence, isDead: true })
    expect(rowById('q-stock-3')).toMatchObject({ syncStatus: 'SUCCESS' })
    expect(offering('FAKE-SKU-1').price).toEqual(money(2100))
    expect(offering('FAKE-SKU-2').price).toEqual(money(2200))
    expect(offering('FAKE-SKU-3').quantity).toBe(9)
  }, 15_000)
})

describe('🔴 unexpected throws release, and a second run re-sends nothing', () => {
  it('a database throw after the claim puts every unfinished sibling back to PENDING, sends nothing, and rethrows', async () => {
    live(); fakeEtsy()
    const lead = seed(queueRow(1, 'stock', 5), queueRow(2, 'stock', 6), queueRow(3, 'stock', 7))
    m.read.mockImplementation(async ({ where }: { where: { id: string } }) => {
      if (where.id === 'cl-3') throw new Error('database unavailable')
      return table.find((row) => row.channelListing?.id === where.id)?.channelListing ?? null
    })
    await expect(service.syncToEtsy(lead)).rejects.toThrow('database unavailable')
    expect(rowById('q-stock-2').syncStatus).toBe('PENDING')
    expect(rowById('q-stock-3').syncStatus).toBe('PENDING')
    expect(m.queue.updateMany).toHaveBeenLastCalledWith({ where: { id: { in: ['q-stock-2', 'q-stock-3'] }, syncStatus: 'IN_PROGRESS' }, data: { syncStatus: 'PENDING' } })
    expect(etsy.log).toEqual([])
  })

  it('a throw while claiming releases the rows already claimed', async () => {
    live(); fakeEtsy()
    const lead = seed(queueRow(1, 'stock', 5), queueRow(2, 'stock', 6), queueRow(3, 'stock', 7))
    beforeClaim['q-stock-3'] = () => { throw new Error('connection reset') }
    await expect(service.syncToEtsy(lead)).rejects.toThrow('connection reset')
    expect(rowById('q-stock-2').syncStatus).toBe('PENDING')
    expect(rowById('q-stock-3').syncStatus).toBe('PENDING')
    expect(etsy.log).toEqual([])
  })

  it('the waiting rows cannot be read: the lead goes alone, exactly as before E2', async () => {
    live(); fakeEtsy()
    const lead = seed(queueRow(1, 'stock', 5), queueRow(2, 'stock', 6))
    m.queue.findMany.mockRejectedValueOnce(new Error('database unavailable'))
    const result = await service.syncToEtsy(lead)
    expect(result).toMatchObject({ status: 'SUCCESS', message: CONFIRMED })
    expect(etsy.puts[0].products.map((p) => p.offerings[0].quantity)).toEqual([5, 2, 3])
    expect(rowById('q-stock-2').syncStatus).toBe('PENDING')
  }, 15_000)

  it('a second run after success (a retried lead, or a janitor-reclaimed sibling) re-sends nothing', async () => {
    live(); fakeEtsy()
    const lead = seed(queueRow(1, 'stock', 5), queueRow(2, 'stock', 6), queueRow(3, 'stock', 7))
    await service.syncToEtsy(lead)
    expect(etsy.log).toEqual(['GET', 'PUT', 'GET'])
    // The lead again (its answer was lost): the same values are already on Etsy.
    const again = await service.syncToEtsy({ ...lead, syncStatus: 'IN_PROGRESS' })
    expect(again).toMatchObject({ success: true, status: 'SUCCESS', message: 'Etsy already holds these values; nothing was sent.' })
    // A sibling reclaimed after its lease ran out, run on its own.
    rowById('q-stock-3').syncStatus = 'IN_PROGRESS'
    const reclaimed = await service.syncToEtsy(rowById('q-stock-3'))
    expect(reclaimed).toMatchObject({ success: true, message: 'Etsy already holds these values; nothing was sent.' })
    expect(etsy.log).toEqual(['GET', 'PUT', 'GET', 'GET', 'GET'])
    expect(etsy.puts).toHaveLength(1)
  }, 15_000)
})
