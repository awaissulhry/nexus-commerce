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
}))

vi.mock('./read-client.js', () => ({
  etsyReader: vi.fn(async () => ({
    shopId: '42',
    get: vi.fn(async (path: string) => {
      h.gets.push(path)
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

const money = (amount: number) => ({ amount, divisor: 100, currency_code: 'EUR' })
const inventory = () => ({
  products: [
    { product_id: 1, sku: 'RED-S', is_deleted: false, offerings: [{ offering_id: 9, quantity: 4, is_enabled: true, is_deleted: false, price: money(1999) }] },
    { product_id: 2, sku: 'BLU-S', is_deleted: false, offerings: [{ offering_id: 10, quantity: 2, is_enabled: true, is_deleted: false, price: money(2450) }] },
  ],
  price_on_property: [200], quantity_on_property: [200], sku_on_property: [], readiness_state_on_property: [],
})

beforeEach(() => {
  h.gets = []; h.puts = []; h.alerts = []; h.getThrows = null
  h.inventory = inventory(); h.readBack = null
})
afterEach(() => { vi.clearAllMocks() })

const write = (changes: Array<Record<string, unknown>>, readBack?: unknown) => {
  if (readBack !== undefined) h.readBack = readBack
  return writeEtsyInventory({ accountId: 'etsy-1', listingId: 7, changes: changes as never, readBackDelayMs: 0 })
}

describe('P4.6c — the happy path', () => {
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
