import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

/*
 * Step 4.3 #3 (A-52; R-55) — the bullets editor, mounted in node (the FormulaCellEditor pattern): AG's hook, the DS
 * Textarea and OrderedList are replaced by recorders so the arms read exactly what the editor hands them.
 */
const capture = vi.hoisted(() => ({ lifecycle: null as any, list: null as any, fields: [] as any[] }))
vi.mock('ag-grid-react', () => ({ useGridCellEditor: (props: any) => { capture.lifecycle = props } }))
vi.mock('../../primitives', () => ({
  Textarea: React.forwardRef((props: any, _ref: any) => { capture.fields.push(props); return null }),
  Button: (props: any) => React.createElement('button', null, props.children),
}))
vi.mock('../../components/OrderedList', () => ({
  OrderedList: (props: any) => {
    capture.list = props
    return React.createElement(React.Fragment, null, ...props.items.map((id: string) => React.createElement('div', { key: id, 'data-id': id }, props.renderItem(id))))
  },
}))

import { SlotListEditor, slotListMoveFact } from './SlotListEditor'
import { EDITOR_KEY_HINT_FORM } from './editorHint'

afterEach(() => { vi.unstubAllGlobals(); capture.fields = []; capture.list = null; capture.lifecycle = null })

const TEN = ['one', 'two', '', 'four', 'five', 'six', '', 'eight', 'nine', 'ten']
const SLOTS = { mode: 'slots' as const, max: 10, maxLength: 700, itemLabel: 'Bullet', label: 'Bullet points' }
const LIST = { mode: 'list' as const, max: null, maxLength: null, itemLabel: 'Bullet', label: 'Bullet points' }

function mount(slotList: typeof SLOTS | typeof LIST, value: unknown, extra: Record<string, unknown> = {}) {
  vi.stubGlobal('window', { innerWidth: 1600 })
  const onValueChange = vi.fn()
  const html = renderToStaticMarkup(React.createElement(SlotListEditor, {
    slotList: slotList as never, value, onValueChange,
    column: { getActualWidth: () => 240, getColId: () => 'slots:bulletPoints' }, ...extra,
  } as any))
  return { html, onValueChange }
}

describe('slots mode — fixed positions, holes in place', () => {
  it('mounts ten positions with stable ids p1…p10, labelled Bullet 1…10, holes shown empty', () => {
    mount(SLOTS, TEN)
    expect(capture.list.items).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'p10'])
    expect(capture.fields.map(f => f['aria-label'])).toEqual(TEN.map((_, i) => `Bullet ${i + 1}`))
    expect(capture.fields.map(f => f.value)).toEqual(TEN)
  })
  it('reports nothing on mount, and an untouched editor cancels (0 writes)', () => {
    const { onValueChange } = mount(SLOTS, TEN)
    expect(onValueChange).not.toHaveBeenCalled()
    expect(capture.lifecycle.isCancelAfterEnd()).toBe(true)
  })
  it('an edit of position 4 reports the WHOLE ten-position value once, holes intact, and is no longer a cancel', () => {
    const { onValueChange } = mount(SLOTS, TEN)
    capture.fields[3].onChange({ target: { value: 'FOUR' } })
    const expected = [...TEN]; expected[3] = 'FOUR'
    expect(onValueChange).toHaveBeenCalledTimes(1)
    expect(onValueChange).toHaveBeenCalledWith(expected)
    expect(capture.lifecycle.isCancelAfterEnd()).toBe(false)
  })
  it('a typed start key opens the form WITHOUT writing that letter into Bullet 1 (a stated choice)', () => {
    const { onValueChange } = mount(SLOTS, TEN, { eventKey: 'a' })
    expect(capture.fields[0].value).toBe('one')
    expect(onValueChange).not.toHaveBeenCalled()
    expect(capture.lifecycle.isCancelAfterEnd()).toBe(true)
  })
  it('an over-cap position is MARKED (aria-invalid, the counter), never truncated (no maxLength on the field)', () => {
    const long = 'x'.repeat(701)
    const { html } = mount(SLOTS, [long, ...TEN.slice(1)])
    expect(capture.fields[0]['aria-invalid']).toBe(true)
    expect(capture.fields[0].maxLength).toBeUndefined()
    expect(capture.fields[0].value).toHaveLength(701)
    expect(html).toContain('701 / 700')
    expect(html).toMatch(/class="nds-slotlist-count over"/)
    expect(capture.fields[1]['aria-invalid']).toBeUndefined()
  })
})

describe('list mode — Shared bullets', () => {
  it('the items plus ONE trailing empty position; typing into it reports n + 1 items, blanks dropped', () => {
    const { onValueChange } = mount(LIST, ['a', 'b'])
    expect(capture.fields.map(f => f.value)).toEqual(['a', 'b', ''])
    capture.fields[2].onChange({ target: { value: 'c' } })
    expect(onValueChange).toHaveBeenCalledWith(['a', 'b', 'c'])
  })
  it('clearing an item reports the list without it (the empty position is never a bullet)', () => {
    const { onValueChange } = mount(LIST, ['a', 'b'])
    capture.fields[0].onChange({ target: { value: '' } })
    expect(onValueChange).toHaveBeenCalledWith(['b'])
  })
})

describe('the frame — marker, key line, fact line', () => {
  it('is the slot-list editor and NEITHER the value/formula editor NOR the chip-list editor (the gate tells them apart)', () => {
    const { html } = mount(SLOTS, TEN)
    expect(html).toMatch(/class="nds-slotlist-editor/)
    expect(html).not.toContain('nds-formula-editor')
    expect(html).not.toContain('nds-list-editor')
    expect(html).toContain('data-slot-count="10"')
  })
  it('shows the R-55 key line in the key-hint class, and the Alt+↑↓ fact under it', () => {
    const { html } = mount(SLOTS, TEN)
    expect(html).toContain(`<span class="nds-editor-keyhint">${EDITOR_KEY_HINT_FORM}</span>`)
    expect(html).toContain(slotListMoveFact('Bullet'))
    expect(slotListMoveFact('Bullet')).toBe('Alt+↑↓ moves a bullet')
  })
  it('names the positions for the reorder control by their CURRENT position', () => {
    mount(SLOTS, TEN)
    expect(capture.list.itemLabel('p3')).toBe('Bullet 3')
    expect(capture.list.label).toBe('Bullet points')
  })
})
