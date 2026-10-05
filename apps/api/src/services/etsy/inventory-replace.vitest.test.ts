/**
 * E2 — `replaceEtsyInventory`, the studio's full inventory replace: under the listing lock, read Etsy's inventory now,
 * let the caller build the whole body from it, send it only when it differs, and read it back. The same stock and
 * currency rules as the pushes guard it before the PUT; after Etsy answered the PUT it never throws.
 * Header and in-memory lease as `inventory-write.p46.vitest.test.ts`. Fake ids only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  order: [] as string[],
  gets: [] as string[],
  puts: [] as Array<Record<string, unknown>>,
  inventory: null as unknown,
  readBack: null as unknown,
  alerts: [] as Array<Record<string, unknown>>,
  alertThrows: null as Error | null,
  getThrows: null as Error | null,
  afterRead: null as (() => void | Promise<void>) | null,
  /** The account's Etsy order-import activation row (EtsyReceiptIngest), as the database would answer. */
  ingest: vi.fn(),
}))

vi.mock('../../db.js', () => ({ default: { etsyReceiptIngest: { findUnique: h.ingest } } }))
vi.mock('./read-client.js', () => ({
  etsyReader: vi.fn(async () => ({
    shopId: '90000001',
    get: vi.fn(async (path: string) => {
      h.order.push('get'); h.gets.push(path)
      if (h.gets.length === 1) await h.afterRead?.()
      if (h.getThrows && h.gets.length > 1) throw h.getThrows
      return structuredClone(h.gets.length === 1 ? h.inventory : (h.readBack ?? h.inventory))
    }),
  })),
}))
vi.mock('./write-client.js', () => ({
  etsyWriter: vi.fn(async () => ({
    shopId: '90000001',
    send: vi.fn(async (input: Record<string, unknown>) => { h.order.push('put'); h.puts.push(input); return {} }),
  })),
}))
vi.mock('../cx/channel-alerts.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../cx/channel-alerts.service.js')>()),
  raiseChannelAlert: vi.fn(async (alert: Record<string, unknown>) => {
    if (h.alertThrows) throw h.alertThrows
    h.alerts.push(alert); return { created: 1, deduped: 0, recipients: 1 }
  }),
}))
vi.mock('../../utils/logger.js', () => ({ logger: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } }))

import { replaceEtsyInventory } from './inventory-write.service.js'
import { toInventoryWrite, type EtsyInventoryWrite } from './inventory.js'
import { etsyListingLockKey, registerEtsyListingLockRedis } from './listing-lock.js'
import { FakeLeaseRedis } from '../../test-support/fake-lease-redis.js'

let leaseRedis = new FakeLeaseRedis()
registerEtsyListingLockRedis(() => leaseRedis)

const LISTING = '9000000001'
const money = (amount: number, currency_code = 'EUR') => ({ amount, divisor: 100, currency_code })
const size = (value: string, id: number) => [{ property_id: 513, property_name: 'Taglia', scale_id: null, scale_name: null, value_ids: [id], values: [value] }]
const product = (sku: string, value: string, quantity: number, price: number, extra: Record<string, unknown> = {}) => ({
  product_id: 1, sku, is_deleted: false, property_values: size(value, quantity + 100),
  offerings: [{ offering_id: 9, quantity, is_enabled: true, is_deleted: false, price: money(price), readiness_state_id: 80000001, ...extra }] })
const inventory = () => ({
  products: [product('FAKE-SKU-1', 'M', 4, 1999), product('FAKE-SKU-2', 'L', 2, 2450)],
  price_on_property: [513], quantity_on_property: [513], sku_on_property: [513], readiness_state_on_property: [],
})
/** A new variation, as Nexus would add it. */
const added = (overrides: Record<string, unknown> = {}) => ({ sku: 'FAKE-SKU-3', property_values: [{ property_id: 513, property_name: 'Taglia', value_ids: [], values: ['XL'], scale_id: null }],
  offerings: [{ price: 21.5, quantity: 3, is_enabled: true, readiness_state_id: 80000001, ...overrides }] })

beforeEach(() => {
  leaseRedis = new FakeLeaseRedis(); h.afterRead = null
  h.order = []; h.gets = []; h.puts = []; h.alerts = []; h.getThrows = null; h.alertThrows = null
  h.inventory = inventory(); h.readBack = null
  vi.stubEnv('NEXUS_ENABLE_ETSY_ORDER_INGEST', '1')
  h.ingest.mockReset().mockResolvedValue({ activatedAt: new Date('2026-10-01T00:00:00Z') })
})
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs() })

type Build = (current: EtsyInventoryWrite) => EtsyInventoryWrite
const replace = (build: Build, options: { readBack?: unknown; beforeSend?: (body: EtsyInventoryWrite) => Promise<void>; priceCurrency?: string } = {}) => {
  if (options.readBack !== undefined) h.readBack = options.readBack
  return replaceEtsyInventory({ accountId: 'etsy-account-1', listingId: LISTING, build, readBackDelayMs: 0,
    priceCurrency: 'priceCurrency' in options ? options.priceCurrency : 'EUR', beforeSend: options.beforeSend,
    ledger: { productId: 'family', triggeredBy: 'api' } })
}
/** A read-back of Etsy holding exactly `body` (with Etsy's read shape). */
const heldAs = (body: EtsyInventoryWrite) => ({ ...body, products: body.products.map((p, i) => ({ product_id: i + 1, is_deleted: false, sku: p.sku,
  property_values: p.property_values, offerings: p.offerings.map((o) => ({ offering_id: 1, is_deleted: false, quantity: o.quantity, is_enabled: o.is_enabled,
    price: money(Math.round(o.price * 100)), readiness_state_id: o.readiness_state_id })) })) })
const withAdded = (overrides: Record<string, unknown> = {}): Build => (current) => ({ ...current, products: [...current.products, added(overrides) as never] })

describe('E2 replace — the lock and the read', () => {
  it('runs under the listing\'s own lock, and releases it', async () => {
    await replace((current) => current)
    const key = etsyListingLockKey('etsy-account-1', LISTING)
    expect(key).toBe(`{nexus:etsy:inventory}:etsy-account-1:${LISTING}`)
    expect(leaseRedis.log[0]).toBe(`SET ${key}`)
    expect(leaseRedis.log.at(-1)).toBe(`RELEASE ${key}`)
    expect(leaseRedis.get(key)).toBeNull()
  })

  it('build gets toInventoryWrite of Etsy\'s inventory as read now (a copy: changing it changes nothing here)', async () => {
    const build = vi.fn((current: EtsyInventoryWrite) => { const seen = structuredClone(current); current.products.length = 0; return seen })
    const result = await replace(build)
    expect(build).toHaveBeenCalledTimes(1)
    expect(h.gets).toEqual([`/listings/${LISTING}/inventory`])
    // What build saw (returned as the body) is exactly toInventoryWrite of Etsy's answer, and emptying its argument
    // did not reach the writer's own copy.
    expect(result.body).toEqual(toInventoryWrite(inventory()))
    expect(result.current).toEqual(toInventoryWrite(inventory()))
    expect(result.sent).toBe(false)
  })

  it('does not send when its lease was lost during the read', async () => {
    h.afterRead = () => leaseRedis.hold(etsyListingLockKey('etsy-account-1', LISTING), 'another-holder', 30_000)
    const beforeSend = vi.fn(async () => {})
    await expect(replace(withAdded(), { beforeSend })).rejects.toMatchObject({ code: 'ETSY_LISTING_BUSY' })
    expect(h.puts).toEqual([])
  })

  it('a build that throws sends nothing, and the lock is released', async () => {
    await expect(replace(() => { throw new Error('Etsy now holds variation FAKE-SKU-9 that Nexus does not; sending the variations would delete it. Review again. Nothing was sent.') }))
      .rejects.toThrow('Review again. Nothing was sent.')
    expect(h.puts).toEqual([])
    expect(leaseRedis.log.at(-1)).toMatch(/^RELEASE /)
  })

  it.each(['0', 'abc', '', '9000000001/x'])('a listing id of %p never reaches a lock or a URL', async (id) => {
    await expect(replaceEtsyInventory({ accountId: 'etsy-account-1', listingId: id, build: (c) => c, readBackDelayMs: 0 })).rejects.toThrow('That is not an Etsy listing id; nothing was sent.')
    expect(h.gets).toEqual([])
    expect(leaseRedis.log).toEqual([])
  })
})

describe('E2 replace — 🔴 a body equal to Etsy\'s is not sent', () => {
  it('equal → no PUT, no beforeSend, no read-back', async () => {
    const beforeSend = vi.fn(async () => {})
    const result = await replace((current) => current, { beforeSend })
    expect(result).toEqual({ sent: false, body: toInventoryWrite(inventory()), current: toInventoryWrite(inventory()), drift: [], confirmed: true })
    expect(h.puts).toEqual([])
    expect(beforeSend).not.toHaveBeenCalled()
    expect(h.gets).toHaveLength(1)
  })

  it('a body that differs only in key order is the same body', async () => {
    const reorder: Build = (current) => ({ readiness_state_on_property: current.readiness_state_on_property, sku_on_property: current.sku_on_property,
      quantity_on_property: current.quantity_on_property, price_on_property: current.price_on_property,
      products: current.products.map((p) => ({ offerings: p.offerings.map((o) => ({ readiness_state_id: o.readiness_state_id, is_enabled: o.is_enabled, quantity: o.quantity, price: o.price })),
        property_values: p.property_values, sku: p.sku })) })
    const result = await replace(reorder)
    expect(result.sent).toBe(false)
    expect(h.puts).toEqual([])
  })
})

describe('E2 replace — the send', () => {
  it('beforeSend gets the exact body, then ONE JSON PUT with the lease signal, then the read-back', async () => {
    const seen: EtsyInventoryWrite[] = []
    const beforeSend = vi.fn(async (body: EtsyInventoryWrite) => { h.order.push('beforeSend'); seen.push(structuredClone(body)) })
    const build = withAdded()
    const body = build(toInventoryWrite(inventory()))
    const result = await replace(build, { beforeSend, readBack: heldAs(body) })
    expect(h.order).toEqual(['get', 'beforeSend', 'put', 'get'])
    expect(h.puts).toHaveLength(1)
    expect(h.puts[0]).toMatchObject({ path: `/listings/${LISTING}/inventory`, method: 'PUT', kind: 'write', operation: 'PUT /listings/:id/inventory',
      ledger: { productId: 'family', triggeredBy: 'api' } })
    expect(h.puts[0].body).toEqual(body)
    expect(seen).toEqual([body])
    expect(h.puts[0].form).toBeUndefined()
    expect(h.puts[0].pushLock).toBeUndefined()
    expect(h.puts[0].signal).toBeInstanceOf(AbortSignal)
    expect((h.puts[0].signal as AbortSignal).aborted).toBe(false)
    expect(result).toEqual({ sent: true, body, current: toInventoryWrite(inventory()), drift: [], confirmed: true })
    expect(h.alerts).toEqual([])
  })

  it('a beforeSend that throws (the journal) sends nothing', async () => {
    await expect(replace(withAdded(), { beforeSend: async () => { throw new Error('journal unavailable') } })).rejects.toThrow('journal unavailable')
    expect(h.puts).toEqual([])
  })

  it('a structure change with Etsy\'s own prices and stock needs neither order import nor a currency', async () => {
    vi.stubEnv('NEXUS_ENABLE_ETSY_ORDER_INGEST', '')
    const profile: Build = (current) => ({ ...current, products: current.products.map((p) => ({ ...p, offerings: p.offerings.map((o) => ({ ...o, readiness_state_id: 80000002 })) })) })
    const result = await replace(profile, { priceCurrency: undefined })
    expect(result.sent).toBe(true)
    expect(h.puts).toHaveLength(1)
    expect(h.ingest).not.toHaveBeenCalled()
  })

  it('an offering with no processing profile is refused before anything is sent (Etsy: "All offerings need readiness state")', async () => {
    const beforeSend = vi.fn(async () => {})
    await expect(replace(withAdded({ readiness_state_id: null }), { beforeSend })).rejects.toMatchObject({ name: 'EtsyInventoryShapeError',
      message: 'Etsy product FAKE-SKU-3 has no processing profile (readiness_state_id), and Etsy refuses an offering without one; nothing was sent.' })
    await expect(replace(withAdded({ price: 0 }))).rejects.toThrow('a price of 0 is not a usable price')
    expect(beforeSend).not.toHaveBeenCalled()
    expect(h.puts).toEqual([])
  })
})

describe('E2 replace — the stock and currency rules, before the PUT', () => {
  it.each([[''], ['0']])('🔴 a new variation buyers can see, with order import %p: EtsyQuantityRefusal, nothing sent', async (flag) => {
    vi.stubEnv('NEXUS_ENABLE_ETSY_ORDER_INGEST', flag)
    const beforeSend = vi.fn(async () => {})
    const refused = await replace(withAdded(), { beforeSend }).catch((error: unknown) => error)
    expect(refused).toMatchObject({ name: 'EtsyQuantityRefusal', code: 'ETSY_ORDER_IMPORT_OFF' })
    expect(beforeSend).not.toHaveBeenCalled()
    expect(h.puts).toEqual([])
  })

  it('order import on but this account not activated: refused the same way', async () => {
    h.ingest.mockResolvedValue(null)
    await expect(replace(withAdded())).rejects.toMatchObject({ name: 'EtsyQuantityRefusal', code: 'ETSY_ORDER_IMPORT_NOT_ACTIVATED' })
    expect(h.ingest).toHaveBeenCalledWith({ where: { workspace_connectionId: { connectionId: 'etsy-account-1' } }, select: { activatedAt: true } })
    expect(h.puts).toEqual([])
  })

  it('D6: a new variation sent HIDDEN cannot sell, so it needs no order import (its price still needs the currency)', async () => {
    vi.stubEnv('NEXUS_ENABLE_ETSY_ORDER_INGEST', '')
    const build = withAdded({ is_enabled: false })
    const result = await replace(build, { readBack: heldAs(build(toInventoryWrite(inventory()))) })
    expect(result).toMatchObject({ sent: true, confirmed: true })
    expect(h.ingest).not.toHaveBeenCalled()
    h.gets = []; h.readBack = null
    await expect(replace(build, { priceCurrency: 'USD' })).rejects.toMatchObject({ name: 'EtsyPriceRefusal' })
  })

  it('a held variation whose quantity moved, or a hidden one shown again, is a stock write too', async () => {
    vi.stubEnv('NEXUS_ENABLE_ETSY_ORDER_INGEST', '')
    const moved: Build = (current) => ({ ...current, products: current.products.map((p, i) => i ? p : { ...p, offerings: [{ ...p.offerings[0], quantity: 9 }] }) })
    await expect(replace(moved)).rejects.toMatchObject({ name: 'EtsyQuantityRefusal' })
    const hiddenNow = inventory(); hiddenNow.products[1].offerings[0].is_enabled = false
    h.inventory = hiddenNow; h.gets = []
    const shown: Build = (current) => ({ ...current, products: current.products.map((p) => ({ ...p, offerings: p.offerings.map((o) => ({ ...o, is_enabled: true })) })) })
    await expect(replace(shown)).rejects.toMatchObject({ name: 'EtsyQuantityRefusal' })
    expect(h.puts).toEqual([])
  })

  it('🔴 a changed quantity_on_property (what the stock is shared by) is a stock change: refused with order import off, even with every number kept', async () => {
    // Etsy holds a shared stock (quantity_on_property []); the same numbers per variation would add up to more on Etsy.
    const sharedNow = inventory(); sharedNow.quantity_on_property = []
    h.inventory = sharedNow
    vi.stubEnv('NEXUS_ENABLE_ETSY_ORDER_INGEST', '')
    const perVariation: Build = (current) => ({ ...current, quantity_on_property: [513] })
    const beforeSend = vi.fn(async () => {})
    await expect(replace(perVariation, { beforeSend })).rejects.toMatchObject({ name: 'EtsyQuantityRefusal', code: 'ETSY_ORDER_IMPORT_OFF' })
    expect(beforeSend).not.toHaveBeenCalled()
    expect(h.puts).toEqual([])
    // With order import on and activated, the same body is sent (the review decides whether such a change is offered).
    vi.stubEnv('NEXUS_ENABLE_ETSY_ORDER_INGEST', '1'); h.gets = []
    await expect(replace(perVariation)).resolves.toMatchObject({ sent: true })
    expect(h.puts).toHaveLength(1)
    expect((h.puts[0].body as EtsyInventoryWrite).quantity_on_property).toEqual([513])
  })

  it('the same quantity_on_property in another order is not a stock change', async () => {
    const twoAxes = inventory(); twoAxes.quantity_on_property = [513, 514]
    h.inventory = twoAxes
    vi.stubEnv('NEXUS_ENABLE_ETSY_ORDER_INGEST', '')
    const reordered: Build = (current) => ({ ...current, quantity_on_property: [514, 513],
      products: current.products.map((p) => ({ ...p, offerings: p.offerings.map((o) => ({ ...o, readiness_state_id: 80000002 })) })) })
    await expect(replace(reordered, { priceCurrency: undefined })).resolves.toMatchObject({ sent: true })
    expect(h.ingest).not.toHaveBeenCalled()
  })

  it('a new variation priced in another currency than Etsy states: EtsyPriceRefusal, nothing sent', async () => {
    const refused = await replace(withAdded(), { priceCurrency: 'GBP' }).catch((error: unknown) => error)
    expect(refused).toMatchObject({ name: 'EtsyPriceRefusal' })
    expect((refused as Error).message).toBe('Etsy prices this listing in EUR, and Nexus holds this price in GBP. A price is never converted, so nothing was sent.')
    await expect(replace(withAdded(), { priceCurrency: undefined })).rejects.toThrow('A price for Etsy must say which currency it is in; nothing was sent.')
    expect(h.puts).toEqual([])
  })

  it('a held price that moved is checked against the currency too', async () => {
    const repriced: Build = (current) => ({ ...current, products: current.products.map((p, i) => i ? p : { ...p, offerings: [{ ...p.offerings[0], price: 25 }] }) })
    await expect(replace(repriced, { priceCurrency: 'USD' })).rejects.toMatchObject({ name: 'EtsyPriceRefusal' })
    expect(h.puts).toEqual([])
  })
})

describe('E2 replace — the read-back, and 🔴 never a throw after the PUT', () => {
  it('a field Etsy holds differently is drift: reported, unconfirmed, and a danger alert', async () => {
    const build = withAdded()
    const after = heldAs(build(toInventoryWrite(inventory())))
    after.products[1].offerings[0].price = money(0)     // a price Nexus kept came back blank (inventory.ts trap 3)
    const result = await replace(build, { readBack: after })
    expect(result.sent).toBe(true)
    expect(result.confirmed).toBe(false)
    expect(result.drift).toEqual([{ product: 'FAKE-SKU-2', offering: 1, field: 'price', sent: 24.5, found: 0 }])
    expect(h.alerts).toHaveLength(1)
    expect(h.alerts[0]).toMatchObject({ kind: 'channel-write-drift', severity: 'danger', entityId: `Etsy:${LISTING}:price` })
  })

  it('a read-back that cannot be read is drift NULL (never []), and no throw', async () => {
    h.getThrows = new Error('Etsy could not read this resource (HTTP 503).')
    const result = await replace(withAdded())
    expect(h.puts).toHaveLength(1)
    expect(result).toMatchObject({ sent: true, drift: null, confirmed: false })
    expect(h.alerts).toEqual([])
  })

  it('a read-back Etsy answers with no usable inventory is drift NULL too', async () => {
    const result = await replace(withAdded(), { readBack: { products: [] } })
    expect(result).toMatchObject({ sent: true, drift: null, confirmed: false })
  })

  it('an alert that fails after the PUT does not throw: the drift is still returned', async () => {
    h.alertThrows = new Error('alerts table unavailable')
    const build = withAdded()
    const after = heldAs(build(toInventoryWrite(inventory())))
    after.products[0].offerings[0].quantity = 1
    const result = await replace(build, { readBack: after })
    expect(result).toMatchObject({ sent: true, confirmed: false, drift: [{ product: 'FAKE-SKU-1', field: 'quantity', sent: 4, found: 1 }] })
  })
})
