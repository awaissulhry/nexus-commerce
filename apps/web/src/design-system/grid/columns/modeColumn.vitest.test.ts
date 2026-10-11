import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { ModeCell } from '../renderers/ModeCell'
import { SelectPanelEditor } from '../editors/SelectPanelEditor'
import { suppressModeKeys, type ModeCellValue } from '../renderers/modeModel'
import { entityLinksColumn, modeColumn, sparklineColumn } from './presets'
import { EntityLinksCell } from '../renderers/EntityLinksCell'
import { SparklineCell } from '../renderers/SparklineCell'
import { entityLinksKeys } from '../renderers/entityLinksKeys'

/**
 * `modeColumn` (bid page DS lane, 2026-10-10): Off · Watch · Ask me · Auto as a DRAFT-only picker. A pick reaches
 * `context.current.onMode` and the row keeps its value (the valueSetter stores nothing); Space never reaches AG.
 */
interface Row { id: string; name: string; mode: ModeCellValue; locked?: string }
type Fn = (p: unknown) => unknown

const col = modeColumn<Row>('mode', {
  header: 'Mode',
  heldOption: (r, step) => (step === 'AUTO' && r.id === 'b' ? 'Needs 14 clean days first' : null),
  lockReason: (r) => r.locked ?? null,
  pending: (r) => r.id === 'b',
})
const a: Row = { id: 'a', name: 'Rule A', mode: 'ASK' }
const b: Row = { id: 'b', name: 'Rule B', mode: { set: 'AUTO', acts: 'ASK', heldBy: { label: 'the account dial' } } }
const d: Row = { id: 'd', name: 'Rule D', mode: 'OFF', locked: 'Needs the ads rules permission' }

const cell = (row: Row | undefined, context: unknown) => renderToStaticMarkup(createElement(ModeCell, {
  ...col.cellRendererParams, data: row, context, eGridCell: undefined,
  api: { startEditingCell: () => {} }, node: { rowIndex: 0 }, column: { getColId: () => 'mode' },
} as never))

describe('modeColumn — the column', () => {
  it('opens the DS list in AG\'s popup, keeps Space from AG, sorts by the scale', () => {
    expect(col.headerName).toBe('Mode')
    expect(col.cellRenderer).toBe(ModeCell)
    expect(col.cellEditor).toBe(SelectPanelEditor)
    expect(col.cellEditorPopup).toBe(true)
    expect(col.suppressKeyboardEvent).toBe(suppressModeKeys)
    expect(['AUTO', 'OFF', 'ASK'].sort(col.comparator as (x: unknown, y: unknown) => number)).toEqual(['OFF', 'ASK', 'AUTO'])
  })

  it('its value is the SET step; the CSV, quick filter and column filter read the word', () => {
    expect((col.valueGetter as Fn)({ data: b })).toBe('AUTO')
    expect((col.valueGetter as Fn)({ data: a })).toBe('ASK')
    expect((col.valueFormatter as Fn)({ value: 'ASK' })).toBe('Ask me')
    expect((col.getQuickFilterText as Fn)({ value: 'WATCH' })).toBe('Watch')
    expect((col.filterValueGetter as Fn)({ data: b })).toBe('Auto')
  })

  it('is editable only with a handler and no lock', () => {
    const onMode = () => {}
    expect((col.editable as Fn)({ data: a, context: { current: { onMode } } })).toBe(true)
    expect((col.editable as Fn)({ data: a, context: { current: {} } })).toBe(false)
    expect((col.editable as Fn)({ data: d, context: { current: { onMode } } })).toBe(false)
  })

  it('lists every step for the row, a held step with its reason', () => {
    const { options } = (col.cellEditorParams as Fn)({ data: b }) as { options: Array<{ value: string; heldReason?: string }> }
    expect(options.map((o) => o.value)).toEqual(['OFF', 'WATCH', 'ASK', 'AUTO'])
    expect(options[3].heldReason).toBe('Needs 14 clean days first')
    expect(((col.cellEditorParams as Fn)({ data: a }) as { options: Array<{ heldReason?: string }> }).options.every((o) => !o.heldReason)).toBe(true)
  })

  it('a pick goes to onMode(row, next, field) and NOTHING is stored (the valueSetter returns false)', () => {
    const onMode = vi.fn()
    const row = { ...a }
    expect((col.valueSetter as Fn)({ data: row, newValue: 'AUTO', context: { current: { onMode } } })).toBe(false)
    expect(onMode).toHaveBeenCalledWith(row, 'AUTO', 'mode')
    expect(row.mode).toBe('ASK')
    // The same step again, or no handler: nothing at all.
    expect((col.valueSetter as Fn)({ data: row, newValue: 'ASK', context: { current: { onMode } } })).toBe(false)
    expect(onMode).toHaveBeenCalledTimes(1)
    expect((col.valueSetter as Fn)({ data: row, newValue: 'OFF', context: { current: {} } })).toBe(false)
  })
})

describe('ModeCell — what it draws', () => {
  const ctx = { current: { onMode: () => {} } }
  it('the meter, the word and the chevron of an editable row', () => {
    const out = cell(a, ctx)
    expect(out).toContain('class="nds-cell-mode"')
    expect(out).toContain('class="nds-cell-mode-word">Ask me<')
    expect(out.match(/class="is-on"/g)).toHaveLength(2)
    expect(out).toContain('nds-ag-chev')
    expect(out).not.toContain('Not saved')
  })
  it('a row held lower: an outline bar and a named mark; the draft\'s "Not saved"', () => {
    const out = cell(b, ctx)
    expect(out).toContain('>Auto<')
    expect(out.match(/class="is-held"/g)).toHaveLength(1)
    expect(out).toContain('aria-label="Acts as Ask me: held by the account dial"')
    expect(out).toContain('Not saved')
  })
  it('a locked row: focusable lock named with the reason, no chevron, never disabled', () => {
    const out = cell(d, ctx)
    expect(out).toContain('nds-cell-mode is-readonly')
    expect(out).toContain('tabindex="-1"')
    expect(out).toContain('aria-label="Needs the ads rules permission"')
    expect(out).not.toContain('nds-ag-chev')
    expect(out).not.toContain('disabled')
  })
  it('without a handler: shows only, no lock, no chevron; a group row draws nothing', () => {
    const out = cell(d, { current: {} })
    expect(out).toContain('>Off<')
    expect(out).not.toContain('nds-cell-mode-lock')
    expect(out).not.toContain('nds-ag-chev')
    expect(cell(undefined, ctx)).toBe('')
  })
})

describe('sparklineColumn and entityLinksColumn', () => {
  interface K { id: string; bid: number[]; campaigns: Array<{ id: string; name: string; href?: string }> }
  const spark = sparklineColumn<K>('bid', { header: 'Bid, 7 days', label: (r) => `Bid of ${r.id}` })
  const links = entityLinksColumn<K>('campaigns', { header: 'Campaigns', noun: { one: 'campaign', many: 'campaigns' } })
  it('the sparkline: its cell, not sortable, words for the CSV', () => {
    expect(spark.cellRenderer).toBe(SparklineCell)
    expect(spark.sortable).toBe(false)
    expect((spark.valueFormatter as Fn)({ value: [1, 3, 2] })).toBe('3 readings, low 1, high 3, now 2')
    expect((spark.valueFormatter as Fn)({ value: undefined })).toBe('No changes')
  })
  it('the links: its cell, names for the CSV, sorted by how many, Enter answered in the cell', () => {
    expect(links.cellRenderer).toBe(EntityLinksCell)
    expect((links.valueFormatter as Fn)({ value: [{ id: '1', name: 'A' }, { id: '2', name: 'B' }] })).toBe('A, B')
    expect((links.comparator as Fn as (x: unknown, y: unknown) => number)([{ id: '1', name: 'A' }], [])).toBeGreaterThan(0)
    expect(links.suppressKeyboardEvent).toBe(entityLinksKeys)
  })
})
