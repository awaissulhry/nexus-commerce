'use client'

/**
 * Bid page — the person's own column picks (Customise, a header's ⋮ menu) kept while a column leaves the table and comes
 * back: the Bids view draws Auto, Goal and Brain bid only where a row needs them, the Rules view draws Market only on All
 * markets. AG forgets a column it no longer has (its saved state drops it) and puts a returning one at the end, so a
 * column that came back showed its default again, in the wrong place, and the pick was lost (use audit A3). This
 * remembers each column's last shown / hidden state and the order — from the saved grid state, from this viewer's own
 * store, and from every change — and puts both back when the definitions change.
 *
 * Per viewer and per browser only (localStorage, wrapped: a private window or blocked storage just forgets, the page
 * still works).
 */
import { useCallback, useRef } from 'react'
import type { GridApi, GridState } from '@/design-system/grid'

const storeKey = (surface: string) => `nexus.bid.columnChoices.${surface}`

interface Stored { hidden: Record<string, boolean>; order: string[] }

function readStore(surface: string): Stored {
  try {
    const raw = window.localStorage.getItem(storeKey(surface))
    const v = raw ? (JSON.parse(raw) as Partial<Stored> | null) : null
    return {
      hidden: v?.hidden && typeof v.hidden === 'object' ? v.hidden : {},
      order: Array.isArray(v?.order) ? v.order.filter((id): id is string => typeof id === 'string') : [],
    }
  } catch {
    return { hidden: {}, order: [] }
  }
}

function writeStore(surface: string, hidden: ReadonlyMap<string, boolean>, order: readonly string[]): void {
  try {
    window.localStorage.setItem(storeKey(surface), JSON.stringify({ hidden: Object.fromEntries(hidden), order }))
  } catch {
    /* private mode / quota: the picks just do not outlive this visit */
  }
}

/** colId → hidden, from the store and then the saved grid state (the newer word for the columns it holds). */
export function seedChoices(stored: Record<string, boolean>, saved: GridState | undefined): Map<string, boolean> {
  const map = new Map<string, boolean>(Object.entries(stored).filter(([, v]) => typeof v === 'boolean'))
  for (const id of saved?.columnOrder?.orderedColIds ?? []) map.set(id, false)
  for (const id of saved?.columnVisibility?.hiddenColIds ?? []) map.set(id, true)
  return map
}

/** The columns whose shown / hidden state is not the one the person left them in (a column that came back, or one the
 *  grid put back to its default when its definitions changed). */
export function strayColumns(now: ReadonlyArray<{ colId: string; hide?: boolean | null }>, known: ReadonlyMap<string, boolean>): Array<{ colId: string; hide: boolean }> {
  return now.filter((c) => known.has(c.colId) && !!c.hide !== known.get(c.colId)).map((c) => ({ colId: c.colId, hide: known.get(c.colId)! }))
}

/** Insert each id of `from` missing in `into` right after the id it followed in `from` (or first). */
function keepPlaces(into: string[], from: readonly string[], skip: (id: string) => boolean): string[] {
  const out = [...into]
  from.forEach((id, i) => {
    if (skip(id) || out.includes(id)) return
    const before = from.slice(0, i).reverse().find((p) => out.includes(p))
    out.splice(before ? out.indexOf(before) + 1 : 0, 0, id)
  })
  return out
}

/** The remembered order after the grid's order changed: the grid's own, with every absent column kept in its place. */
export function mergeOrder(remembered: readonly string[], current: readonly string[]): string[] {
  return keepPlaces([...current], remembered, () => false)
}

/** The order the grid should show: the remembered one for the columns it has, a new column where its definitions put it. */
export function placeColumns(remembered: readonly string[], current: readonly string[]): string[] {
  const has = new Set(current)
  return keepPlaces(remembered.filter((id) => has.has(id)), current, () => false)
}

/**
 * Call `bind(api)` from the grid's `onGridReady`. From then on every column change is remembered, and when the column
 * definitions change (a column returns, or the grid put one back to its default or to the end) each takes back its
 * remembered state and place.
 */
export function useColumnChoices(surface: string, saved: GridState | undefined): (api: GridApi) => void {
  const known = useRef<{ hidden: Map<string, boolean>; order: string[] } | null>(null)
  const seed = () => {
    if (!known.current) {
      const stored = typeof window === 'undefined' ? { hidden: {}, order: [] } : readStore(surface)
      const savedOrder = saved?.columnOrder?.orderedColIds ?? []
      known.current = { hidden: seedChoices(stored.hidden, saved), order: savedOrder.length ? mergeOrder(stored.order, savedOrder) : stored.order }
    }
    return known.current
  }
  return useCallback((api: GridApi) => {
    const k = seed()
    const ids = () => api.getColumnState().map((c) => c.colId)
    const record = () => {
      if (api.isDestroyed()) return
      for (const c of api.getColumnState()) k.hidden.set(c.colId, !!c.hide)
      k.order = mergeOrder(k.order, ids())
      writeStore(surface, k.hidden, k.order)
    }
    const sync = () => {
      if (api.isDestroyed()) return
      const stray = strayColumns(api.getColumnState(), k.hidden)
      const now = ids()
      const want = k.order.length ? placeColumns(k.order, now) : now
      const moved = want.some((id, i) => id !== now[i])
      if (moved) api.applyColumnState({ state: want.map((colId) => ({ colId, ...(stray.find((s) => s.colId === colId) ?? {}) })), applyOrder: true })
      else if (stray.length) api.applyColumnState({ state: stray })
    }
    // The definitions may have changed before the grid was ready (the columns a scope needs arrive with its rows).
    sync()
    api.addEventListener('newColumnsLoaded', sync)
    api.addEventListener('columnVisible', record)
    api.addEventListener('columnMoved', record)
  }, [surface]) // eslint-disable-line react-hooks/exhaustive-deps
}
