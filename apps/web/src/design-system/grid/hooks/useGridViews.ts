'use client'

/**
 * State persistence — a grid "view" is ONE object, stored server-side, per operator.
 *
 * Two payload schemas, one table:
 *
 *   schema 1 — `api.getState()`, AG's own canonical description of everything the operator
 *   arranged (column order, widths, visibility, pinning, sort, row grouping, filters), plus the
 *   page's own state AG does not know about. Round-trips through `initialState` unchanged. What
 *   `/products/next` saves: its column set is fixed, so the blob means the same thing every day.
 *
 *   schema 2 — a list of column KEYS in order (`views/viewPayload.ts`). What a SHEET saves: its
 *   column set is a union over product types and markets, and a key list is the only shape that
 *   means the same thing on every one of them (see that file's header for why an AG blob does not).
 *
 * A saved view rides on the `SavedView` table and the `/api/saved-views` CRUD that already exist,
 * under a NEW surface per grid. The reason is not tidiness: the `products` surface is read by
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

import { isColumnsViewPayload, type ColumnsViewPayload } from '../views/viewPayload'
import { savedViewRequest, type StoredSheetLayout, type WorkingLayoutWrite } from '../views/savedViewTransport'

export const GRID_VIEW_SCHEMA = 1

export interface GridViewPayload<TPage> {
  v: typeof GRID_VIEW_SCHEMA
  gridState: GridState
  page: TPage
}

/** What a saved view may hold: AG state (schema 1) or a column list (schema 2). */
export type SavedViewPayload<TPage> = GridViewPayload<TPage> | ColumnsViewPayload

export interface SavedGridView<TPage> {
  id: string
  name: string
  isDefault: boolean
  payload: SavedViewPayload<TPage> | null
  updatedAt: string
  legacyShared?: boolean
}

export interface ApiView {
  id: string
  name: string
  isDefault: boolean
  filters: unknown
  updatedAt: string
  legacyShared?: boolean
  workingLayout?: StoredSheetLayout<unknown>
}

/** Schema 1 — an AG grid-state blob. */
export const isGridStatePayload = <T,>(x: unknown): x is GridViewPayload<T> =>
  !!x && typeof x === 'object' && (x as { v?: unknown }).v === GRID_VIEW_SCHEMA && 'gridState' in (x as object)

/** Either schema, or null for anything else — a row this code did not write is not guessed at. */
const readPayload = <T,>(x: unknown): SavedViewPayload<T> | null =>
  isGridStatePayload<T>(x) ? x : isColumnsViewPayload(x) ? x : null

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
  /**
   * Apply a schema-2 view — the columns it names, resolved against what the grid has NOW.
   *
   * A sheet supplies it (the resolution needs the sheet's identity columns and its order rule); a
   * grid that only ever saves AG state may omit it. Applying a schema-2 view where none is supplied
   * is reported in dev rather than swallowed — a view that "applies" and changes nothing is the
   * silent failure this programme keeps finding.
   */
  applyColumnsView?: (payload: ColumnsViewPayload, view: SavedGridView<TPage>) => void
}

function fromApi<TPage>(view: ApiView): SavedGridView<TPage> {
  return { id: view.id, name: view.name, isDefault: view.isDefault, payload: readPayload<TPage>(view.filters), updatedAt: view.updatedAt, legacyShared: view.legacyShared }
}

/** Keep the server acknowledgement even if the following list refresh fails. */
export function acknowledgeGridView<TPage>(views: SavedGridView<TPage>[], saved: ApiView): SavedGridView<TPage>[] {
  const current = views.find((view) => view.id === saved.id)
  if (current && Date.parse(current.updatedAt) > Date.parse(saved.updatedAt)) return views
  const next = fromApi<TPage>(saved)
  const newerDefault = views.some((view) => view.id !== next.id && view.isDefault && Date.parse(view.updatedAt) > Date.parse(next.updatedAt))
  if (next.isDefault && newerDefault) next.isDefault = false
  return [...views
    .filter((view) => view.id !== next.id && !(view.legacyShared && !next.legacyShared && view.name === next.name))
    .map((view) => next.isDefault && view.isDefault ? { ...view, isDefault: false } : view), next]
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name))
}

interface ViewsState<TPage> {
  scope: string
  views: SavedGridView<TPage>[]
  loaded: boolean
  loadError: string | null
  activeId: string | null
}

export function useGridViews<TPage>({ surface, baseUrl, getPageState, applyPageState, applyColumnsView }: UseGridViewsOptions<TPage>) {
  const url = `${baseUrl}/api/saved-views`
  const scope = JSON.stringify([url, surface])
  const blank = (): ViewsState<TPage> => ({ scope, views: [], loaded: false, loadError: null, activeId: null })
  const [state, setState] = useState<ViewsState<TPage>>(blank)
  // Mask the preceding scope synchronously: the landing effect must never see another market's default.
  const { views, loaded, loadError, activeId } = state.scope === scope ? state : blank()
  const contextRef = useRef({ scope, epoch: 0, request: 0, mounted: true })
  if (contextRef.current.scope !== scope) contextRef.current = { scope, epoch: 0, request: 0, mounted: true }
  const apiRef = useRef<GridApi | null>(null)
  const pageRef = useRef(getPageState)
  pageRef.current = getPageState
  const applyRef = useRef(applyPageState)
  applyRef.current = applyPageState
  const applyColumnsRef = useRef(applyColumnsView)
  applyColumnsRef.current = applyColumnsView

  const change = useCallback((update: (previous: ViewsState<TPage>) => ViewsState<TPage>) => {
    const context = contextRef.current
    const epoch = context.epoch
    if (context.scope !== scope || !context.mounted) return
    setState((previous) => context === contextRef.current && context.mounted && context.epoch === epoch
      ? update(previous.scope === scope ? previous : { scope, views: [], loaded: false, loadError: null, activeId: null })
      : previous)
  }, [scope])

  const refresh = useCallback(async () => {
    const context = contextRef.current
    if (context.scope !== scope || !context.mounted) return
    const epoch = context.epoch
    const request = ++context.request
    const current = () => context === contextRef.current && context.mounted && context.epoch === epoch && context.request === request
    try {
      const raw = await savedViewRequest<ApiView[] | { items?: ApiView[]; views?: ApiView[] }>(`${url}?surface=${encodeURIComponent(surface)}`)
      const list = Array.isArray(raw) ? raw : raw?.items ?? raw?.views
      if (!Array.isArray(list)) throw new Error('The server did not return a saved-view list')
      const received = list.map(fromApi<TPage>)
      if (current()) change((previous) => ({ ...previous, views: received, loaded: true, loadError: null }))
    } catch (error) {
      // A failed read is not an empty list. Keep the last known views and offer an explicit retry.
      if (current()) change((previous) => ({ ...previous, loadError: error instanceof Error ? error.message : String(error) }))
    }
  }, [scope, url, surface, change])

  useEffect(() => {
    const context = contextRef.current
    context.mounted = true
    change((previous) => previous)
    void refresh()
    return () => { context.mounted = false; context.epoch++; context.request++ }
  }, [refresh, change])

  const defaultView = useMemo(() => views.find((view) => view.isDefault && view.payload) ?? null, [views])
  const bind = useCallback((api: GridApi) => { apiRef.current = api }, [])
  const markActive = useCallback((id: string | null) => change((previous) => ({ ...previous, activeId: id })), [change])

  const apply = useCallback((view: SavedGridView<TPage>) => {
    if (!view.payload) return
    if (isColumnsViewPayload(view.payload)) {
      if (applyColumnsRef.current) applyColumnsRef.current(view.payload, view)
      else if (process.env.NODE_ENV !== 'production') console.error('[useGridViews] a columns view was applied without applyColumnsView:', view.name)
    } else {
      apiRef.current?.setState(view.payload.gridState)
      applyRef.current(view.payload.page)
    }
    markActive(view.id)
  }, [markActive])

  const snapshot = useCallback((): GridViewPayload<TPage> | null => {
    const api = apiRef.current
    return api ? { v: GRID_VIEW_SCHEMA, gridState: api.getState(), page: pageRef.current() } : null
  }, [])

  const acknowledge = useCallback((saved: ApiView, previousId?: string, activate = false) => {
    // Any list read started before this commit must not overwrite its acknowledgement.
    contextRef.current.request++
    change((previous) => ({ ...previous, views: acknowledgeGridView(previous.views, saved), activeId: activate || previous.activeId === previousId ? saved.id : previous.activeId }))
  }, [change])

  const write = useCallback(async (method: 'POST' | 'PATCH', path: string, body: Record<string, unknown>, previousId?: string, activate = false) => {
    const context = contextRef.current
    const epoch = context.epoch
    const saved = await savedViewRequest<ApiView>(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (context === contextRef.current && context.scope === scope && context.mounted && context.epoch === epoch) {
      acknowledge(saved, previousId, activate)
      await refresh()
    }
    return saved
  }, [scope, acknowledge, refresh])

  const saveRecord = useCallback(
    async (name: string, opts: { isDefault?: boolean; id?: string; payload?: SavedViewPayload<TPage>; expectedUpdatedAt?: string; workingLayout?: WorkingLayoutWrite } = {}) => {
      const payload = opts.payload ?? snapshot()
      if (!payload) throw new Error('The grid is not ready to save a view yet')
      return write(opts.id ? 'PATCH' : 'POST', opts.id ? `${url}/${opts.id}` : url, {
        name, surface, filters: payload, isDefault: !!opts.isDefault,
        ...(opts.id ? { expectedUpdatedAt: opts.expectedUpdatedAt ?? views.find((view) => view.id === opts.id)?.updatedAt } : {}),
        ...(opts.workingLayout ? { workingLayout: opts.workingLayout } : {}),
      }, opts.id, true)
    },
    [snapshot, surface, url, write, views],
  )

  const save = useCallback(
    async (name: string, opts: { isDefault?: boolean; id?: string; payload?: SavedViewPayload<TPage> } = {}) => (await saveRecord(name, opts)).id,
    [saveRecord],
  )

  const rename = useCallback(async (id: string, name: string) => {
    const view = views.find((candidate) => candidate.id === id)
    await write('PATCH', `${url}/${id}`, { name, expectedUpdatedAt: view?.updatedAt, ...(view?.legacyShared ? { isDefault: view.isDefault } : {}) }, id)
  }, [url, write, views])

  const duplicate = useCallback(async (view: SavedGridView<TPage>, name: string) => {
    if (!view.payload) throw new Error('This view holds nothing to copy')
    return (await write('POST', url, { name, surface, filters: view.payload, isDefault: false }, undefined, true)).id
  }, [url, surface, write])

  const setDefault = useCallback(async (id: string) => {
    await write('PATCH', `${url}/${id}`, { isDefault: true, expectedUpdatedAt: views.find((view) => view.id === id)?.updatedAt }, id)
  }, [url, write, views])

  const clearDefault = useCallback(async (id: string) => {
    await write('PATCH', `${url}/${id}`, { isDefault: false, expectedUpdatedAt: views.find((view) => view.id === id)?.updatedAt }, id)
  }, [url, write, views])

  const remove = useCallback(async (id: string) => {
    const context = contextRef.current
    const epoch = context.epoch
    await savedViewRequest(`${url}/${id}`, { method: 'DELETE' })
    if (context === contextRef.current && context.scope === scope && context.mounted && context.epoch === epoch) {
      context.request++
      change((previous) => ({ ...previous, views: previous.views.filter((view) => view.id !== id), activeId: previous.activeId === id ? null : previous.activeId }))
      await refresh()
    }
  }, [scope, url, change, refresh])

  return { views, loaded, loadError, activeId, defaultView, bind, apply, save, saveRecord, rename, duplicate, setDefault, clearDefault, remove, refresh, markActive }
}
