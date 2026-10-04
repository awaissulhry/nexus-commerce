/**
 * MX.1 — the shared verb-preview engine is DETERMINISTIC and asks the financial permission.
 *
 * The page (preview mode) and the API (`commit:false`) run this one function; the parity that matters is
 * "same read + same request → byte-identical VerbPreview", which is what the first case pins. The second pins
 * the permission KEY the price verbs ask for: `products.price.edit` (Add 4(d)) — a page whose `can` answers
 * for `products.edit` alone would preview a change the server then refuses, and that gap is what this holds shut.
 */
import { describe, expect, it } from 'vitest'
import { MATRIX_COPY, MATRIX_VERB_LABELS, type MatrixRead } from './matrix-contract.js'
import { STILL_HELD, followQty, inventoryCoordinate, previewVerb, syncLabel } from './matrix-preview.js'

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
    expect(syncLabel({ kind: 'PAUSED', via: 'POLICY', mode: 'PINNED', intended: null, held: 2, buffer: 0, poolAvailable: 9, routedLocations: [], fbaAtAmazon: null, oversold: false })).toBe('Sync held (policy) · Pinned')
  })
})

/**
 * Build shape v2 (P12) — the Matrix speaks stock-sync words, never selling words: "Pause sync" is "Hold stock sync", a held
 * listing says "release" (never "resume"), and a listing whose SELLING is paused (the wire's CLOSED) reads "Inactive" and
 * points at the sheet's Status column — the Matrix has no selling verbs (the Owner's decision).
 */
describe('matrix-preview — hold / release stock sync words (build shape v2)', () => {
  const ctx = { can: () => true, simulated: false }
  const held = (via: 'POLICY' | 'LISTING'): MatrixRead => {
    const r = read()
    r.rows[1].cells['AMAZON:EU'].sync = { kind: 'PAUSED', via, mode: 'FOLLOW', intended: null, held: 4, buffer: 0, poolAvailable: 10, routedLocations: ['IT-MAIN'], fbaAtAmazon: null, oversold: false }
    return r
  }
  const run = (r: MatrixRead, verb: 'pause-sync' | 'resume-sync' | 'push-now' | 'pin-quantity') =>
    previewVerb(r, { params: verb === 'pin-quantity' ? { verb, value: 3 } : { verb }, targets: [{ rowId: 'c1', coordinateKey: 'AMAZON:IT' }], commit: false }, ctx)

  it('names the verbs Hold stock sync / Release stock sync', () => {
    expect(MATRIX_VERB_LABELS['pause-sync']).toBe('Hold stock sync')
    expect(MATRIX_VERB_LABELS['resume-sync']).toBe('Release stock sync')
  })
  it('a hold says "Sync held", a release says what it pushes, a push on a held listing is refused with "release"', () => {
    const hold = run(read(), 'pause-sync')
    expect(hold.changes[0]).toMatchObject({ toLabel: 'Sync held (listing) · Follow', note: 'The channel keeps 10 until the stock sync is released' })
    const release = run(held('LISTING'), 'resume-sync')
    expect(release.changes[0]).toMatchObject({ fromLabel: 'Sync held (listing) · Follow', toLabel: 'Follow 10' })
    expect(run(held('LISTING'), 'push-now').refusals[0]?.reason).toBe(STILL_HELD)
    expect(run(held('LISTING'), 'pin-quantity').changes[0]?.note).toBe(STILL_HELD)
    expect(run(held('POLICY'), 'resume-sync').refusals[0]?.reason).toMatch(/^Held by the channel policy — releasing here changes nothing/)
    for (const p of [hold, release]) for (const text of [...p.changes.flatMap(c => [c.fromLabel, c.toLabel, c.note ?? '']), ...p.refusals.map(x => x.reason)]) {
      expect(text).not.toMatch(/\b(pause|paused|resume|resumed)\b/i)
    }
  })
  it('a listing whose selling is paused (CLOSED) reads Inactive and points at the sheet\'s Status column', () => {
    const r = read()
    r.rows[1].cells['AMAZON:EU'].sync = { kind: 'CLOSED', via: null, mode: 'FOLLOW', intended: null, held: 0, buffer: 0, poolAvailable: 10, routedLocations: ['IT-MAIN'], fbaAtAmazon: null, oversold: false }
    expect(syncLabel(r.rows[1].cells['AMAZON:EU'].sync)).toBe('Inactive')
    const refused = run(r, 'pin-quantity').refusals[0]
    expect(refused?.reason).toBe(MATRIX_COPY.closedHint)
    expect(MATRIX_COPY.closedHint).toBe("Selling is paused here — set Active in the sheet's Status column and Publish")
    expect(MATRIX_COPY.pausedBy('LISTING', 7)).toBe('Stock sync held by this listing — would push 7 · Release to push')
    expect(MATRIX_COPY.pausedBy('POLICY', null)).toBe('Stock sync held by the channel policy — would push — · Release to push')
  })
})

/**
 * MCP full control L8 — eBay ENDS a listing pinned at 0 unless the account's out-of-stock option is ON. The preview asks
 * the context (the server reads the option from eBay; a page without it previews as before and the server's re-check at
 * commit refuses): ON allows the pin, OFF or unknown refuses it by name. A pin above 0, and every other channel, are
 * untouched by the guard.
 */
describe('matrix-preview — eBay pin to 0', () => {
  const ctx = { can: () => true, simulated: false }
  const ebay = (): MatrixRead => {
    const r = read()
    r.coordinates.push({ key: 'EBAY:IT', kind: 'market', channel: 'EBAY', market: 'IT', label: 'eBay · IT', region: null, alias: null, accountId: 'e1', currency: 'EUR', connected: true, listed: 1, draft: 0,
      cells: ['listing', 'syncMode', 'syncQty', 'syncBuffer', 'syncState', 'price'], absent: [], sharedInventoryWith: null, inventoryOn: null, vocabulary: { fulfilment: null } })
    r.rows[1].cells['EBAY:IT'] = { listingId: 'l-eb', version: 2, listing: null, fulfilment: null,
      sync: { kind: 'FOLLOW', via: null, mode: 'FOLLOW', intended: 10, held: 10, buffer: 0, poolAvailable: 10, routedLocations: ['IT-MAIN'], fbaAtAmazon: null, oversold: false },
      queue: null, price: null, sale: null, writable: { syncMode: true, syncQty: true }, writeBlockedReason: {} }
    return r
  }
  const pin = (value: number, key = 'EBAY:IT') => ({ params: { verb: 'pin-quantity' as const, value }, targets: [{ rowId: 'c1', coordinateKey: key }], commit: false })
  const withOption = (state: boolean | null) => ({ ...ctx, ebayZeroAllowed: () => state })

  it('refuses a pin to 0 when the option is OFF or unknown, by name', () => {
    for (const state of [false, null]) {
      const p = previewVerb(ebay(), pin(0), withOption(state))
      expect(p.changes).toEqual([])
      expect(p.refusals).toEqual([expect.objectContaining({ rowId: 'c1', coordinateKey: 'EBAY:IT', kind: 'guard', reason: expect.stringContaining('out-of-stock option') })])
    }
  })

  it('allows it when the option is ON; a pin above 0 and other channels are not asked', () => {
    expect(previewVerb(ebay(), pin(0), withOption(true)).changes).toHaveLength(1)
    let asked = 0
    const counting = { ...ctx, ebayZeroAllowed: () => { asked++; return false } }
    expect(previewVerb(ebay(), pin(3), counting).changes).toHaveLength(1)
    expect(previewVerb(ebay(), pin(0, 'AMAZON:IT'), counting).changes).toHaveLength(1)
    expect(asked).toBe(0)
  })
})
