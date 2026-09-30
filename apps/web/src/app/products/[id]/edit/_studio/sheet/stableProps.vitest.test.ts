/**
 * Audit B32 — the sheet's chrome keeps its props while nothing it shows changed (`stableProps.ts`), so `memo` holds and a
 * save's status change stops re-rendering the toolbar, the grid host and the drawer. Measured with a render counter over
 * the real `ProductSheetSurface` (happy-dom, a fake adapter that rebuilds its model like the real ones): one edit's three
 * status changes went from 80 component renders to 56; the grid host from 3 renders to 0.
 */
import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { stabilize, valueAt } from './stableProps'

/** Hand the same raw value through `stabilize` twice, as a surface re-render does. */
function track<T>(depth = 4) {
  let raw: unknown, stable: unknown, latest: T
  const resolve = (path: ReadonlyArray<string | number>) => valueAt(latest, path)
  return (next: T): T => { latest = next; const out = stabilize(raw, stable, next, resolve, { maxDepth: depth }); raw = next; stable = out; return out }
}

describe('stabilize', () => {
  it('a model rebuilt with the same content keeps its identity; inline event handlers become trampolines to the latest one', () => {
    const next = track<{ visible: number; onExport: () => string; overflow: Array<{ id: string; onSelect: () => string }> }>()
    const first = next({ visible: 21, onExport: () => 'first', overflow: [{ id: 'a', onSelect: () => 'a1' }] })
    const second = next({ visible: 21, onExport: () => 'second', overflow: [{ id: 'a', onSelect: () => 'a2' }] })
    expect(second).toBe(first)
    // …and a kept handler never runs a stale closure.
    expect(second.onExport()).toBe('second')
    expect(second.overflow[0].onSelect()).toBe('a2')
  })

  it('a changed value makes a new object, and only the branch that changed', () => {
    const next = track<{ status: { pending: number }; views: { list: string[] } }>()
    const first = next({ status: { pending: 0 }, views: { list: ['a'] } })
    const second = next({ status: { pending: 1 }, views: { list: ['a'] } })
    expect(second).not.toBe(first)
    expect(second.status).toEqual({ pending: 1 })
    expect(second.views).toBe(first.views)
  })

  it('a function that is not an event handler is compared by identity (a component may call it while rendering)', () => {
    const next = track<{ resolveRow: () => number }>()
    const first = next({ resolveRow: () => 1 })
    const second = next({ resolveRow: () => 2 })
    expect(second).not.toBe(first)
    expect(second.resolveRow()).toBe(2)
  })

  it('an element is kept only when its type, key and props are the same — its handlers by identity', () => {
    const onDone = vi.fn()
    const next = track<{ actions: unknown }>()
    const first = next({ actions: createElement('span', { rows: 1, onDone }, 'verbs') })
    expect(next({ actions: createElement('span', { rows: 1, onDone }, 'verbs') })).toBe(first)
    expect(next({ actions: createElement('span', { rows: 1, onDone: () => undefined }, 'verbs') })).not.toBe(first)
  })

  it('below the depth, identity only: a new row array always reaches the grid, however similar', () => {
    const next = track<{ rowData: Array<{ id: string }>; onCellKeyDown: () => void }>(1)
    const first = next({ rowData: [{ id: 'r1' }], onCellKeyDown: () => undefined })
    const second = next({ rowData: [{ id: 'r1' }], onCellKeyDown: () => undefined })
    expect(second).not.toBe(first)
    const rows = second.rowData
    const third = next({ rowData: rows, onCellKeyDown: () => undefined })
    expect(third).toBe(second)
  })

  it('a trampoline calls the latest handler on the object that holds it', () => {
    const next = track<{ api: { name: string; onRun(this: { name: string }): string } }>()
    const kept = next({ api: { name: 'a', onRun() { return this.name } } })
    next({ api: { name: 'a', onRun() { return `${this.name}!` } } })
    expect(kept.api.onRun()).toBe('a!')
  })
})

describe('ProductSheetSurface — the chrome renders from stable props', () => {
  const src = readFileSync(join(__dirname, 'ProductSheetSurface.tsx'), 'utf8')
  it('the toolbar, the grid props and the rest of the chrome go through useStable; the status line reads a store', () => {
    expect(src).toMatch(/const toolbarProps = useStable\(\{/)
    expect(src).toMatch(/const gridProps = useStable\(model\.grid, 1\)/)
    expect(src).toMatch(/const chrome = useStable\(\{/)
    expect(src).toMatch(/useSyncExternalStore\(store\.subscribe, store\.get, store\.get\)/)
    expect(src).toMatch(/<GridSheet density=\{columns\.density\} toolbar=\{toolbar\} footer=\{footer\}>\{body\}<\/GridSheet>/)
  })
  it('the toolbar is memoised', () => {
    expect(readFileSync(join(__dirname, 'SheetToolbar.tsx'), 'utf8')).toMatch(/export const SheetToolbar = memo\(SheetToolbarBar\)/)
  })
})
