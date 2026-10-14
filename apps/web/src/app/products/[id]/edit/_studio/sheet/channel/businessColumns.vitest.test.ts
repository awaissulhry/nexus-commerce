/**
 * Amazon Business step 5 (Part 4) — the Amazon product sheet's B2B price and Quantity discounts columns: the Matrix's own
 * cells (`matrixColumnDef`, the Matrix renderers, text and hover), READ ONLY in their definition (no editor, no setter, no
 * fill handle, no paste), set on the Matrix: Enter, F2 or a double-click opens it where the Matrix would let this person
 * set the cell; a paste, a fill or Delete that reaches them says the sentence. Amazon only.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { CellSaveTracker, MATRIX_CELL_RENDERERS, matrixBusinessPriceText, matrixBusinessTiersText, matrixCellTooltip } from '@/design-system/grid'

import { MATRIX_COPY, type BusinessCell, type MatrixCells, type MatrixCoordinate } from '../../matrix/contract'
import { buildChannelColumns, type BuildChannelColumnsOptions } from '../master/channelColumns'
import {
  BUSINESS_SHEET_COPY, businessGesture, businessOpensMatrix, businessTooltip, clearsSelectionOn, fillTargetColumns, openMatrixTab, pasteTargetColumns,
  reachesBusiness, withBusinessPaste,
} from './businessColumns'
import { takesClearKey } from '../sheetReset'
import { CascadeCell } from './CascadeCell'
import type { ChannelSheetRow, SheetColumn } from './types'

/** The API's words (`studio-stock.ts` `STUDIO_BUSINESS_COPY`) — the server sends them; restated here as the fixture. */
const SET_ON_MATRIX = 'Set on the Matrix — read only here. Enter or a double-click opens the Matrix.'
const PARENT_PRICE_REASON = 'The parent is not buyable — set prices on the variants'
const NO_B2B = MATRIX_COPY.absentBusiness('OUTERWEAR')

/** The two columns as the API serves them on the Amazon sheet (`studioBusinessColumns` + `stockControlRouting`). */
const column = (key: 'business_price' | 'business_tiers', label: string, width: number): SheetColumn => ({
  key, writeField: key, label, width, group: 'Offer', groupKey: 'sheet:offer', kind: 'text', storage: 'listing', scope: 'per_variant',
  requiredBy: [], editable: false, defaultVisible: true, formulaWritable: false, helpText: `${label} for Amazon business buyers. Set on the Matrix — read only here.`,
} as SheetColumn)
const PRICE = column('business_price', 'B2B price', 168)
const TIERS = column('business_tiers', 'Quantity discounts', 180)

const IT: MatrixCoordinate = {
  key: 'AMAZON:IT', kind: 'market', channel: 'AMAZON', market: 'IT', label: 'Amazon · IT', region: 'EU', alias: null, accountId: 'acc-1', currency: 'EUR',
  connected: true, listed: 2, draft: 0, cells: ['listing', 'fulfilment', 'price', 'salePrice', 'businessPrice', 'businessTiers'], absent: [],
  sharedInventoryWith: null, inventoryOn: 'AMAZON:EU', vocabulary: { fulfilment: ['FBA', 'FBM'] },
}
const DE: MatrixCoordinate = { ...IT, key: 'AMAZON:DE', market: 'DE', label: 'Amazon · DE', cells: ['listing', 'fulfilment', 'price', 'salePrice'],
  absent: [{ cell: 'businessPrice', reason: NO_B2B }, { cell: 'businessTiers', reason: NO_B2B }] }
const BUSINESS: BusinessCell = {
  rule: 'PERCENT_OFF', percent: 5, exact: null, tiers: { type: 'percent', levels: [{ minQty: 2, value: 3, unitPrice: 96.76 }] }, price: 99.75, normalPrice: 105,
  minPrice: null, maxPrice: null, currency: 'EUR', warnings: [], held: null, send: { state: 'queued', at: '2026-10-13T10:00:30.000Z', line: null, final: false }, live: null, reported: null,
}
const cellsOf = (o: Partial<MatrixCells> = {}): MatrixCells => ({
  listingId: 'l-1', version: 3, listing: null, fulfilment: null, sync: null, queue: null, price: null, sale: null,
  writable: { businessPrice: true, businessTiers: true }, writeBlockedReason: {}, business: BUSINESS, ...o,
})
/** A sheet row as the API sends it: its market's Matrix cells and the two read-only cells with their sentence. */
function row(cells: MatrixCells | null, coordinate: MatrixCoordinate | null, reason: string, o: { isParent?: boolean } = {}): ChannelSheetRow {
  const cell = (value: unknown) => ({ value, editable: false, writable: false, writeBlockedReason: reason })
  return {
    rowId: 'primary:v1', id: 'v1', parentId: o.isParent ? null : 'root', isParent: !!o.isParent, aliasId: null, listing: null,
    values: { business_price: cell(cells?.business?.price ?? null), business_tiers: cell(cells?.business?.tiers ?? null) },
    business: { key: coordinate?.key ?? 'AMAZON:IT', cells, coordinate },
  } as unknown as ChannelSheetRow
}
const variant = () => row(cellsOf(), IT, SET_ON_MATRIX)
const parent = () => row(cellsOf({ business: null, writable: { businessPrice: false, businessTiers: false }, writeBlockedReason: { businessPrice: PARENT_PRICE_REASON, businessTiers: PARENT_PRICE_REASON } }), IT, PARENT_PRICE_REASON, { isParent: true })
const noB2b = () => row(cellsOf({ business: undefined, writable: {} }), DE, NO_B2B)
const noListing = () => row(null, DE, MATRIX_COPY.noListingYet)

type Fn = (p: unknown) => unknown
const call = (def: object, key: string, p: unknown) => ((def as Record<string, Fn>)[key])(p)
function defs(channel = 'AMAZON', gridColumns: SheetColumn[] = [PRICE, TIERS]) {
  return buildChannelColumns({
    data: { scope: { channel, marketplace: 'IT', label: `${channel} · IT`, connectionId: 'acc-1' } }, gridColumns,
    formulaWiring: { exprFor: () => null, errorFor: () => null }, productLevelOnly: false, refusedReasonFor: () => null,
    tracker: new CellSaveTracker(), activeCellsRef: { current: null }, viewCtx: { locale: 'it', variationAxes: [], flaggedKeys: [] },
    mediaEditor: { open: () => {}, actions: {} }, shopifyEditor: { open: () => {} }, auth: { has: () => true },
  } as unknown as BuildChannelColumnsOptions) as unknown as Array<Record<string, unknown>>
}

describe('the B2B pair on the Amazon sheet is the Matrix\'s cells', () => {
  it('the Matrix renderers, text and order of words: rule and price, the quantity discounts with their unit prices', () => {
    const [price, tiers] = defs()
    expect(price!.cellRenderer).toBe(MATRIX_CELL_RENDERERS.businessPrice)
    expect(tiers!.cellRenderer).toBe(MATRIX_CELL_RENDERERS.businessTiers)
    expect(call(price!, 'valueFormatter', { data: variant() })).toBe(matrixBusinessPriceText(BUSINESS))
    expect(call(tiers!, 'valueFormatter', { data: variant() })).toBe(matrixBusinessTiersText(BUSINESS))
    expect(call(price!, 'getQuickFilterText', { data: variant() })).toBe(matrixBusinessPriceText(BUSINESS))
    // A percent follows the price: the Matrix's own tint, not the sheet's lock.
    const rules = price!.cellClassRules as Record<string, Fn>
    expect(rules['nds-cell-is-following']!({ data: variant() })).toBe(true)
    expect(rules['nds-cell-is-locked']!({ data: variant() })).toBe(false)
    expect(rules['nds-cell-is-locked']!({ data: parent() })).toBe(true)
    expect(price!.headerName).toBe('B2B price'); expect(tiers!.headerName).toBe('Quantity discounts')
    expect(price!.headerTooltip).toContain('Set on the Matrix')
  })

  it('🔴 read only in the DEFINITION: not editable, no editor, no parser, no fill handle, no paste; the setter changes nothing', () => {
    for (const def of defs()) {
      expect(def.editable).toBe(false)
      expect(def.suppressFillHandle).toBe(true)
      expect(def.suppressPaste).toBe(true)
      expect(def.cellEditor).toBeUndefined()
      expect(def.cellEditorSelector).toBeUndefined()
      expect(def.valueParser).toBeUndefined()
      const data = variant()
      expect(call(def, 'valueSetter', { data, newValue: '10%' })).toBe(false)
      expect(data.business!.cells!.business).toEqual(BUSINESS)
      // The Matrix may let this person set it THERE: here the cell carries no editable class and no pencil to reveal.
      expect(String(call(def, 'cellClass', { data }))).not.toMatch(/nds-cell-is-editable|nds-reveal-row/)
    }
  })

  it('the hover is the Matrix\'s, then where it is set — or why it is held, said once', () => {
    const [price, tiers] = defs()
    const matrix = matrixCellTooltip('businessPrice', cellsOf(), IT, MATRIX_COPY)
    expect(call(price!, 'tooltipValueGetter', { data: variant() })).toBe(`${matrix} · ${SET_ON_MATRIX}`)
    expect(String(call(price!, 'tooltipValueGetter', { data: variant() }))).toContain('5% below the price')
    expect(String(call(tiers!, 'tooltipValueGetter', { data: variant() }))).toContain('2+ units: −3% → €96.76 each')
    // The parent: the Matrix already says its sentence — once.
    const held = String(call(price!, 'tooltipValueGetter', { data: parent() }))
    expect(held.split(PARENT_PRICE_REASON)).toHaveLength(2)
    // A market without B2B and a row without a listing there: the server's reason.
    expect(call(price!, 'tooltipValueGetter', { data: noB2b() })).toBe(NO_B2B)
    expect(call(tiers!, 'tooltipValueGetter', { data: noListing() })).toBe(MATRIX_COPY.noListingYet)
    expect(businessTooltip(null, null)).toBeUndefined()
  })

  it('Amazon only: on another channel a field of the same name stays an ordinary sheet column', () => {
    for (const channel of ['EBAY', 'SHOPIFY', 'ETSY']) {
      const [price] = defs(channel)
      expect(price!.cellRenderer, channel).toBe(CascadeCell)
      expect(price!.suppressPaste, channel).toBeUndefined()
    }
  })
})

describe('set on the Matrix: the way there, and the sentence', () => {
  const key = (k: string, o: Partial<KeyboardEvent> = {}) => ({ key: k, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...o })
  it('Enter, F2 or a double-click opens the Matrix where the Matrix would let this person set the cell', () => {
    for (const colId of ['business_price', 'business_tiers']) {
      expect(businessGesture({ colId, row: variant(), key: key('Enter') })).toBe('open')
      expect(businessGesture({ colId, row: variant(), key: key('F2') })).toBe('open')
      expect(businessGesture({ colId, row: variant(), doubleClick: true })).toBe('open')
    }
    // No business price kept yet is still set there.
    expect(businessOpensMatrix('business_price', row(cellsOf({ business: { ...BUSINESS, rule: null, percent: null, tiers: null, price: null } }), IT, SET_ON_MATRIX))).toBe(true)
  })

  it('a held cell does not open it (the sheet says its reason); a typed key, a modifier or another column is the sheet\'s own', () => {
    for (const r of [parent(), noB2b(), noListing()]) {
      expect(businessGesture({ colId: 'business_price', row: r, key: key('Enter') })).toBeNull()
      expect(businessGesture({ colId: 'business_price', row: r, doubleClick: true })).toBeNull()
    }
    const noRight = row(cellsOf({ writable: { businessPrice: false }, writeBlockedReason: { businessPrice: 'You do not have permission to change prices (products.price.edit)' } }), IT, 'x')
    expect(businessGesture({ colId: 'business_price', row: noRight, key: key('Enter') })).toBeNull()
    expect(businessGesture({ colId: 'business_price', row: variant(), key: key('7') })).toBeNull()
    expect(businessGesture({ colId: 'business_price', row: variant(), key: key('Enter', { ctrlKey: true }) })).toBeNull()
    expect(businessGesture({ colId: 'business_price', row: variant(), key: key('Enter', { shiftKey: true }) })).toBeNull()
    expect(businessGesture({ colId: 'stock_qty', row: variant(), key: key('Enter') })).toBeNull()
    expect(businessGesture({ colId: 'stock_qty', row: variant(), doubleClick: true })).toBeNull()
  })

  it('Delete or Backspace on the pair, or on a selection that reaches it, says the sentence', () => {
    expect(businessGesture({ colId: 'business_tiers', row: variant(), key: key('Delete') })).toBe('readOnly')
    expect(businessGesture({ colId: 'business_price', row: parent(), key: key('Backspace') })).toBe('readOnly')
    expect(businessGesture({ colId: 'stock_qty', row: variant(), key: key('Delete'), selected: ['stock_qty', 'stock_buffer', 'business_price'] })).toBe('readOnly')
    expect(businessGesture({ colId: 'stock_qty', row: variant(), key: key('Delete'), selected: ['stock_qty'] })).toBeNull()
  })

  it('a paste: every selected range, and from the focused cell as wide as the clipboard', () => {
    const displayed = ['purchasable_offer__our_price', 'stock_buffer', 'stock_fba', 'business_price', 'business_tiers', 'listing_asin']
    expect(reachesBusiness(pasteTargetColumns({ ranges: [['business_price']], focused: 'business_price', displayed, width: 1 }))).toBe(true)
    expect(reachesBusiness(pasteTargetColumns({ ranges: [], focused: 'stock_buffer', displayed, width: 3 }))).toBe(true)
    expect(reachesBusiness(pasteTargetColumns({ ranges: [['stock_buffer']], focused: 'stock_buffer', displayed, width: 2 }))).toBe(false)
    expect(reachesBusiness(pasteTargetColumns({ ranges: [['stock_buffer', 'stock_fba', 'business_price']], focused: 'stock_buffer', displayed, width: 1 }))).toBe(true)
    expect(reachesBusiness(pasteTargetColumns({ ranges: [], focused: 'listing_asin', displayed, width: 4 }))).toBe(false)
  })

  it('the sheet\'s paste is unchanged; in front of it, the columns it lands on are told (the sentence speaks for the pair only)', () => {
    const col = (id: string) => ({ getColId: () => id })
    const api = (focused: string, ranges: string[][]) => ({
      getCellRanges: () => ranges.map((r) => ({ columns: r.map(col) })), getFocusedCell: () => ({ column: col(focused) }),
      getAllDisplayedColumns: () => ['stock_fba', 'business_price', 'business_tiers', 'listing_asin'].map(col),
    })
    const heard: string[][] = []
    const pasted = [['a', 'b']]
    const paste = withBusinessPaste((p: { data: string[][] }) => p.data, (columns) => { heard.push(columns) })
    expect(paste({ data: pasted, api: api('stock_fba', []) })).toBe(pasted)
    expect(reachesBusiness(heard[0]!)).toBe(true)
    expect(paste({ data: [['x']], api: api('listing_asin', [['listing_asin']]) })).toEqual([['x']])
    expect(reachesBusiness(heard[1]!)).toBe(false)
  })

  it('a fill: down or up writes every column of the range; across only the new columns', () => {
    const down = fillTargetColumns({ columns: ['business_price'], startRow: 0, endRow: 0 }, { columns: ['business_price'], startRow: 0, endRow: 4 })
    expect(reachesBusiness(down)).toBe(true)
    const across = fillTargetColumns({ columns: ['stock_fba'], startRow: 2, endRow: 2 }, { columns: ['stock_fba', 'business_price'], startRow: 2, endRow: 2 })
    expect(across).toEqual(['business_price'])
    // Filling across FROM the pair writes the other columns only.
    expect(reachesBusiness(fillTargetColumns({ columns: ['business_tiers'], startRow: 2, endRow: 2 }, { columns: ['business_tiers', 'listing_asin'], startRow: 2, endRow: 2 }))).toBe(false)
  })

  it('🔴 Delete with the focus on the pair: the grid keeps off the key (it would blank the selection\'s other cells unasked)', () => {
    const del = (k: string, editing = false) => ({ event: { key: k, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }, editing })
    for (const def of defs()) {
      const suppress = def.suppressKeyboardEvent as (p: unknown) => boolean
      expect(suppress(del('Delete'))).toBe(true)
      expect(suppress(del('Backspace'))).toBe(true)
      expect(suppress(del('Delete', true))).toBe(false)
      expect(suppress(del('Enter'))).toBe(false)
      expect(suppress(del('7'))).toBe(false)
    }
  })

  it('… and the sheet asks "Clear or Reset?" for the selection\'s other cells, as an editable column\'s Delete does', () => {
    // The control takes the key on an attribute column, or on a read-only column the scope names; never on another.
    const controlled = (colId: string) => colId === 'item_name'
    const named = (colId: string) => clearsSelectionOn('AMAZON', colId)
    expect(takesClearKey('item_name', controlled, named)).toBe(true)
    for (const colId of ['business_price', 'business_tiers', 'stock_fba']) expect(takesClearKey(colId, controlled, named), colId).toBe(true)
    // Mode / Qty / Buffer and the ASIN keep their own keys (an editor on Backspace; the ASIN's own Clear).
    for (const colId of ['stock_qty', 'stock_mode', 'listing_asin', 'purchasable_offer__our_price']) expect(takesClearKey(colId, controlled, named), colId).toBe(false)
    expect(takesClearKey(undefined, controlled, named)).toBe(false)
    expect(takesClearKey('business_price', controlled)).toBe(false)
    // Amazon only.
    for (const channel of ['EBAY', 'SHOPIFY', null]) expect(clearsSelectionOn(channel, 'business_price'), String(channel)).toBe(false)
    // Wired: the channel sheet names them to its control, and the control asks for them.
    const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8')
    expect(read('./useChannelSheetAdapter.tsx')).toContain('clearsSelection: colId => clearsSelectionOn(channel, colId),')
    expect(read('../useSheetControl.tsx')).toContain('takesClearKey(colId, (id) => !!live.current.columnFacts(id), live.current.clearsSelection)')
  })

  it('the way to the Matrix: the tab — or, while the sheet holds an unsaved change, the sentence to wait (never silence)', () => {
    const said: string[] = [], opened: string[] = []
    const say = (m: string) => { said.push(m) }
    expect(openMatrixTab({ canChangeEditor: () => false, setTab: (t) => { opened.push(t) } }, say)).toBe(false)
    expect(opened).toEqual([]); expect(said).toEqual(['Wait for the sheet to save, then open the Matrix.'])
    expect(openMatrixTab({ canChangeEditor: () => true, setTab: (t) => { opened.push(t) } }, say)).toBe(true)
    expect(openMatrixTab({ setTab: (t) => { opened.push(t) } }, say)).toBe(true)
    expect(opened).toEqual(['matrix', 'matrix']); expect(said).toHaveLength(1)
    expect(BUSINESS_SHEET_COPY.waitToOpen).toBe('Wait for the sheet to save, then open the Matrix.')
  })

  it('the sentence names the pair, where they are set and how to get there', () => {
    expect(BUSINESS_SHEET_COPY.readOnly).toBe('Not changed: B2B price and Quantity discounts are set on the Matrix. Enter or a double-click on one of their cells opens the Matrix.')
  })
})
