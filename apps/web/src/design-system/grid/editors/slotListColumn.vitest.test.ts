import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { CellSaveTracker } from './roundTrip'
import { SlotListEditor, SlotListValue, slotListProvenance, slotListSaveState } from './SlotListEditor'
import { slotListColumnDef, slotListEditable } from './slotListColumn'
import { suppressSlotListKeys, type SlotGroup } from './slotList'

/*
 * Step 4.3 #3 (A-52; R-55, R-56) — the ONE engine ColDef both builders return for the one bullets cell. Each arm below is
 * a property a sheet has already paid for on another column (VT.2's selector, the fill handle, a setter that must mutate).
 */
type Row = { rowId: string; values: Record<string, { value?: unknown; editable?: boolean; writable?: boolean }> }
const KEYS = Array.from({ length: 10 }, (_, i) => `bulletPoints_${i + 1}`)
const GROUP: SlotGroup = { of: 'bulletPoints', max: 10, keys: KEYS, maxLength: 700 }
const TEN = ['one', 'two', '', 'four', 'five', 'six', '', 'eight', 'nine', 'ten']
const rowOf = (values = TEN, extra: Partial<Record<string, { editable?: boolean; writable?: boolean }>> = {}): Row =>
  ({ rowId: 'r1', values: Object.fromEntries(KEYS.map((k, i) => [k, { value: values[i] === '' ? null : values[i], editable: true, ...(extra[k] ?? {}) }])) })

function setup(tracker = new CellSaveTracker()) {
  const setSlot = vi.fn((row: Row, key: string, value: string | null) => { row.values = { ...row.values, [key]: { ...row.values[key], value } }; return true })
  const def = slotListColumnDef<Row>(GROUP, { label: 'Bullet points', itemLabel: 'Bullet', cellOf: (r, k) => r.values[k], setSlot, rowIdOf: r => r.rowId, tracker,
    provenanceOf: (r, k) => ((r.values[k] as { prov?: string })?.prov ?? 'own') as never, required: () => true })
  return { def: def as Record<string, any>, setSlot, tracker }
}

describe('the one cell opens its own editor, never a formula selector', () => {
  it('SlotListEditor in a popup, the selector CLEARED (a selector beats cellEditor), slots mode with the cap', () => {
    const { def } = setup()
    expect(def.colId).toBe('slots:bulletPoints')
    expect(def.cellEditor).toBe(SlotListEditor)
    expect(def.cellEditorPopup).toBe(true)
    expect('cellEditorSelector' in def).toBe(true)
    expect(def.cellEditorSelector).toBeUndefined()
    expect(def.cellEditorParams).toEqual({ slotList: { mode: 'slots', max: 10, maxLength: 700, itemLabel: 'Bullet', label: 'Bullet points' } })
    expect(def.suppressKeyboardEvent).toBe(suppressSlotListKeys)
  })
  it('the fill handle is off, no pasted text is parsed, AG infers no data type; 240px', () => {
    const { def } = setup()
    expect(def.suppressFillHandle).toBe(true)
    expect(def.valueParser).toBeUndefined()
    expect(def.cellDataType).toBe(false)
    expect(def.width).toBe(240)
  })
})

describe('value and writes', () => {
  it('the value is exactly ten positions, holes as empty strings', () => {
    const { def } = setup()
    expect(def.valueGetter({ data: rowOf() })).toEqual(TEN)
  })
  it('the setter MUTATES the row through each changed slot\'s own setter — only the changed positions', () => {
    const { def, setSlot } = setup()
    const row = rowOf()
    const next = [...TEN]; next[3] = 'FOUR'; next[6] = 'SEVEN'
    expect(def.valueSetter({ data: row, newValue: next })).toBe(true)
    expect(setSlot.mock.calls.map(c => [c[1], c[2]])).toEqual([['bulletPoints_4', 'FOUR'], ['bulletPoints_7', 'SEVEN']])
    expect(def.valueGetter({ data: row })).toEqual(next)
  })
  it('a cleared position is written as null (a slot clear)', () => {
    const { def, setSlot } = setup()
    const next = [...TEN]; next[0] = ''
    def.valueSetter({ data: rowOf(), newValue: next })
    expect(setSlot).toHaveBeenCalledWith(expect.anything(), 'bulletPoints_1', null)
  })
  it('Delete (null), pasted text and an unchanged value write NOTHING', () => {
    const { def, setSlot } = setup()
    expect(def.valueSetter({ data: rowOf(), newValue: null })).toBe(false)
    expect(def.valueSetter({ data: rowOf(), newValue: 'pasted text' })).toBe(false)
    expect(def.valueSetter({ data: rowOf(), newValue: [...TEN] })).toBe(false)
    expect(setSlot).not.toHaveBeenCalled()
  })
  it('equality is structural — an untouched edit fires no change', () => {
    const { def } = setup()
    expect(def.equals([...TEN], [...TEN])).toBe(true)
    expect(def.equals(TEN, ['x', ...TEN.slice(1)])).toBe(false)
  })
})

describe('editability — every position or none', () => {
  it('editable when every slot cell is editable and writable; one locked or missing position locks the cell', () => {
    expect(slotListEditable(rowOf(), GROUP, (r, k) => r.values[k])).toBe(true)
    expect(slotListEditable(rowOf(TEN, { bulletPoints_5: { editable: false } }), GROUP, (r, k) => r.values[k])).toBe(false)
    expect(slotListEditable(rowOf(TEN, { bulletPoints_5: { writable: false } }), GROUP, (r, k) => r.values[k])).toBe(false)
    const missing = rowOf(); delete missing.values.bulletPoints_10
    expect(slotListEditable(missing, GROUP, (r, k) => r.values[k])).toBe(false)
    const { def } = setup()
    expect(def.cellClass({ data: rowOf(TEN, { bulletPoints_2: { editable: false } }) })).toContain('nds-cell-is-locked')
  })
})

describe('what the cell says', () => {
  const render = (row: Row, tracker = new CellSaveTracker(), prov?: (r: Row, k: string) => never) =>
    renderToStaticMarkup(React.createElement(SlotListValue as any, { data: row, value: null, group: GROUP, cellOf: (r: Row, k: string) => r.values[k], rowIdOf: (r: Row) => r.rowId, tracker, provenanceOf: prov, required: () => true }))
  it('"N of 10 · first bullet"', () => {
    expect(render(rowOf())).toContain('8 of 10 · one')
  })
  it('an empty list says 0 of 10 and the required mark', () => {
    const html = render(rowOf(Array(10).fill('')))
    expect(html).toContain('0 of 10')
    expect(html).toContain('nds-cell-required')
  })
  it('wears the inherited mark only when EVERY filled position is inherited', () => {
    const inherited = (() => 'inherited') as never
    expect(render(rowOf(), new CellSaveTracker(), inherited)).toContain('nds-cell-prov-inherited')
    expect(slotListProvenance(rowOf(), GROUP, TEN, (_r, k) => (k === 'bulletPoints_2' ? 'pinned' : 'inherited'))).toBe('own')
  })
  it('copy / export text numbers the filled positions', () => {
    const { def } = setup()
    expect(def.valueFormatter({ value: TEN })).toBe('1. one\n2. two\n4. four\n5. five\n6. six\n8. eight\n9. nine\n10. ten')
  })
  it('the worst save state across the positions is the cell\'s, with the refusal sentence in the tooltip', () => {
    const tracker = new CellSaveTracker()
    tracker.set('r1', 'bulletPoints_2', 'saving')
    tracker.set('r1', 'bulletPoints_4', 'refused', 'Bullet 4 takes at most 700 characters')
    expect(slotListSaveState(tracker, 'r1', KEYS)).toEqual({ state: 'refused', reasons: ['Bullet 4 takes at most 700 characters'] })
    const { def } = setup(tracker)
    expect(def.cellClassRules['nds-cell-is-refused']({ data: rowOf() })).toBe(true)
    expect(def.tooltipValueGetter({ data: rowOf() })).toContain('Bullet 4 takes at most 700 characters')
  })
})
