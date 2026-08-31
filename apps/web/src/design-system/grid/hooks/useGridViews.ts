'use client'

/**
 * State persistence — a grid "view" is ONE object, stored server-side, per operator.
 *
 * `api.getState()` is AG's own canonical description of everything the operator arranged:
 * column order, widths, visibility, pinning, sort, row grouping, filters. It round-trips through
 * `initialState` unchanged. So a saved view is that object plus the page's own state that AG does
 * not know about — the accordion filters, the search box, the density — and nothing else.
 *
 * It rides on the `SavedView` table and the `/api/saved-views` CRUD that already exist, under a
 * NEW surface, `products-next`. The reason is not tidiness: the `products` surface is read by
 * `saved-view-alerts/evaluator.service.ts` and `build-where.service.ts`, which expect `filters`
 * to be the legacy ProductFilters shape. Writing a grid-state blob under that surface would be
 * consumed by the alert evaluator as a filter and break every alert on it. A surface is a schema.
 *
 * Why server-side and not localStorage, which is what the DataGrid `storageKey` did: a view that
 * lives in one browser cannot be shared, cannot follow the operator to another machine, and
 * vanishes when the profile is cleared. Those are the three things a "saved view" is for.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GridApi, GridState } from 'ag-grid-community'

export const GRID_VIEW_SCHEMA = 1

export interface GridViewPayload<TPage> {
  v: typeof GRID_VIEW_SCHEMA
  gridState: GridState
  page: TPage
}

export interface SavedGridView<TPage> {
  id: string
  name: string
  isDefault: boolean
  payload: GridViewPayload<TPage> | null
  updatedAt: string
}

interface ApiView {
  id: string
  name: string
  isDefault: boolean
  filters: unknown
  updatedAt: string
}

const isPayload = <T,>(x: unknown): x is GridViewPayload<T> =>
  !!x && typeof x === 'object' && (x as { v?: unknown }).v === GRID_VIEW_SCHEMA && 'gridState' in (x as object)

export interface UseGridViewsOptions<TPage> {
  surface: string
  /**
   * Where `/api/saved-views` lives. REQUIRED, and supplied by the app on purpose: until
   * 2026-08-31 this hook imported `@/lib/backend-url` directly, which made it the ONE design-system
   * file reaching outside the design system. That single import failed the DS declaration build
   * with TS6059 (`rootDir`), so NO component's `.d.ts` could be regenerated — and it would have
   * broken the moment the grid DS was mirrored into apps/factory, which has no such module.
   *
   * The DS asks; the app answers. No default, so the compiler names every caller rather than
   * letting one silently inherit an app-shaped guess.
   */
  baseUrl: string
  /** The page state to save alongside the grid state, read at save time. */
  getPageState: () => TPage
  /** Apply a view's page state. The grid state is applied to the grid by this hook. */
  applyPageState: (page: TPage) => void
}

export function useGridViews<TPage>({ surface, baseUrl, getPageState, applyPageState }: UseGridViewsOptions<TPage>) {
  const [views, setViews] = useState<SavedGridView<TPage>[]>([])
  const [loaded, setLoaded] = useState(false)
  const [activeId, setActiveId] = useState<string | null>(null)
  const apiRef = useRef<GridApi | null>(null)
  const pageRef = useRef(getPageState)
  pageRef.current = getPageState
  const applyRef = useRef(applyPageState)
  applyRef.current = applyPageState

  const url = `${baseUrl}/api/saved-views`

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${url}?surface=${encodeURIComponent(surface)}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(String(res.status))
      // Measured against the live endpoint: it answers `{ items: [...] }`. The other two shapes
      // are kept as fallbacks, not guesses — a hook that reads the wrong key shows an operator
      // no views while the table holds theirs, and nothing in that failure says why.
      const raw = (await res.json()) as ApiView[] | { items?: ApiView[]; views?: ApiView[] }
      const list = Array.isArray(raw) ? raw : (raw.items ?? raw.views ?? [])
      setViews(
        list.map((v) => ({
          id: v.id,
          name: v.name,
          isDefault: v.isDefault,
          payload: isPayload<TPage>(v.filters) ? v.filters : null,
          updatedAt: v.updatedAt,
        })),
      )
    } catch {
      // Views are a convenience. A failed load leaves the grid on its defaults, which is correct.
    } finally {
      setLoaded(true)
    }
  }, [url, surface])

  useEffect(() => { void refresh() }, [refresh])

  /** The default view's grid state — hand this to `initialState` so the FIRST render is right. */
  const defaultView = useMemo(() => views.find((v) => v.isDefault && v.payload) ?? null, [views])

  const bind = useCallback((api: GridApi) => { apiRef.current = api }, [])

  const apply = useCallback((view: SavedGridView<TPage>) => {
    if (!view.payload) return
    const api = apiRef.current
    if (api) {
      // setState is the runtime counterpart of initialState: same object, applied live.
      api.setState(view.payload.gridState)
    }
    applyRef.current(view.payload.page)
    setActiveId(view.id)
  }, [])

  const snapshot = useCallback((): GridViewPayload<TPage> | null => {
    const api = apiRef.current
    if (!api) return null
    return { v: GRID_VIEW_SCHEMA, gridState: api.getState(), page: pageRef.current() }
  }, [])

  const save = useCallback(
    async (name: string, opts: { isDefault?: boolean; id?: string } = {}) => {
      const payload = snapshot()
      if (!payload) return null
      const body = JSON.stringify({ name, surface, filters: payload, isDefault: !!opts.isDefault })
      const res = await fetch(opts.id ? `${url}/${opts.id}` : url, {
        method: opts.id ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      })
      if (!res.ok) throw new Error(`Save failed: ${res.status}`)
      const saved = (await res.json()) as ApiView
      await refresh()
      setActiveId(saved.id)
      return saved.id
    },
    [snapshot, surface, url, refresh],
  )

  const setDefault = useCallback(
    async (id: string) => {
      const res = await fetch(`${url}/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ isDefault: true }),
      })
      if (!res.ok) throw new Error(`Set default failed: ${res.status}`)
      await refresh()
    },
    [url, refresh],
  )

  const remove = useCallback(
    async (id: string) => {
      const res = await fetch(`${url}/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`Delete failed: ${res.status}`)
      if (activeId === id) setActiveId(null)
      await refresh()
    },
    [url, refresh, activeId],
  )

  return { views, loaded, activeId, defaultView, bind, apply, save, setDefault, remove, refresh }
}
