import { describe, expect, it } from 'vitest'

import { COLUMNS_VIEW_SCHEMA, SHEET_LAYOUT_SCHEMA, columnsViewPayload, isColumnsViewPayload, sheetLayoutPayload, viewDisplayOf } from './viewPayload'

describe('columnsViewPayload', () => {
  it('stores the keys in the given order, once each, blanks dropped', () => {
    expect(columnsViewPayload(['brand', 'basePrice', 'brand', '', '  '])).toEqual({ v: COLUMNS_VIEW_SCHEMA, kind: 'columns', columns: ['brand', 'basePrice'] })
  })
  it('carries a chip only when one is named', () => {
    expect(columnsViewPayload(['brand'], 'missing-required').chip).toBe('missing-required')
    expect('chip' in columnsViewPayload(['brand'], null)).toBe(false)
    expect('chip' in columnsViewPayload(['brand'])).toBe(false)
  })
})

describe('sheetLayoutPayload', () => {
  const layout = () => sheetLayoutPayload({
    columns: ['brand', 'basePrice'],
    columnOrder: ['brand', 'weightValue', 'basePrice', 'unavailable_in_this_market'],
    lockedColumns: ['brand'],
    groupOrder: ['master:identity', 'master:pricing', 'master:physical'],
    groupOverrides: { brand: 'master:pricing', unavailable_in_this_market: 'master:physical' },
    chip: 'missing-required',
  })

  it('round-trips full layout, retaining hidden and unavailable columns and group assignments', () => {
    const payload = layout()
    expect(payload.v).toBe(SHEET_LAYOUT_SCHEMA)
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload)
    expect(isColumnsViewPayload(JSON.parse(JSON.stringify(payload)))).toBe(true)
    expect(payload.columnOrder).toEqual(['brand', 'weightValue', 'basePrice', 'unavailable_in_this_market'])
    expect(payload.groupOverrides).toEqual({ brand: 'master:pricing', unavailable_in_this_market: 'master:physical' })
    expect(payload.chip).toBe('missing-required')
  })

  it('deduplicates every ordered set and drops blank keys and destinations without changing identities', () => {
    expect(sheetLayoutPayload({
      columns: [' brand ', 'brand', ''],
      columnOrder: ['brand', 'weightValue', 'brand', ' '],
      lockedColumns: ['brand', 'brand', ''],
      groupOrder: ['master:physical', 'master:physical', ''],
      groupOverrides: { ' brand ': ' master:physical ', '': 'master:physical', weightValue: ' ' },
    })).toEqual({
      v: 3, kind: 'columns', columns: ['brand'], columnOrder: ['brand', 'weightValue'],
      lockedColumns: ['brand'], groupOrder: ['master:physical'], groupOverrides: { brand: 'master:physical' },
    })
  })

  it.each(['columnOrder', 'lockedColumns', 'groupOrder', 'groupOverrides'] as const)('rejects a schema-3 layout missing %s', (key) => {
    const payload: Record<string, unknown> = { ...layout() }
    delete payload[key]
    expect(isColumnsViewPayload(payload)).toBe(false)
  })

  it('rejects invalid ordered sets, group maps and unknown versions while preserving schema 2', () => {
    for (const key of ['columns', 'columnOrder', 'lockedColumns', 'groupOrder']) {
      for (const invalid of [null, 'brand', [1], [' ']]) {
        expect(isColumnsViewPayload({ ...layout(), [key]: invalid })).toBe(false)
      }
    }
    for (const groupOverrides of [null, [], 'group', { brand: 1 }, { brand: '' }, { '': 'master:identity' }]) {
      expect(isColumnsViewPayload({ ...layout(), groupOverrides })).toBe(false)
    }
    expect(isColumnsViewPayload({ ...layout(), v: 4 })).toBe(false)
    expect(isColumnsViewPayload({ v: 2, kind: 'columns', columns: ['brand'], chip: null })).toBe(true)
    expect(columnsViewPayload(['brand']).v).toBe(2)
  })
})

describe('isColumnsViewPayload — checked, never cast', () => {
  it('accepts what columnsViewPayload writes', () => {
    expect(isColumnsViewPayload(columnsViewPayload(['a']))).toBe(true)
    expect(isColumnsViewPayload(columnsViewPayload(['a'], 'chip'))).toBe(true)
  })
  it('🔴 rejects a schema-1 grid-state blob — the shape /products/next saves', () => {
    expect(isColumnsViewPayload({ v: 1, gridState: {}, page: {} })).toBe(false)
  })
  it('rejects the wrong kind, a missing list, or a list holding non-strings', () => {
    expect(isColumnsViewPayload({ v: 2, kind: 'rows', columns: [] })).toBe(false)
    expect(isColumnsViewPayload({ v: 2, kind: 'columns' })).toBe(false)
    expect(isColumnsViewPayload({ v: 2, kind: 'columns', columns: [1] })).toBe(false)
    expect(isColumnsViewPayload({ v: 2, kind: 'columns', columns: ['a'], chip: 3 })).toBe(false)
  })
  it('rejects null, primitives and arrays', () => {
    expect(isColumnsViewPayload(null)).toBe(false)
    expect(isColumnsViewPayload('x')).toBe(false)
    expect(isColumnsViewPayload(['a'])).toBe(false)
  })
})

describe('viewDisplayOf — what a view restores besides its columns (2026-09-26)', () => {
  it('reads widths, sort and row height exactly as stored', () => {
    const display = viewDisplayOf({ ...columnsViewPayload(['brand']), columnWidths: { brand: 180.4, color: 96 }, sort: [{ colId: 'color', sort: 'desc' }, { colId: 'brand', sort: 'asc' }], density: 'compact' })
    expect(display).toEqual({ columnWidths: { brand: 180, color: 96 }, sort: [{ colId: 'color', sort: 'desc' }, { colId: 'brand', sort: 'asc' }], density: 'compact' })
  })

  it('returns nothing for a view saved before the fields existed, so it leaves the screen alone', () => {
    expect(viewDisplayOf(columnsViewPayload(['brand']))).toEqual({})
    expect(viewDisplayOf(null)).toEqual({})
    expect(viewDisplayOf(['brand'])).toEqual({})
  })

  it('keeps an EMPTY sort — it means "unsorted", which is different from absent', () => {
    expect(viewDisplayOf({ sort: [] })).toEqual({ sort: [] })
  })

  it('drops every entry the grid could not apply instead of applying it', () => {
    const display = viewDisplayOf({
      columnWidths: { brand: 5, color: 'wide', size: 3000, ' ': 100, material: 140 },
      sort: [{ colId: 'brand', sort: 'up' }, { colId: '', sort: 'asc' }, { colId: 'color', sort: 'asc' }, { colId: 'color', sort: 'desc' }, 'size'],
      density: 'tiny',
    })
    expect(display).toEqual({ columnWidths: { material: 140 }, sort: [{ colId: 'color', sort: 'asc' }] })
  })

  it('a payload carrying the fields is still a columns view (the fields are additive)', () => {
    expect(isColumnsViewPayload({ ...columnsViewPayload(['brand']), density: 'cozy', sort: [] })).toBe(true)
  })
})
