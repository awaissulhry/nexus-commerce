/**
 * Amazon sheet gaps (gap 5) — the ASIN cell: an assigned ASIN with its Copy and Open on Amazon actions, the shared
 * "ASIN pending" and draft states with the header chips' words, a dash otherwise, and the parent's hover.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { MATRIX_COPY } from '../../matrix/contract'
import { ASIN_PENDING_CHIP_LABEL, asinPendingChipDetail, DRAFT_CHIP_LABEL, draftChipDetail } from '../../draftListing'
import { ASIN_COLUMN_MIN_WIDTH, ASIN_COPY, AsinCell, asinCellKeys, asinCellModel, asinColumnDef, PARENT_ASIN_NOTE } from './AsinCell'
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
