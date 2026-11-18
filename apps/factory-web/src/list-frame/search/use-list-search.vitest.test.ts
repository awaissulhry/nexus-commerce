import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SEARCH_DELAY_MS, SEARCH_MAX, searchStep, useListSearch, type ListSearch, type SearchState } from './use-list-search'

/**
 * F-SA-223 (sales page plan N5 / N8, picks P18, P23; 12-lists-board §5 rule 3): ONE search rule for every list — the words are
 * read 300 ms after the last key, Enter at once, Esc clears, at most 100 characters, and the field follows the list's search when
 * it changes from outside unless the person is typing. The rule is pure (searchStep); the hook is drawn on the server and its
 * field's handlers are called after (no DOM), with fake timers.
 */

const idle = (value: string): SearchState => ({ value, dirty: false })

describe('the rule (searchStep)', () => {
  it('typing keeps the words in the field (at most 100) and commits nothing yet; the pause commits them, trimmed', () => {
    const typed = searchStep(idle(''), { type: 'type', text: 'SO-14' }, '')
    expect(typed).toEqual({ state: { value: 'SO-14', dirty: true }, commit: null })
    expect(searchStep(typed.state, { type: 'settle' }, '')).toEqual({ state: { value: 'SO-14', dirty: false }, commit: 'SO-14' })
    expect(searchStep({ value: ' SO-14 ', dirty: true }, { type: 'settle' }, '').commit).toBe('SO-14')
    expect(searchStep(idle(''), { type: 'type', text: 'x'.repeat(140) }, '').state.value).toHaveLength(SEARCH_MAX)
    expect(SEARCH_MAX).toBe(100)
    expect(SEARCH_DELAY_MS).toBe(300)
  })

  it('the same words as the list already reads commit nothing (no second read)', () => {
    expect(searchStep({ value: 'rossi ', dirty: true }, { type: 'settle' }, 'rossi').commit).toBeNull()
    expect(searchStep({ value: 'rossi', dirty: true }, { type: 'enter' }, 'rossi').commit).toBeNull()
  })

  it('Enter commits at once; Esc clears the field and the list\'s search (nothing to clear: nothing committed)', () => {
    expect(searchStep({ value: 'brand', dirty: true }, { type: 'enter' }, '')).toEqual({ state: { value: 'brand', dirty: false }, commit: 'brand' })
    expect(searchStep({ value: 'brand', dirty: true }, { type: 'escape' }, 'bra')).toEqual({ state: { value: '', dirty: false }, commit: '' })
    expect(searchStep({ value: 'brand', dirty: true }, { type: 'escape' }, '').commit).toBeNull()
  })

  it('the field follows the list\'s search from outside (Back, a saved view, Clear all), never while the person types', () => {
    expect(searchStep(idle('old'), { type: 'address' }, 'from a view')).toEqual({ state: idle('from a view'), commit: null })
    expect(searchStep({ value: 'typing…', dirty: true }, { type: 'address' }, 'from a view')).toEqual({ state: { value: 'typing…', dirty: true }, commit: null })
  })
})

describe('the hook (useListSearch)', () => {
  let search: ListSearch | null = null
  const committed: string[] = []
  function Probe({ q }: { q: string }) {
    search = useListSearch(q, (next) => committed.push(next))
    return null
  }
  const draw = (q: string) => {
    renderToString(createElement(Probe, { q }))
    return search!
  }
  const type = (field: ListSearch['field'], text: string) => field.onChange({ target: { value: text } } as never)
  const key = (field: ListSearch['field'], name: string) => {
    const event = { key: name, preventDefault: vi.fn(), stopPropagation: vi.fn() }
    field.onKeyDown(event as never)
    return event
  }

  beforeEach(() => {
    vi.useFakeTimers()
    committed.length = 0
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts with the list\'s search, at most 100 characters in the field', () => {
    const field = draw('SO-2026').field
    expect(field.value).toBe('SO-2026')
    expect(field.maxLength).toBe(100)
  })

  it('reads 300 ms after the last key — one read for a run of keys', () => {
    const field = draw('').field
    type(field, 'S')
    vi.advanceTimersByTime(200)
    type(field, 'SO')
    vi.advanceTimersByTime(299)
    expect(committed).toEqual([])
    vi.advanceTimersByTime(1)
    expect(committed).toEqual(['SO'])
  })

  it('Enter reads at once (the wait is skipped, never a second read after it)', () => {
    const field = draw('').field
    type(field, 'Brand Alpha')
    key(field, 'Enter')
    expect(committed).toEqual(['Brand Alpha'])
    vi.advanceTimersByTime(1000)
    expect(committed).toEqual(['Brand Alpha'])
  })

  it('Esc clears the field and the list\'s search; on an empty field it is the page\'s (a dialog\'s Esc still closes it)', () => {
    const field = draw('rossi').field
    const escaped = key(field, 'Escape')
    expect(committed).toEqual([''])
    expect(escaped.stopPropagation).toHaveBeenCalled()
    const empty = draw('').field
    const passed = key(empty, 'Escape')
    expect(passed.stopPropagation).not.toHaveBeenCalled()
    expect(committed).toEqual([''])
  })

  it('every Sales list (and Purchasing › Suppliers, the same list) uses it, none keeps a search timer of its own', () => {
    const files = [
      '../../areas/sales/orders/list/view/OrdersListView.tsx',
      '../../areas/sales/inquiries/view/InquiriesView.tsx',
      '../../areas/sales/quotes/list/view/QuotesListView.tsx',
      '../../areas/sales/mtm/view/MtmListView.tsx',
      '../../areas/parties/_shared/view/PartiesListView.tsx',
    ]
    for (const file of files) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8')
      expect(source, file).toContain('useListSearch(')
      expect(source, file).toContain('{...search.field')
      expect(source, file).not.toMatch(/onBlur=\{\(\) => search !== /)
    }
    const page = readFileSync(new URL('../../areas/parties/_shared/PartiesList.tsx', import.meta.url), 'utf8')
    expect(page).not.toContain('query ? 250 : 0')
  })
})
