/**
 * Amazon fulfilment conversion (2026-10-07) — the FBA hard block (`guardFbaQtyFlip`) and its ONE exception.
 *
 * A merchant `[{ DEFAULT, quantity }]` for an FBA SKU is exactly what converts its Amazon offer to FBM, so the block strips
 * it — unless the call carries a `conversionId` whose row is an operator-confirmed FBA → FBM conversion of THIS seller
 * SKU and marketplace with THIS quantity, SENDING, under 10 minutes old, while Nexus mirrors no FBA units NOW. Every pass
 * and every strip case is here, against the guard's own reads (the database faked), plus the pure verdict.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  product: { findUnique: vi.fn() },
  stockLevel: { aggregate: vi.fn(), findMany: vi.fn() },
  fbaInventoryDetail: { findMany: vi.fn() },
  fulfilmentConversion: { findUnique: vi.fn() },
}))
vi.mock('../db.js', () => ({ default: db }))
vi.mock('../utils/logger.js', () => ({ logger: { info() {}, warn() {}, error() {}, debug() {} } }))

import { AmazonSpApiClient } from './amazon-sp-api.client.js'
import { CONVERSION_SEND_WINDOW_MS, conversionGuardVerdict, type ConversionGuardRecord } from '../services/pim/fulfilment-conversion-guard.js'

const IT = 'APJ6JRA9NG5V4'
const fbmPatch = (quantity: number, extra: Array<Record<string, unknown>> = []) => ({
  productType: 'OUTERWEAR',
  patches: [{ op: 'replace', path: '/attributes/fulfillment_availability', value: [{ fulfillment_channel_code: 'DEFAULT', quantity }] }, ...extra],
})
const record = (over: Partial<ConversionGuardRecord & { productId: string }> = {}) => ({
  status: 'SENDING', toMethod: 'FBM', sku: 'SKU-1', marketplaceId: IT, quantity: 6, operatorConfirmed: true, createdAt: new Date(), productId: 'p1', ...over,
})
const guard = (payload: unknown, conversion?: { conversionId?: string; marketplaceId: string }) =>
  (new AmazonSpApiClient() as unknown as { guardFbaQtyFlip: (sku: string, payload: unknown, c?: unknown) => Promise<{ payload: any; blocked: boolean }> })
    .guardFbaQtyFlip('SKU-1', payload, conversion)

beforeEach(() => {
  // An FBA SKU by its product mark; no FBA units mirrored (on hand, reserved, inbound).
  db.product.findUnique.mockReset().mockResolvedValue({ id: 'p1', fulfillmentMethod: 'FBA' })
  db.stockLevel.aggregate.mockReset().mockResolvedValue({ _sum: { quantity: 0 } })
  db.stockLevel.findMany.mockReset().mockResolvedValue([])
  db.fbaInventoryDetail.findMany.mockReset().mockResolvedValue([])
  db.fulfilmentConversion.findUnique.mockReset().mockResolvedValue(record())
})

describe('guardFbaQtyFlip — the conversion exception', () => {
  it('PASSES: an operator-confirmed FBM conversion of this SKU, market and quantity, SENDING, fresh, no FBA units', async () => {
    const payload = fbmPatch(6)
    const r = await guard(payload, { conversionId: 'conv-1', marketplaceId: IT })
    expect(r).toEqual({ payload, blocked: false })
    expect(db.fulfilmentConversion.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'conv-1' } }))
  })

  it.each([
    ['no conversionId (every automatic path)', undefined, {}, []],
    ['no conversion row with this id', 'conv-1', { missing: true }, []],
    ['the conversion is SENT (not SENDING)', 'conv-1', { status: 'SENT' }, []],
    ['the conversion is to FBA', 'conv-1', { toMethod: 'FBA' }, []],
    ['not confirmed by a person', 'conv-1', { operatorConfirmed: false }, []],
    ['another SKU', 'conv-1', { sku: 'SKU-2' }, []],
    ['another marketplace', 'conv-1', { marketplaceId: 'A1PA6795UKMFR9' }, []],
    ['another quantity', 'conv-1', { quantity: 5 }, []],
    ['older than 10 minutes', 'conv-1', { createdAt: new Date(Date.now() - CONVERSION_SEND_WINDOW_MS - 1000) }, []],
    ['FBA units on hand now', 'conv-1', {}, [{ productId: 'p1', quantity: 2 }]],
  ] as const)('STRIPS: %s', async (_name, conversionId, over, levels) => {
    if ('missing' in over) db.fulfilmentConversion.findUnique.mockResolvedValue(null)
    else db.fulfilmentConversion.findUnique.mockResolvedValue(record(over as never))
    db.stockLevel.findMany.mockResolvedValue([...levels])
    const r = await guard(fbmPatch(6), conversionId ? { conversionId, marketplaceId: IT } : { marketplaceId: IT })
    expect(r.blocked).toBe(true)
    expect(r.payload.patches).toEqual([])
  })

  it('STRIPS: FBA units reserved or inbound at Amazon now', async () => {
    db.fbaInventoryDetail.findMany.mockResolvedValue([{ productId: 'p1', sku: 'SKU-1', condition: 'INBOUND', quantity: 3 }])
    expect((await guard(fbmPatch(6), { conversionId: 'conv-1', marketplaceId: IT })).blocked).toBe(true)
    db.fbaInventoryDetail.findMany.mockResolvedValue([{ productId: null, sku: 'SKU-1', condition: 'RESERVED', quantity: 1 }])
    expect((await guard(fbmPatch(6), { conversionId: 'conv-1', marketplaceId: IT })).blocked).toBe(true)
  })

  it('STRIPS: the conversion lookup fails (fail closed)', async () => {
    db.fulfilmentConversion.findUnique.mockRejectedValue(new Error('connection reset'))
    const r = await guard(fbmPatch(6), { conversionId: 'conv-1', marketplaceId: IT })
    expect(r.blocked).toBe(true)
  })

  it('STRIPS: two merchant entries with different quantities; keeps every other patch', async () => {
    const other = { op: 'replace', path: '/attributes/item_name', value: [{ value: 'x' }] }
    const payload = { patches: [{ op: 'replace', path: '/attributes/fulfillment_availability', value: [{ fulfillment_channel_code: 'DEFAULT', quantity: 6 }, { fulfillment_channel_code: 'DEFAULT', quantity: 9 }] }, other] }
    const r = await guard(payload, { conversionId: 'conv-1', marketplaceId: IT })
    expect(r).toEqual({ payload: { patches: [other] }, blocked: true })
  })

  it('unchanged for the cases it never touched: a genuine FBM SKU passes, an FBA patch with no quantity passes, an FBA product lookup failure strips', async () => {
    db.product.findUnique.mockResolvedValue({ id: 'p1', fulfillmentMethod: 'FBM' })
    expect(await guard(fbmPatch(6))).toMatchObject({ blocked: false })
    db.product.findUnique.mockResolvedValue({ id: 'p1', fulfillmentMethod: 'FBA' })
    const fba = { patches: [{ op: 'replace', path: '/attributes/fulfillment_availability', value: [{ fulfillment_channel_code: 'AMAZON_EU' }] }] }
    expect(await guard(fba)).toEqual({ payload: fba, blocked: false })
    db.product.findUnique.mockRejectedValue(new Error('db down'))
    db.fulfilmentConversion.findUnique.mockRejectedValue(new Error('db down'))
    expect((await guard(fbmPatch(6), { conversionId: 'conv-1', marketplaceId: IT })).blocked).toBe(true)
  })
})

describe('conversionGuardVerdict (pure)', () => {
  const now = new Date('2026-10-07T12:00:00Z')
  const rec = (over: Partial<ConversionGuardRecord> = {}): ConversionGuardRecord => ({ status: 'SENDING', toMethod: 'FBM', sku: 'S', marketplaceId: IT, quantity: 4, operatorConfirmed: true, createdAt: new Date(now.getTime() - 60_000), ...over })
  const ask = { sku: 'S', marketplaceId: IT, quantities: [4], fbaUnits: 0, now }
  it('passes the one case and names why every other case does not', () => {
    expect(conversionGuardVerdict(rec(), ask).pass).toBe(true)
    expect(conversionGuardVerdict(null, ask).reason).toBe('no conversion row with this id')
    expect(conversionGuardVerdict(rec({ quantity: null }), ask).pass).toBe(false)
    expect(conversionGuardVerdict(rec(), { ...ask, quantities: [] }).pass).toBe(false)
    expect(conversionGuardVerdict(rec({ createdAt: new Date(now.getTime() + 60_000) }), ask).pass).toBe(false)
    expect(conversionGuardVerdict(rec(), { ...ask, fbaUnits: 1 }).reason).toBe('1 FBA units are mirrored for the product now')
  })
})
