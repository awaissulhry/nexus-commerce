import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { OptionList } from '../components/OptionList'
import { FilterBar, filterSummary, filtersOn, type FilterDimension } from './FilterBar'

/** 2026-10-12 — the ads pages' filter bar: named triggers, held lists, counted options that search by words, the
 *  collapsed header's summary and Clear, and an open state the page holds. */

const noop = () => {}
const dims = (over: Partial<Extract<FilterDimension, { kind: 'multiselect' }>> = {}): FilterDimension[] => [
  {
    key: 'portfolio', label: 'Portfolio', kind: 'multiselect', value: ['p1', 'p2'], onChange: noop, searchable: true,
    options: [{ value: 'p1', label: 'Boots', count: 3 }, { value: 'p2', label: 'Jackets', count: 1 }, { value: 'p3', label: 'Gloves' }], ...over,
  },
  { key: 'campaign', label: 'Campaign', kind: 'multiselect', value: [], onChange: noop, options: [], heldReason: 'No campaign fits the picks above' },
  { key: 'price', label: 'Price', kind: 'range', min: '10', max: '', onChange: noop },
]
const render = (props: Partial<Parameters<typeof FilterBar>[0]> = {}) =>
  renderToStaticMarkup(createElement(FilterBar, { dimensions: dims(), activeCount: 2, onClear: noop, ...props }))
const buttons = (html: string) => [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => ({ attrs: m[1], body: m[2] }))

describe('filterSummary', () => {
  it('says what filters now, one part per field', () => {
    expect(filterSummary(dims())).toBe('Portfolio: Boots +1 · Price: ≥ 10')
    expect(filterSummary(dims({ value: ['p2'] }))).toBe('Portfolio: Jackets · Price: ≥ 10')
    expect(filterSummary(dims({ value: ['zz', 'p1'] }))).toBe('Portfolio: 2 selected · Price: ≥ 10')
    expect(filterSummary([{ key: 't', label: 'Has photos', kind: 'toggle', value: true, onChange: noop }])).toBe('Has photos')
    expect(filterSummary([{ key: 'r', label: 'Price', kind: 'range', min: '', max: '', onChange: noop }])).toBe('')
  })
})

describe('a picked list', () => {
  it('says how many are picked, never "All" (every option of a narrowed list ticked still filters)', () => {
    const html = render({ dimensions: dims({ value: ['p1', 'p2', 'p3'] }) })
    expect(html).toContain('3 selected')
    // The one "All" left is the Campaign list's, where nothing is picked.
    expect(html.match(/>All</g)).toHaveLength(1)
  })
})

describe('filtersOn', () => {
  it('counts the fields that filter, not the picks', () => {
    expect(filtersOn(dims())).toBe(2)
    expect(filtersOn(dims({ value: [] }))).toBe(1)
    expect(filtersOn([{ key: 't', label: 'Has photos', kind: 'toggle', value: false, onChange: noop }])).toBe(0)
  })
})

describe('FilterBar', () => {
  it('collapsed: the header says what filters and offers Clear; the toggle names the panel', () => {
    const html = render({ open: false })
    expect(html).toContain('<span class="nds-fpanel-summary has-short">Portfolio: Boots +1 · Price: ≥ 10</span>')
    // On a phone the names give way to a count (CSS swaps the two at 760 px).
    expect(html).toContain('<span class="nds-fpanel-summary short">2 on</span>')
    const all = buttons(html)
    expect(all.map((b) => b.body.replace(/<[^>]+>/g, ''))).toEqual(['Clear', 'Show'])
    const toggle = all[1].attrs
    expect(toggle).toContain('aria-expanded="false"')
    expect(toggle).toContain('aria-label="Show filters"')
    expect(html).not.toContain('nds-fpanel-grid')
  })

  it('collapsed with nothing filtered: no summary, no Clear', () => {
    const html = render({ open: false, activeCount: 0, dimensions: dims({ value: [] }).slice(0, 2) })
    expect(html).not.toContain('nds-fpanel-summary')
    expect(buttons(html).map((b) => b.body.replace(/<[^>]+>/g, ''))).toEqual(['Show'])
  })

  it('open: the fields, no summary; the toggle controls the body', () => {
    const html = render({ open: true })
    expect(html).not.toContain('nds-fpanel-summary')
    const toggle = buttons(html).find((b) => b.attrs.includes('nds-fpanel-toggle'))!.attrs
    expect(toggle).toContain('aria-expanded="true"')
    expect(toggle).toContain('aria-label="Hide filters"')
    const controls = /aria-controls="([^"]+)"/.exec(toggle)![1]
    expect(html).toContain(`id="${controls}" class="nds-fpanel-body"`)
  })

  it('each picker is named by its field label and its value', () => {
    const html = render({ open: true })
    const label = /<span class="flbl" id="([^"]+)">Portfolio<\/span>/.exec(html)
    expect(label).not.toBeNull()
    const trigger = buttons(html).find((b) => b.attrs.includes('nds-ms-btn') && b.body.includes('2 selected'))!
    const [labelId, valueId] = /aria-labelledby="([^"]+)"/.exec(trigger.attrs)![1].split(' ')
    expect(labelId).toBe(label![1])
    expect(trigger.body).toContain(`id="${valueId}"`)
    expect(trigger.attrs).not.toContain('aria-label=')
  })

  it('a held picker keeps its focus and says why; it is never disabled', () => {
    const html = render({ open: true })
    const held = buttons(html).find((b) => b.attrs.includes('nds-ms-btn') && b.attrs.includes('aria-disabled'))!
    expect(held.attrs).toContain('aria-disabled="true"')
    expect(held.attrs).toContain('aria-description="No campaign fits the picks above"')
    expect(held.attrs).not.toMatch(/\sdisabled=/)
    expect(html).toContain('nds-tooltip')
  })

  it('without `open`, it keeps its own state from `defaultOpen` (every page before)', () => {
    expect(render({ defaultOpen: false })).toContain('aria-label="Show filters"')
    expect(render()).toContain('aria-label="Hide filters"')
  })
})

describe('OptionList searchText', () => {
  const counted = createElement('span', null, 'Boots ', createElement('span', { className: 'nds-ms-count' }, '3'))
  const list = (searchText?: string) => renderToStaticMarkup(createElement(OptionList, {
    options: [{ value: 'p1', label: counted, ...(searchText ? { searchText } : {}) }, { value: 'p2', label: 'Jackets' }],
    value: [], onChange: noop, initialQuery: 'boots',
  }))
  it('an option drawn with its count is found by its words', () => {
    expect(list('Boots')).toContain('Boots ')
    expect(list('Boots')).not.toContain('Jackets')
  })
  it('without them, a drawn label falls back to its value (why FilterBar passes them)', () => {
    expect(list()).toContain('No matches')
  })
})
