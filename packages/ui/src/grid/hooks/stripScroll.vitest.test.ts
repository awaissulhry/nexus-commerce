import { describe, expect, it } from 'vitest'

import { stripScroll } from './useGridState'
import type { GridState } from 'ag-grid-community'

const st = (over: Partial<GridState> = {}): GridState =>
  ({ scroll: { top: 240, left: 1227 }, sort: { sortModel: [] }, ...over } as GridState)

/*
 * §9.5a / #425 — what is never persisted.
 *
 * A restored `scroll.left` of 1,227px lands the operator past identity, past the required-and-
 * incomplete block and past the commerce spine on every load — undoing §9.2's ordering decision
 * with an accident of where somebody stopped scrolling. **A side effect must not overrule a
 * ruling.** Vertical scroll is different in kind: returning to your row is returning to your place,
 * and it cannot hide a column.
 */
describe('stripScroll — horizontal is withdrawn, vertical is kept', () => {
  it('🔴 drops scroll.left and keeps scroll.top', () => {
    const out = stripScroll(st())
    expect(out.scroll).toEqual({ top: 240 })
    expect((out.scroll as { left?: number } | undefined)?.left).toBeUndefined()
  })

  it('leaves everything else untouched — it is not a state filter', () => {
    const out = stripScroll(st({ sort: { sortModel: [{ colId: 'sku', sort: 'asc' }] } } as Partial<GridState>))
    expect(out.sort).toEqual({ sortModel: [{ colId: 'sku', sort: 'asc' }] })
  })

  it('🔴 omitScroll drops BOTH — the deep-link case must not race the restore at all', () => {
    // AG's deferred `initialState` restore lands ~90ms after a reveal has already scrolled to the
    // named cell and wins. An explicit coordinate should not have to out-run an implicit one.
    expect(stripScroll(st(), true).scroll).toBeUndefined()
  })

  it('handles a state with no scroll at all, both ways', () => {
    const bare = { sort: { sortModel: [] } } as GridState
    expect(stripScroll(bare).scroll).toBeUndefined()
    expect(stripScroll(bare, true).scroll).toBeUndefined()
  })

  it('does not mutate the state it was given', () => {
    // It is called on `api.getState()`, whose result AG may hold; mutating it would corrupt the
    // grid's own view of itself rather than just what we store.
    const input = st()
    stripScroll(input)
    expect(input.scroll).toEqual({ top: 240, left: 1227 })
  })
})
