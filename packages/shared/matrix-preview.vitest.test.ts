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
import {
  PREVIEW_WORDS, STILL_HELD, adjustPricesProblem, followFromCodes, followQty, inventoryCoordinate, previewVerb, queueStateWord, sellsFromCodes, sourceCodesProblem,
  syncBufferText, syncLabel,
} from './matrix-preview.js'

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
    expect(p.changes[0]).toMatchObject({ cell: 'price', to: 95, toLabel: '€95.00', note: 'Own price (was the base price)' })
    expect(p.simulated).toBe(false); expect(p.notices).not.toContain(MATRIX_COPY.simulated)
  })
  it('asks products.price.edit for the price verbs, and nothing else for the inventory verbs', () => {
    const asked: string[] = []
    const ctx = { can: (perm: string) => { asked.push(perm); return false }, simulated: false }
    const price = previewVerb(read(), { params: { verb: 'set-price', value: 80 }, targets: [{ rowId: 'c1', coordinateKey: 'AMAZON:IT' }], commit: false }, ctx)
    expect(price.refusals[0]).toMatchObject({ kind: 'permission', reason: expect.stringContaining('products.price.edit') })
    expect(asked).toEqual(['products.price.edit'])
    const pin = previewVerb(read(), { params: { verb: 'pin-quantity', value: 4 }, targets: [{ rowId: 'c1', coordinateKey: 'AMAZON:IT' }], commit: false }, ctx)
    expect(pin.changes[0]).toMatchObject({ coordinateKey: 'AMAZON:EU', cell: 'syncQty', to: 4, fromLabel: 'Follow · 10', toLabel: 'Pinned · 4' })
    expect(pin.notices).toContain('Amazon EU: this covers IT DE'); expect(asked).toEqual(['products.price.edit'])
  })
  it('routes an EU market target to its region group and labels the resolver number', () => {
    expect(inventoryCoordinate(read(), 'AMAZON:IT')).toBe('AMAZON:EU')
    expect(followQty({ poolAvailable: 10, buffer: 3 })).toBe(7); expect(followQty({ poolAvailable: null, buffer: 3 })).toBeNull()
    expect(syncLabel({ kind: 'PAUSED', via: 'POLICY', mode: 'PINNED', intended: null, held: 2, buffer: 0, poolAvailable: 9, routedLocations: [], fbaAtAmazon: null, oversold: false })).toBe('Pinned · ⏸ 2')
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
    /* The server folds a held sync into the Sync cell (`foldQueue`): the grid reads "Sync held · listing". */
    r.rows[1].cells['AMAZON:EU'].queue = { state: 'paused', at: null, reason: null, syncType: null, via }
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
    expect(hold.changes[0]).toMatchObject({ fromLabel: 'Sent', toLabel: 'Sync held · listing', note: 'The channel keeps 10 until the stock sync is released' })
    const release = run(held('LISTING'), 'resume-sync')
    expect(release.changes[0]).toMatchObject({ fromLabel: 'Sync held · listing', toLabel: 'Queued · 10' })
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

/**
 * Step 2 (Owner 2026-10-07) — "Sells from": one choice per market group (once for Amazon EU), sum only, list order = sale
 * order, a choice equal to the market default is stored as [].
 */
describe('matrix-preview — set-source (Sells from)', () => {
  const LOCATIONS = [
    { code: 'IT-MAIN', name: 'Italy main', active: true, isDefault: true },
    { code: 'MI-3PL', name: 'Milan 3PL', active: true },
    { code: 'OLD', name: 'Old store', active: false },
  ]
  const withSource = (over: Partial<NonNullable<MatrixRead['rows'][number]['cells'][string]['source']>> = {}): MatrixRead => {
    const r = read()
    r.locations = LOCATIONS
    r.rows[1].stock.locations = [{ code: 'IT-MAIN', available: 10 }, { code: 'MI-3PL', available: 4 }]
    r.rows[1].cells['AMAZON:EU'].source = {
      own: [], marketDefault: ['IT-MAIN'], defaultOrigin: 'routes', effective: [{ code: 'IT-MAIN', available: 10 }], writable: true, blockedReason: null, ...over,
    }
    return r
  }
  const ctx = { can: () => true, simulated: false }
  const run = (r: MatrixRead, codes: string[], c: { can: (p: string) => boolean; simulated: boolean } = ctx) =>
    previewVerb(r, { params: { verb: 'set-source', codes }, targets: [{ rowId: 'c1', coordinateKey: 'AMAZON:IT' }], commit: false }, c)

  it('the normaliser: a choice equal to the default (same order) is [], any other order is an exception', () => {
    expect(sellsFromCodes(['IT-MAIN'], ['IT-MAIN'])).toEqual([])
    expect(sellsFromCodes([], ['IT-MAIN'])).toEqual([])
    expect(sellsFromCodes([' MI-3PL ', 'IT-MAIN'], ['IT-MAIN', 'MI-3PL'])).toEqual(['MI-3PL', 'IT-MAIN'])
    expect(sellsFromCodes(['it-main', 'mi-3pl'], ['IT-MAIN', 'MI-3PL'])).toEqual([])
  })

  it('the code check: at most 20, never twice, only this business\'s active warehouses', () => {
    expect(sourceCodesProblem(['IT-MAIN', 'MI-3PL'], LOCATIONS)).toBeNull()
    expect(sourceCodesProblem(['IT-MAIN', 'it-main'], LOCATIONS)).toBe(MATRIX_COPY.sourceTwice('it-main'))
    expect(sourceCodesProblem(['NOPE'], LOCATIONS)).toBe(MATRIX_COPY.sourceUnknown('NOPE'))
    expect(sourceCodesProblem(['OLD'], LOCATIONS)).toBe(MATRIX_COPY.sourceInactive('OLD'))
    expect(sourceCodesProblem(Array.from({ length: 21 }, (_, i) => `L${i}`), undefined)).toBe(MATRIX_COPY.sourceTooMany)
    expect(sourceCodesProblem(['ANY'], undefined)).toBeNull()
  })

  it('an EU market target lands on the region group, with the EU notice, no typed word and the Follow number after it', () => {
    const p = run(withSource(), ['MI-3PL', 'IT-MAIN'])
    expect(p.changes).toEqual([{
      rowId: 'c1', sku: 'CHILD-1', coordinateKey: 'AMAZON:EU', cell: 'source', from: [], to: ['MI-3PL', 'IT-MAIN'],
      fromLabel: 'IT-MAIN', toLabel: 'MI-3PL + IT-MAIN', note: 'Follow shows 14',
    }])
    expect(p.notices).toContain('Amazon EU: this covers IT DE')
    /* 2026-10-08: none or a typed word — the Edit dialog's Apply confirms a small change. */
    expect(p.confirm).toBe('none')
    expect(followFromCodes(['MI-3PL'], [{ code: 'IT-MAIN', available: 10 }, { code: 'MI-3PL', available: 4 }], 1)).toBe(3)
    expect(followFromCodes(['X'], [{ code: 'IT-MAIN', available: 10 }], 0)).toBeNull()
  })

  it('back to the default stores [] and says so; the same list again is no change', () => {
    const own = withSource({ own: ['MI-3PL'], effective: [{ code: 'MI-3PL', available: 4 }] })
    expect(run(own, ['IT-MAIN']).changes[0]).toMatchObject({ from: ['MI-3PL'], to: [], fromLabel: 'MI-3PL', toLabel: 'IT-MAIN', note: 'The market default · Follow shows 10' })
    expect(run(own, []).changes[0]).toMatchObject({ to: [] })
    const same = run(own, ['MI-3PL'])
    expect(same.changes).toEqual([]); expect(same.refusals).toEqual([])
    expect(run(withSource(), ['IT-MAIN']).changes).toEqual([])
  })

  it('refuses by name: no inventory.adjust, no source cell, FBA, a held cell, an unknown or switched-off code', () => {
    const asked: string[] = []
    expect(run(withSource(), ['MI-3PL'], { can: (perm) => { asked.push(perm); return false }, simulated: false }).refusals[0]).toMatchObject({ kind: 'permission', reason: MATRIX_COPY.sourcePermission })
    expect(asked).toEqual(['inventory.adjust'])
    expect(run(read(), ['MI-3PL']).refusals[0]).toMatchObject({ kind: 'not-applicable', reason: MATRIX_COPY.sourceNone })
    const fba = withSource({ writable: false, blockedReason: MATRIX_COPY.sourceFba })
    fba.rows[1].cells['AMAZON:EU'].sync!.kind = 'FBA_EXCLUDED'
    expect(run(fba, ['MI-3PL']).refusals[0]).toMatchObject({ kind: 'amazon-managed', reason: MATRIX_COPY.sourceFba })
    expect(run(withSource({ writable: false, blockedReason: 'Shared stock' }), ['MI-3PL']).refusals[0]).toMatchObject({ kind: 'not-applicable', reason: 'Shared stock' })
    expect(run(withSource(), ['NOPE']).refusals[0]).toMatchObject({ reason: MATRIX_COPY.sourceUnknown('NOPE') })
    expect(run(withSource(), ['OLD']).refusals[0]).toMatchObject({ reason: MATRIX_COPY.sourceInactive('OLD') })
  })

  it('the parent is refused before anything else (it has no listing of its own)', () => {
    const r = withSource()
    r.rows[0].cells['AMAZON:EU'] = { ...r.rows[1].cells['AMAZON:EU'] }
    const p = previewVerb(r, { params: { verb: 'set-source', codes: ['MI-3PL'] }, targets: [{ rowId: 'p', coordinateKey: 'AMAZON:EU' }], commit: false }, ctx)
    expect(p.refusals[0]).toMatchObject({ rowId: 'p', kind: 'not-applicable' })
    expect(MATRIX_VERB_LABELS['set-source']).toBe('Set sells from…')
  })
})

/**
 * Matrix bulk Edit v2 (2026-10-12) — Raise / Lower by an amount, a price of 0 refused before Apply, and preview words that
 * say what the grid says (the dialog shows `fromLabel → toLabel`, the note and every refusal verbatim).
 */
describe('matrix-preview — adjust prices by an amount', () => {
  const ctx = { can: () => true, simulated: false }
  const priced = (value: number | null, source: 'master' | 'override' | 'formula' = 'override'): MatrixRead => {
    const r = read()
    r.rows[1].cells['AMAZON:IT'].price = { value, currency: 'EUR', source, formula: source === 'formula' ? '=BASE*1.1' : null, clamped: null }
    return r
  }
  const by = (r: MatrixRead, amount: number, currency = 'EUR') =>
    previewVerb(r, { params: { verb: 'adjust-prices', amount, currency }, targets: [{ rowId: 'c1', coordinateKey: 'AMAZON:IT' }], commit: false }, ctx)

  it('moves each price by the amount, rounded to cents', () => {
    const p = by(priced(99.99), -2.5)
    expect(p.changes).toEqual([expect.objectContaining({ cell: 'price', from: 99.99, to: 97.49, fromLabel: '€99.99', toLabel: '€97.49' })])
    expect(p.changes[0]!.note).toBeUndefined()
    expect(by(priced(100, 'master'), 3).changes[0]).toMatchObject({ to: 103, note: PREVIEW_WORDS.ownPrice })
    expect(p.confirm).toBe('none')
  })
  it('refuses a market that sells in another currency, a price that would be 0 or less, and a market with no price', () => {
    expect(by(priced(100), -2, 'GBP').refusals).toEqual([expect.objectContaining({ kind: 'currency', reason: 'This market sells in EUR' })])
    expect(by(priced(10), -10).refusals[0]).toMatchObject({ reason: 'A price must be more than 0' })
    expect(by(priced(10), -12).refusals[0]).toMatchObject({ reason: 'A price must be more than 0' })
    expect(by(priced(null), 5).refusals[0]).toMatchObject({ kind: 'not-applicable', reason: 'No price to change' })
    expect(by(priced(100, 'formula'), 5).refusals[0]).toMatchObject({ kind: 'formula', reason: 'A formula sets this price — edit the formula instead' })
  })
  it('asks for the typed word when any line drops by 30 % or more — by an amount as by a percent', () => {
    expect(by(priced(100), -30)).toMatchObject({ confirm: 'type-to-confirm', confirmWord: 'APPLY' })
    expect(by(priced(10), -3)).toMatchObject({ confirm: 'type-to-confirm', confirmWord: 'APPLY' })
    expect(by(priced(100), -29.99)).toMatchObject({ confirm: 'none', confirmWord: null })
    expect(by(priced(100), 50)).toMatchObject({ confirm: 'none' })
    const pct = (percent: number) => previewVerb(priced(100), { params: { verb: 'adjust-prices', percent }, targets: [{ rowId: 'c1', coordinateKey: 'AMAZON:IT' }], commit: false }, ctx)
    expect(pct(-30).confirm).toBe('type-to-confirm'); expect(pct(-29).confirm).toBe('none')
  })
  it('checks the params: a percent or an amount, never both; an amount other than 0 with a 3-letter currency', () => {
    expect(adjustPricesProblem({ percent: -5 })).toBeNull()
    expect(adjustPricesProblem({ amount: -2.5, currency: 'EUR' })).toBeNull()
    expect(adjustPricesProblem({ percent: -5, amount: 2, currency: 'EUR' })).toBe('Adjust prices by a percent or by an amount, not both')
    expect(adjustPricesProblem({ amount: 0, currency: 'EUR' })).toBe('The amount must be a number other than 0')
    expect(adjustPricesProblem({ amount: Number.NaN, currency: 'EUR' })).toBe('The amount must be a number other than 0')
    expect(adjustPricesProblem({ amount: '2', currency: 'EUR' })).toBe('The amount must be a number other than 0')
    expect(adjustPricesProblem({ amount: 2 })).toMatch(/3-letter code/)
    expect(adjustPricesProblem({ amount: 2, currency: 'eur' })).toMatch(/3-letter code/)
    expect(adjustPricesProblem({ percent: 5, currency: 'EUR' })).toBe('A currency goes with an amount, not with a percent')
    expect(adjustPricesProblem({})).toBe('Adjust prices needs a percent or an amount')
    expect(adjustPricesProblem({ percent: Number.POSITIVE_INFINITY })).toBe('The percent must be a number')
  })
})

describe('matrix-preview — a price of 0 is refused before Apply', () => {
  const ctx = { can: () => true, simulated: false }
  const set = (value: number) => previewVerb(read(), { params: { verb: 'set-price', value }, targets: [{ rowId: 'c1', coordinateKey: 'AMAZON:IT' }], commit: false }, ctx)
  it('set-price 0 (or less) is a refusal, never a change with a note', () => {
    for (const v of [0, 0.001, -1]) {
      const p = set(v)
      expect(p.changes).toEqual([])
      expect(p.refusals).toEqual([expect.objectContaining({ kind: 'not-applicable', reason: 'A price must be more than 0' })])
    }
    expect(set(0.01).changes[0]).toMatchObject({ to: 0.01, toLabel: '€0.01' })
  })
  it('a cut of 100 % is refused the same way', () => {
    const p = previewVerb(read(), { params: { verb: 'adjust-prices', percent: -100 }, targets: [{ rowId: 'c1', coordinateKey: 'AMAZON:IT' }], commit: false }, ctx)
    expect(p.refusals[0]).toMatchObject({ reason: 'A price must be more than 0' })
  })
})

describe('matrix-preview — the grid\'s words', () => {
  const ctx = { can: () => true, simulated: false }
  const run = (r: MatrixRead, params: Parameters<typeof previewVerb>[1]['params'], coordinateKey = 'AMAZON:IT') =>
    previewVerb(r, { params, targets: [{ rowId: 'c1', coordinateKey }], commit: false }, ctx)
  const pinned = (): MatrixRead => {
    const r = read()
    r.rows[1].cells['AMAZON:EU'].sync = { kind: 'PINNED', via: null, mode: 'PINNED', intended: 3, held: 3, buffer: 1, poolAvailable: 10, routedLocations: ['IT-MAIN'], fbaAtAmazon: null, oversold: false }
    return r
  }

  it('Quantity reads Mode · Qty, as the grid\'s two cells', () => {
    expect(run(pinned(), { verb: 'set-follow' }).changes[0]).toMatchObject({ fromLabel: 'Pinned · 3', toLabel: 'Follow · 9' })
    expect(run(read(), { verb: 'pin-quantity', value: 0 }).changes[0]).toMatchObject({ fromLabel: 'Follow · 10', toLabel: 'Pinned · 0' })
    const uncounted = pinned(); uncounted.rows[1].cells['AMAZON:EU'].sync!.poolAvailable = null
    expect(run(uncounted, { verb: 'set-follow' }).changes[0]).toMatchObject({ toLabel: 'Follow · Uncounted' })
  })
  it('Buffer reads the number, `—` on a fixed quantity, with the plain note', () => {
    expect(run(read(), { verb: 'set-buffer', value: 2 }).changes[0]).toMatchObject({ fromLabel: 'Buffer 0', toLabel: 'Buffer 2', note: 'The market shows 8' })
    expect(run(pinned(), { verb: 'set-buffer', value: 4 }).changes[0]).toMatchObject({ from: 1, to: 4, fromLabel: 'Buffer —', toLabel: 'Buffer 4', note: 'Used when the market follows your stock' })
    expect(syncBufferText(pinned().rows[1].cells['AMAZON:EU'].sync)).toBe('—')
  })
  it('Push now and Retry read the Sync column\'s words, never a raw state', () => {
    const r = read()
    expect(run(r, { verb: 'push-now' }).changes[0]).toMatchObject({ from: 'sent', fromLabel: 'Sent', toLabel: 'Queued · 10' })
    r.rows[1].cells['AMAZON:EU'].queue = null
    expect(run(r, { verb: 'push-now' }).changes[0]).toMatchObject({ from: 'never', fromLabel: '—' })
    r.rows[1].cells['AMAZON:EU'].queue = { state: 'failed', at: null, reason: 'eBay: 25002', syncType: 'QUANTITY_UPDATE', via: null }
    expect(run(r, { verb: 'retry-sync' }).changes[0]).toMatchObject({ from: 'failed', fromLabel: 'Failed', toLabel: 'Queued', note: 'eBay: 25002' })
    expect(run(read(), { verb: 'retry-sync' }).refusals[0]).toMatchObject({ reason: 'Nothing to retry here — the last push did not fail' })
    expect(queueStateWord({ state: 'never', at: null, reason: null, syncType: null, via: null })).toBe('Never')
    expect(queueStateWord({ state: 'sent', at: '2026-10-12T10:00:00.000Z', reason: null, syncType: null, via: null })).toBe('Sent')
    expect(queueStateWord({ state: 'sent', at: '2026-10-12T10:00:00.000Z', reason: null, syncType: null, via: null }, Date.parse('2026-10-12T10:02:00.000Z'))).toBe('Sent 2 min')
  })
  it('refusals say where in plain words, never "coordinate"', () => {
    const r = read()
    r.coordinates.push({ key: 'EBAY:IT', kind: 'market', channel: 'EBAY', market: 'IT', label: 'eBay · IT', region: null, alias: null, accountId: 'e1', currency: 'EUR', connected: true, listed: 0, draft: 0,
      cells: ['listing', 'price'], absent: [], sharedInventoryWith: null, inventoryOn: null, vocabulary: { fulfilment: null } })
    expect(run(r, { verb: 'set-price', value: 5 }, 'EBAY:IT').refusals[0]).toMatchObject({ kind: 'no-listing', reason: 'Not on this market' })
    expect(run(read(), { verb: 'set-price', value: 5 }, 'AMAZON:EU').refusals[0]).toMatchObject({ reason: 'This market has no price here' })
    const noSync = read(); noSync.rows[1].cells['AMAZON:EU'].sync = null
    expect(run(noSync, { verb: 'pin-quantity', value: 2 }).refusals[0]).toMatchObject({ reason: 'This market carries no stock here' })
    const all = Object.values(PREVIEW_WORDS).map((w) => (typeof w === 'function' ? w('EUR') : w))
    for (const w of [...all, MATRIX_COPY.sourceNone]) expect(w).not.toMatch(/coordinate/i)
  })
  it('copy-prices across currencies names the currencies plainly', () => {
    const r = read()
    r.coordinates.push({ key: 'AMAZON:UK', kind: 'market', channel: 'AMAZON', market: 'UK', label: 'Amazon · UK', region: null, alias: null, accountId: 'a', currency: 'GBP', connected: true, listed: 1, draft: 0,
      cells: ['listing', 'price'], absent: [], sharedInventoryWith: null, inventoryOn: null, vocabulary: { fulfilment: null } })
    r.rows[1].cells['AMAZON:UK'] = { ...r.rows[1].cells['AMAZON:IT'], price: { value: 80, currency: 'GBP', source: 'override', formula: null, clamped: null } }
    expect(run(r, { verb: 'copy-prices', fromCoordinateKey: 'AMAZON:UK' }).refusals[0]).toMatchObject({ kind: 'currency', reason: 'This market sells in EUR, not GBP — set the price instead' })
    expect(run(read(), { verb: 'copy-prices', fromCoordinateKey: 'AMAZON:UK' }).refusals[0]).toMatchObject({ reason: 'No price on the market you copy from' })
  })
})

describe('matrix-preview — Amazon Business: money in its currency, deep cuts typed, Amazon\'s own price said once', () => {
  const ctx = { can: () => true, simulated: false }
  const biz = (o: Record<string, unknown> = {}) => ({ rule: null, percent: null, exact: null, tiers: null, price: null, normalPrice: 105, minPrice: null, maxPrice: null, currency: 'EUR', warnings: [], held: null, send: null, live: null, reported: null, ...o })
  const b2bRead = (it: Record<string, unknown> = {}): MatrixRead => {
    const r = read()
    r.coordinates[1]!.cells = ['listing', 'price', 'salePrice', 'businessPrice', 'businessTiers']
    r.coordinates.push({ ...r.coordinates[1]!, key: 'AMAZON:UK', market: 'UK', label: 'Amazon · UK', region: 'UK', currency: 'GBP', inventoryOn: null })
    const cell = (b: Record<string, unknown>, value: number) => ({ ...r.rows[1]!.cells['AMAZON:IT']!, price: { value, currency: b.currency as string, source: 'override' as const, formula: null, clamped: null }, business: b as never, writable: { price: true, salePrice: true, businessPrice: true, businessTiers: true } })
    r.rows[1]!.cells['AMAZON:IT'] = cell(biz(it), 105)
    r.rows[1]!.cells['AMAZON:UK'] = cell(biz({ normalPrice: 95, currency: 'GBP', ...it, ...(it.currency ? {} : { currency: 'GBP' }) }), 95)
    return r
  }
  const both = [{ rowId: 'c1', coordinateKey: 'AMAZON:IT' }, { rowId: 'c1', coordinateKey: 'AMAZON:UK' }]
  const run = (r: MatrixRead, params: Parameters<typeof previewVerb>[1]['params'], targets = both) => previewVerb(r, { params, targets, commit: false }, ctx)

  it('an exact B2B price, B2B prices per unit and Set price go to the markets of their currency only; the rest say why', () => {
    const exact = run(b2bRead(), { verb: 'set-business-price', mode: 'exact', price: 90, currency: 'EUR' })
    expect(exact.changes.map((c) => [c.coordinateKey, c.toLabel])).toEqual([['AMAZON:IT', '€90.00']])
    expect(exact.refusals).toEqual([expect.objectContaining({ coordinateKey: 'AMAZON:UK', kind: 'currency', reason: PREVIEW_WORDS.marketCurrency('GBP') })])
    const fixed = { type: 'fixed' as const, levels: [{ minQty: 2, value: 88 }] }
    const tiers = run(b2bRead({ rule: 'FIXED', exact: 90, price: 90 }), { verb: 'set-business-tiers', mode: 'set', tiers: fixed, currency: 'GBP' })
    expect(tiers.refusals.map((x) => [x.coordinateKey, x.reason])).toEqual([['AMAZON:IT', PREVIEW_WORDS.marketCurrency('EUR')]])
    // Percent discounts and a percent below the price carry no money: every market takes them.
    expect(run(b2bRead({ rule: 'FIXED', exact: 90, price: 90 }), { verb: 'set-business-tiers', mode: 'set', tiers: { type: 'percent', levels: [{ minQty: 2, value: 3 }] }, currency: 'GBP' }).refusals).toEqual([])
    expect(run(b2bRead(), { verb: 'set-business-price', mode: 'percent', percent: 5 }).changes).toHaveLength(2)
    // Market price "Set to": the same rule.
    const set = run(b2bRead(), { verb: 'set-price', value: 90, currency: 'EUR' })
    expect(set.changes.map((c) => c.coordinateKey)).toEqual(['AMAZON:IT'])
    expect(set.refusals).toEqual([expect.objectContaining({ coordinateKey: 'AMAZON:UK', kind: 'currency', reason: 'This market sells in GBP' })])
  })

  it('a new B2B price (or quantity discount) 30 % or more below the normal price asks for the typed word, whatever the mode', () => {
    const exact = (price: number) => run(b2bRead(), { verb: 'set-business-price', mode: 'exact', price, currency: 'EUR' }, [both[0]!])
    expect(exact(10)).toMatchObject({ confirm: 'type-to-confirm', confirmWord: 'APPLY' })
    expect(exact(73.5)).toMatchObject({ confirm: 'type-to-confirm', confirmWord: 'APPLY' })
    expect(exact(73.51)).toMatchObject({ confirm: 'none', confirmWord: null })
    const deepTier = run(b2bRead({ rule: 'FIXED', exact: 100, price: 100 }), { verb: 'set-business-tiers', mode: 'set', tiers: { type: 'fixed', levels: [{ minQty: 2, value: 70 }] }, currency: 'EUR' }, [both[0]!])
    expect(deepTier.confirmWord).toBe('APPLY')
  })

  it('replacing a business price set outside Nexus is said once above the table as well as on its line', () => {
    const p = run(b2bRead({ reported: { price: 95 } }), { verb: 'set-business-price', mode: 'percent', percent: 5 }, [both[0]!])
    expect(p.changes[0]!.note).toBe(PREVIEW_WORDS.businessReplacesAmazon('€95.00'))
    expect(p.notices).toEqual([PREVIEW_WORDS.businessReplacesAmazonNotice])
    expect(run(b2bRead(), { verb: 'set-business-price', mode: 'percent', percent: 5 }, [both[0]!]).notices).toEqual([])
  })
})
