/**
 * useDetailParam (Keyword Harvest page F1, 2026-10-10) — the open row's detail in the address. The hook is thin; the
 * rules it follows are these pure functions.
 */
import { describe, expect, it } from 'vitest'
import { detailCloseMode, detailOpenMode, detailSearch } from './useDetailParam'

const keys = { key: 'term', tabKey: 'tab' }

describe('detailSearch', () => {
  it('sets the row (and its tab), keeping the page\'s own params in their order', () => {
    expect(detailSearch('view=terms&show=ready', keys, { id: 't1' })).toBe('view=terms&show=ready&term=t1')
    expect(detailSearch('view=terms', keys, { id: 't1', tab: 'history' })).toBe('view=terms&term=t1&tab=history')
    expect(detailSearch('view=terms&term=t1&tab=history', keys, { id: 't2', tab: 'history' })).toBe('view=terms&term=t2&tab=history')
  })
  it('a null or empty tab removes the tab param (the modal\'s default tab)', () => {
    expect(detailSearch('term=t1&tab=history', keys, { id: 't1', tab: null })).toBe('term=t1')
    expect(detailSearch('term=t1&tab=history', keys, { id: 't1', tab: '' })).toBe('term=t1')
  })
  it('closing removes the row AND its tab, nothing else', () => {
    expect(detailSearch('view=terms&term=t1&tab=history&market=IT', keys, { id: null })).toBe('view=terms&market=IT')
    expect(detailSearch('term=t1', keys, { id: '' })).toBe('')
  })
  it('without a tab key the tab is never written', () => {
    expect(detailSearch('a=1', { key: 'rule' }, { id: 'r1', tab: 'history' })).toBe('a=1&rule=r1')
  })
  it('encodes ids that hold separators', () => {
    expect(new URLSearchParams(detailSearch('', keys, { id: 'IT|c 1|a&b' })).get('term')).toBe('IT|c 1|a&b')
  })
})

describe('open and close modes', () => {
  it('open pushes when nothing was open (Back closes), replaces when moving between rows', () => {
    expect(detailOpenMode(false)).toBe('push')
    expect(detailOpenMode(true)).toBe('replace')
  })
  it('close goes back over our own entry, else replaces (a shared link or a reload never leaves the page)', () => {
    expect(detailCloseMode(true)).toBe('back')
    expect(detailCloseMode(false)).toBe('replace')
  })
})
