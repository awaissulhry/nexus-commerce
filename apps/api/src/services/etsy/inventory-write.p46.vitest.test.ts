/**
 * P4.6c — the Etsy stock/price write, end to end: read → transform → change → PUT → read back.
 *
 * The two cases that carry the slice are `does NOT send when nothing would change` and
 * `a price that came back blank raises the alert`. Both are about trap 3 — Etsy's inventory PUT
 * can destroy a price it was never asked about — and neither can be seen in the write's answer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  gets: [] as string[],
  puts: [] as Array<{ path: string; body: unknown }>,
  inventory: null as unknown,
  readBack: null as unknown,
  alerts: [] as Array<Record<string, unknown>>,
  getThrows: null as Error | null,
  afterRead: null as (() => void | Promise<void>) | null,
}))

vi.mock('./read-client.js', () => ({
  etsyReader: vi.fn(async () => ({
    shopId: '42',
    get: vi.fn(async (path: string) => {
      h.gets.push(path)
      if (h.gets.length === 1) await h.afterRead?.()
      if (h.getThrows && h.gets.length > 1) throw h.getThrows
      return h.gets.length === 1 ? h.inventory : (h.readBack ?? h.inventory)
    }),
  })),
}))
vi.mock('./write-client.js', () => ({
  etsyWriter: vi.fn(async () => ({
    shopId: '42',
    send: vi.fn(async (input: { path: string; body: unknown }) => { h.puts.push({ path: input.path, body: input.body }); return {} }),
  })),
}))
vi.mock('../cx/channel-alerts.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../cx/channel-alerts.service.js')>()),
  raiseChannelAlert: vi.fn(async (alert: Record<string, unknown>) => { h.alerts.push(alert); return { created: 1, deduped: 0, recipients: 1 } }),
}))
vi.mock('../../utils/logger.js', () => ({ logger: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } }))


import { writeEtsyInventory } from './inventory-write.service.js'
import { etsyListingLockKey, registerEtsyListingLockRedis } from './listing-lock.js'
import { FakeLeaseRedis } from '../../test-support/fake-lease-redis.js'

// The per-listing lock (listing-lock.ts) takes its lease from the app's Redis; an in-memory stand-in here.
let leaseRedis = new FakeLeaseRedis()
registerEtsyListingLockRedis(() => leaseRedis)

const money = (amount: number) => ({ amount, divisor: 100, currency_code: 'EUR' })
const inventory = () => ({
  products: [
    { product_id: 1, sku: 'RED-S', is_deleted: false, offerings: [{ offering_id: 9, quantity: 4, is_enabled: true, is_deleted: false, price: money(1999) }] },
    { product_id: 2, sku: 'BLU-S', is_deleted: false, offerings: [{ offering_id: 10, quantity: 2, is_enabled: true, is_deleted: false, price: money(2450) }] },
  ],
  price_on_property: [200], quantity_on_property: [200], sku_on_property: [], readiness_state_on_property: [],
})

beforeEach(() => {
  leaseRedis = new FakeLeaseRedis(); h.afterRead = null
  h.gets = []; h.puts = []; h.alerts = []; h.getThrows = null
  h.inventory = inventory(); h.readBack = null
  // A stock number needs Etsy order import on (2026-10-01); the arms below are about the write itself.
  vi.stubEnv('NEXUS_ENABLE_ETSY_ORDER_INGEST', '1')
})
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs() })

const write = (changes: Array<Record<string, unknown>>, readBack?: unknown) => {
  if (readBack !== undefined) h.readBack = readBack
  return writeEtsyInventory({ accountId: 'etsy-1', listingId: 7, changes: changes as never, readBackDelayMs: 0, priceCurrency: 'EUR' })
}

describe('P4.6c — the happy path', () => {
  it('does not send stale inventory when its lease was lost during the read', async () => {
    h.afterRead = () => leaseRedis.hold(etsyListingLockKey('etsy-1', 7), 'another-holder', 30_000)
    await expect(write([{ sku: 'RED-S', quantity: 12 }])).rejects.toMatchObject({ code: 'ETSY_LISTING_BUSY' })
    expect(h.puts).toEqual([])
  })
  it('reads, sends the WHOLE inventory with one quantity changed, and reads back', async () => {
    const after = inventory(); after.products[0].offerings[0].quantity = 12
    const result = await write([{ sku: 'RED-S', quantity: 12 }], after)
    expect(h.gets).toEqual(['/listings/7/inventory', '/listings/7/inventory'])
    expect(h.puts).toHaveLength(1)
    expect(h.puts[0].path).toBe('/listings/7/inventory')
    expect(h.puts[0].body).toEqual({
      products: [
        { sku: 'RED-S', offerings: [{ price: 19.99, quantity: 12, is_enabled: true }] },
        // 🔴 Untouched, and carrying ETSY'S OWN price — never a price this code invented.
        { sku: 'BLU-S', offerings: [{ price: 24.5, quantity: 2, is_enabled: true }] },
      ],
      price_on_property: [200], quantity_on_property: [200], sku_on_property: [], readiness_state_on_property: [],
    })
    expect(result).toMatchObject({ sent: true, confirmed: true, drift: [] })
    expect(h.alerts).toEqual([])
  })
})

describe('P4.6c — 🔴 a write that would change nothing is not sent', () => {
  it('the quantity Etsy already holds costs no PUT at all', async () => {
    const result = await write([{ sku: 'RED-S', quantity: 4 }])
    expect(h.puts).toEqual([])
    expect(h.gets).toEqual(['/listings/7/inventory'])   // no read-back either: nothing happened
    expect(result).toMatchObject({ sent: false, confirmed: true, drift: [] })
    expect(result.reason).toBe('Etsy already holds these values; nothing was sent.')
  })
  it('POSITIVE CONTROL: one different unit and the PUT IS sent', async () => {
    const after = inventory(); after.products[0].offerings[0].quantity = 5
    await write([{ sku: 'RED-S', quantity: 5 }], after)
    expect(h.puts).toHaveLength(1)
  })
  it('a price that is already right is not sent either', async () => {
    const result = await write([{ sku: 'BLU-S', price: 24.5 }])
    expect(h.puts).toEqual([])
    expect(result.sent).toBe(false)
  })
})

describe('P4.6c — 🔴 trap 3: the read-back is the only thing that can see it', () => {
  it('a price we never touched came back BLANK: drift, and a danger alert', async () => {
    const after = inventory()
    after.products[0].offerings[0].quantity = 12
    after.products[1].offerings[0].price = money(0)     // regional pricing switched off by the PUT
    const result = await write([{ sku: 'RED-S', quantity: 12 }], after)
    expect(result.sent).toBe(true)
    expect(result.confirmed).toBe(false)
    expect(result.drift).toEqual([{ product: 'BLU-S', offering: 1, field: 'price', sent: 24.5, found: 0 }])
    expect(h.alerts).toHaveLength(1)
    expect(h.alerts[0]).toMatchObject({ kind: 'channel-write-drift', severity: 'danger', entityType: 'ChannelListing', entityId: 'Etsy:7:price' })
    expect(String(h.alerts[0].body)).toContain('BLU-S offering 1: price was sent as 24.5 and Etsy now holds 0')
  })

  it('the PUT answering 200 is NOT the proof — the same call with a clean read-back raises nothing', async () => {
    const after = inventory(); after.products[0].offerings[0].quantity = 12
    const result = await write([{ sku: 'RED-S', quantity: 12 }], after)
    expect(result.confirmed).toBe(true)
    expect(h.alerts).toEqual([])
  })

  it('🔴 a read-back that cannot be read is confirmed:false with drift NULL, never an empty list', async () => {
    h.getThrows = new Error('Etsy could not read this resource (HTTP 503).')
    const result = await write([{ sku: 'RED-S', quantity: 12 }])
    expect(result.sent).toBe(true)
    expect(result.confirmed).toBe(false)
    expect(result.drift).toBeNull()               // not []
    expect(result.reason).toContain('HTTP 503')
    expect(h.alerts).toEqual([])                  // we cannot claim drift we did not see
  })
})

describe('P4.6c — the inputs are proven', () => {
  it.each(['0', 'abc', '', '-1', '1.5'])('a listing id of %p never reaches a URL', async (id) => {
    await expect(writeEtsyInventory({ accountId: 'etsy-1', listingId: id, changes: [{ quantity: 1 }], readBackDelayMs: 0 }))
      .rejects.toThrow('That is not an Etsy listing id; nothing was sent.')
    expect(h.gets).toEqual([])
  })
  it('a SKU Etsy does not have stops before the PUT', async () => {
    await expect(write([{ sku: 'GREEN-XL', quantity: 1 }])).rejects.toThrow('Etsy has no product with SKU "GREEN-XL"')
    expect(h.puts).toEqual([])
  })
})

/** 2026-10-01 (Owner) — what the writer itself holds back, so no caller of it can skip the rule. */
describe('stock numbers: order import, and Etsy\'s ceiling', () => {
  it.each([[''], ['0'], ['true']])('🔴 with order import %p (not 1) a stock number is refused before the lock, a read or a send', async (flag) => {
    vi.stubEnv('NEXUS_ENABLE_ETSY_ORDER_INGEST', flag)
    const refused = await write([{ sku: 'RED-S', quantity: 12 }]).catch((error: unknown) => error)
    expect(refused).toMatchObject({ name: 'EtsyQuantityRefusal', code: 'ETSY_QUANTITY_REFUSED' })
    expect((refused as Error).message).toBe("Etsy order import is off (NEXUS_ENABLE_ETSY_ORDER_INGEST is not 1), so Etsy's own sales do not reach Nexus stock. A stock number sent now could put back units Etsy has already sold, so nothing was sent to Etsy. Turn on Etsy order import first.")
    expect(h.gets).toEqual([])
    expect(h.puts).toEqual([])
    expect(leaseRedis.log).toEqual([])
  })

  it('a PRICE is not a stock number: it is written with order import off', async () => {
    vi.stubEnv('NEXUS_ENABLE_ETSY_ORDER_INGEST', '')
    // Priced by colour (property 200), so one colour may be priced alone.
    const byColour = () => {
      const inv = inventory()
      inv.products.forEach((p, i) => Object.assign(p, { property_values: [{ property_id: 200, property_name: 'Colour', scale_id: null, value_ids: [i + 1], values: [p.sku] }] }))
      return inv
    }
    h.inventory = byColour()
    const after = byColour(); after.products[1].offerings[0].price = money(2600)
    const result = await write([{ sku: 'BLU-S', price: 26 }], after)
    expect(result).toMatchObject({ sent: true, confirmed: true, clamped: [] })
    expect(h.puts).toHaveLength(1)
  })

  it('a number above 999 is sent as 999, the result says so, and the read-back of 999 confirms it', async () => {
    const after = inventory(); after.products[0].offerings[0].quantity = 999
    const result = await write([{ sku: 'RED-S', quantity: 1200 }], after)
    expect((h.puts[0].body as { products: Array<{ offerings: Array<{ quantity: number }> }> }).products.map((p) => p.offerings[0].quantity)).toEqual([999, 2])
    expect(result).toMatchObject({ sent: true, confirmed: true, drift: [], clamped: [{ sku: 'RED-S', requested: 1200, sent: 999 }] })
  })

  it('a clamped number Etsy already holds sends nothing, and still reports the clamp', async () => {
    h.inventory = inventory(); (h.inventory as ReturnType<typeof inventory>).products[0].offerings[0].quantity = 999
    const result = await write([{ sku: 'RED-S', quantity: 5000 }])
    expect(h.puts).toEqual([])
    expect(result).toMatchObject({ sent: false, clamped: [{ sku: 'RED-S', requested: 5000, sent: 999 }] })
  })
})
