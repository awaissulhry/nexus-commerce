'use client'

/**
 * GDS — grid state: what the operator last had, and the views they named (Q4, decided 2026-08-28).
 *
 *   const grid = useGridState<PageState>({ surface: 'products-next', getPageState, applyPageState })
 *   <NexusGrid initialState={grid.initialState ?? DEFAULT} onGridReady={(e) => grid.bind(e.api)} … />
 *   <GridViewsMenu views={grid} />
 *
 * Three layers, one precedence:
 *   1. a SERVER default view (`SavedView`, `isDefault`) — wins on first load;
 *   2. otherwise the LAST-USED state, auto-persisted to localStorage `nds-grid:<surface>:v1`
 *      as `{ v, gridState, page }` on every AG `stateUpdated` (debounced) and on `markDirty()`
 *      from the page (density, page size, accordion filters — what AG state cannot hold);
 *   3. otherwise the page's own default.
 *
 * Named views are the server's, exactly as `useGridViews` had them; this hook is that hook plus
 * the last-used layer, so a page swaps one import. No legacy-key adapters: a rebuilt page starts
 * clean (§0b), and only server view payloads are converted when a page is rebuilt.
 *
 * The AG Grid State API (`getState` / `setState` / `initialState`) is the ONE serialisation —
 * columns, sort, filter model, row-group columns, pagination. Nothing here reads a column.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GridApi, GridState } from 'ag-grid-community'

import { GRID_VIEW_SCHEMA, useGridViews, type GridViewPayload, type UseGridViewsOptions } from './useGridViews'

export const LAST_USED_SCHEMA = 1
const PERSIST_DEBOUNCE_MS = 400

export interface LastUsedState<TPage> {
  v: typeof LAST_USED_SCHEMA
  gridState: GridState
  page: TPage
  savedAt: string
}

export const lastUsedKey = (surface: string) => `nds-grid:${surface}:v${LAST_USED_SCHEMA}`

export function readLastUsed<TPage>(surface: string): LastUsedState<TPage> | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(lastUsedKey(surface))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<LastUsedState<TPage>>
    if (parsed.v !== LAST_USED_SCHEMA || !parsed.gridState || typeof parsed.gridState !== 'object') return null
    return parsed as LastUsedState<TPage>
  } catch {
    return null
  }
}

export function writeLastUsed<TPage>(surface: string, state: Omit<LastUsedState<TPage>, 'v' | 'savedAt'>): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(lastUsedKey(surface), JSON.stringify({ v: LAST_USED_SCHEMA, savedAt: new Date().toISOString(), ...state }))
  } catch {
    /* private mode / quota: the choice just does not survive a reload */
  }
}

export function clearLastUsed(surface: string): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(lastUsedKey(surface))
  } catch {
    /* nothing to clear */
  }
}

export interface UseGridStateOptions<TPage> extends UseGridViewsOptions<TPage> {
  /** Restore the last-used state on mount when no default view exists. Default true. */
  autoRestore?: boolean
}

export function useGridState<TPage>({ surface, getPageState, applyPageState, autoRestore = true }: UseGridStateOptions<TPage>) {
  const views = useGridViews<TPage>({ surface, getPageState, applyPageState })
  const apiRef = useRef<GridApi | null>(null)
  const pageRef = useRef(getPageState)
  pageRef.current = getPageState
  const applyRef = useRef(applyPageState)
  applyRef.current = applyPageState
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Read once, on the client, before the grid mounts — the value `initialState` hands AG.
  const [lastUsed] = useState<LastUsedState<TPage> | null>(() => (autoRestore ? readLastUsed<TPage>(surface) : null))

  /**
   * What the grid starts from. The server default view is fetched asynchronously; until it
   * arrives the last-used state is the best answer, and the page's own default after that. A
   * default view that lands later is applied by the page through `views.defaultView` as before.
   */
  const initialState = useMemo<GridState | undefined>(
    () => views.defaultView?.payload?.gridState ?? lastUsed?.gridState,
    [views.defaultView, lastUsed],
  )

  const persist = useCallback(() => {
    const api = apiRef.current
    if (!api || api.isDestroyed()) return
    writeLastUsed<TPage>(surface, { gridState: api.getState(), page: pageRef.current() })
  }, [surface])

  const persistSoon = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(persist, PERSIST_DEBOUNCE_MS)
  }, [persist])

  /** Hand the grid over: from here every state change is remembered. */
  const bind = useCallback(
    (api: GridApi) => {
      apiRef.current = api
      views.bind(api)
      api.addEventListener('stateUpdated', persistSoon)
      // The last-used PAGE state (density, page size, accordion) — the grid part rode in `initialState`.
      if (autoRestore && lastUsed && !views.defaultView) applyRef.current(lastUsed.page)
    },
    [views, persistSoon, autoRestore, lastUsed],
  )

  /** The page changed something AG state does not hold (density, page size, a tile). */
  const markDirty = useCallback(() => persistSoon(), [persistSoon])

  /** Forget the last-used state (a "Reset" that should also stop remembering). */
  const forget = useCallback(() => clearLastUsed(surface), [surface])

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
      const api = apiRef.current
      if (api && !api.isDestroyed()) api.removeEventListener('stateUpdated', persistSoon)
    },
    [persistSoon],
  )

  return { ...views, bind, initialState, lastUsed, markDirty, forget, persist }
}

export type GridStateApi<TPage> = ReturnType<typeof useGridState<TPage>>

/** A named view's payload, for callers that build one by hand. */
export const gridViewPayload = <TPage,>(gridState: GridState, page: TPage): GridViewPayload<TPage> => ({ v: GRID_VIEW_SCHEMA, gridState, page })
