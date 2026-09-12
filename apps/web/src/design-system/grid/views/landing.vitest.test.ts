import { describe, expect, it } from 'vitest'

import { allColumns, arrangementColumnState, resolveLanding } from './landing'
import { columnsViewPayload } from './viewPayload'

const KEYS = ['brand', 'item_name', 'bullet_point', 'color', 'size', 'name', 'status', 'basePrice', 'fabric_type']
const ALWAYS = ['product']

describe('allColumns — the ground state', () => {
  it('is identity first, then every column once, in the given order', () => {
    expect(allColumns(KEYS, ALWAYS)).toEqual(['product', ...KEYS])
  })
  it('never names a column twice, even when identity is also in the list', () => {
    expect(allColumns(['product', 'brand', 'brand'], ALWAYS)).toEqual(['product', 'brand'])
  })
  it('drops blanks rather than naming an empty column', () => {
    expect(allColumns(['', 'brand'], [''])).toEqual(['brand'])
  })
})

describe('resolveLanding — full by default, narrowed only by an EXPLICIT default view', () => {
  it('🔴 with no default view the sheet lands on ALL columns — on every scope, on every reload', () => {
    const r = resolveLanding({ orderedKeys: KEYS, always: ALWAYS })
    expect(r.columns).toEqual(['product', ...KEYS])
    expect(r.source).toEqual({ kind: 'all' })
  })

  it('a null default view is the same as none', () => {
    expect(resolveLanding({ orderedKeys: KEYS, always: ALWAYS, defaultView: null }).source).toEqual({ kind: 'all' })
  })

  it('lands on the operator’s default view, identity first, in the VIEW’s order', () => {
    const r = resolveLanding({
      orderedKeys: KEYS,
      always: ALWAYS,
      defaultView: { id: 'v1', name: 'Pricing', payload: columnsViewPayload(['basePrice', 'brand']) },
    })
    expect(r.columns).toEqual(['product', 'basePrice', 'brand'])
    expect(r.source).toEqual({ kind: 'saved', id: 'v1', name: 'Pricing', missing: [] })
  })

  it('REPORTS the columns a default view names that this product type lacks, and shows the rest', () => {
    const r = resolveLanding({
      orderedKeys: KEYS,
      always: ALWAYS,
      defaultView: { id: 'v1', name: 'Amazon launch', payload: columnsViewPayload(['basePrice', 'weave_type', 'brand']) },
    })
    expect(r.columns).toEqual(['product', 'basePrice', 'brand'])
    expect(r.source).toEqual({ kind: 'saved', id: 'v1', name: 'Amazon launch', missing: ['weave_type'] })
  })

  it('🔴 a default view NONE of whose columns exist here lands FULL and says which default it could not honour', () => {
    const r = resolveLanding({
      orderedKeys: KEYS,
      always: ALWAYS,
      defaultView: { id: 'v1', name: 'Knee sliders', payload: columnsViewPayload(['weave_type', 'closure_type']) },
    })
    expect(r.columns).toEqual(['product', ...KEYS])
    expect(r.source).toEqual({ kind: 'all', ignoredDefault: { id: 'v1', name: 'Knee sliders', missing: ['weave_type', 'closure_type'] } })
  })

  it('🔴 a schema-1 payload (an AG state blob) is NOT a columns view — the sheet lands full rather than guessing', () => {
    const r = resolveLanding({
      orderedKeys: KEYS,
      always: ALWAYS,
      defaultView: { id: 'old', name: 'Old', payload: { v: 1, gridState: { columnVisibility: { hiddenColIds: ['brand'] } }, page: {} } },
    })
    expect(r.columns).toEqual(['product', ...KEYS])
    expect(r.source).toEqual({ kind: 'all' })
  })

  it('a malformed payload is not a view either', () => {
    const r = resolveLanding({ orderedKeys: KEYS, always: ALWAYS, defaultView: { id: 'x', name: 'x', payload: 'nonsense' } })
    expect(r.source).toEqual({ kind: 'all' })
  })
})

describe('arrangementColumnState — widths, pins and sort come back; membership and order do NOT', () => {
  const current = ['product', 'brand', 'item_name', 'basePrice']

  it('nothing persisted → nothing to apply', () => {
    expect(arrangementColumnState(null, current)).toEqual([])
    expect(arrangementColumnState(undefined, current)).toEqual([])
    expect(arrangementColumnState({}, current)).toEqual([])
  })

  it('restores widths for columns that exist now', () => {
    const state = arrangementColumnState({ columnSizing: { columnSizingModel: [{ colId: 'brand', width: 300 }] } }, current)
    expect(state).toEqual([{ colId: 'brand', width: 300 }])
  })

  it('🔴 states ONLY what was persisted — no `pinned: null` or `sort: null` on the others (AG.1-c)', () => {
    const state = arrangementColumnState({ columnSizing: { columnSizingModel: [{ colId: 'brand', width: 300 }] } }, current)
    expect(state).toHaveLength(1)
    expect(Object.keys(state[0])).toEqual(['colId', 'width'])
  })

  it('restores pins and the sort, with the sort’s index', () => {
    const state = arrangementColumnState(
      {
        columnPinning: { leftColIds: ['product'], rightColIds: ['basePrice'] },
        sort: { sortModel: [{ colId: 'item_name', sort: 'desc' }, { colId: 'brand', sort: 'asc' }] },
      },
      current,
    )
    expect(state).toEqual([
      { colId: 'product', pinned: 'left' },
      { colId: 'brand', sort: 'asc', sortIndex: 1 },
      { colId: 'item_name', sort: 'desc', sortIndex: 0 },
      { colId: 'basePrice', pinned: 'right' },
    ])
  })

  it('🔴 drops persisted columns that no longer exist — a market switch removes columns legitimately', () => {
    const state = arrangementColumnState(
      { columnSizing: { columnSizingModel: [{ colId: 'weave_type', width: 200 }, { colId: 'brand', width: 120 }] }, columnPinning: { leftColIds: ['gone'], rightColIds: [] } },
      current,
    )
    expect(state).toEqual([{ colId: 'brand', width: 120 }])
  })

  it('🔴 IGNORES a persisted visibility or order slice even when present — those belong to the view', () => {
    const persisted = {
      columnVisibility: { hiddenColIds: ['brand'] },
      columnOrder: { orderedColIds: ['basePrice', 'brand'] },
      columnSizing: { columnSizingModel: [{ colId: 'brand', width: 90 }] },
    } as never
    expect(arrangementColumnState(persisted, current)).toEqual([{ colId: 'brand', width: 90 }])
  })

  it('a malformed entry is skipped rather than throwing', () => {
    const state = arrangementColumnState(
      { columnSizing: { columnSizingModel: [{ colId: 'brand' }, { width: 5 } as never, null as never] }, sort: { sortModel: [{ colId: 'brand', sort: 'sideways' as never }] } },
      current,
    )
    expect(state).toEqual([])
  })
})
