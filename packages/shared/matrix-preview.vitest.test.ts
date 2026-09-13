/**
 * MX.1 — the shared verb-preview engine is DETERMINISTIC and asks the financial permission.
 *
 * The page (preview mode) and the API (`commit:false`) run this one function; the parity that matters is
 * "same read + same request → byte-identical VerbPreview", which is what the first case pins. The second pins
 * the permission KEY the price verbs ask for: `products.price.edit` (Add 4(d)) — a page whose `can` answers
 * for `products.edit` alone would preview a change the server then refuses, and that gap is what this holds shut.
 */
import { describe, expect, it } from 'vitest'
import { MATRIX_COPY, type MatrixRead } from './matrix-contract.js'
import { followQty, inventoryCoordinate, previewVerb, syncLabel } from './matrix-preview.js'

const read = (): MatrixRead => ({
  version: 1, productId: 'p', source: 'live', generatedAt: '2026-09-13T00:00:00.000Z', policies: [],
  coordinates: [
    { key: 'AMAZON:EU', kind: 'region-inventory', channel: 'AMAZON', market: 'EU', label: 'Amazon EU · Inventory · IT DE', region: 'EU', alias: null, accountId: 'a', currency: 'EUR', connected: true, listed: 1, draft: 0, cells: ['fulfilment', 'syncMode', 'syncQty', 'syncBuffer', 'syncState'], absent: [], sharedInventoryWith: ['IT', 'DE'], inventoryOn: null, vocabulary: { fulfilment: ['FBA', 'FBM'] } },
    { key: 'AMAZON:IT', kind: 'market', channel: 'AMAZON', market: 'IT', label: 'Amazon · IT', region: 'EU', alias: null, accountId: 'a', currency: 'EUR', connected: true, listed: 1, draft: 0, cells: ['listing', 'price', 'salePrice'], absent: [], sharedInventoryWith: null, inventoryOn: 'AMAZON:EU', vocabulary: { fulfilment: ['FBA', 'FBM'] } },
  ],
  rows: [
    { id: 'p', sku: 'PARENT', role: 'parent', stock: { available: 10, uncounted: false, locations: [] }, basePrice: 100, status: 'ACTIVE', cells: {} },
    { id: 'c1', sku: 'CHILD-1', role: 'variant', stock: { available: 10, uncounted: false, locations: [{ code: 'IT-MAIN', available: 10 }] }, basePrice: 100, status: 'ACTIVE', cells: {
      'AMAZON:EU': { listingId: 'l-it', version: 3, listing: null, fulfilment: { method: 'FBM', source: 'set', guard: 'FBM', reported: null },
        sync: { kind: 'FOLLOW', via: null, mode: 'FOLLOW', intended: 10, held: 10, buffer: 0, poolAvailable: 10, routedLocations: ['IT-MAIN'], fbaAtAmazon: null, oversold: false },
        queue: { state: 'sent', at: null, reason: null, syncType: 'QUANTITY_UPDATE', via: null }, price: null, sale: null,
        writable: { fulfilment: true, syncMode: true, syncQty: true, syncBuffer: true }, writeBlockedReason: {} },
      'AMAZON:IT': { listingId: 'l-it', version: 3, listing: { state: 'listed', externalId: 'B0X', detail: null, published: true }, fulfilment: null, sync: null, queue: null,
        price: { value: 100, currency: 'EUR', source: 'master', formula: null, clamped: null }, sale: { value: null, start: null, end: null },
        writable: { price: true, salePrice: true }, writeBlockedReason: {} },
    } },
  ],
})

describe('matrix-preview — one function, one answer', () => {
  it('is deterministic: the same read and request give a byte-identical preview', () => {
    const req = { params: { verb: 'adjust-prices' as const, percent: -5 }, targets: [{ rowId: 'c1', coordinateKey: 'AMAZON:IT' }], commit: false }
    const ctx = { can: () => true, simulated: false }
    expect(JSON.stringify(previewVerb(read(), req, ctx))).toBe(JSON.stringify(previewVerb(read(), req, ctx)))
    const p = previewVerb(read(), req, ctx)
    expect(p.changes[0]).toMatchObject({ cell: 'price', to: 95, toLabel: '€95.00', note: 'Set here (was: follows the base price)' })
    expect(p.simulated).toBe(false); expect(p.notices).not.toContain(MATRIX_COPY.simulated)
  })
  it('asks products.price.edit for the price verbs, and nothing else for the inventory verbs', () => {
    const asked: string[] = []
    const ctx = { can: (perm: string) => { asked.push(perm); return false }, simulated: false }
    const price = previewVerb(read(), { params: { verb: 'set-price', value: 80 }, targets: [{ rowId: 'c1', coordinateKey: 'AMAZON:IT' }], commit: false }, ctx)
    expect(price.refusals[0]).toMatchObject({ kind: 'permission', reason: expect.stringContaining('products.price.edit') })
    expect(asked).toEqual(['products.price.edit'])
    const pin = previewVerb(read(), { params: { verb: 'pin-quantity', value: 4 }, targets: [{ rowId: 'c1', coordinateKey: 'AMAZON:IT' }], commit: false }, ctx)
    expect(pin.changes[0]).toMatchObject({ coordinateKey: 'AMAZON:EU', cell: 'syncQty', to: 4, fromLabel: 'Follow 10', toLabel: 'Pinned 4' })
    expect(pin.notices).toContain('Amazon EU: this covers IT DE'); expect(asked).toEqual(['products.price.edit'])
  })
  it('routes an EU market target to its region group and labels the resolver number', () => {
    expect(inventoryCoordinate(read(), 'AMAZON:IT')).toBe('AMAZON:EU')
    expect(followQty({ poolAvailable: 10, buffer: 3 })).toBe(7); expect(followQty({ poolAvailable: null, buffer: 3 })).toBeNull()
    expect(syncLabel({ kind: 'PAUSED', via: 'POLICY', mode: 'PINNED', intended: null, held: 2, buffer: 0, poolAvailable: 9, routedLocations: [], fbaAtAmazon: null, oversold: false })).toBe('Paused (policy) · Pinned')
  })
})
