/**
 * The listing's channel id cell. Amazon sheet gaps (gap 5) — the ASIN cell: an assigned ASIN with its Copy and Open on
 * Amazon actions, the shared "ASIN pending" and draft states with the header chips' words, a dash otherwise, and the
 * parent's hover (these cases are unchanged by the rename). Item ID control (step I1) — the eBay Item ID cell: the
 * server's value only when it counts, "Not confirmed" / draft / "No number recorded" otherwise, the control's door on
 * the main row only (Enter, Delete), a variation row read-only with the server's "Set on the main row".
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { MATRIX_COPY } from '../../matrix/contract'
import { ASIN_PENDING_CHIP_LABEL, asinPendingChipDetail, DRAFT_CHIP_LABEL, draftChipDetail } from '../../draftListing'
import {
  ASIN_COLUMN_MIN_WIDTH, ASIN_COPY, AsinCell, asinCellKeys, asinCellModel, asinColumnDef, isListingIdKey, ITEM_ID_COLUMN_MIN_WIDTH, ITEM_ID_COPY,
  ItemIdCell, itemIdCellModel, itemIdKeyIntent, listingIdCellModel, listingIdCellText, listingIdColumnDef, PARENT_ASIN_NOTE,
} from './ListingIdCell'
import type { ChannelSheetRow, SheetColumn } from './types'

function row(over: { asin?: string | null; listing?: Record<string, unknown> | null; isParent?: boolean; reason?: string | null } = {}): ChannelSheetRow {
  const listing = over.listing === null ? null : { id: 'L-DE', version: 3, externalListingId: over.asin ?? null, listingStatus: 'ACTIVE', isPublished: true, ...over.listing }
  return {
    rowId: 'primary:v1', id: 'v1', isParent: over.isParent ?? false, listing,
    values: { listing_asin: { value: over.asin ?? null, editable: false, writable: false, writeBlockedReason: over.reason ?? 'Amazon assigns the ASIN; Nexus shows it.' } },
  } as unknown as ChannelSheetRow
}

const COL = { key: 'listing_asin', writeField: 'listing_asin', label: 'ASIN', width: 130, group: 'Identifiers', kind: 'text', storage: 'listing', scope: 'per_variant', requiredBy: [], editable: false, defaultVisible: true } as SheetColumn

describe('asinCellModel — what one row\'s ASIN cell shows', () => {
  it('an assigned ASIN: the ASIN and its Amazon page on this market', () => {
    expect(asinCellModel(row({ asin: 'B0DE000001' }), 'DE')).toEqual({ kind: 'asin', asin: 'B0DE000001', url: 'https://www.amazon.de/dp/B0DE000001', tooltip: null })
    expect(asinCellModel(row({ asin: 'B0UK000001' }), 'UK')).toMatchObject({ url: 'https://www.amazon.co.uk/dp/B0UK000001' })
  })
  it('the parent row: the parent ASIN, "Parent ASIN — not buyable"', () => {
    expect(asinCellModel(row({ asin: 'B0PARENT01', isParent: true }), 'DE')).toEqual({ kind: 'asin', asin: 'B0PARENT01', url: 'https://www.amazon.de/dp/B0PARENT01', tooltip: PARENT_ASIN_NOTE })
    expect(PARENT_ASIN_NOTE).toBe('Parent ASIN — not buyable')
  })
  it('published and live, no ASIN read back yet: the shared pending chip and its words', () => {
    expect(asinCellModel(row({ asin: null }), 'DE')).toEqual({ kind: 'pending', label: ASIN_PENDING_CHIP_LABEL, tooltip: asinPendingChipDetail(1, 'DE') })
  })
  it('a Nexus draft: the draft chip and its words', () => {
    expect(asinCellModel(row({ listing: { listingStatus: 'DRAFT', isPublished: false } }), 'DE')).toEqual({ kind: 'draft', label: DRAFT_CHIP_LABEL, tooltip: draftChipDetail('AMAZON', 'DE') })
  })
  it('no listing: a dash, the hover the server\'s sentence', () => {
    expect(asinCellModel(row({ listing: null, reason: MATRIX_COPY.noListingYet }), 'DE')).toEqual({ kind: 'none', tooltip: MATRIX_COPY.noListingYet })
  })
})

describe('AsinCell — DS parts only', () => {
  const render = (data: ChannelSheetRow) => renderToStaticMarkup(createElement(AsinCell, {
    data, market: 'DE', node: { rowIndex: 0 }, api: { setFocusedCell: () => {} }, column: { getColId: () => 'listing_asin' },
  } as never))
  it('an ASIN: mono text with the Copy and Open on Amazon cell actions', () => {
    const html = render(row({ asin: 'B0DE000001' }))
    expect(html).toContain('nds-projcell-detail')
    expect(html).toContain('>B0DE000001<')
    expect(html).toContain(`aria-label="${ASIN_COPY.copy('B0DE000001')}"`)
    expect(html).toContain(`aria-label="${ASIN_COPY.open}"`)
    expect(html.match(/data-nds-cell-action/g)?.length).toBe(2)
  })
  it('pending and draft: the DS pill with the chip\'s word; none: the dash', () => {
    expect(render(row({ asin: null }))).toContain(ASIN_PENDING_CHIP_LABEL)
    expect(render(row({ listing: { listingStatus: 'DRAFT', isPublished: false } }))).toContain(DRAFT_CHIP_LABEL)
    expect(render(row({ listing: null }))).toContain('—')
  })
})

describe('asinColumnDef and its keys', () => {
  const def = asinColumnDef(COL, 'DE')
  it('read-only; copy, export and the filters read the ASIN; the hover is the model\'s; wide enough for the ASIN and both actions', () => {
    expect(def.editable).toBe(false)
    expect(def.width).toBe(ASIN_COLUMN_MIN_WIDTH)
    const data = row({ asin: 'B0PARENT01', isParent: true })
    expect((def.valueGetter as (p: unknown) => unknown)({ data })).toBe('B0PARENT01')
    expect((def.valueFormatter as (p: unknown) => unknown)({ data })).toBe('B0PARENT01')
    expect((def.tooltipValueGetter as (p: unknown) => unknown)({ data })).toBe(PARENT_ASIN_NOTE)
    expect((def.valueGetter as (p: unknown) => unknown)({ data: row({ asin: null }) })).toBeNull()
    expect(def.cellEditorSelector).toBeUndefined()
  })
  it('Enter on the cell opens the ASIN on Amazon; other keys stay the grid\'s', () => {
    const open = vi.fn()
    const key = (k: string, type = 'keydown') => ({ key: k, type, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, preventDefault: () => {} }) as unknown as KeyboardEvent
    expect(asinCellKeys({ event: key('Enter'), editing: false, data: row({ asin: 'B0DE000001' }) }, 'DE', open)).toBe(true)
    expect(open).toHaveBeenCalledWith('https://www.amazon.de/dp/B0DE000001')
    expect(asinCellKeys({ event: key('c'), editing: false, data: row({ asin: 'B0DE000001' }) }, 'DE', open)).toBe(false)
    expect(asinCellKeys({ event: key('Enter'), editing: false, data: row({ asin: null }) }, 'DE', open)).toBe(false)
    expect(open).toHaveBeenCalledTimes(1)
  })
})

/* ── eBay: the Item ID (Item ID control, step I1) ─────────────────────────────────────────────────────────────────── */

const SET_ON_MAIN = 'Set on the main row: one eBay Item ID carries the whole variation family.'
function ebayRow(over: { value?: string | null; listing?: Record<string, unknown> | null; parentId?: string | null; reason?: string | null } = {}): ChannelSheetRow {
  const listing = over.listing === null ? null : { id: 'L-IT', version: 7, externalListingId: over.value ?? null, listingStatus: 'ACTIVE', isPublished: true, ...over.listing }
  const main = !over.parentId
  return {
    rowId: 'primary:p', id: 'p', sku: 'JKT', isParent: main, parentId: over.parentId ?? null, listing,
    values: { listing_item_id: { value: over.value ?? null, editable: main && !!listing, writable: main && !!listing, writeBlockedReason: main ? null : over.reason ?? SET_ON_MAIN } },
  } as unknown as ChannelSheetRow
}
const EBAY = { channel: 'EBAY', marketplace: 'IT' } as const
const ITEM_COL = { ...COL, key: 'listing_item_id', writeField: 'listing_item_id', label: 'Item ID', width: 168 } as SheetColumn

describe('itemIdCellModel — what one row\'s eBay Item ID cell shows', () => {
  it('the server\'s value when it counts: the id, its eBay page on this market, the control on the main row', () => {
    expect(itemIdCellModel(ebayRow({ value: '520000000001' }), 'IT')).toEqual({ kind: 'item', itemId: '520000000001', url: 'https://www.ebay.it/itm/520000000001', ended: false, tooltip: ITEM_ID_COPY.live('520000000001'), editable: true })
    expect(itemIdCellModel(ebayRow({ value: '520000000001', listing: { listingStatus: 'ENDED' } }), 'IT')).toMatchObject({ kind: 'item', ended: true, tooltip: ITEM_ID_COPY.endedHover('520000000001') })
  })
  it('an id the server does not count is "Not confirmed": the held id, the reason in the hover', () => {
    const row = ebayRow({ value: null, listing: { externalListingId: '520000000009', listingStatus: 'DRAFT', isPublished: false } })
    expect(itemIdCellModel(row, 'IT')).toEqual({ kind: 'notConfirmed', itemId: '520000000009', label: 'Not confirmed', tooltip: ITEM_ID_COPY.notConfirmedHover('520000000009', 'DRAFT'), editable: true })
  })
  it('a draft; live without a number; no listing', () => {
    expect(itemIdCellModel(ebayRow({ listing: { listingStatus: 'DRAFT', isPublished: false } }), 'IT')).toMatchObject({ kind: 'draft', label: DRAFT_CHIP_LABEL, editable: true })
    expect(itemIdCellModel(ebayRow({}), 'IT')).toMatchObject({ kind: 'noNumber', label: 'No number recorded', tooltip: ITEM_ID_COPY.noNumberHover })
    expect(itemIdCellModel(ebayRow({ listing: null }), 'IT')).toEqual({ kind: 'none', tooltip: MATRIX_COPY.noListingYet, editable: false })
  })
  it('a variation row: read-only, its hover the server\'s sentence ("Set on the main row", or why it is not confirmed)', () => {
    expect(itemIdCellModel(ebayRow({ value: '520000000001', parentId: 'p' }), 'IT')).toMatchObject({ kind: 'item', editable: false, tooltip: SET_ON_MAIN })
    const other = 'Not confirmed: this row holds Item ID 520000000002, but the main row holds 520000000001.'
    expect(itemIdCellModel(ebayRow({ value: null, parentId: 'p', reason: other, listing: { externalListingId: '520000000002' } }), 'IT')).toMatchObject({ kind: 'notConfirmed', editable: false, tooltip: other })
  })
  it('one model for both channels; the text is the id that counts', () => {
    expect(listingIdCellModel(row({ asin: 'B0DE000001' }), { channel: 'AMAZON', marketplace: 'DE' })).toEqual(asinCellModel(row({ asin: 'B0DE000001' }), 'DE'))
    expect(listingIdCellModel(ebayRow({ value: '520000000001' }), EBAY)).toEqual(itemIdCellModel(ebayRow({ value: '520000000001' }), 'IT'))
    expect(listingIdCellText(ebayRow({ value: '520000000001' }), EBAY)).toBe('520000000001')
    expect(listingIdCellText(ebayRow({ value: null, listing: { externalListingId: '520000000009', listingStatus: 'ERROR' } }), EBAY)).toBe('')
    expect(isListingIdKey('listing_item_id') && isListingIdKey('listing_asin') && !isListingIdKey('stock_qty')).toBe(true)
  })
})

describe('the eBay Item ID keys: the control\'s door on the main row only', () => {
  const key = (k: string, extra: Partial<KeyboardEvent> = {}) => ({ key: k, type: 'keydown', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...extra }) as unknown as KeyboardEvent
  it('Enter opens it; Delete or Backspace opens Clear when an id is held; nothing else, never while editing', () => {
    expect(itemIdKeyIntent({ event: key('Enter'), editing: false, data: ebayRow({ value: '520000000001' }) }, 'IT')).toBe('edit')
    expect(itemIdKeyIntent({ event: key('Delete'), editing: false, data: ebayRow({ value: '520000000001' }) }, 'IT')).toBe('clear')
    expect(itemIdKeyIntent({ event: key('Backspace'), editing: false, data: ebayRow({ value: null, listing: { externalListingId: '520000000009', listingStatus: 'DRAFT' } }) }, 'IT')).toBe('clear')
    expect(itemIdKeyIntent({ event: key('Delete'), editing: false, data: ebayRow({ listing: { listingStatus: 'DRAFT', isPublished: false } }) }, 'IT')).toBeNull()
    expect(itemIdKeyIntent({ event: key('c', { ctrlKey: true } as never), editing: false, data: ebayRow({ value: '520000000001' }) }, 'IT')).toBeNull()
    expect(itemIdKeyIntent({ event: key('Enter'), editing: true, data: ebayRow({ value: '520000000001' }) }, 'IT')).toBeNull()
  })
  it('a variation row takes no key (the grid\'s own Enter says "Set on the main row")', () => {
    expect(itemIdKeyIntent({ event: key('Enter'), editing: false, data: ebayRow({ value: '520000000001', parentId: 'p' }) }, 'IT')).toBeNull()
  })
})

describe('listingIdColumnDef — eBay', () => {
  const def = listingIdColumnDef(ITEM_COL, EBAY)
  it('never the grid\'s editor; the id that counts is the text; the hover is the model\'s; wide enough for three actions', () => {
    expect(def.editable).toBe(false)
    expect(def.cellRenderer).toBe(ItemIdCell)
    expect(def.width).toBe(ITEM_ID_COLUMN_MIN_WIDTH)
    expect((def.valueGetter as (p: unknown) => unknown)({ data: ebayRow({ value: '520000000001' }) })).toBe('520000000001')
    expect((def.valueGetter as (p: unknown) => unknown)({ data: ebayRow({ value: null, listing: { externalListingId: '520000000009', listingStatus: 'DRAFT' } }) })).toBeNull()
    expect((def.tooltipValueGetter as (p: unknown) => unknown)({ data: ebayRow({ value: '520000000001', parentId: 'p' }) })).toBe(SET_ON_MAIN)
    expect((def.valueSetter as (p: unknown) => unknown)({})).toBe(false)
  })
  it('keeps the grid off the keys the control takes (Enter, Delete on a main row)', () => {
    const k = (key: string) => ({ event: { key, type: 'keydown', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }, editing: false })
    expect((def.suppressKeyboardEvent as (p: unknown) => boolean)({ ...k('Enter'), data: ebayRow({ value: '520000000001' }) })).toBe(true)
    expect((def.suppressKeyboardEvent as (p: unknown) => boolean)({ ...k('Enter'), data: ebayRow({ value: '520000000001', parentId: 'p' }) })).toBe(false)
    expect((def.suppressKeyboardEvent as (p: unknown) => boolean)({ ...k('ArrowDown'), data: ebayRow({ value: '520000000001' }) })).toBe(false)
  })
  it('the Amazon branch is the ASIN\'s, as before', () => {
    const amazon = listingIdColumnDef(COL, { channel: 'AMAZON', marketplace: 'DE' })
    expect(amazon.cellRenderer).toBe(AsinCell)
    expect(amazon.width).toBe(ASIN_COLUMN_MIN_WIDTH)
  })
})

describe('ItemIdCell — DS parts only', () => {
  const render = (data: ChannelSheetRow) => renderToStaticMarkup(createElement(ItemIdCell, {
    data, market: 'IT', node: { rowIndex: 0 }, api: { setFocusedCell: () => {} }, column: { getColId: () => 'listing_item_id' }, eGridCell: null,
  } as never))
  it('an id: mono text with Copy and Open on eBay; ended adds the muted Ended pill', () => {
    const html = render(ebayRow({ value: '520000000001' }))
    expect(html).toContain('>520000000001<')
    expect(html).toContain(`aria-label="${ITEM_ID_COPY.copy('520000000001')}"`)
    expect(html).toContain(`aria-label="${ITEM_ID_COPY.open}"`)
    expect(render(ebayRow({ value: '520000000001', listing: { listingStatus: 'ENDED' } }))).toContain('>Ended<')
  })
  it('Not confirmed and No number recorded are warning pills; a draft the info pill; no listing a dash', () => {
    const nc = render(ebayRow({ value: null, listing: { externalListingId: '520000000009', listingStatus: 'DRAFT', isPublished: false } }))
    expect(nc).toContain('Not confirmed')
    expect(nc).toContain('520000000009')
    expect(render(ebayRow({}))).toContain('No number recorded')
    expect(render(ebayRow({ listing: { listingStatus: 'DRAFT', isPublished: false } }))).toContain(DRAFT_CHIP_LABEL)
    expect(render(ebayRow({ listing: null }))).toContain('—')
  })
  it('without the sheet\'s control (no provider) the cell offers no Change action', () => {
    expect(render(ebayRow({ value: '520000000001' }))).not.toContain(ITEM_ID_COPY.change)
  })
})
