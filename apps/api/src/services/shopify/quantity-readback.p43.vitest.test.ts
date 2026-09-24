/**
 * P4.3f — the Shopify quantity read-back.
 *
 * Three propositions:
 *   A. the per-listing VERDICT — what is compared, what is "could not read", and
 *      what is "nothing to compare against". These three must never collapse.
 *   B. the loop: it reads Shopify's own number, diffs it against the resolver,
 *      logs once per product per day, and heals with a row that NAMES its listing.
 *   C. it is SCHEDULED, not registry-only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { readbackVerdict } from './quantity-readback.service.js'

// ── A. the verdict, by value ────────────────────────────────────────────────
describe('P4.3f readbackVerdict', () => {
  it.each([
    ['a live number and a FOLLOW resolution', { shopifyAvailable: 3, resolutionKind: 'FOLLOW', resolutionQuantity: 5 }, 'COMPARE', 5],
    ['agreement is still a COMPARE — the caller decides, not the verdict', { shopifyAvailable: 5, resolutionKind: 'FOLLOW', resolutionQuantity: 5 }, 'COMPARE', 5],
    ['a live ZERO is a real number, not a missing one', { shopifyAvailable: 0, resolutionKind: 'FOLLOW', resolutionQuantity: 0 }, 'COMPARE', 0],
    ['an intended ZERO is a real number too', { shopifyAvailable: 7, resolutionKind: 'FOLLOW', resolutionQuantity: 0 }, 'COMPARE', 0],
  ])('%s → %s', (_n, args, kind, intended) => {
    expect(readbackVerdict(args as never)).toMatchObject({ kind, intended })
  })

  it('🔴 "could not read Shopify" is UNREADABLE, never a mismatch against 0', () => {
    // The variant is not stocked at the reviewed location. Diffing null as zero
    // would report every unstocked listing as drifted and heal it to the pool.
    const v = readbackVerdict({ shopifyAvailable: null, resolutionKind: 'FOLLOW', resolutionQuantity: 5 })
    expect(v.kind).toBe('UNREADABLE')
    expect(v.intended).toBeNull()
  })

  it('🔴 UNREADABLE wins over SKIPPED — the two need different fixes', () => {
    // A listing that is BOTH unreadable and paused is reported as unreadable:
    // "we cannot see Shopify" is an operational fault, "it is paused" is a choice.
    expect(readbackVerdict({ shopifyAvailable: null, resolutionKind: 'PAUSED', resolutionQuantity: null }).kind).toBe('UNREADABLE')
  })

  it.each([
    ['FBA_EXCLUDED', 'FBA_EXCLUDED'],
    ['CLOSED', 'CLOSED'],
    ['PAUSED', 'PAUSED'],
    ['UNCOUNTED', 'UNCOUNTED'],
    ['PINNED', 'PINNED'],
  ])('%s is SKIPPED — there is no pool number to compare against', (_n, resolutionKind) => {
    const v = readbackVerdict({ shopifyAvailable: 3, resolutionKind, resolutionQuantity: 9 })
    expect(v.kind).toBe('SKIPPED')
    expect(v.intended).toBeNull()
    expect(v.reason).toContain(resolutionKind)
  })

  it('🔴 a PINNED listing is not "corrected" back to the operator\'s number', () => {
    // A pin is the operator's number and the shop may legitimately hold another
    // one; silently healing it would overwrite a person's decision.
    expect(readbackVerdict({ shopifyAvailable: 1, resolutionKind: 'PINNED', resolutionQuantity: 99 }).kind).toBe('SKIPPED')
  })

  it('a non-integer intended quantity is SKIPPED, not rounded', () => {
    expect(readbackVerdict({ shopifyAvailable: 3, resolutionKind: 'FOLLOW', resolutionQuantity: 2.5 }).kind).toBe('SKIPPED')
    expect(readbackVerdict({ shopifyAvailable: 3, resolutionKind: 'FOLLOW', resolutionQuantity: null }).kind).toBe('SKIPPED')
    expect(readbackVerdict({ shopifyAvailable: 3, resolutionKind: 'FOLLOW', resolutionQuantity: undefined }).kind).toBe('SKIPPED')
  })
})

// ── B. the loop ─────────────────────────────────────────────────────────────
const m = vi.hoisted(() => {
  const outbound = vi.fn(() => { throw new Error('Unexpected outbound fetch') }); vi.stubGlobal('fetch', outbound)
  return {
    outbound,
    findMany: vi.fn(), findFirst: vi.fn(), logConflict: vi.fn(),
    createOutboundRow: vi.fn(), shopifyAdmin: vi.fn(), readShopifyAvailable: vi.fn(),
    loadSyncLedgers: vi.fn(), loadChannelPolicies: vi.fn(), recordDrift: vi.fn(),
  }
})
vi.mock('../../db.js', () => ({ default: { channelListing: { findMany: m.findMany }, syncHealthLog: { findFirst: m.findFirst } } }))
vi.mock('../outbound-rows.js', () => ({ createOutboundRow: m.createOutboundRow }))
vi.mock('../sync-health.service.js', () => ({ syncHealthService: { logConflict: m.logConflict } }))
vi.mock('./admin-client.js', () => ({ shopifyAdmin: m.shopifyAdmin }))
vi.mock('./listing-write.service.js', () => ({ readShopifyAvailable: m.readShopifyAvailable }))
// A-36 (Step 3.5a) — the one ChannelDrift writer, observed.
vi.mock('../channel-drift.service.js', () => ({ recordChannelReadback: m.recordDrift }))
vi.mock('../stock-pool/sync-ledgers.js', async (orig) => ({
  ...(await orig<typeof import('../stock-pool/sync-ledgers.js')>()),
  loadSyncLedgers: m.loadSyncLedgers,
}))
vi.mock('../sync-control-policy.service.js', () => ({ loadChannelPolicies: m.loadChannelPolicies, policyFor: () => null }))

const { readBackShopifyQuantities } = await import('./quantity-readback.service.js')
const { syncLedgerOf } = await import('../sync-control-core.js')

const listing = (over: Record<string, unknown> = {}) => ({
  id: 'cl-1', productId: 'p-1', marketplace: 'GLOBAL', quantity: null, price: 49.9, stockBuffer: 0,
  fulfillmentMethod: 'FBM', syncPaused: false, offerClosedAt: null, followMasterQuantity: true,
  sourceLocationCodes: [], channelConnectionId: 'conn-1', platformAttributes: {},
  externalListingId: 'gid://shopify/Product/1', listingStatus: 'ACTIVE', syncLocked: false,
  product: { id: 'p-1', sku: 'SKU-1' }, ...over,
})

const ledgerFor = (available: number) => new Map([['p-1', {
  productId: 'p-1', source: { kind: 'own' as const },
  ledger: syncLedgerOf([{ locationCode: 'IT-MAIN', available, syncRoutes: [] }]),
  quantity: available, available, uncountedIsZero: true, fbaBucket: 0,
}]])

describe('P4.3f readBackShopifyQuantities', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    m.loadChannelPolicies.mockResolvedValue(new Map())
    m.shopifyAdmin.mockResolvedValue({ graphql: vi.fn(), domain: 'shop.myshopify.com' })
    m.findFirst.mockResolvedValue(null)
    m.logConflict.mockResolvedValue(undefined)
    m.createOutboundRow.mockResolvedValue({ id: 'q-1' })
  })
  const onePage = (rows: unknown[]) => { m.findMany.mockResolvedValueOnce(rows).mockResolvedValue([]) }

  it('a listing that agrees with the pool is checked and produces nothing', async () => {
    onePage([listing()])
    m.loadSyncLedgers.mockResolvedValue(ledgerFor(5))
    m.readShopifyAvailable.mockResolvedValue({ available: 5, price: 49.9, locationId: 'gid://shopify/Location/1', variantId: 'v1' })
    const r = await readBackShopifyQuantities()
    expect(r).toMatchObject({ checked: 1, unreadable: 0, skipped: 0, logged: 0, healed: 0 })
    expect(r.mismatches).toEqual([])
    expect(m.logConflict).not.toHaveBeenCalled()
    expect(m.createOutboundRow).not.toHaveBeenCalled()
  })

  it('a drifted listing is logged once and healed with a row that NAMES its listing', async () => {
    onePage([listing()])
    m.loadSyncLedgers.mockResolvedValue(ledgerFor(5))
    m.readShopifyAvailable.mockResolvedValue({ available: 2, price: 49.9, locationId: 'gid://shopify/Location/1', variantId: 'v1' })
    const r = await readBackShopifyQuantities()
    expect(r).toMatchObject({ checked: 1, logged: 1, healed: 1 })
    expect(r.mismatches[0]).toMatchObject({ listingId: 'cl-1', shopifyQty: 2, intendedQty: 5 })
    expect(m.logConflict).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      channel: 'SHOPIFY', conflictType: 'CHANNEL_QTY_READBACK', productId: 'p-1',
      localData: { intendedQty: 5 },
      remoteData: expect.objectContaining({ shopifyQty: 2, source: 'SHOPIFY_INVENTORY_LEVEL' }),
    }))
    // P4.3c — the heal must name its listing, or the engine refuses the row and
    // the dispatch re-read, the routed ceiling and the EU guard never run on it.
    const healed = m.createOutboundRow.mock.calls[0][1].data
    expect(healed).toMatchObject({
      channelListingId: 'cl-1', channelConnectionId: 'conn-1', targetChannel: 'SHOPIFY',
      syncType: 'QUANTITY_UPDATE',
    })
    expect(healed.payload).toMatchObject({ quantity: 5, observedOnChannel: 2, source: 'SHOPIFY_QTY_READBACK' })
  })

  it('a mismatch already logged in the last 24 h is not logged again — but is still healed', async () => {
    onePage([listing()])
    m.loadSyncLedgers.mockResolvedValue(ledgerFor(5))
    m.readShopifyAvailable.mockResolvedValue({ available: 2, price: 49.9, locationId: 'L', variantId: 'v1' })
    m.findFirst.mockResolvedValue({ id: 'existing' })
    const r = await readBackShopifyQuantities()
    expect(r).toMatchObject({ logged: 0, healed: 1 })
    expect(m.logConflict).not.toHaveBeenCalled()
  })

  it('🔴 an unreadable listing is counted apart and never healed', async () => {
    onePage([listing()])
    m.loadSyncLedgers.mockResolvedValue(ledgerFor(5))
    m.readShopifyAvailable.mockResolvedValue({ available: null, price: 49.9, locationId: 'L', variantId: 'v1' })
    const r = await readBackShopifyQuantities()
    // `checked` stays 0: a run that could not read must not print like a clean one.
    expect(r).toMatchObject({ checked: 0, unreadable: 1, logged: 0, healed: 0 })
    expect(m.createOutboundRow).not.toHaveBeenCalled()
  })

  it('a thrown read is unreadable, not a silent pass', async () => {
    onePage([listing()])
    m.loadSyncLedgers.mockResolvedValue(ledgerFor(5))
    m.readShopifyAvailable.mockRejectedValue(new Error('Shopify request failed (HTTP 503).'))
    expect(await readBackShopifyQuantities()).toMatchObject({ checked: 0, unreadable: 1, healed: 0 })
  })

  it('an account that cannot be opened makes its listings unreadable, and is tried once', async () => {
    onePage([listing({ id: 'cl-1' }), listing({ id: 'cl-2' })])
    m.loadSyncLedgers.mockResolvedValue(ledgerFor(5))
    m.shopifyAdmin.mockRejectedValue(new Error('The Shopify account has no verified myshopify.com domain.'))
    const r = await readBackShopifyQuantities()
    expect(r).toMatchObject({ checked: 0, unreadable: 2 })
    // One client per account, not one per listing.
    expect(m.shopifyAdmin).toHaveBeenCalledOnce()
  })

  it('a PAUSED resolution is skipped, not compared', async () => {
    onePage([listing({ syncPaused: true })])
    m.loadSyncLedgers.mockResolvedValue(ledgerFor(5))
    m.readShopifyAvailable.mockResolvedValue({ available: 2, price: 49.9, locationId: 'L', variantId: 'v1' })
    expect(await readBackShopifyQuantities()).toMatchObject({ checked: 0, skipped: 1, healed: 0 })
  })

  it('healing can be turned off, and the mismatch is still logged', async () => {
    onePage([listing()])
    m.loadSyncLedgers.mockResolvedValue(ledgerFor(5))
    m.readShopifyAvailable.mockResolvedValue({ available: 2, price: 49.9, locationId: 'L', variantId: 'v1' })
    expect(await readBackShopifyQuantities({ heal: false })).toMatchObject({ logged: 1, healed: 0 })
    expect(m.createOutboundRow).not.toHaveBeenCalled()
  })

  it('the buffer is held back: Shopify showing the unbuffered number IS drift', async () => {
    onePage([listing({ stockBuffer: 2 })])
    m.loadSyncLedgers.mockResolvedValue(ledgerFor(5))
    m.readShopifyAvailable.mockResolvedValue({ available: 5, price: 49.9, locationId: 'L', variantId: 'v1' })
    const r = await readBackShopifyQuantities()
    expect(r.mismatches[0]).toMatchObject({ shopifyQty: 5, intendedQty: 3 })
  })

  it('no candidate listings: a clean, empty run that asks Shopify nothing', async () => {
    m.findMany.mockResolvedValue([])
    expect(await readBackShopifyQuantities()).toMatchObject({ checked: 0, unreadable: 0, mismatches: [], capped: false })
    expect(m.shopifyAdmin).not.toHaveBeenCalled()
  })
})

// ── C. it runs on its own ───────────────────────────────────────────────────
describe('P4.3f: the job is SCHEDULED, not registry-only', () => {
  it('index.ts starts the cron at boot', () => {
    const source = readFileSync(new URL('../../index.ts', import.meta.url), 'utf8')
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).toContain('startEbayReadbackCron')                 // the stripper left the file intact
    expect(code).toMatch(/startShopifyQtyReadbackCron\(\)/)
  })

  it('the job file calls cron.schedule — a CRON_REGISTRY entry is a manual trigger', () => {
    const source = readFileSync(new URL('../../jobs/shopify-qty-readback.job.ts', import.meta.url), 'utf8')
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code.length).toBeGreaterThan(source.length / 3)
    expect(code).toMatch(/cron\.schedule\(/)
    // And the schedule is validated before it is used, so a bad override does not
    // take the job down silently.
    expect(code).toMatch(/cron\.validate\(schedule\)/)
  })
})

// ── P4.4e — the price arm, from the same response ───────────────────────────
describe('P4.4e: the Shopify read-back also diffs the price', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    m.loadChannelPolicies.mockResolvedValue(new Map())
    m.shopifyAdmin.mockResolvedValue({ graphql: vi.fn(), domain: 'shop.myshopify.com' })
    m.findFirst.mockResolvedValue(null)
    m.logConflict.mockResolvedValue(undefined)
    m.createOutboundRow.mockResolvedValue({ id: 'q-1' })
    m.loadSyncLedgers.mockResolvedValue(ledgerFor(5))
  })
  const onePage = (rows: unknown[]) => { m.findMany.mockResolvedValueOnce(rows).mockResolvedValue([]) }

  it('a drifted price is reported, with no extra channel call', async () => {
    onePage([listing()])
    m.readShopifyAvailable.mockResolvedValue({ available: 5, price: 59.9, locationId: 'L', variantId: 'v1' })
    const r = await readBackShopifyQuantities()
    // One read for BOTH arms: `readShopifyAvailable` already selected `price`.
    expect(m.readShopifyAvailable).toHaveBeenCalledOnce()
    expect(r.priceMismatches).toEqual([{ listingId: 'cl-1', productId: 'p-1', sku: 'SKU-1', shopifyPrice: 59.9, intendedPrice: 49.9 }])
    expect(r.priceLogged).toBe(1)
    expect(m.logConflict).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'SHOPIFY', conflictType: 'CHANNEL_PRICE_READBACK', productId: 'p-1',
      localData: { intendedPrice: 49.9 },
    }))
  })

  it('🔴 nothing is HEALED for a price — it is reported only', async () => {
    onePage([listing()])
    m.readShopifyAvailable.mockResolvedValue({ available: 5, price: 59.9, locationId: 'L', variantId: 'v1' })
    const r = await readBackShopifyQuantities()
    expect(r.priceMismatches).toHaveLength(1)
    expect(r.healed).toBe(0)
    expect(m.createOutboundRow).not.toHaveBeenCalled()
  })

  it('🔴 a PAUSED listing is skipped for quantity but its PRICE is still checked', async () => {
    onePage([listing({ syncPaused: true })])
    m.readShopifyAvailable.mockResolvedValue({ available: 5, price: 59.9, locationId: 'L', variantId: 'v1' })
    const r = await readBackShopifyQuantities()
    expect(r.skipped).toBe(1)
    expect(r.priceMismatches).toHaveLength(1)
  })

  it('an agreeing price reports nothing', async () => {
    onePage([listing()])
    m.readShopifyAvailable.mockResolvedValue({ available: 5, price: 49.9, locationId: 'L', variantId: 'v1' })
    expect((await readBackShopifyQuantities()).priceMismatches).toEqual([])
  })

  it('a price Shopify did not send is not a drift to zero', async () => {
    onePage([listing()])
    m.readShopifyAvailable.mockResolvedValue({ available: 5, price: null, locationId: 'L', variantId: 'v1' })
    expect((await readBackShopifyQuantities()).priceMismatches).toEqual([])
  })

  it('a 24 h duplicate is not logged again', async () => {
    onePage([listing()])
    m.readShopifyAvailable.mockResolvedValue({ available: 5, price: 59.9, locationId: 'L', variantId: 'v1' })
    m.findFirst.mockResolvedValue({ id: 'existing' })
    const r = await readBackShopifyQuantities()
    expect(r.priceMismatches).toHaveLength(1)
    expect(r.priceLogged).toBe(0)
  })
})

// ── C. A-36 (Step 3.5a) — every compared listing reaches ChannelDrift ─────────
describe('A-36 readBackShopifyQuantities → ChannelDrift', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    m.loadChannelPolicies.mockResolvedValue(new Map())
    m.shopifyAdmin.mockResolvedValue({ graphql: vi.fn(), domain: 'shop.myshopify.com' })
    m.findFirst.mockResolvedValue(null)
    m.logConflict.mockResolvedValue(undefined)
    m.createOutboundRow.mockResolvedValue({ id: 'q-1' })
    m.recordDrift.mockResolvedValue({ driftCount: 0 })
    m.loadSyncLedgers.mockResolvedValue(ledgerFor(5))
  })
  const onePage = (rows: unknown[]) => { m.findMany.mockResolvedValueOnce(rows).mockResolvedValue([]) }
  const recorded = () => m.recordDrift.mock.calls.map(c => c[0])

  it('🔴 a drifted listing is recorded with our quantity and Shopify\'s', async () => {
    onePage([listing()])
    m.readShopifyAvailable.mockResolvedValue({ available: 2, price: 49.9, locationId: 'L', variantId: 'v1' })
    await readBackShopifyQuantities()
    expect(recorded()).toEqual([{ channelListingId: 'cl-1', channel: 'SHOPIFY', marketplace: 'GLOBAL', source: 'shopify-inventory-level',
      compared: ['quantity', 'price'], differing: [{ field: 'quantity', ours: 5, theirs: 2 }] }])
  })

  it('🔴 a matching listing is recorded as compared and clean — that is what clears an old drift', async () => {
    onePage([listing()])
    m.readShopifyAvailable.mockResolvedValue({ available: 5, price: 49.9, locationId: 'L', variantId: 'v1' })
    await readBackShopifyQuantities()
    expect(recorded()).toEqual([expect.objectContaining({ channelListingId: 'cl-1', compared: ['quantity', 'price'], differing: [] })])
  })

  it('🔴 an unreadable quantity is NOT compared — only the price, which Shopify did answer', async () => {
    onePage([listing()])
    m.readShopifyAvailable.mockResolvedValue({ available: null, price: 55, locationId: null, variantId: 'v1' })
    await readBackShopifyQuantities()
    expect(recorded()).toEqual([expect.objectContaining({ compared: ['price'], differing: [{ field: 'price', ours: 49.9, theirs: 55 }] })])
  })
})
