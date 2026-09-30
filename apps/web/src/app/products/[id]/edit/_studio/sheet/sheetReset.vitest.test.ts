import { describe, expect, it } from 'vitest'
import {
  channelResetOffer, clearChoiceCounts, controlColumnFacts, deleteAsks, isClearKey, isMenuKey, masterResetOffer, resetTargets,
  selectedCells, wireCellValue, withControlVerbs, type SelectionApi,
} from './sheetReset'
import type { ChannelSheetRow, StudioCellValue } from './channel/types'
import type { StudioRow } from './master/types'

/** P1 — full control (report 2 I-5, I-6; report 1 I-10): which cells a reset, a clear and a column verb touch. */
const cell = (over: Partial<StudioCellValue> = {}): StudioCellValue => ({
  value: 'Xavia Racing', source: 'channelExplicit', inheritedFrom: null, inherited: false, layer: 'channel', pinned: true, follows: false,
  editable: true, linkGroupId: null, mapped: null, writeField: 'attr_brand', writeTarget: 'channelListing', writeVerb: 'channel',
  affectsAllChannels: false, writable: true, ...over,
}) as StudioCellValue
const channelRow = (values: Record<string, StudioCellValue>, kind: 'variant' | 'parent' = 'variant') =>
  ({ id: 'p1', rowId: 'primary:p1', sku: 'REGAL-L', rowKind: kind, aliasId: null, values }) as unknown as ChannelSheetRow

describe('channelResetOffer — a reset exists where the value is this listing’s own', () => {
  it('offers "Reset to inherited" on a listing override, on a band and on a variant', () => {
    expect(channelResetOffer(channelRow({ brand: cell() }), 'brand')).toEqual({ intent: 'reset', formula: false, label: 'Reset to inherited' })
    expect(channelResetOffer(channelRow({ brand: cell({ layer: 'alias' }) }, 'parent'), 'brand')?.intent).toBe('reset')
  })
  it('offers nothing on a value that already follows Master, on a cell that writes the shared record, or on a locked cell', () => {
    expect(channelResetOffer(channelRow({ brand: cell({ layer: 'master', pinned: false, follows: true, source: 'masterColumn' }) }), 'brand')).toBeNull()
    expect(channelResetOffer(channelRow({ brand: cell({ writeTarget: 'master' }) }), 'brand')).toBeNull()
    expect(channelResetOffer(channelRow({ brand: cell({ editable: false }) }), 'brand')).toBeNull()
    expect(channelResetOffer(channelRow({}), 'brand')).toBeNull()
  })
  it('calls an old listing text’s reset "Follow Master", a list’s a whole-list reset, and a formula cell’s a formula removal', () => {
    expect(channelResetOffer(channelRow({ name: cell({ source: 'channelSnapshot', layer: 'master', pinned: false, follows: true }) }), 'name')?.label).toBe('Follow Master')
    expect(channelResetOffer(channelRow({ imageUrls_2: cell({ writeField: 'imageUrls[2]' }) }), 'imageUrls_2')).toMatchObject({ intent: 'reset-list', label: 'Reset list to inherited…' })
    expect(channelResetOffer(channelRow({ brand: cell() }), 'brand', true)).toEqual({ intent: 'reset', formula: true, label: 'Remove formula and reset to inherited' })
  })
  it('includes a pinned AI or outdated translation (Cell details used to exclude them by kind)', () => {
    const ai = cell({ tier: 'pin', provenance: { member: 'ai', from: 'Italian · eBay · IT · pin' }, translation: { source: 'ai', reviewedAt: null, outdated: false } } as never)
    expect(channelResetOffer(channelRow({ name: ai }), 'name')?.intent).toBe('reset')
  })
})

const masterRow = (values: Record<string, unknown>, over: Partial<StudioRow> = {}) =>
  ({ id: 'child', sku: 'REGAL-L', isParent: false, parentId: 'regal', values, ...over }) as unknown as StudioRow
const mcell = (over: Record<string, unknown> = {}) => ({ value: 'Xavia', source: 'masterColumn', inheritedFrom: null, inherited: false, editable: true, ...over })
const col = (key: string, over: Record<string, unknown> = {}) => ({ key, scope: 'global' as const, editable: true, writeField: key, ...over })

describe('masterResetOffer — a variation’s own value, or a row’s own translation', () => {
  it('offers a reset on a variation’s own value of a column the family holds (the Master menu had none)', () => {
    expect(masterResetOffer(masterRow({ brand: mcell() }), col('brand'))).toEqual({ intent: 'reset', formula: false, label: 'Reset to inherited' })
    expect(masterResetOffer(masterRow({ brand: mcell({ value: null, pinned: true }) }), col('brand'))?.intent).toBe('reset')
  })
  it('offers nothing on the family row, on an inherited value, on a per-variant axis or on a fact a variation never inherits', () => {
    expect(masterResetOffer(masterRow({ brand: mcell() }, { isParent: true, parentId: null }), col('brand'))).toBeNull()
    expect(masterResetOffer(masterRow({ brand: mcell({ inherited: true }) }), col('brand'))).toBeNull()
    expect(masterResetOffer(masterRow({ color: mcell() }), col('color', { scope: 'per_variant' }))).toBeNull()
    for (const key of ['basePrice', 'totalStock', 'status', 'lowStockThreshold']) expect(masterResetOffer(masterRow({ [key]: mcell() }), col(key))).toBeNull()
  })
  it('offers a reset on a row’s own translation, the family row too (the language shows its source again)', () => {
    expect(masterResetOffer(masterRow({ name: mcell({ tier: 'language' }) }, { isParent: true, parentId: null }), col('name'))?.intent).toBe('reset')
  })
})

describe('resetTargets', () => {
  it('keeps only the cells that have a reset, each once, and a list once per row', () => {
    const offers: Record<string, { intent: 'reset' | 'reset-list'; formula: boolean; label: string } | null> = {
      'a:brand': { intent: 'reset', formula: false, label: '' }, 'a:img_1': { intent: 'reset-list', formula: false, label: '' },
      'a:img_2': { intent: 'reset-list', formula: false, label: '' }, 'b:brand': null,
    }
    const targets = resetTargets(
      [{ rowId: 'a', colId: 'brand' }, { rowId: 'a', colId: 'brand' }, { rowId: 'a', colId: 'img_1' }, { rowId: 'a', colId: 'img_2' }, { rowId: 'b', colId: 'brand' }],
      (r, c) => offers[`${r}:${c}`] ?? null, (_r, c) => (c.startsWith('img_') ? 'imageUrls' : null))
    expect(targets).toEqual([{ rowId: 'a', colId: 'brand', intent: 'reset', formula: false }, { rowId: 'a', colId: 'img_1', intent: 'reset-list', formula: false }])
  })
})

describe('selectedCells', () => {
  const rows = ['r0', 'r1', 'r2', 'r3'].map(id => ({ id }))
  const api = (ranges: ReturnType<SelectionApi<{ id: string }>['getCellRanges']>, focused: ReturnType<SelectionApi<{ id: string }>['getFocusedCell']> = null): SelectionApi<{ id: string }> => ({
    getCellRanges: () => ranges, getFocusedCell: () => focused, getDisplayedRowAtIndex: (i: number) => (rows[i] ? { data: rows[i] } : undefined),
  })
  const colOf = (id: string) => ({ getColId: () => id })
  it('reads every cell of every range once, in row then column order, whichever way it was dragged', () => {
    const cells = selectedCells(api([{ startRow: { rowIndex: 2 }, endRow: { rowIndex: 1 }, columns: [colOf('brand'), colOf('material')] }, { startRow: { rowIndex: 1 }, endRow: { rowIndex: 1 }, columns: [colOf('brand')] }]), r => r.id)
    expect(cells.map(c => `${c.rowId}:${c.colId}`)).toEqual(['r1:brand', 'r1:material', 'r2:brand', 'r2:material'])
  })
  it('falls back to the focused cell, and never reads a pinned row', () => {
    expect(selectedCells(api([], { rowIndex: 3, column: colOf('name') }), r => r.id).map(c => c.rowId)).toEqual(['r3'])
    expect(selectedCells(api([], { rowIndex: 0, rowPinned: 'top', column: colOf('name') }), r => r.id)).toEqual([])
  })
})

describe('Delete asks only where Clear and Reset differ', () => {
  it('counts what each answer would do', () => {
    const counts = clearChoiceCounts([{ rowId: 'a', colId: 'x' }, { rowId: 'b', colId: 'x' }], (r) => r === 'a', (r) => (r === 'b' ? { intent: 'reset', formula: false, label: '' } : null))
    expect(counts).toEqual({ clearable: 1, resettable: 1 })
  })
  it('asks on a channel or a variation; clears a family row straight away, as before', () => {
    expect(deleteAsks({ clearable: 3, resettable: 0 }, true)).toBe(true)
    expect(deleteAsks({ clearable: 3, resettable: 2 }, false)).toBe(true)
    expect(deleteAsks({ clearable: 3, resettable: 0 }, false)).toBe(false)
  })
  it('answers Delete/Backspace outside an editor, and Shift+F10 / ContextMenu as the menu key', () => {
    const key = (k: string, mods: Partial<KeyboardEvent> = {}) => ({ key: k, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...mods }) as KeyboardEvent
    expect(isClearKey(key('Delete'), false)).toBe(true)
    expect(isClearKey(key('Backspace'), false)).toBe(true)
    expect(isClearKey(key('Delete'), true)).toBe(false)
    expect(isClearKey(key('Delete', { metaKey: true }), false)).toBe(false)
    expect(isMenuKey(key('F10', { shiftKey: true }))).toBe(true)
    expect(isMenuKey(key('ContextMenu'))).toBe(true)
    expect(isMenuKey(key('F10'))).toBe(false)
  })
})

describe('the column verbs', () => {
  it('act on attribute columns only, and never offer "Set every row…" on a Shopify field', () => {
    for (const key of ['__productRole', '__parentSku', 'productMedia', 'progress:scope', 'slots:bulletPoints']) expect(controlColumnFacts({ key, label: key })).toBeNull()
    expect(controlColumnFacts({ key: 'variation_theme', label: 'Theme', kind: 'variationTheme' })).toBeNull()
    expect(controlColumnFacts({ key: 'sku', label: 'SKU', editable: false })).toBeNull()
    expect(controlColumnFacts({ key: 'brand', label: 'Brand', kind: 'select', options: ['Xavia'], mode: 'open' })).toMatchObject({ colId: 'brand', mode: 'open' })
    expect(controlColumnFacts({ key: 'custom.fit', label: 'Fit', shopifyField: {} })?.settable).toBe(false)
  })
  it('give a column its header items and keep AG off Delete, without losing the column’s own key rules', () => {
    const own = (p: { event: KeyboardEvent }) => p.event.key === 'Tab'
    const def = withControlVerbs({ colId: 'brand', suppressKeyboardEvent: own as never }, () => true, id => [`Set every row · ${id}`])
    const suppress = def.suppressKeyboardEvent as unknown as (p: { event: Partial<KeyboardEvent>; editing: boolean }) => boolean
    expect(suppress({ event: { key: 'Delete' }, editing: false })).toBe(true)
    expect(suppress({ event: { key: 'Delete' }, editing: true })).toBe(false)
    expect(suppress({ event: { key: 'Tab' }, editing: true })).toBe(true)
    expect(((def as { context?: unknown }).context as { menuItems: () => unknown[] }).menuItems()).toEqual(['Set every row · brand'])
    const media = { colId: 'productMedia' }
    expect(withControlVerbs(media, id => id !== 'productMedia', () => [])).toBe(media)
  })
})

describe('an emptied list leaves as a clear (report 1 I-10)', () => {
  it('sends null for [] — the write path refused [] with "0 values — needs at least 1"', () => {
    expect(wireCellValue([])).toBeNull()
    expect(wireCellValue(['giacca'])).toEqual(['giacca'])
    expect(wireCellValue('')).toBe('')
  })
})
