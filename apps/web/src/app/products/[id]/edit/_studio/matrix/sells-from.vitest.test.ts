import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { buildMatrixColumns, FROM_EDIT_COPY, matrixGroupKeyOf, parseMatrixColId } from './columns'
import { MATRIX_COPY, type MatrixCells, type MatrixCoordinate, type MatrixRowRead, type SourceCell } from './contract'
import {
  activeWarehouses, defaultLink, dryRunSentence, fromBefore, fromCellText, fromCellView, fromTooltip, isMatrixFromColId, knownCodes, marketSourcesTarget,
  matrixFromColId, pickerOrder, productCodesToWrite, saveHeld, startingCodes, tickedInOrder, toggleCode,
} from './sellsFrom'
import { listBefore, parseMatrixRead, postMarketSources } from './source'
import { MATRIX_FROM_SINCE, savedBeforeMatrixFrom } from './statusCells'

/**
 * "Sells from" (Step 2, Owner 2026-10-07): the From column (once per group that carries the quantity — so once on Amazon
 * EU), its cell and door, the pop-up's rules (This product | Every product), and the market-default route's client.
 */

const coord = (key: string, cells: MatrixCoordinate['cells'], extra: Partial<MatrixCoordinate> = {}): MatrixCoordinate => ({
  key, kind: 'market', channel: key.split(':')[0]!, market: key.split(':')[1]!, label: key, region: null, alias: null, accountId: null, currency: 'EUR',
  connected: true, listed: 1, draft: 0, cells, absent: [], sharedInventoryWith: null, inventoryOn: null, vocabulary: { fulfilment: null }, ...extra,
})
const EU = coord('AMAZON:EU', ['fulfilment', 'syncMode', 'syncQty', 'syncBuffer', 'syncState'], { kind: 'region-inventory', market: 'EU', label: 'Amazon EU · Inventory · IT DE' })
const IT = coord('AMAZON:IT', ['listing', 'price', 'salePrice'], { inventoryOn: 'AMAZON:EU' })
const EBAY = coord('EBAY:IT', ['listing', 'syncMode', 'syncQty', 'syncBuffer', 'syncState', 'price'], { label: 'eBay · IT' })

const LOCATIONS = [
  { code: 'MI-3PL', name: 'Milan 3PL', active: true },
  { code: 'IT-MAIN', name: 'Main warehouse', active: true, isDefault: true },
  { code: 'OLD', name: 'Old', active: false },
]
const src = (over: Partial<SourceCell> = {}): SourceCell => ({
  own: [], marketDefault: ['IT-MAIN'], defaultOrigin: 'routes', effective: [{ code: 'IT-MAIN', available: 12 }], writable: true, blockedReason: null, ...over,
})
const cells = (source: SourceCell | null, over: Partial<MatrixCells> = {}): MatrixCells => ({
  listingId: 'L', version: 3, listing: null, fulfilment: null, sync: null, queue: null, price: null, sale: null, writable: {}, writeBlockedReason: {}, source, ...over,
})
const row = (id: string, over: Partial<MatrixRowRead> = {}): MatrixRowRead => ({
  id, sku: id.toUpperCase(), role: 'variant', stock: { available: 16, uncounted: false, locations: [{ code: 'IT-MAIN', available: 12 }, { code: 'MI-3PL', available: 4 }], source: null },
  basePrice: 10, status: 'ACTIVE', cells: {}, ...over,
})

const ROWS: Record<string, MatrixRowRead> = {
  v1: row('v1'),
  v2: row('v2'),
  p: row('p', { role: 'parent' }),
  pooled: row('pooled', { stock: { available: 3, uncounted: false, locations: [], source: { kind: 'pool', grantId: 'g', lenderName: 'Xavia' } } }),
}
const CELLS: Record<string, MatrixCells> = {
  'v1|AMAZON:EU': cells(src()),
  'v2|AMAZON:EU': cells(src({ own: ['MI-3PL', 'IT-MAIN'], effective: [{ code: 'MI-3PL', available: 4 }, { code: 'IT-MAIN', available: 12 }] })),
  'p|AMAZON:EU': cells(src({ effective: [], writable: false, blockedReason: MATRIX_COPY.sourceParent })),
  'pooled|AMAZON:EU': cells(src({ writable: false, blockedReason: 'Sells Xavia\'s stock (shared stock)' })),
}

type Def = Record<string, unknown>
function groups(onOpenFrom?: (rowId: string, key: string, anchor: HTMLElement | null) => void): Def[] {
  return buildMatrixColumns({
    coordinates: [EU, IT, EBAY], cellsOf: (id: string, key: string) => CELLS[`${id}|${key}`] ?? null, rowOf: (id: string) => ROWS[id] ?? null,
    tracker: { get: () => undefined } as never, sheetColumns: [], locale: 'it', market: 'IT',
    axesRef: { current: [] }, rowMenuRef: { current: () => [] }, onPickFulfilment: () => undefined, rowsRef: { current: [] },
    onOpenFrom,
  } as never) as Def[]
}
const idsOf = (g: Def[], key: string) => (g.find((x) => x.groupId === `grp-${key}`)!.children as Def[]).map((c) => c.colId)
const fromDef = (g: Def[]) => (g.find((x) => x.groupId === 'grp-AMAZON:EU')!.children as Def[]).find((c) => c.colId === 'AMAZON:EU.from')!
const render = (d: Def, id: string) => {
  const params = { ...(d.cellRendererParams as object), data: { id }, node: { rowIndex: 0 }, api: {}, column: { getColId: () => 'AMAZON:EU.from' } }
  return renderToStaticMarkup(createElement(d.cellRenderer as never, params as never))
}

describe('the From column', () => {
  it('sits after Fulfilment on every group that carries the quantity — once on Amazon EU, never on its markets', () => {
    const g = groups()
    /* No Sync column (Owner 2026-10-08): the group serves the kind, the page does not draw it. */
    expect(idsOf(g, 'AMAZON:EU')).toEqual(['AMAZON:EU.fulfilment', 'AMAZON:EU.from', 'AMAZON:EU.syncMode', 'AMAZON:EU.syncQty', 'AMAZON:EU.syncBuffer'])
    expect(idsOf(g, 'AMAZON:IT')).not.toContain('AMAZON:IT.from')
    expect(idsOf(g, 'EBAY:IT')).toEqual(['EBAY:IT.listing', 'EBAY:IT.from', 'EBAY:IT.syncMode', 'EBAY:IT.syncQty', 'EBAY:IT.syncBuffer', 'EBAY:IT.price'])
    expect(fromBefore(IT)).toBeNull()
    expect(fromBefore(coord('X:Y', ['syncQty'], { connected: false }))).toBeNull()
  })

  it('🔴 is read-only in the grid: no Matrix cell id, no edit, no paste or fill — the pop-up is its only writer', () => {
    const d = fromDef(groups(() => undefined))
    expect(d.headerName).toBe('From')
    expect(d.editable).toBe(false)
    expect(d.suppressPaste).toBe(true)
    expect(d.suppressFillHandle).toBe(true)
    expect(parseMatrixColId('AMAZON:EU.from')).toBeNull()
    expect(isMatrixFromColId(matrixFromColId('EBAY:IT#al-1'))).toBe(true)
    for (const other of ['AMAZON:EU.syncQty', 'AMAZON:IT.status', 'shared.stock', '', null]) expect(isMatrixFromColId(other), String(other)).toBe(false)
    expect(matrixGroupKeyOf('AMAZON:EU.from')).toBe('AMAZON:EU')
  })

  it('shows the codes in sale order: muted while it follows the default, normal once the product has its own', () => {
    const d = fromDef(groups(() => undefined))
    const def1 = render(d, 'v1')
    expect(def1).toContain('>IT-MAIN<')
    expect(def1).toContain('nds-cell-muted')
    const own = render(d, 'v2')
    expect(own).toContain('>MI-3PL + IT-MAIN<')
    expect(own).not.toContain('nds-cell-muted')
    expect((d.valueGetter as (p: object) => unknown)({ data: { id: 'v2' } })).toBe('MI-3PL + IT-MAIN')
  })

  it('opens by its pencil when the page gives a door and the cell may change; never on the parent or shared stock', () => {
    const d = fromDef(groups(() => undefined))
    expect(render(d, 'v1').match(/data-nds-cell-action/g)?.length).toBe(1)
    expect(render(d, 'v1')).toContain(`aria-label="${FROM_EDIT_COPY.label}"`)
    // The parent: nothing to say — the grid's empty cell, the same dash as every empty Matrix cell, and no pencil.
    expect(render(d, 'p')).toContain('nds-cell-empty')
    expect(render(d, 'p')).not.toContain('data-nds-cell-action')
    expect(render(d, 'pooled')).toContain('Shared')
    expect(render(d, 'pooled')).not.toContain('data-nds-cell-action')
    // No door (preview, or no right to adjust stock): the words alone.
    expect(render(fromDef(groups(undefined)), 'v1')).not.toContain('data-nds-cell-action')
    expect(d.cellClass).toContain('nds-reveal-row')
  })

  it('the tooltip names each warehouse with its units, whose choice it is, and the rule once', () => {
    const d = fromDef(groups())
    const tip = (id: string) => (d.tooltipValueGetter as (p: object) => string | undefined)({ data: { id } })
    expect(tip('v1')).toBe('Sells from IT-MAIN (12) — the Amazon EU default.')
    expect(tip('v2')).toBe('Sells from MI-3PL (4), then IT-MAIN (12) — this product\'s own choice.\nListings show the sum; a sale takes stock from the first that has it.')
    expect(fromTooltip(src({ effective: [], marketDefault: [] }), 'eBay · IT')).toBe('No warehouse sells on eBay · IT.')
  })
})

describe('fromCellView', () => {
  it('FBA: a dash and Amazon\'s sentence, no door', () => {
    const fba = cells(src({ writable: false, blockedReason: MATRIX_COPY.sourceFba }), { sync: { kind: 'FBA_EXCLUDED' } as never })
    expect(fromCellView(ROWS.v1!, fba, EU)).toMatchObject({ text: '—', look: 'fba', door: false, held: MATRIX_COPY.sourceFba })
  })
  it('without the right to adjust stock: the codes, no door, and the reason for an open gesture', () => {
    const v = fromCellView(ROWS.v1!, cells(src({ writable: false, blockedReason: MATRIX_COPY.sourcePermission })), EU)
    expect(v).toMatchObject({ text: 'IT-MAIN', door: false, held: MATRIX_COPY.sourcePermission })
  })
  it('an older server (no source cell): blank, nothing to export', () => {
    expect(fromCellView(ROWS.v1!, cells(null), EU).look).toBe('none')
    expect(fromCellText(ROWS.v1!, null, EU)).toBeNull()
  })
})

describe('the picker', () => {
  it('offers the active warehouses only: the default first, then by code', () => {
    expect(activeWarehouses(LOCATIONS).map((l) => l.code)).toEqual(['IT-MAIN', 'MI-3PL'])
    expect(activeWarehouses(undefined)).toEqual([])
  })
  it('lists the ticked ones first in sale order, then the rest; a reorder keeps only the ticked ones, in their new order', () => {
    expect(pickerOrder(LOCATIONS, ['MI-3PL'])).toEqual(['MI-3PL', 'IT-MAIN'])
    expect(pickerOrder(LOCATIONS, [])).toEqual(['IT-MAIN', 'MI-3PL'])
    expect(tickedInOrder(['MI-3PL', 'IT-MAIN'], ['IT-MAIN', 'MI-3PL'])).toEqual(['MI-3PL', 'IT-MAIN'])
    expect(tickedInOrder(['IT-MAIN', 'MI-3PL'], ['MI-3PL'])).toEqual(['MI-3PL'])
  })
  it('ticking adds a warehouse last; unticking takes it out', () => {
    expect(toggleCode(['IT-MAIN'], 'MI-3PL')).toEqual(['IT-MAIN', 'MI-3PL'])
    expect(toggleCode(['IT-MAIN', 'MI-3PL'], 'IT-MAIN')).toEqual(['MI-3PL'])
  })
  it('drops unknown and switched-off codes, and spells each as the warehouse does', () => {
    expect(knownCodes(['it-main', 'OLD', 'NOPE', 'IT-MAIN'], LOCATIONS)).toEqual(['IT-MAIN'])
  })
})

describe('the pop-up', () => {
  it('starts This product from what it sells from now, Every product from the market default', () => {
    const own = src({ own: ['MI-3PL', 'IT-MAIN'] })
    expect(startingCodes(own, 'product', LOCATIONS)).toEqual(['MI-3PL', 'IT-MAIN'])
    expect(startingCodes(own, 'market', LOCATIONS)).toEqual(['IT-MAIN'])
    expect(startingCodes(src(), 'product', LOCATIONS)).toEqual(['IT-MAIN'])
  })
  it('Save waits with a reason: nothing ticked, nothing changed, a code that cannot sell', () => {
    expect(saveHeld('product', [], src(), LOCATIONS)).toBe('Tick at least one warehouse')
    expect(saveHeld('product', ['IT-MAIN'], src(), LOCATIONS)).toBe('Nothing to change')
    expect(saveHeld('product', ['MI-3PL'], src(), LOCATIONS)).toBeNull()
    expect(saveHeld('product', ['OLD'], src(), LOCATIONS)).toBe(MATRIX_COPY.sourceInactive('OLD'))
    expect(saveHeld('market', ['IT-MAIN'], src({ own: ['MI-3PL'] }), LOCATIONS)).toBe('Nothing to change')
    expect(saveHeld('market', ['IT-MAIN', 'MI-3PL'], src(), LOCATIONS)).toBeNull()
    // Back to the default from an own choice is a change.
    expect(saveHeld('product', ['IT-MAIN'], src({ own: ['MI-3PL'] }), LOCATIONS)).toBeNull()
  })
  it('This product stores [] when the choice is the default (an exception exists only when it differs)', () => {
    expect(productCodesToWrite(['IT-MAIN'], src())).toEqual([])
    expect(productCodesToWrite(['MI-3PL', 'IT-MAIN'], src())).toEqual(['MI-3PL', 'IT-MAIN'])
  })
  it('offers "Use the default" only while the choice differs from it', () => {
    expect(defaultLink(['MI-3PL'], src())).toBe('Use the default (IT-MAIN)')
    expect(defaultLink(['IT-MAIN'], src())).toBeNull()
    expect(defaultLink(['MI-3PL'], src({ marketDefault: [] }))).toBeNull()
  })
  it('names Amazon EU as one group for the market default; another group by its market', () => {
    expect(marketSourcesTarget(EU)).toEqual({ channel: 'AMAZON', marketplace: 'EU' })
    expect(marketSourcesTarget(EBAY)).toEqual({ channel: 'EBAY', marketplace: 'IT' })
  })
  it('says what Every product changes, in one line', () => {
    expect(dryRunSentence({ listings: 18, exceptions: 0 })).toBe('Changes the default for 18 listings')
    expect(dryRunSentence({ listings: 1, exceptions: 1 })).toBe('Changes the default for 1 listing · 1 product keeps its own choice')
    expect(dryRunSentence({ listings: 18, exceptions: 2 })).toBe('Changes the default for 18 listings · 2 products keep their own choice')
  })
})

describe('the market default route (source.ts)', () => {
  it('posts the group and the codes in sale order, and reads the answer', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) })
      return new Response(JSON.stringify({ ok: true, channel: 'AMAZON', marketplace: 'EU', markets: ['IT', 'DE'], codes: ['MI-3PL', 'IT-MAIN'], before: { IT: [], DE: [] }, listings: 18, products: 9, exceptions: 1, recascadeQueued: 9 }), { status: 200 })
    }) as unknown as typeof fetch
    const a = await postMarketSources({ channel: 'AMAZON', marketplace: 'EU', codes: ['MI-3PL', 'IT-MAIN'] }, { fetchImpl, baseUrl: 'http://api' })
    expect(calls[0]).toEqual({ url: 'http://api/api/stock/sync-control/market-sources', body: { channel: 'AMAZON', marketplace: 'EU', codes: ['MI-3PL', 'IT-MAIN'] } })
    expect(a).toMatchObject({ markets: ['IT', 'DE'], listings: 18, exceptions: 1, recascadeQueued: 9 })
    expect(listBefore(a)).toEqual([])
  })
  it('a refusal throws with the server\'s own sentence', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: 'Switched off: OLD.' }), { status: 400 })) as unknown as typeof fetch
    await expect(postMarketSources({ channel: 'AMAZON', marketplace: 'EU', codes: ['OLD'] }, { fetchImpl, baseUrl: 'http://api' })).rejects.toThrow('Switched off: OLD.')
  })
  it('the Matrix read carries the warehouses (absent on an older server)', () => {
    const body = { coordinates: [], rows: [], locations: [{ code: 'IT-MAIN', name: 'Main', active: true, isDefault: true }, { code: 'OLD', active: false }, { name: 'no code' }] }
    const r = parseMatrixRead(body, 'p')
    expect('read' in r && r.read.locations).toEqual([{ code: 'IT-MAIN', name: 'Main', active: true, isDefault: true }, { code: 'OLD', name: 'OLD', active: false }])
    const old = parseMatrixRead({ coordinates: [], rows: [] }, 'p')
    expect('read' in old && old.read.locations).toBeUndefined()
  })
})

describe('saved views', () => {
  it('a view saved before the From columns existed shows them; one saved since keeps what it names', () => {
    expect(savedBeforeMatrixFrom(new Date(MATRIX_FROM_SINCE - 1).toISOString())).toBe(true)
    expect(savedBeforeMatrixFrom(new Date(MATRIX_FROM_SINCE + 1).toISOString())).toBe(false)
    expect(savedBeforeMatrixFrom(undefined)).toBe(false)
  })
})

describe('the pop-up opens on its first warehouse (Matrix polish, Owner 2026-10-08)', () => {
  it('autoFocusFirst marks only the first warehouse in the list; without it no box is marked (the bulk Edit)', async () => {
    const { SellsFromPicker } = await import('./SellsFromPicker')
    const draw = (autoFocusFirst: boolean) => renderToStaticMarkup(createElement(SellsFromPicker, {
      label: 'Sells from', locations: LOCATIONS, value: ['IT-MAIN'], onChange: () => undefined, autoFocusFirst,
    }))
    const on = draw(true)
    expect(on.match(/data-autofocus/g)?.length).toBe(1)
    // The ticked warehouse leads the list, so it is the one the pop-up opens on.
    expect(on.indexOf('data-autofocus')).toBeLessThan(on.indexOf('MI-3PL'))
    expect(draw(false)).not.toContain('data-autofocus')
  })
})
