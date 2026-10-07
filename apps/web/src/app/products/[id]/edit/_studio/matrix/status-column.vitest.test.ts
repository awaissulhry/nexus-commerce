import { describe, expect, it, vi } from 'vitest'

import { CellSaveTracker, SelectPanelEditor, SellingStatusCell } from '@/design-system/grid'
import { newRowId, type PublishActionCell } from '@nexus/shared/publish-actions'

import { STATUS_COLUMN, statusColumn, type PublishCellReadState } from '../sheet/channel/statusColumn'
import type { StudioRow } from '../sheet/master/types'
import { buildMatrixColumns, hasMatrixStatus, isMatrixStatusColId, matrixColId, matrixGroupKeyOf, matrixStatusColId, parseMatrixColId } from './columns'
import type { MatrixCoordinate } from './contract'
import { clearsNothing, matrixStatusCell, MATRIX_STATUS_SINCE, publishCellsByPlace, publishPlaceKey, savedBeforeMatrixStatus } from './statusCells'

/**
 * The Matrix's Status columns (Owner 2026-10-07): the Information page's own Status column, once per market — "use the
 * same column, not a copy" — reading the cell that market's sheet shows for the same listing.
 */

function cell(over: Partial<PublishActionCell> & Pick<PublishActionCell, 'listingId' | 'productId'>): PublishActionCell {
  return {
    sku: 'SKU', channel: 'AMAZON', marketplace: 'IT', accountId: 'acc-1', aliasKey: '', state: 'active', stateReason: null,
    send: { mode: 'partial', setAt: null, setById: null, setByName: null, noLongerApplies: null },
    status: { target: null, setAt: null, setById: null, setByName: null, noLongerApplies: null },
    deleted: null, create: null, sendOptions: [],
    statusOptions: [{ target: 'active', offered: true, action: null, reason: null, warning: null, checkedAtSend: null }, { target: 'inactive', offered: true, action: 'pause', reason: null, warning: null, checkedAtSend: null }],
    ...over,
  }
}

function coordinate(over: Partial<MatrixCoordinate> & Pick<MatrixCoordinate, 'key' | 'channel' | 'market'>): MatrixCoordinate {
  return {
    kind: 'market', label: `${over.channel} · ${over.market}`, region: null, alias: null, accountId: 'acc-1', currency: 'EUR', connected: true,
    listed: null, draft: null, cells: ['listing', 'syncMode', 'price'], absent: [], sharedInventoryWith: null, inventoryOn: null, vocabulary: { fulfilment: null },
    ...over,
  }
}

describe('which publish cell a Matrix row shows on a market', () => {
  const live = cell({ listingId: 'L-IT', productId: 'p1', state: 'paused', status: { target: 'active', setAt: '2026-10-07T08:00:00.000Z', setById: 'u', setByName: 'Anna', noLongerApplies: null } })
  const fresh = cell({ listingId: newRowId({ productId: 'p2', channel: 'AMAZON', marketplace: 'IT', accountId: 'acc-1', aliasKey: '' }), productId: 'p2', state: 'not_listed',
    create: { target: 'active', source: 'default', defaultTarget: 'active', noRecord: true, sentence: 'Publish creates it and it sells.' } })
  const elsewhere = cell({ listingId: newRowId({ productId: 'p2', channel: 'AMAZON', marketplace: 'IT', accountId: 'acc-2', aliasKey: '' }), productId: 'p2', accountId: 'acc-2', state: 'not_listed' })
  const aliasRow = cell({ listingId: 'L-ALIAS', productId: 'p1', channel: 'EBAY', aliasKey: 'al-1' })
  const rows = [live, fresh, elsewhere, aliasRow]
  const byListingId = new Map(rows.map((c) => [c.listingId, c]))
  const byPlace = publishCellsByPlace(rows)
  const amazonIt = coordinate({ key: 'AMAZON:IT', channel: 'AMAZON', market: 'IT' })

  it('the row\'s listing on that market: the exact cell its sheet shows (waiting value, who and when included)', () => {
    expect(matrixStatusCell('p1', amazonIt, 'L-IT', byListingId, byPlace)).toBe(live)
  })

  it('no listing there: the new row of that market\'s main listing, on the Matrix\'s own account only', () => {
    expect(matrixStatusCell('p2', amazonIt, null, byListingId, byPlace)).toBe(fresh)
    expect(matrixStatusCell('p2', { ...amazonIt, accountId: 'acc-2' }, null, byListingId, byPlace)).toBe(elsewhere)
    expect(matrixStatusCell('p2', { ...amazonIt, accountId: 'acc-3' }, null, byListingId, byPlace)).toBeNull()
    expect(matrixStatusCell('p3', amazonIt, null, byListingId, byPlace)).toBeNull()
  })

  it('an alias group reads its alias\'s cell; a market code reads the same in any case', () => {
    const alias = coordinate({ key: 'EBAY:IT#al-1', channel: 'EBAY', market: 'it', alias: { id: 'al-1', label: 'Second', position: 1 } })
    expect(matrixStatusCell('p1', alias, null, byListingId, byPlace)).toBe(aliasRow)
    expect(matrixStatusCell('p1', { ...alias, alias: null }, null, byListingId, byPlace)).toBeNull()
  })

  it('🔴 a listing the publish read does not hold (yet): no cell — as the sheet, never an older new row of the place', () => {
    expect(matrixStatusCell('p2', amazonIt, 'L-UNKNOWN', byListingId, byPlace)).toBeNull()
  })

  it('🔴 a listing of another account (or none) is not this market\'s: the account\'s own row for the product, as its sheet shows', () => {
    // The Matrix holds S's listing with no account (a deleted connection) on Amazon IT, whose account is acc-1.
    const orphan = cell({ listingId: 'L-ORPHAN', productId: 'p4', accountId: '' })
    const own = cell({ listingId: newRowId({ productId: 'p4', channel: 'AMAZON', marketplace: 'IT', accountId: 'acc-1', aliasKey: '' }), productId: 'p4', state: 'not_listed' })
    const rows2 = [orphan, own]
    expect(matrixStatusCell('p4', amazonIt, 'L-ORPHAN', new Map(rows2.map((c) => [c.listingId, c])), publishCellsByPlace(rows2))).toBe(own)
    expect(matrixStatusCell('p4', amazonIt, 'L-ORPHAN', new Map([[orphan.listingId, orphan]]), publishCellsByPlace([orphan]))).toBeNull()
  })

  it('a listing Nexus holds wins over the new row of the same place (a choice that just started its draft)', () => {
    const started = cell({ listingId: 'L-NEW', productId: 'p2', state: 'draft' })
    const place = publishCellsByPlace([fresh, started])
    expect(place.get(publishPlaceKey('AMAZON', 'IT', 'acc-1', '', 'p2'))).toBe(started)
    expect(publishCellsByPlace([started, fresh]).get(publishPlaceKey('amazon', 'it', 'acc-1', '', 'p2'))).toBe(started)
    // The Matrix has not read the new listing yet (no listing id): the place still finds it.
    expect(matrixStatusCell('p2', amazonIt, null, new Map(), place)).toBe(started)
  })
})

describe('the Matrix\'s Status column IS the Information page\'s Status column', () => {
  const read: PublishCellReadState = { loaded: true, failed: false, lockedReason: null }
  const waiting = cell({ listingId: 'L-IT', productId: 'p1', state: 'active', status: { target: 'inactive', setAt: '2026-10-07T08:00:00.000Z', setById: 'u', setByName: 'Anna', noLongerApplies: null } })
  type Def = Record<string, unknown>
  const call = <T,>(fn: unknown, params: unknown): T => (fn as (p: unknown) => T)(params)
  const build = (colId: string | undefined, onInput = vi.fn()) => ({
    def: statusColumn<{ id: string }>({ colId, cell: () => waiting, read: () => read, onInput, canDelete: () => false, tracker: new CellSaveTracker(), rowIdOf: (r) => r.id }) as Def,
    onInput,
  })

  it('same value, words, cell, editor and choices — only the column id differs', () => {
    const sheet = build(undefined).def
    const matrix = build(matrixStatusColId('AMAZON:IT')).def
    expect(sheet.colId).toBe(STATUS_COLUMN)
    expect(matrix.colId).toBe('AMAZON:IT.status')
    const params = { data: { id: 'p1' } }
    expect(call(matrix.valueGetter, params)).toEqual(call(sheet.valueGetter, params))
    expect(call(matrix.valueGetter, params)).toMatchObject({ state: 'active', waiting: { target: 'inactive', setByName: 'Anna' } })
    const value = call(sheet.valueGetter, params)
    expect(call(matrix.valueFormatter, { value })).toBe(call(sheet.valueFormatter, { value }))
    expect(call(matrix.valueFormatter, { value })).toBe('Inactive')
    expect(matrix.cellRenderer).toBe(SellingStatusCell)
    expect(matrix.cellEditor).toBe(sheet.cellEditor)
    expect(matrix.cellEditor).toBe(SelectPanelEditor)
    expect(call(matrix.cellEditorParams, params)).toEqual(call(sheet.cellEditorParams, params))
    expect(call(matrix.editable, params)).toBe(call(sheet.editable, params))
    expect(call(matrix.tooltipValueGetter, { ...params, value })).toBe(call(sheet.tooltipValueGetter, { ...params, value }))
    for (const key of ['headerName', 'headerTooltip', 'width', 'minWidth', 'cellEditorPopup', 'cellEditorPopupPosition', 'sortable']) expect(matrix[key], key).toEqual(sheet[key])
  })

  it('a value is staged, never written to the row: the setter hands it on and AG sees no change', () => {
    const { def, onInput } = build(matrixStatusColId('AMAZON:IT'))
    expect(call(def.valueSetter, { data: { id: 'p1' }, newValue: 'active' })).toBe(false)
    expect(onInput).toHaveBeenCalledWith({ id: 'p1' }, expect.anything())
  })

  it('its save marks are kept under its own id: one market\'s refusal never shows on another market', () => {
    const tracker = new CellSaveTracker()
    const it = statusColumn<{ id: string }>({ colId: 'AMAZON:IT.status', cell: () => waiting, read: () => read, onInput: vi.fn(), canDelete: () => false, tracker, rowIdOf: (r) => r.id }) as Def
    const de = statusColumn<{ id: string }>({ colId: 'AMAZON:DE.status', cell: () => waiting, read: () => read, onInput: vi.fn(), canDelete: () => false, tracker, rowIdOf: (r) => r.id }) as Def
    tracker.set('p1', 'AMAZON:IT.status', 'refused', 'Amazon refused it.')
    const value = call(it.valueGetter, { data: { id: 'p1' } })
    expect(call(it.tooltipValueGetter, { data: { id: 'p1' }, value })).toContain('Amazon refused it.')
    expect(call(de.tooltipValueGetter, { data: { id: 'p1' }, value })).not.toContain('Amazon refused it.')
  })
})

describe('where the Matrix places a market\'s Status column', () => {
  const coords: MatrixCoordinate[] = [
    coordinate({ key: 'AMAZON:IT', channel: 'AMAZON', market: 'IT', cells: ['listing', 'fulfilment', 'price'], inventoryOn: 'AMAZON:EU' }),
    coordinate({ key: 'AMAZON:EU', channel: 'AMAZON', market: 'EU', kind: 'region-inventory', cells: ['syncMode', 'syncQty', 'syncBuffer'] }),
    coordinate({ key: 'EBAY:IT', channel: 'EBAY', market: 'IT', cells: ['listing', 'syncMode', 'price'] }),
    coordinate({ key: 'EBAY:IT#al-1', channel: 'EBAY', market: 'IT', cells: ['listing', 'syncQty'], alias: { id: 'al-1', label: 'Second', position: 1 } }),
    coordinate({ key: 'ETSY:GLOBAL', channel: 'ETSY', market: 'GLOBAL', kind: 'global', cells: [] }),
  ]
  const statusColumnOf = vi.fn((coord: MatrixCoordinate) => ({ colId: matrixStatusColId(coord.key), headerName: 'Status' }))
  const groups = buildMatrixColumns({
    coordinates: coords, cellsOf: () => null, rowOf: () => null, tracker: new CellSaveTracker(), sheetColumns: [], locale: 'it', market: 'IT',
    axesRef: { current: [] }, rowMenuRef: { current: () => [] }, masterHeldReason: null, onJump: () => undefined, onPickFulfilment: () => undefined,
    rowsRef: { current: [] as StudioRow[] }, statusColumnOf,
  }) as Array<{ groupId?: string; children?: Array<{ colId?: string }> }>
  const idsOf = (key: string) => groups.find((g) => g.groupId === `grp-${key}`)!.children!.map((c) => c.colId)

  it('right after Listing, on every listed market and alias — never on a region\'s inventory or an unlisted market', () => {
    expect(idsOf('AMAZON:IT')).toEqual(['AMAZON:IT.listing', 'AMAZON:IT.status', 'AMAZON:IT.fulfilment', 'AMAZON:IT.price'])
    expect(idsOf('EBAY:IT')).toEqual(['EBAY:IT.listing', 'EBAY:IT.status', 'EBAY:IT.syncMode', 'EBAY:IT.price'])
    // An alias that carries a quantity has its From column ("Sells from", Step 2) before Qty; Status stays after Listing.
    expect(idsOf('EBAY:IT#al-1')).toEqual(['EBAY:IT#al-1.listing', 'EBAY:IT#al-1.status', 'EBAY:IT#al-1.from', 'EBAY:IT#al-1.syncQty'])
    expect(idsOf('AMAZON:EU')).not.toContain('AMAZON:EU.status')
    expect(idsOf('ETSY:GLOBAL')).toEqual([matrixColId('ETSY:GLOBAL', 'notListed')])
    expect(statusColumnOf.mock.calls.map(([c]) => c.key)).toEqual(['AMAZON:IT', 'EBAY:IT', 'EBAY:IT#al-1'])
    expect(coords.map(hasMatrixStatus)).toEqual([true, false, true, true, false])
  })

  it('🔴 its id is never a Matrix cell id: no Matrix or master write path can take it', () => {
    expect(parseMatrixColId('AMAZON:IT.status')).toBeNull()
    expect(parseMatrixColId('EBAY:IT#al-1.status')).toBeNull()
    expect(isMatrixStatusColId('AMAZON:IT.status')).toBe(true)
    expect(isMatrixStatusColId('EBAY:IT#al-1.status')).toBe(true)
    for (const other of ['status', 'AMAZON:IT.listing', 'shared.fba', 'basePrice', '', null, undefined]) expect(isMatrixStatusColId(other), String(other)).toBe(false)
  })
})

describe('the Matrix\'s own rules around the shared column', () => {
  it('a market\'s Status cell belongs to its group (the toolbar verbs act on that market)', () => {
    expect(matrixGroupKeyOf('AMAZON:IT.status')).toBe('AMAZON:IT')
    expect(matrixGroupKeyOf('EBAY:IT#al-1.status')).toBe('EBAY:IT#al-1')
    expect(matrixGroupKeyOf('AMAZON:IT.price')).toBe('AMAZON:IT')
    for (const other of ['status', 'shared.fba', 'identity', null]) expect(matrixGroupKeyOf(other), String(other)).toBeNull()
  })

  it('a range Delete clears only a cell with a value waiting (the sheet\'s Delete rule)', () => {
    const clear = { change: { column: 'status' as const, target: null } }
    const nothing = cell({ listingId: 'a', productId: 'p' })
    const waiting = cell({ listingId: 'b', productId: 'p', status: { target: 'inactive', setAt: 'x', setById: 'u', setByName: 'A', noLongerApplies: null } })
    expect(clearsNothing(clear, nothing)).toBe(true)
    expect(clearsNothing(clear, null)).toBe(true)
    expect(clearsNothing(clear, waiting)).toBe(false)
    expect(clearsNothing({ change: { column: 'status', target: 'inactive' } }, nothing)).toBe(false)
    expect(clearsNothing({ refused: 'no' }, nothing)).toBe(false)
  })

  it('a saved view older than the Status columns shows them beside its Listings; one saved since keeps what it names', () => {
    expect(savedBeforeMatrixStatus('2026-10-01T10:00:00.000Z')).toBe(true)
    expect(savedBeforeMatrixStatus(new Date(MATRIX_STATUS_SINCE + 1000).toISOString())).toBe(false)
    expect(savedBeforeMatrixStatus(undefined)).toBe(false)
    expect(savedBeforeMatrixStatus('not a date')).toBe(false)
  })
})
