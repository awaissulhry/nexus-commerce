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
 *
 * `persistKeys` (2026-09-04): a surface may name WHICH slices of `GridState` it remembers. The
 * studio sheets keep widths, pins and sort and deliberately NOT visibility or order — those come
 * from the view (`views/landing.ts`), and a remembered `hiddenColIds` was the invisible state that
 * made a sheet look like it ignored the operator (#772–#774). The list is applied on the way OUT
 * (persist) and on the way IN (read), so a value written before the rule cannot outlive it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GridApi, GridState } from 'ag-grid-community'

import { GRID_VIEW_SCHEMA, isGridStatePayload, useGridViews, type GridViewPayload, type UseGridViewsOptions } from './useGridViews'

export const LAST_USED_SCHEMA = 1
const PERSIST_DEBOUNCE_MS = 400

export interface LastUsedState<TPage> {
  v: typeof LAST_USED_SCHEMA
  gridState: GridState
  page: TPage
  savedAt: string
}

export type GridStateKey = keyof GridState

export const lastUsedKey = (surface: string) => `nds-grid:${surface}:v${LAST_USED_SCHEMA}`

/**
 * Keep only the named slices. `undefined` keys = keep everything (the pre-2026-09-04 behaviour,
 * what `/products/next` relies on). An allow-list, not an omit-list: a slice AG adds in a later
 * version is forgotten by default, which is the safe direction — stored junk reads as a preference.
 */
export function pickGridState(state: GridState, keys: readonly GridStateKey[] | undefined): GridState {
  if (!keys) return state
  const out: Record<string, unknown> = {}
  for (const k of keys) {
    const v = (state as Record<string, unknown>)[k]
    if (v !== undefined) out[k] = v
  }
  return out as GridState
}

export function readLastUsed<TPage>(surface: string, keys?: readonly GridStateKey[]): LastUsedState<TPage> | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(lastUsedKey(surface))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<LastUsedState<TPage>>
    if (parsed.v !== LAST_USED_SCHEMA || !parsed.gridState || typeof parsed.gridState !== 'object') return null
    return keys ? { ...(parsed as LastUsedState<TPage>), gridState: pickGridState(parsed.gridState, keys) } : (parsed as LastUsedState<TPage>)
  } catch {
    return null
  }
}

/**
 * §9.5a — what is NEVER persisted, and why the horizontal half is different from the vertical.
 *
 * 🔴 **Horizontal scroll is withdrawn from persistence entirely.** A restored `scroll.left` of
 * 1,227px lands the operator past identity, past the required-and-incomplete block and past the
 * commerce spine on every load — undoing §9.2's whole ordering decision with an accident of where
 * somebody happened to stop scrolling last time. The ordering is a ruling; the scroll position is a
 * side effect, and a side effect must not overrule a decision.
 *
 * **Vertical scroll may persist**: coming back to the row you were on is the same operator
 * returning to their place, and it cannot hide a column.
 *
 * `omitScroll` drops BOTH — for the deep-link case (#425), where AG's own deferred `initialState`
 * restore was writing the persisted position at 676ms and beating a reveal that had correctly
 * computed and written its target at 586ms. Explicit beats implicit rather than racing it.
 */
export function stripScroll(state: GridState, omitScroll = false): GridState {
  const { scroll, ...rest } = state
  if (omitScroll || !scroll) return rest
  // Keep the vertical half only. `top` alone is a valid `scroll` to AG; `left` is what we refuse.
  return { ...rest, scroll: { top: scroll.top } as GridState['scroll'] }
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
  /**
   * Drop the replayed scroll position entirely (#425). Pass it when the URL names a cell: AG's
   * `initialState` restore is deferred behind `CtrlsService.whenReady` and lands ~90ms AFTER a
   * reveal has already scrolled to the named cell, so the two race and the persisted value wins.
   * An explicit coordinate should not have to out-run an implicit one.
   */
  omitScroll?: boolean
  /** Restore the last-used state on mount when no default view exists. Default true. */
  autoRestore?: boolean
  /**
   * The slices of `GridState` this surface remembers between visits. Omit to remember everything.
   * The studio sheets pass `['columnSizing', 'columnPinning', 'sort']` — see the file header.
   */
  persistKeys?: readonly GridStateKey[]
  /**
   * The `SavedView` surface for NAMED views, when it differs from the last-used key. A channel
   * scope remembers widths PER COORDINATE (`product-edit:AMAZON:IT`) but shares its views PER
   * CHANNEL (`product-edit:views:AMAZON`): the column set is the channel's, not the market's.
   */
  viewsSurface?: string
}

export function useGridState<TPage>({
  surface,
  baseUrl,
  getPageState,
  applyPageState,
  applyColumnsView,
  autoRestore = true,
  omitScroll = false,
  persistKeys,
  viewsSurface,
}: UseGridStateOptions<TPage>) {
  const views = useGridViews<TPage>({ surface: viewsSurface ?? surface, baseUrl, getPageState, applyPageState, applyColumnsView })
  const apiRef = useRef<GridApi | null>(null)
  const pageRef = useRef(getPageState)
  pageRef.current = getPageState
  const applyRef = useRef(applyPageState)
  applyRef.current = applyPageState
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The list is read at persist time through a ref so a caller passing an inline array does not
  // re-bind the AG listener on every render.
  const keysRef = useRef(persistKeys)
  keysRef.current = persistKeys

  // Read once, on the client, before the grid mounts — the value `initialState` hands AG.
  const [lastUsed] = useState<LastUsedState<TPage> | null>(() => (autoRestore ? readLastUsed<TPage>(surface, persistKeys) : null))

  /** A schema-1 default view carries AG state; a schema-2 one carries columns and is the sheet's to apply. */
  const defaultGridState = useMemo<GridState | null>(() => {
    const p = views.defaultView?.payload
    return p && isGridStatePayload<TPage>(p) ? p.gridState : null
  }, [views.defaultView])

  /**
   * What the grid starts from. The server default view is fetched asynchronously; until it
   * arrives the last-used state is the best answer, and the page's own default after that. A
   * default view that lands later is applied by the page through `views.defaultView` as before.
   */
  const initialState = useMemo<GridState | undefined>(() => {
    const base = defaultGridState ?? lastUsed?.gridState
    // Stripped on the way OUT as well as the way in: a value persisted before §9.5a, or one that
    // arrives inside a server default view, must not restore a horizontal position either.
    return base ? stripScroll(base, omitScroll) : base
  }, [defaultGridState, lastUsed, omitScroll])

  const persist = useCallback(() => {
    const api = apiRef.current
    if (!api || api.isDestroyed()) return
    // §9.5a — the horizontal position never reaches storage in the first place, so an older
    // persisted value cannot outlive this rule on a machine that already has one.
    writeLastUsed<TPage>(surface, { gridState: pickGridState(stripScroll(api.getState()), keysRef.current), page: pageRef.current() })
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
      // A schema-1 default view carries its own page state; a schema-2 one does not, so ours applies.
      if (autoRestore && lastUsed && !defaultGridState) applyRef.current(lastUsed.page)
    },
    [views, persistSoon, autoRestore, lastUsed, defaultGridState],
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
