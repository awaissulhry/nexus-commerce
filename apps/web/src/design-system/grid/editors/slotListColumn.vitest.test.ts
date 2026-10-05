import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { CellSaveTracker } from './roundTrip'
import { SlotListEditor, SlotListValue, slotListMark, slotListMarkText, slotListProvenance, slotListSaveState, type SlotMarkText } from './SlotListEditor'
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
  // W3-6 — the sheets' required mark: the header may say more than the list's name; the editor keeps the name.
  it('the header is the list\'s name, or the header the sheet passes ("Bullet points *")', () => {
    expect(setup().def.headerName).toBe('Bullet points')
    const marked = slotListColumnDef<Row>(GROUP, { label: 'Bullet points', headerName: 'Bullet points *', cellOf: (r, k) => r.values[k], setSlot: () => false, rowIdOf: (r) => r.rowId }) as Record<string, any>
    expect(marked.headerName).toBe('Bullet points *')
    expect(marked.cellEditorParams.slotList.label).toBe('Bullet points')
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
  const render = (row: Row, tracker = new CellSaveTracker(), prov?: (r: Row, k: string) => never, markOf?: (r: Row, k: string) => SlotMarkText | null) =>
    renderToStaticMarkup(React.createElement(SlotListValue as any, { data: row, value: null, group: GROUP, cellOf: (r: Row, k: string) => r.values[k], rowIdOf: (r: Row) => r.rowId, tracker, provenanceOf: prov, markOf, required: () => true, itemLabel: 'Bullet' }))
  it('"N of 10 · first bullet"', () => {
    expect(render(rowOf())).toContain('8 of 10 · one')
  })
  it('an empty list says 0 of 10 and the required mark', () => {
    const html = render(rowOf(Array(10).fill('')))
    expect(html).toContain('0 of 10')
    expect(html).toContain('nds-cell-required')
  })
  it('a list whose filled positions all share one member wears that mark, in the member’s own sentence (no source given)', () => {
    const inherited = (() => 'inherited') as never
    const html = render(rowOf(), new CellSaveTracker(), inherited)
    expect(html).toContain('nds-cell-prov-inherited')
    expect(html).toContain('aria-label="Inherited from the parent — edit to give this row its own value" title="Inherited from the parent — edit to give this row its own value"')
    expect(slotListMarkText(rowOf(), GROUP, TEN, () => 'inherited', 'Bullet')).toBeUndefined()
  })
  /* 🔴 2026-10-04: a MIXED list used to wear no mark (own), so a bullets cell with a pinned position looked exactly like
     one that simply follows. It now wears the strongest member and names which positions carry which. */
  it('a mixed list wears the strongest member by the one precedence, and its text names the positions', () => {
    const mixed = (_r: unknown, k: string) => (k === 'bulletPoints_2' ? 'pinned' : k === 'bulletPoints_4' || k === 'bulletPoints_5' ? 'inherited' : 'own') as never
    expect(slotListProvenance(rowOf(), GROUP, TEN, mixed)).toBe('inherited')
    expect(slotListMarkText(rowOf(), GROUP, TEN, mixed, 'Bullet')).toBe('Bullets 4 and 5: Inherited · Bullet 2: Pinned')
    const html = render(rowOf(), new CellSaveTracker(), mixed)
    expect(html).toContain('nds-cell-prov-inherited')
    expect(html).toContain('aria-label="Bullets 4 and 5: Inherited · Bullet 2: Pinned"')
    // Pinned on its own among plain positions: the pin shows, and only position 2 is named.
    const onePin = (_r: unknown, k: string) => (k === 'bulletPoints_2' ? 'pinned' : 'own') as never
    expect(slotListProvenance(rowOf(), GROUP, TEN, onePin)).toBe('pinned')
    expect(slotListMarkText(rowOf(), GROUP, TEN, onePin, 'Bullet')).toBe('Bullet 2: Pinned')
  })
  it('the strongest member wins across the whole chain: refused › attention › pending › … › pinned', () => {
    const by = (map: Record<string, string>) => (_r: unknown, k: string) => (map[k] ?? 'own') as never
    expect(slotListProvenance(rowOf(), GROUP, TEN, by({ bulletPoints_1: 'pinned', bulletPoints_9: 'refused' }))).toBe('refused')
    expect(slotListProvenance(rowOf(), GROUP, TEN, by({ bulletPoints_1: 'pending', bulletPoints_2: 'attention' }))).toBe('attention')
    expect(slotListProvenance(rowOf(), GROUP, TEN, by({ bulletPoints_1: 'listingValue', bulletPoints_2: 'pending' }))).toBe('pending')
    expect(slotListProvenance(rowOf(), GROUP, TEN, by({ bulletPoints_1: 'mapped', bulletPoints_2: 'listingLevel', bulletPoints_4: 'listingValue' }))).toBe('listingLevel')
    expect(slotListMarkText(rowOf(), GROUP, TEN, by({ bulletPoints_1: 'mapped', bulletPoints_2: 'listingLevel', bulletPoints_4: 'listingValue' }), 'Bullet'))
      .toBe('Bullet 2: One value for the whole listing · Bullet 4: Listing value · Bullet 1: Derived by a mapping rule')
  })
  /* 2026-10-04 (A2) — a UNIFORM list keeps its member's full words: the FIRST filled position's own text (`markOf`), so the
     bullets cell reads like that position's own cell on both scopes. */
  it('a uniform list reads the first filled position\'s own text — a refusal keeps the server reason verbatim', () => {
    const reason = 'Bullet 1 takes at most 700 characters — this one has 812'
    const marks: Record<string, SlotMarkText> = { bulletPoints_1: { from: reason }, bulletPoints_2: { from: 'another reason' } }
    const markOf = (_r: Row, k: string) => marks[k] ?? null
    expect(slotListMark(rowOf(), GROUP, TEN, () => 'refused', markOf, 'Bullet')).toEqual({ from: reason })
    const html = render(rowOf(), new CellSaveTracker(), (() => 'refused') as never, markOf)
    expect(html).toContain('nds-cell-prov-refused')
    expect(html).toContain(`aria-label="${reason}" title="${reason}"`)
  })
  it('a uniform pending / pinned list keeps its sentence, or names what the pin no longer follows', () => {
    const pendingOf = (_r: Row, k: string) => (k === 'bulletPoints_1' ? { from: 'Live until you publish: old text' } : { from: 'x' })
    expect(render(rowOf(), new CellSaveTracker(), (() => 'pending') as never, pendingOf)).toContain('aria-label="Live until you publish: old text"')
    const pinnedOf = (_r: Row, k: string) => ({ from: k === 'bulletPoints_1' ? 'the Shared product' : 'elsewhere' })
    expect(render(rowOf(), new CellSaveTracker(), (() => 'pinned') as never, pinnedOf)).toContain('aria-label="Pinned on this row — it no longer follows the Shared product"')
    // The first FILLED position: position 1 empty → position 2's text.
    const holes = ['', 'two', 'three', '', '', '', '', '', '', '']
    expect(slotListMark(rowOf(holes), GROUP, holes, () => 'pinned', pinnedOf, 'Bullet')).toEqual({ from: 'elsewhere' })
  })
  it('a mixed list ignores markOf (it names the positions); no markOf or no mark → the member\'s own words', () => {
    const mixed = (_r: unknown, k: string) => (k === 'bulletPoints_2' ? 'pinned' : 'own') as never
    expect(slotListMark(rowOf(), GROUP, TEN, mixed, () => ({ from: 'Main listing' }), 'Bullet')).toEqual({ tooltip: 'Bullet 2: Pinned' })
    expect(slotListMark(rowOf(), GROUP, TEN, () => 'pinned', undefined, 'Bullet')).toEqual({})
    expect(slotListMark(rowOf(), GROUP, TEN, () => 'own', () => ({ from: 'x' }), 'Bullet')).toEqual({})
    expect(slotListMark(rowOf(), GROUP, TEN, undefined, () => ({ from: 'x' }), 'Bullet')).toEqual({})
  })
  it('the cell is MarkedValue\'s layout — no cell-only class', () => {
    const html = render(rowOf(), new CellSaveTracker(), (() => 'inherited') as never)
    expect(html).toMatch(/^<span class="nds-cell-value"><span class="nds-cell-prov nds-cell-prov-inherited"[^>]*>.*<\/span><span class="nds-cell-value-text">8 of 10 · one<\/span><\/span>$/)
  })
  it('markOf reaches the renderer from the column', () => {
    const markOf = () => ({ from: 'x' })
    const def = slotListColumnDef<Row>(GROUP, { label: 'Bullet points', cellOf: (r, k) => r.values[k], setSlot: () => false, rowIdOf: (r) => r.rowId, markOf }) as Record<string, any>
    expect(def.cellRendererParams.markOf).toBe(markOf)
  })
  it('an EMPTY position says nothing about the list — its member is never counted', () => {
    // Position 3 is empty in TEN; a refusal there does not mark the list.
    expect(slotListProvenance(rowOf(), GROUP, TEN, (_r, k) => (k === 'bulletPoints_3' ? 'refused' : 'own'))).toBe('own')
    expect(slotListMarkText(rowOf(), GROUP, TEN, (_r, k) => (k === 'bulletPoints_3' ? 'refused' : 'own'), 'Bullet')).toBeUndefined()
  })
  it('the one cell wears the TINT of the member its mark shows, beside the save-state classes', () => {
    const { def } = setup()
    const row = rowOf()
    row.values.bulletPoints_2 = { ...row.values.bulletPoints_2, prov: 'pinned' } as never
    expect(def.cellClassRules['nds-cell-is-pinned']({ data: row, colDef: { colId: def.colId } })).toBe(true)
    expect(def.cellClassRules['nds-cell-is-inherited']({ data: row, colDef: { colId: def.colId } })).toBe(false)
    expect(def.cellClassRules['nds-cell-is-pinned']({ data: rowOf(), colDef: { colId: def.colId } })).toBe(false)
    expect(def.cellRendererParams.itemLabel).toBe('Bullet')
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
