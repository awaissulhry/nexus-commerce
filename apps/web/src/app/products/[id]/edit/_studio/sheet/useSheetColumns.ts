'use client'

/** Shared sheet layout: server-saved membership, ordering, groups and pins, plus transient chips. */
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import type { GridApi, GridState } from '@/design-system/grid'
import {
  ALL_VIEW_ID, arrangementColumnState, columnStateToPrefs, columnsViewPayload,
  isColumnsViewPayload, pickGridState, prefsToColumnState, resolveLanding, resolvePreset, useGridState,
  type ColumnsViewPayload, type GridStateApi, type GridStateKey, type GridViewPreset,
  type Landing, type PrefsBridgeOptions, type SavedGridView, type UseGridStateOptions,
} from '@/design-system/grid'
import type { PreferencesColumnSpec, PreferencesValue } from '@/design-system/patterns/PreferencesModal'
import { loadWorkingLayout, saveWorkingLayout, type StoredSheetLayout } from '@/design-system/grid/views/savedViewTransport'
import { viewChipColumns, type ViewChip } from '../contracts'
import type { SheetColumn } from './master/types'
import { alwaysColumnsFor, orderColumnKeys, sheetViews, type ViewContext } from './views'
import { layoutFromPreferences, preferencesFromLayout, visibleLayoutKeys, mergeVisibleColumnOrder } from '@/design-system/grid/views/columnLayout'

/** Widths and sort remain lightweight browser preferences. Complete layouts are saved explicitly. */
export const SHEET_PERSIST_KEYS: readonly GridStateKey[] = ['columnSizing', 'columnPinning', 'sort']
export type ActiveColumns =
  | { kind: 'all' }
  | { kind: 'preset'; id: string; label: string }
  | { kind: 'saved'; id: string; name: string; missing: string[] }
  | { kind: 'custom'; count: number }

export interface UseSheetColumnsArgs<TRow, TPage> {
  apiRef: MutableRefObject<GridApi<TRow> | null>
  gridReady: GridApi<TRow> | null
  columns: SheetColumn[]
  viewCtx: ViewContext
  serverViews?: Array<{ id: string; label: string; columnKeys: string[] }>
  identityColumn: string
  prefsBridge: PrefsBridgeOptions
  activeChip: ViewChip | null
  setChip?: (id: string | null) => void
  /** Personal working layout, isolated by scope and market. Named views remain reusable. */
  layoutSurface: string
  grid: Pick<UseGridStateOptions<TPage>, 'surface' | 'viewsSurface' | 'baseUrl' | 'getPageState' | 'applyPageState' | 'omitScroll'>
}
export interface SheetColumnsApi<TPage> {
  gridState: GridStateApi<TPage>
  initialState: GridState | undefined
  captureGridState: () => void
  presets: GridViewPreset[]
  viewsSource: 'server' | 'rules'
  active: ActiveColumns
  activePresetId: string | null
  emptyLabel: string
  activeViewName: string | null
  landed: boolean
  landing: Landing | null
  loadError: string | null
  orderedKeys: string[]
  preferenceColumns: PreferencesColumnSpec[]
  alwaysColumns: string[]
  allColumnKeys: string[]
  applyPreset: (preset: GridViewPreset) => void
  applyCustom: (keys: readonly string[], locks?: readonly string[]) => void
  currentPreferences: () => PreferencesValue
  currentPayload: () => ColumnsViewPayload
  savePreferences: (value: PreferencesValue) => Promise<void>
  savePreferencesAs: (name: string, value: PreferencesValue) => Promise<string>
  updatePreferences: (view: SavedGridView<TPage>, value: PreferencesValue) => Promise<void>
  reloadSavedPreferences: () => Promise<PreferencesValue>
  saveCurrentAs: (name: string) => Promise<string | null>
  updateView: (view: SavedGridView<TPage>) => Promise<unknown>
  describeView: (view: SavedGridView<TPage>) => { note?: string; title?: string } | null
  visibleAttributeKeys: () => string[]
}

export function useSheetColumns<TRow, TPage>(a: UseSheetColumnsArgs<TRow, TPage>): SheetColumnsApi<TPage> {
  const { apiRef, gridReady, columns, viewCtx, serverViews, identityColumn, prefsBridge, activeChip, setChip, layoutSurface } = a
  const baseUrl = a.grid.baseUrl
  const scopeRef = useRef(layoutSurface)
  scopeRef.current = layoutSurface
  const orderedKeys = useMemo(() => orderColumnKeys(columns, viewCtx), [columns, viewCtx])
  const attributeKeys = useMemo(() => new Set(orderedKeys), [orderedKeys])
  const addressable = useMemo(() => [identityColumn, ...orderedKeys], [identityColumn, orderedKeys])
  const addressableSet = useMemo(() => new Set(addressable), [addressable])
  const alwaysColumns = useMemo(() => alwaysColumnsFor(addressable), [addressable])
  const allColumnKeys = useMemo(() => [...alwaysColumns, ...orderedKeys.filter((k) => !alwaysColumns.includes(k))], [alwaysColumns, orderedKeys])
  const specs = useMemo<PreferencesColumnSpec[]>(() => {
    // The modal receives this schema order too. Required-first grid ranking must not reorder groups on Save.
    return [{ key: identityColumn, label: 'Identity (SKU, readiness)', locked: true }, ...columns.map((c) => ({ key: c.key, label: c.label, group: c.group, groupKey: c.groupKey }))]
  }, [columns, identityColumn])
  const views = useMemo(() => sheetViews(columns, viewCtx, serverViews), [columns, viewCtx, serverViews])
  const [active, setActive] = useState<ActiveColumns>({ kind: 'all' })
  const [landing, setLanding] = useState<Landing | null>(null)
  const [landedScope, setLandedScope] = useState<string | null>(null)
  const [landedGrid, setLandedGrid] = useState<GridApi<TRow> | null>(null)
  const [recovery, setRecovery] = useState<{ surface: string; state: GridState } | null>(null)
  const landed = landedScope === layoutSurface && landedGrid === gridReady
  const activeColumnsRef = useRef<string[]>([])
  // Retain the full payload: changing product type must never delete temporarily unavailable IDs.
  const layoutRef = useRef<ColumnsViewPayload | null>(null)
  const workingRef = useRef<{ surface: string; record: StoredSheetLayout | null; ready: boolean }>({ surface: layoutSurface, record: null, ready: false })
  const [loadState, setLoadState] = useState<{ surface: string; ready: boolean; error: string | null }>({ surface: layoutSurface, ready: false, error: null })
  const loadError = loadState.surface === layoutSurface ? loadState.error : null
  const requestSequence = useRef(0)
  const saving = useRef(false)
  const applySavedRef = useRef<(payload: ColumnsViewPayload, view: SavedGridView<TPage>) => void>(() => {})
  const gridState = useGridState<TPage>({ ...a.grid, persistKeys: SHEET_PERSIST_KEYS, applyColumnsView: (payload, view) => applySavedRef.current(payload, view) })
  const recoveryState = recovery?.surface === layoutSurface ? recovery.state : undefined
  const captureGridState = useCallback(() => {
    const api = apiRef.current
    if (api && !api.isDestroyed()) setRecovery({ surface: layoutSurface, state: pickGridState(api.getState(), SHEET_PERSIST_KEYS) })
  }, [apiRef, layoutSurface])

  const fetchLayout = useCallback(async () => {
    const sequence = ++requestSequence.current
    try {
      const record = await loadWorkingLayout(baseUrl, layoutSurface)
      if (scopeRef.current !== layoutSurface || sequence !== requestSequence.current) throw new Error('The sheet scope changed. Reopen Customise in the current scope.')
      workingRef.current = { surface: layoutSurface, record, ready: true }
      setLoadState({ surface: layoutSurface, ready: true, error: null })
      return record
    } catch (error) {
      if (scopeRef.current === layoutSurface && sequence === requestSequence.current) {
        workingRef.current = { surface: layoutSurface, record: null, ready: false }
        setLoadState({ surface: layoutSurface, ready: false, error: error instanceof Error ? error.message : 'Could not load your saved layout' })
      }
      throw error
    }
  }, [baseUrl, layoutSurface])

  useEffect(() => {
    setLandedScope(null)
    setLanding(null)
    layoutRef.current = null
    workingRef.current = { surface: layoutSurface, record: null, ready: false }
    setLoadState({ surface: layoutSurface, ready: false, error: null })
    void fetchLayout().catch(() => {})
    return () => { requestSequence.current += 1 }
  }, [layoutSurface, fetchLayout])

  const gridLocks = useCallback((api: GridApi<TRow>) => columnStateToPrefs(api.getColumnState(), preferencesFromLayout(null, specs), prefsBridge).lockedColumns ?? [], [specs, prefsBridge])
  const applyToGrid = useCallback((keys: readonly string[], order: boolean, locks?: readonly string[]) => {
    const api = apiRef.current
    if (!api || api.isDestroyed()) return false
    const value = { ...preferencesFromLayout(null, specs), visibleColumns: keys.filter((k) => addressableSet.has(k)), lockedColumns: [...(locks ?? gridLocks(api))] }
    api.applyColumnState({ state: prefsToColumnState(value, prefsBridge), applyOrder: order })
    return true
  }, [apiRef, specs, addressableSet, gridLocks, prefsBridge])

  const activate = useCallback((next: ActiveColumns, payload: ColumnsViewPayload, restoreLocks = true) => {
    layoutRef.current = payload
    const keys = [...alwaysColumns, ...visibleLayoutKeys(payload, specs)]
    activeColumnsRef.current = keys
    setActive(next)
    applyToGrid(keys, true, restoreLocks && payload.v === 3 ? payload.lockedColumns : undefined)
    gridState.markDirty()
  }, [alwaysColumns, specs, applyToGrid, gridState])
  const applyPreset = useCallback((preset: GridViewPreset) => {
    const resolved = resolvePreset(preset, addressable, alwaysColumns)
    gridState.markActive(null)
    activate(preset.id === ALL_VIEW_ID ? { kind: 'all' } : { kind: 'preset', id: preset.id, label: preset.label }, columnsViewPayload(resolved.columns.filter((k) => attributeKeys.has(k))), false)
    setChip?.(null)
  }, [addressable, alwaysColumns, gridState, activate, attributeKeys, setChip])
  const applySaved = useCallback((payload: ColumnsViewPayload, view: SavedGridView<TPage>) => {
    activate({ kind: 'saved', id: view.id, name: view.name, missing: payload.columns.filter((k) => !attributeKeys.has(k)) }, payload)
    setChip?.(payload.chip ?? null)
  }, [activate, attributeKeys, setChip])
  applySavedRef.current = applySaved
  const applyCustom = useCallback((keys: readonly string[], locks?: readonly string[]) => {
    const prefs = preferencesFromLayout(layoutRef.current, specs)
    const payload = layoutFromPreferences(specs, { ...prefs, visibleColumns: [...keys], ...(locks ? { lockedColumns: [...locks] } : {}) }, alwaysColumns)
    gridState.markActive(null)
    activate({ kind: 'custom', count: payload.columns.filter((k) => attributeKeys.has(k)).length }, payload, locks !== undefined)
  }, [specs, alwaysColumns, gridState, activate, attributeKeys])

  useEffect(() => {
    const api = apiRef.current
    if (landed || !api || api.isDestroyed() || !gridReady || !orderedKeys.length || !gridState.loaded || loadState.surface !== layoutSurface || !loadState.ready) return
    const colIds = api.getColumnState().map((c) => c.colId)
    if (!orderedKeys.some((k) => colIds.includes(k))) return
    const savedState = recoveryState ?? gridState.lastUsed?.gridState
    const arrangement = arrangementColumnState(savedState, colIds)
    if (arrangement.length) api.applyColumnState({ state: arrangement, applyOrder: false })
    // A failed read removes AG without unmounting this hook. Reapply the current view on retry,
    // including a temporary chip, instead of leaving default columns under the old view label.
    if (landedScope === layoutSurface && layoutRef.current) {
      const wanted = activeChip ? viewChipColumns(activeChip.cells) : []
      applyToGrid(activeColumnsRef.current, true)
      if (wanted.length) applyToGrid([...alwaysColumns, ...wanted], false)
      setLandedGrid(api)
      return
    }
    const working = workingRef.current.record
    const dv = gridState.defaultView
    const l = resolveLanding({ orderedKeys, always: alwaysColumns, defaultView: dv ? { id: dv.id, name: dv.name, payload: dv.payload } : null })
    setLanding(l)
    if (working) {
      const named = gridState.views.find((v) => JSON.stringify(v.payload) === JSON.stringify(working.filters))
      activate(named ? { kind: 'saved', id: named.id, name: named.name, missing: working.filters.columns.filter((k) => !attributeKeys.has(k)) } : { kind: 'custom', count: visibleLayoutKeys(working.filters, specs).length }, working.filters)
      gridState.markActive(named?.id ?? null)
      setChip?.(working.filters.chip ?? null)
    } else if (dv && isColumnsViewPayload(dv.payload)) {
      applySaved(dv.payload, dv)
      gridState.markActive(dv.id)
    } else {
      activate({ kind: 'all' }, columnsViewPayload(orderedKeys), false)
      gridState.markActive(null)
    }
    setLandedScope(layoutSurface)
    setLandedGrid(api)
  }, [recoveryState, landedScope, activeChip, applyToGrid, landed, apiRef, gridReady, orderedKeys, gridState, loadState, layoutSurface, alwaysColumns, activate, specs, setChip, applySaved, attributeKeys])

  const keySignature = JSON.stringify(orderedKeys)
  const lastSignature = useRef(keySignature)
  useEffect(() => {
    if (!landed || lastSignature.current === keySignature) return
    lastSignature.current = keySignature
    if (active.kind === 'all') { activate(active, columnsViewPayload(orderedKeys), false); return }
    if (active.kind === 'preset') {
      const preset = views.presets.find((p) => p.id === active.id)
      if (preset) applyPreset(preset)
      return
    }
    const payload = layoutRef.current
    if (payload) activate(active.kind === 'saved' ? { ...active, missing: payload.columns.filter((k) => !attributeKeys.has(k)) } : { kind: 'custom', count: visibleLayoutKeys(payload, specs).length }, payload)
  }, [landed, keySignature, active, activate, orderedKeys, views.presets, applyPreset, attributeKeys, specs])

  useEffect(() => {
    if (!landed || !gridState.loaded || active.kind !== 'saved') return
    const acknowledged = gridState.activeId && gridState.activeId !== active.id ? gridState.views.find((v) => v.id === gridState.activeId) : null
    if (acknowledged) { setActive({ ...active, id: acknowledged.id, name: acknowledged.name }); return }
    const still = gridState.views.find((v) => v.id === active.id)
    if (!still) setActive({ kind: 'custom', count: activeColumnsRef.current.filter((k) => attributeKeys.has(k)).length })
    else if (still.name !== active.name) setActive({ ...active, name: still.name })
  }, [landed, gridState.loaded, gridState.views, gridState.activeId, active, attributeKeys])

  useEffect(() => {
    if (!landed) return
    const wanted = activeChip ? viewChipColumns(activeChip.cells) : []
    applyToGrid(wanted.length ? [...alwaysColumns, ...wanted] : activeColumnsRef.current, false)
    // A chip changes membership only, preserving the chosen layout's order and pins.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChip, landed])

  const visibleAttributeKeys = useCallback(() => {
    const api = apiRef.current
    return (!api || api.isDestroyed() ? activeColumnsRef.current : api.getColumnState().filter((s) => !s.hide).map((s) => s.colId)).filter((k) => attributeKeys.has(k))
  }, [apiRef, attributeKeys])
  const currentPreferences = useCallback(() => {
    const previous = preferencesFromLayout(layoutRef.current, specs)
    const api = apiRef.current
    if (!api || api.isDestroyed()) return previous
    const fromGrid = columnStateToPrefs(api.getColumnState(), previous, prefsBridge)
    const unavailable = (keys: readonly string[]) => keys.filter((k) => !addressableSet.has(k))
    // Chip filters are temporary: opening Customise edits the underlying view's membership.
    return {
      ...fromGrid,
      visibleColumns: activeChip ? previous.visibleColumns : [...fromGrid.visibleColumns, ...unavailable(previous.visibleColumns)],
      lockedColumns: [...(fromGrid.lockedColumns ?? []), ...unavailable(previous.lockedColumns ?? [])],
      columnOrder: mergeVisibleColumnOrder(previous.columnOrder ?? [], fromGrid.visibleColumns.filter((key) => attributeKeys.has(key) && !fromGrid.lockedColumns?.includes(key) && !fromGrid.rowGroups?.includes(key))),
    }
  }, [specs, apiRef, prefsBridge, addressableSet, activeChip, attributeKeys])
  const currentPayload = useCallback((): ColumnsViewPayload => ({ ...layoutFromPreferences(specs, currentPreferences(), alwaysColumns), ...(activeChip ? { chip: activeChip.id } : {}) }), [specs, currentPreferences, alwaysColumns, activeChip])

  const persistDraft = useCallback(async (value: PreferencesValue, named?: { name: string; view?: SavedGridView<TPage>; chip?: string }) => {
    if (saving.current) throw new Error('A layout save is already in progress')
    const working = workingRef.current
    if (scopeRef.current !== layoutSurface || working.surface !== layoutSurface || !working.ready) throw new Error('Load your saved layout before saving. Use Reload saved layout to retry.')
    const payload = { ...layoutFromPreferences(specs, value, alwaysColumns), ...(named?.chip ? { chip: named.chip } : {}) }
    saving.current = true
    try {
      let id: string | null = null
      let stored: StoredSheetLayout
      if (named) {
        const saved = await gridState.saveRecord(named.name, {
          id: named.view?.id, isDefault: named.view?.isDefault, expectedUpdatedAt: named.view?.updatedAt, payload,
          workingLayout: { surface: layoutSurface, filters: payload, expectedUpdatedAt: working.record?.updatedAt ?? null },
        })
        if (!saved.workingLayout || !isColumnsViewPayload(saved.workingLayout.filters)) throw new Error('The server did not acknowledge the saved layout. Reload saved layout before retrying.')
        stored = { ...saved.workingLayout, filters: saved.workingLayout.filters }
        id = saved.id
      } else stored = await saveWorkingLayout(baseUrl, layoutSurface, payload, working.record)
      if (scopeRef.current !== layoutSurface) return id
      workingRef.current = { surface: layoutSurface, record: stored, ready: true }
      activate(id && named ? { kind: 'saved', id, name: named.name, missing: payload.columns.filter((k) => !attributeKeys.has(k)) } : { kind: 'custom', count: visibleLayoutKeys(payload, specs).length }, payload)
      gridState.markActive(id)
      setChip?.(payload.chip ?? null)
      return id
    } finally { saving.current = false }
  }, [layoutSurface, specs, alwaysColumns, gridState, baseUrl, activate, attributeKeys, setChip])
  const savePreferences = useCallback(async (value: PreferencesValue) => { await persistDraft(value) }, [persistDraft])
  const savePreferencesAs = useCallback(async (name: string, value: PreferencesValue) => (await persistDraft(value, { name, chip: activeChip?.id }))!, [persistDraft, activeChip])
  const updatePreferences = useCallback(async (view: SavedGridView<TPage>, value: PreferencesValue) => { await persistDraft(value, { name: view.name, view, chip: activeChip?.id }) }, [persistDraft, activeChip])
  const saveCurrentAs = useCallback((name: string) => savePreferencesAs(name, currentPreferences()), [savePreferencesAs, currentPreferences])
  const updateView = useCallback((view: SavedGridView<TPage>) => updatePreferences(view, currentPreferences()), [updatePreferences, currentPreferences])
  const reloadSavedPreferences = useCallback(async () => {
    const record = await fetchLayout()
    await gridState.refresh()
    if (scopeRef.current !== layoutSurface) throw new Error('The sheet scope changed. Reopen Customise in the current scope.')
    const payload = record?.filters ?? columnsViewPayload(orderedKeys)
    activate({ kind: 'custom', count: visibleLayoutKeys(payload, specs).length }, payload)
    gridState.markActive(null)
    setChip?.(payload.chip ?? null)
    return preferencesFromLayout(payload, specs)
  }, [fetchLayout, gridState, layoutSurface, orderedKeys, activate, specs, setChip])

  const describeView = useCallback((view: SavedGridView<TPage>) => {
    if (!isColumnsViewPayload(view.payload)) return view.payload ? { note: 'Saved in an older format — open it to convert' } : { note: 'Holds no columns' }
    const missing = view.payload.columns.filter((k) => !attributeKeys.has(k))
    const legacy = view.legacyShared ? 'Shared legacy template; saving creates your personal copy.' : ''
    if (!missing.length) return legacy ? { note: legacy } : null
    return { note: `${missing.length} of ${view.payload.columns.length} not on this product type: ${missing.slice(0, 4).join(', ')}${missing.length > 4 ? ', …' : ''}`, title: [legacy, missing.join(', ')].filter(Boolean).join(' ') }
  }, [attributeKeys])
  return {
    gridState, initialState: recoveryState ?? gridState.initialState, captureGridState,
    presets: views.presets, viewsSource: views.source, active,
    activePresetId: active.kind === 'all' ? ALL_VIEW_ID : active.kind === 'preset' ? active.id : null,
    emptyLabel: active.kind === 'custom' ? `Custom (${active.count})` : 'View',
    activeViewName: active.kind === 'saved' ? active.name : null,
    landed, landing, loadError: loadError ?? gridState.loadError, orderedKeys, preferenceColumns: specs, alwaysColumns, allColumnKeys,
    applyPreset, applyCustom, currentPreferences, currentPayload, savePreferences, savePreferencesAs,
    updatePreferences, reloadSavedPreferences, saveCurrentAs, updateView, describeView, visibleAttributeKeys,
  }
}
