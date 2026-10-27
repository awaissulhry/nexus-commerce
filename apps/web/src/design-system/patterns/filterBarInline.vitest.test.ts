import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FilterBar, filterSummary, filtersButtonWords, filtersOn, type FilterDimension } from './FilterBar'

/** 2026-10-26 — the Negative Targeting page top: `layout="inline"`, the `listbox` field, fields named by their label. */

const noop = () => {}
const dims = (status = 'wasting'): FilterDimension[] => [
  {
    key: 'status', label: 'Status', kind: 'listbox', value: status, onChange: noop,
    options: [{ value: 'wasting', label: 'Wasting', count: 9 }, { value: 'stopped', label: 'Stopped', count: 4 }],
  },
  { key: 'market', label: 'Market', kind: 'select', value: '', onChange: noop, options: [{ value: 'it', label: 'Amazon IT' }] },
]
const render = (props: Partial<Parameters<typeof FilterBar>[0]> = {}) =>
  renderToStaticMarkup(createElement(FilterBar, { dimensions: dims(), activeCount: 1, onClear: noop, ...props }))
const labelIdOf = (html: string, words: string) => html.match(new RegExp(`<span class="flbl" id="([^"]+)">${words}</span>`))?.[1]

describe('a listbox field', () => {
  it('counts and summarises like a select', () => {
    expect(filtersOn(dims())).toBe(1)
    expect(filtersOn(dims(''))).toBe(0)
    expect(filterSummary(dims())).toBe('Status: Wasting')
  })
  it('is named by its label and the value it shows ("Status Wasting")', () => {
    const html = render({ layout: 'inline' })
    const id = labelIdOf(html, 'Status')
    expect(id).toBeTruthy()
    const trigger = html.match(/<button[^>]*class="nds-listbox-btn"[^>]*>/)?.[0] ?? ''
    const named = trigger.match(/aria-labelledby="([^"]+)"/)?.[1].split(' ') ?? []
    expect(named[0]).toBe(id)
    expect(html).toContain(`id="${named[1]}">Wasting</span>`)
    expect(trigger).not.toContain('aria-label=')
  })
})

describe('a select field', () => {
  it('is named by its label', () => {
    const html = render()
    const id = labelIdOf(html, 'Market')
    expect(html).toMatch(new RegExp(`<input class="nds-combo-in" aria-labelledby="${id}"`))
  })
})

describe('layout="inline"', () => {
  it('draws no panel head and no collapse: the fields in one row and Clear at its end', () => {
    const html = render({ layout: 'inline' })
    expect(html).not.toContain('nds-fpanel-head')
    expect(html).not.toContain('nds-fpanel-toggle')
    expect(html).toMatch(/<div class="nds-fbar-row"><div class="nds-fbar-fields">.*<\/div><button[^>]*nds-fbar-clear[^>]*>Clear<\/button><\/div>/)
  })
  it('draws the phone button too (the stylesheet shows it at ≤ 760 px), the sheet only once opened', () => {
    const html = render({ layout: 'inline', dimensions: dims('') })
    expect(html).toMatch(/<div class="nds-fbar-phone"><button[^>]*aria-haspopup="dialog" aria-expanded="false"[^>]*>Filters<\/button><\/div>/)
    expect(html).not.toContain('nds-fbar-sheet')
  })
  it('holds Clear at 0 on, and says why', () => {
    const held = render({ layout: 'inline', activeCount: 0 }).match(/<button[^>]*nds-fbar-clear[^>]*>/)?.[0] ?? ''
    expect(held).toContain('aria-disabled="true"')
    expect(held).toContain('aria-description="No filter is on"')
    const live = render({ layout: 'inline', activeCount: 1 }).match(/<button[^>]*nds-fbar-clear[^>]*>/)?.[0] ?? ''
    expect(live).not.toContain('aria-disabled')
  })
  it('the default stays the panel, unchanged', () => {
    expect(render()).toContain('nds-fpanel-head')
    expect(render()).not.toContain('nds-fbar-')
  })
  it('the phone button counts what filters', () => {
    expect(filtersButtonWords(0)).toBe('Filters')
    expect(filtersButtonWords(2)).toBe('Filters (2)')
  })
})
