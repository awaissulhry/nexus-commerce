import { createElement } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { _isStopPropagationForAgGrid, _stopPropagationForAgGrid } from 'ag-grid-community'
import { describe, expect, it, vi } from 'vitest'

import { ActionsCell } from './cells'
import {
  AG_STOP_PROPAGATION_FLAG, actionsColumnWidth, isMultiVerb, keepFromGrid, rowVerbHeld, rowVerbsOf, rowVerbVariant,
  type RowVerb, type RowVerbs,
} from './rowVerbs'

interface Row { id: string; waiting: boolean; stale?: string }
const row: Row = { id: 'r1', waiting: true }
const approve: RowVerb<Row> = { id: 'approve', label: 'Approve', tone: 'primary', onClick: () => {}, disabled: (r) => r.stale }
const reject: RowVerb<Row> = { id: 'reject', label: 'Reject', tone: 'danger', onClick: () => {} }
const retry: RowVerb<Row> = { id: 'retry', label: 'Retry', onClick: () => {} }
const perRow = (r: Row): RowVerbs<Row> => (r.waiting ? [approve, reject] : [retry])

describe('row verbs (G2)', () => {
  it('reads the three shapes of `primary`, in order, never more than two', () => {
    expect(rowVerbsOf(undefined, row)).toEqual([])
    expect(rowVerbsOf({ label: 'Edit' }, row).map((v) => v.label)).toEqual(['Edit'])
    expect(rowVerbsOf([approve, reject], row).map((v) => v.id)).toEqual(['approve', 'reject'])
    expect(rowVerbsOf(perRow, { ...row, waiting: false }).map((v) => v.id)).toEqual(['retry'])
    // A function typed loosely at runtime still cannot draw a third button.
    expect(rowVerbsOf((() => [approve, reject, retry]) as never, row)).toHaveLength(2)
  })

  it('only the new shapes are "multi" — the single object keeps every old default', () => {
    expect(isMultiVerb(undefined)).toBe(false)
    expect(isMultiVerb({ label: 'Edit' })).toBe(false)
    expect(isMultiVerb([approve])).toBe(true)
    expect(isMultiVerb(perRow)).toBe(true)
  })

  it('maps tones to DS variants: default = secondary (what Edit always drew), danger = the outline, never the fill', () => {
    expect(rowVerbVariant(undefined)).toBe('secondary')
    expect(rowVerbVariant('default')).toBe('secondary')
    expect(rowVerbVariant('primary')).toBe('primary')
    expect(rowVerbVariant('danger')).toBe('danger-outline')
  })

  it('a verb is held only with a reason', () => {
    expect(rowVerbHeld(approve, row)).toBeNull()
    expect(rowVerbHeld(approve, { ...row, stale: '  ' })).toBeNull()
    expect(rowVerbHeld(approve, { ...row, stale: 'Older than 24 h' })).toBe('Older than 24 h')
  })

  it('the column width follows the shape: 56 ⋯ only, 120 one verb (unchanged), 200 two or per-row', () => {
    expect(actionsColumnWidth(undefined)).toBe(56)
    expect(actionsColumnWidth({ label: 'Edit' })).toBe(120)
    expect(actionsColumnWidth([approve])).toBe(120)
    expect(actionsColumnWidth([approve, reject])).toBe(200)
    expect(actionsColumnWidth(perRow)).toBe(200)
  })

  it('keepFromGrid sets the flag AG 36 itself reads — an AG upgrade that renames it fails here', () => {
    const ours = new Event('click')
    keepFromGrid({ nativeEvent: ours })
    expect(_isStopPropagationForAgGrid(ours)).toBe(true)
    const theirs = new Event('click')
    _stopPropagationForAgGrid(theirs)
    expect((theirs as unknown as Record<string, unknown>)[AG_STOP_PROPAGATION_FLAG]).toBe(true)
    // It flags; it never stops the event (the button's own handler must still run at React's root).
    const native = new Event('click', { bubbles: true })
    const stop = vi.spyOn(native, 'stopPropagation')
    keepFromGrid(native)
    expect(stop).not.toHaveBeenCalled()
  })
})

describe('ActionsCell markup', () => {
  const cell = (params: Record<string, unknown>, data: Row = row) => render(createElement(ActionsCell as never, { data, ...params } as never))

  it('the single Edit button is drawn exactly as before', () => {
    expect(cell({ primary: { label: 'Edit', onClick: () => {} } })).toBe('<div class="nds-cell-actions"><button type="button" class="nds-btn sm">Edit</button></div>')
  })

  it('two verbs: Approve primary, Reject danger outline, then the ⋯', () => {
    const html = cell({ primary: [approve, reject], items: () => [{ id: 'automate', label: 'Automate this kind…' }], menuLabel: () => 'More actions' })
    expect(html).toContain('<button type="button" class="nds-btn primary sm">Approve</button>')
    expect(html).toContain('<button type="button" class="nds-btn danger-outline sm">Reject</button>')
    expect(html.indexOf('Approve')).toBeLessThan(html.indexOf('Reject'))
    expect(html.indexOf('Reject')).toBeLessThan(html.indexOf('aria-label="More actions"'))
  })

  it('a held verb stays focusable and says why — aria-disabled, never the disabled attribute', () => {
    const html = cell({ primary: perRow }, { ...row, stale: 'The stock count is older than 24 h' })
    expect(html).toMatch(/<button type="button" class="nds-btn primary sm" aria-disabled="true" aria-description="The stock count is older than 24 h">Approve<\/button>/)
    expect(html).not.toMatch(/\sdisabled(=|\s|>)/)
    expect(html).toContain('class="nds-btn danger-outline sm">Reject</button>')
  })

  it('a per-row function decides the verbs; an accessible name per row when given', () => {
    const named: RowVerb<Row> = { ...retry, ariaLabel: (r) => `Retry ${r.id}` }
    const html = cell({ primary: () => [named] }, { ...row, waiting: false })
    expect(html).toContain('aria-label="Retry r1"')
    expect(html).not.toContain('Approve')
  })
})
