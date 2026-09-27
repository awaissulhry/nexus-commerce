'use client'

/**
 * Shared sheet layout: server-saved membership, ordering, groups and pins, plus the transient row filter.
 *
 * TOOLBAR REBUILD (Owner, 2026-09-27 — `docs/product-sheet-toolbar/PLAN-2026-09-27.md`). Three rules, kept pure in
 * `sheetLayoutMemory.ts`:
 *  1. **Views work on FIELDS.** The Languages menu decides how many language columns a text field shows; a view,
 *     a preset, a layout and Customise never do. Choosing a view never changes the languages, and the other way round.
 *  2. **The view picked last opens again** — one memory per scope ("Current layout"), on the server, on every product
 *     and market of that scope. A product-type default applies only until the operator picks (D2 = A).
 *  3. **Progress columns show unless a layout hid them on purpose.** They can be hidden, shown and pinned like any
 *     other column, and that choice is kept.
 *
 * A row filter narrows the columns to those with matches while "Only columns with matches" is on (D1 = A). Picking a
 * view turns that off: the columns follow what was asked for last.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import type { GridApi, GridState } from '@/design-system/grid'
import {
  ALL_VIEW_ID, arrangementColumnState, columnStateToPrefs, columnsViewPayload,
  isColumnsViewPayload, pickGridState, prefsToColumnState, productTypeDefaultView, resolvePreset, useGridState, viewDisplayOf,
  describeViewRules, viewRulesFor, viewRulesOf, withViewRules,
  type ColumnsViewPayload, type GridStateApi, type GridStateKey, type GridViewPreset,
  type PrefsBridgeOptions, type SavedGridView, type UseGridStateOptions, type ViewDisplay, type ViewRule, type ViewRuleFacts,
} from '@/design-system/grid'
import type { GridDensityName } from '@/design-system/tokens/grid'
import type { PreferencesColumnSpec, PreferencesValue } from '@/design-system/patterns/PreferencesModal'
import { loadWorkingLayout, saveWorkingLayout, type StoredSheetLayout } from '@/design-system/grid/views/savedViewTransport'
import { viewChipColumns, type ViewChip } from '../contracts'
import type { SheetColumn } from './master/types'
import { alwaysColumnsFor, GAPS_VIEW_ID, orderColumnKeys, REQUIRED_VIEW_ID, sheetViews, structuralColumnKeys, type ViewContext } from './views'
import { defaultViewKeys } from './slotListColumns'
import { layoutFromPreferences, preferencesFromLayout, visibleLayoutKeys, mergeVisibleColumnOrder } from '@/design-system/grid/views/columnLayout'
import {
  chooseLanding, fieldPayload, hasMyLayout, languageKeyMap, layoutPart, pickOf, progressShown, recalledPick, rememberPick, withPick,
  type SheetPick, type WorkingLayoutPayload,
} from './sheetLayoutMemory'

/**
 * Widths and sort remain lightweight browser preferences for the WORKING layout. A NAMED view also
 * carries them, with the row height (2026-09-26, `ViewDisplay`), and applying one restores all three.
 */
export const SHEET_PERSIST_KEYS: readonly GridStateKey[] = ['columnSizing', 'columnPinning', 'sort']

/**
 * The sheet's row height, per operator and browser — one choice for every product and scope, like
 * the products grid's. Read after mount, not in the state initialiser: this hook also renders on the
 * server, where there is no storage, and a first paint that disagreed with the client's would not
 * hydrate. The default is COMPACT — what `GridSheet` has always given the sheet — so an operator who
 * never touches the control sees no change.
 */
export const SHEET_DENSITY_KEY = 'nds-sheet-density:v1'
export const SHEET_DEFAULT_DENSITY: GridDensityName = 'compact'
const DENSITIES: readonly GridDensityName[] = ['compact', 'cozy', 'spacious']
function readSheetDensity(): GridDensityName | null {
  try {
    const stored = window.localStorage.getItem(SHEET_DENSITY_KEY)
    return stored && (DENSITIES as readonly string[]).includes(stored) ? (stored as GridDensityName) : null
  } catch { return null }
}
function writeSheetDensity(density: GridDensityName): void {
  try { window.localStorage.setItem(SHEET_DENSITY_KEY, density) } catch { /* private mode: the choice lasts this visit */ }
}
/** "OUTERWEAR" → "Outerwear", "SAFETY_HELMET" → "Safety helmet": the menu's words for a stored product-type code. */
export function productTypeLabel(code: string): string {
  const words = code.trim().toLowerCase().replace(/[_-]+/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** A preset whose SAVED view follows a rule rather than freezing today's keys (SHEET-VIEWS step 5). */
const PRESET_RULES: Readonly<Record<string, ViewRule>> = { [REQUIRED_VIEW_ID]: { kind: 'required' }, [GAPS_VIEW_ID]: { kind: 'gaps' } }

/** "My layout" — the scope's own arrangement (was "Custom (N)"). */
export const MY_LAYOUT_LABEL = 'My layout'

export type ActiveColumns =
  | { kind: 'all' }
  | { kind: 'preset'; id: string; label: string }
  | { kind: 'saved'; id: string; name: string; missing: string[] }
  | { kind: 'custom'; count: number }

export interface UseSheetColumnsArgs<TRow, TPage> {
  apiRef: MutableRefObject<GridApi<TRow> | null>
  gridReady: GridApi<TRow> | null
  /** The GRID's columns — with two or more languages on, a text field arrives as one `<key>@<lang>` column per language. */
  columns: SheetColumn[]
  viewCtx: ViewContext
  serverViews?: Array<{ id: string; label: string; columnKeys: string[] }>
  identityColumn: string
  prefsBridge: PrefsBridgeOptions
  activeChip: ViewChip | null
  /** The operator's "Current layout" and last pick — ONE per scope (`product-edit:layout:master`, `…:AMAZON`). */
  layoutSurface: string
  /** The per-market surface used before 2026-09-27. Read once, to seed a scope that has no record of its own yet. */
  legacyLayoutSurface?: string
  /**
   * SHEET-VIEWS step 4 — the family parent's product type (`OUTERWEAR`). A view that is the default for it
   * opens until the operator picks another. `undefined` = not read yet, and the sheet WAITS to land (measured:
   * master landed on its media column before the family arrived, so a type default never won); `null` = read,
   * and the family has no type.
   */
  productType: string | null | undefined
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
  /** What the views menu calls the screen when neither a preset nor a saved view is on: "My layout". */
  emptyLabel: string
  activeViewName: string | null
  /** Attributes on screen in the active view — progress and identity columns are not counted. */
  activeCount: number | null
  /** The active saved view when it is the operator's own, so Customise Save updates it rather than My layout. */
  ownActiveView: SavedGridView<TPage> | null
  /** "My layout", when this scope has one, and how many attributes it shows here. */
  myLayout: { count: number } | null
  applyMyLayout: () => void
  /** D1 = A — while a row filter is on, show only the columns with matches. */
  narrowToMatches: boolean
  setNarrowToMatches: (on: boolean) => void
  landed: boolean
  loadError: string | null
  /** The GRID keys of every attribute column, in the sheet's order — what "export all" writes. */
  orderedKeys: string[]
  preferenceColumns: PreferencesColumnSpec[]
  alwaysColumns: string[]
  allColumnKeys: string[]
  /** A field's column ids on the grid: one per language when languages are split, else the field itself. */
  gridKeysOf: (field: string) => string[]
  applyPreset: (preset: GridViewPreset) => void
  currentPreferences: () => PreferencesValue
  currentPayload: () => ColumnsViewPayload
  savePreferences: (value: PreferencesValue) => Promise<void>
  savePreferencesAs: (name: string, value: PreferencesValue) => Promise<string>
  updatePreferences: (view: SavedGridView<TPage>, value: PreferencesValue) => Promise<void>
  reloadSavedPreferences: () => Promise<PreferencesValue>
  saveCurrentAs: (name: string) => Promise<string | null>
  updateView: (view: SavedGridView<TPage>) => Promise<unknown>
  describeView: (view: SavedGridView<TPage>) => { note?: string; title?: string } | null
  /** The GRID keys of the attribute columns on screen (export and transfer read these). */
  visibleAttributeKeys: () => string[]
  /** The sheet's row height. A view that carries one sets it; so does the toolbar. */
  density: GridDensityName
  setDensity: (density: GridDensityName) => void
  /** The product type on screen, for the views menu's "Make default for <Type> products". */
  productType: { code: string; label: string } | null
  /** The views menu's count for a saved view: the attributes it shows here, rules included (`withViewRules`). */
  viewColumnCount: (view: SavedGridView<TPage>) => number | null
}

type Working = { surface: string; record: StoredSheetLayout<WorkingLayoutPayload> | null; layout: ColumnsViewPayload | null; ready: boolean }

/** A teammate's view or an old shared template: applied and copied, never overwritten. */
const isOwnView = (view: SavedGridView<unknown>) => view.owned !== false && !view.teamShared && !view.legacyShared

export function useSheetColumns<TRow, TPage>(a: UseSheetColumnsArgs<TRow, TPage>): SheetColumnsApi<TPage> {
  const { apiRef, gridReady, columns, viewCtx, serverViews, identityColumn, prefsBridge, activeChip, layoutSurface, legacyLayoutSurface } = a
  const baseUrl = a.grid.baseUrl
  const scopeRef = useRef(layoutSurface)
  scopeRef.current = layoutSurface

  /* Rule 1 — everything below works on FIELDS. The grid's language columns are mapped at the edge (`toGrid`). */
  const keyMap = useMemo(() => languageKeyMap(columns), [columns])
  const fieldColumns = keyMap.fields
  const progressKeys = useMemo(() => fieldColumns.filter((c) => c.managedBy === 'progress').map((c) => c.key), [fieldColumns])
  const progressSet = useMemo(() => new Set(progressKeys), [progressKeys])
  const attributeColumns = useMemo(() => fieldColumns.filter((c) => c.managedBy !== 'progress'), [fieldColumns])
  const fieldCtx = useMemo<ViewContext>(() => ({
    ...viewCtx,
    ...(viewCtx.flaggedKeys ? { flaggedKeys: keyMap.toFields(viewCtx.flaggedKeys) } : {}),
    ...(viewCtx.requiredKeys ? { requiredKeys: keyMap.toFields(viewCtx.requiredKeys) } : {}),
  }), [viewCtx, keyMap])
  const orderedKeys = useMemo(() => orderColumnKeys(attributeColumns, fieldCtx), [attributeColumns, fieldCtx])
  /* R-56 (Step 4.3 #3) — what the sheet LANDS on: every column minus the slots a one-cell shows. Only the landing sites
     read this; `orderedKeys` stays every column (Customise, saved views and "export all" keep Bullet 1–10). */
  const landingKeys = useMemo(() => defaultViewKeys(orderedKeys, attributeColumns), [orderedKeys, attributeColumns])
  const attributeKeys = useMemo(() => new Set(orderedKeys), [orderedKeys])
  const knownKeys = useMemo(() => new Set([...orderedKeys, ...progressKeys]), [orderedKeys, progressKeys])
  const addressable = useMemo(() => [identityColumn, ...progressKeys, ...orderedKeys], [identityColumn, progressKeys, orderedKeys])
  const addressableSet = useMemo(() => new Set(addressable), [addressable])
  /* R-VT-1 (2026-09-13): a STRUCTURAL column joins the always-columns, so a saved view that predates
     it cannot silently drop it. Derived from the live column set by KIND — see `structuralColumnKeys`. */
  const structural = useMemo(() => structuralColumnKeys(fieldColumns), [fieldColumns])
  const alwaysColumns = useMemo(() => alwaysColumnsFor(addressable, structural), [addressable, structural])
  const allColumnKeys = useMemo(() => [...new Set([...alwaysColumns, ...progressKeys, ...orderedKeys])], [alwaysColumns, progressKeys, orderedKeys])
  const gridOrderedKeys = useMemo(() => columns.filter((c) => c.managedBy !== 'progress').map((c) => c.key), [columns])
  const gridAttributeKeys = useMemo(() => new Set(gridOrderedKeys), [gridOrderedKeys])
  const toGrid = useCallback((keys: readonly string[]) => [...new Set(keys.flatMap((key) => {
    const grid = keyMap.gridKeysOf(key)
    return grid.length ? grid : key === identityColumn ? [key] : []
  }))], [keyMap, identityColumn])
  const specs = useMemo<PreferencesColumnSpec[]>(() => {
    // The modal receives this schema order too. Required-first grid ranking must not reorder groups on Save.
    // Progress columns are listed (hide, show, pin) but not counted: the dialog counts attributes, like the toolbar.
    // A structural column (the variation theme) is always on screen, so the dialog shows it as FIXED, not tickable.
    return [{ key: identityColumn, label: 'Identity (SKU, readiness)', locked: true }, ...fieldColumns.map((c) => ({
      key: c.key, label: c.label, group: c.group, groupKey: c.groupKey,
      ...(c.managedBy === 'progress' ? { uncounted: true } : {}), ...(structural.includes(c.key) ? { locked: true } : {}),
    }))]
  }, [fieldColumns, identityColumn, structural])
  /* A view's count is the attributes it names; the always-on columns (identity, variation theme) are nobody's to name,
     so they are left out of every preset here — resolving a preset puts them back (`resolvePreset`'s `always`). */
  const views = useMemo(() => {
    const built = sheetViews(attributeColumns, fieldCtx, serverViews)
    return { ...built, presets: built.presets.map((p) => (p.columns.some((k) => structural.includes(k)) ? { ...p, columns: p.columns.filter((k) => !structural.includes(k)) } : p)) }
  }, [attributeColumns, fieldCtx, serverViews, structural])
  /* SHEET-VIEWS step 5 — the row facts a rule view follows. Read through a ref when a view is applied, so a
     gap fixed while editing does not pull its column off screen: a rule resolves at APPLY time, not live. */
  const ruleFacts = useMemo<ViewRuleFacts>(() => ({
    required: new Set(attributeColumns.filter((c) => c.requiredBy.length > 0 || fieldCtx.requiredKeys?.includes(c.key)).map((c) => c.key)),
    gaps: new Set((fieldCtx.flaggedKeys ?? []).filter((k) => attributeKeys.has(k))),
  }), [attributeColumns, fieldCtx, attributeKeys])
  const ruleFactsRef = useRef(ruleFacts)
  ruleFactsRef.current = ruleFacts
  const productTypeCode = a.productType?.trim().toUpperCase() || null
  const productType = useMemo(() => (productTypeCode ? { code: productTypeCode, label: productTypeLabel(productTypeCode) } : null), [productTypeCode])
  const [active, setActive] = useState<ActiveColumns>({ kind: 'all' })
  const activeRef = useRef(active)
  activeRef.current = active
  const [landedScope, setLandedScope] = useState<string | null>(null)
  const [landedGrid, setLandedGrid] = useState<GridApi<TRow> | null>(null)
  const [recovery, setRecovery] = useState<{ surface: string; state: GridState } | null>(null)
  const landed = landedScope === layoutSurface && landedGrid === gridReady
  /** The FIELD keys the active view shows (identity, progress and attributes). */
  const activeColumnsRef = useRef<string[]>([])
  // Retain the full payload: changing product type must never delete temporarily unavailable IDs.
  const layoutRef = useRef<ColumnsViewPayload | null>(null)
  const workingRef = useRef<Working>({ surface: layoutSurface, record: null, layout: null, ready: false })
  const [workingVersion, setWorkingVersion] = useState(0)
  const setWorking = useCallback((next: Working) => { workingRef.current = next; setWorkingVersion((v) => v + 1) }, [])
  const [loadState, setLoadState] = useState<{ surface: string; ready: boolean; error: string | null }>({ surface: layoutSurface, ready: false, error: null })
  const [memoryError, setMemoryError] = useState<{ surface: string; message: string } | null>(null)
  const loadError = loadState.surface === layoutSurface ? loadState.error : null
  const requestSequence = useRef(0)
  const saving = useRef(false)
  const [density, setDensityState] = useState<GridDensityName>(SHEET_DEFAULT_DENSITY)
  const densityRef = useRef(density)
  densityRef.current = density
  useEffect(() => { const stored = readSheetDensity(); if (stored) setDensityState(stored) }, [])
  const setDensity = useCallback((next: GridDensityName) => { setDensityState(next); writeSheetDensity(next) }, [])
  const applySavedRef = useRef<(payload: ColumnsViewPayload, view: SavedGridView<TPage>) => void>(() => {})
  const gridState = useGridState<TPage>({ ...a.grid, persistKeys: SHEET_PERSIST_KEYS, applyColumnsView: (payload, view) => applySavedRef.current(payload, view) })
  const recoveryState = recovery?.surface === layoutSurface ? recovery.state : undefined
  const captureGridState = useCallback(() => {
    const api = apiRef.current
    if (api && !api.isDestroyed()) setRecovery({ surface: layoutSurface, state: pickGridState(api.getState(), SHEET_PERSIST_KEYS) })
  }, [apiRef, layoutSurface])

  /* ── the row filter's narrowing (D1 = A) ──────────────────────────────────────────────────── */
  const [narrowToMatches, setNarrowState] = useState(true)
  const narrowRef = useRef(true)
  const chipRef = useRef(activeChip)
  chipRef.current = activeChip
  /** The columns a narrowing filter shows, or null when nothing narrows. */
  const narrowedKeys = useCallback((): string[] | null => {
    const chip = chipRef.current
    if (!chip || !narrowRef.current) return null
    const matches = keyMap.toFields(viewChipColumns(chip.cells)).filter((k) => knownKeys.has(k))
    if (!matches.length) return null
    const progress = activeColumnsRef.current.filter((k) => progressSet.has(k))
    return [...new Set([...alwaysColumns, ...progress, ...matches])]
  }, [keyMap, knownKeys, progressSet, alwaysColumns])

  const fetchLayout = useCallback(async () => {
    const sequence = ++requestSequence.current
    try {
      const record = await loadWorkingLayout<WorkingLayoutPayload>(baseUrl, layoutSurface)
      let layout = record ? layoutPart(record.filters) : null
      /* Before 2026-09-27 the layout was kept per market. A scope with no record of its own starts from the one this
         market had; the first pick or save writes the scope's record and leaves the old row as it was. */
      if (!record && legacyLayoutSurface) layout = layoutPart((await loadWorkingLayout(baseUrl, legacyLayoutSurface).catch(() => null))?.filters)
      if (scopeRef.current !== layoutSurface || sequence !== requestSequence.current) throw new Error('The sheet scope changed. Reopen Customise in the current scope.')
      setWorking({ surface: layoutSurface, record, layout, ready: true })
      setLoadState({ surface: layoutSurface, ready: true, error: null })
      return { record, layout }
    } catch (error) {
      if (scopeRef.current === layoutSurface && sequence === requestSequence.current) {
        setWorking({ surface: layoutSurface, record: null, layout: null, ready: false })
        setLoadState({ surface: layoutSurface, ready: false, error: error instanceof Error ? error.message : 'Could not load your saved layout' })
      }
      throw error
    }
  }, [baseUrl, layoutSurface, legacyLayoutSurface, setWorking])

  useEffect(() => {
    setLandedScope(null)
    layoutRef.current = null
    setWorking({ surface: layoutSurface, record: null, layout: null, ready: false })
    setLoadState({ surface: layoutSurface, ready: false, error: null })
    void fetchLayout().catch(() => {})
    return () => { requestSequence.current += 1 }
  }, [layoutSurface, fetchLayout, setWorking])

  /**
   * Rule 2 — write "Current layout": My layout plus the last pick. Writes run one after another, each on the record
   * the previous one returned; a stale record (another tab saved) is re-read once and the write retried.
   */
  const writes = useRef<Promise<unknown>>(Promise.resolve())
  const writeWorking = useCallback((build: (layout: ColumnsViewPayload | null) => WorkingLayoutPayload, opts: { throwOnError?: boolean } = {}) => {
    const surface = layoutSurface
    const attempt = async (retry: boolean): Promise<void> => {
      const w = workingRef.current
      if (w.surface !== surface || !w.ready) {
        if (opts.throwOnError) throw new Error('Load your saved layout before saving. Use Reload saved layout to retry.')
        return
      }
      try {
        const stored = await saveWorkingLayout<WorkingLayoutPayload>(baseUrl, surface, build(w.layout), w.record)
        if (workingRef.current.surface === surface) setWorking({ surface, record: stored, layout: layoutPart(stored.filters), ready: true })
        setMemoryError((previous) => (previous?.surface === surface ? null : previous))
      } catch (error) {
        if (retry && (error as { status?: number }).status === 409) {
          await fetchLayout().catch(() => {})
          return attempt(false)
        }
        const message = error instanceof Error ? error.message : 'Could not save your layout'
        if (scopeRef.current === surface) setMemoryError({ surface, message: `Your view choice was not saved: ${message}` })
        if (opts.throwOnError) throw error
      }
    }
    const run = writes.current.then(() => attempt(true))
    writes.current = run.catch(() => {})
    return run
  }, [layoutSurface, baseUrl, setWorking, fetchLayout])
  /** Remember an explicit pick: in this tab at once, and on the server. */
  const remember = useCallback((pick: SheetPick) => {
    rememberPick(layoutSurface, pick)
    void writeWorking((layout) => withPick(layout, pick))
  }, [layoutSurface, writeWorking])

  const gridLocks = useCallback((api: GridApi<TRow>) => keyMap.toFields(columnStateToPrefs(api.getColumnState(), preferencesFromLayout(null, specs), prefsBridge).lockedColumns ?? []), [keyMap, specs, prefsBridge])
  const applyToGrid = useCallback((keys: readonly string[], order: boolean, locks?: readonly string[]) => {
    const api = apiRef.current
    if (!api || api.isDestroyed()) return false
    const value = { ...preferencesFromLayout(null, specs), visibleColumns: toGrid(keys), lockedColumns: toGrid(locks ?? gridLocks(api)) }
    api.applyColumnState({ state: prefsToColumnState(value, prefsBridge), applyOrder: order })
    return true
  }, [apiRef, specs, toGrid, gridLocks, prefsBridge])
  /** Put the active view on the grid — or, while a row filter narrows, the columns with matches. */
  const paint = useCallback((order: boolean, locks?: readonly string[]) => applyToGrid(narrowedKeys() ?? activeColumnsRef.current, order, locks), [applyToGrid, narrowedKeys])

  const countOf = useCallback((payload: ColumnsViewPayload) => visibleLayoutKeys(payload, specs).filter((k) => attributeKeys.has(k)).length, [specs, attributeKeys])
  /**
   * The FIELD keys a payload shows: identity, the progress columns it does not hide (always right after Product, as
   * they opened on 2026-09-26), the structural columns (variation theme), then its own columns.
   */
  const shownKeys = useCallback((payload: ColumnsViewPayload) => {
    const applied = withViewRules(payload, specs, preferencesFromLayout(payload, specs), ruleFactsRef.current)
    const own = visibleLayoutKeys(applied, specs).filter((k) => !progressSet.has(k))
    const progress = progressShown(payload, progressKeys)
    return [...new Set([...alwaysColumns.filter((k) => !structural.includes(k)), ...progress, ...alwaysColumns, ...own])]
  }, [specs, progressKeys, progressSet, alwaysColumns, structural])
  const activate = useCallback((next: ActiveColumns, payload: ColumnsViewPayload, restoreLocks = true) => {
    // The STORED payload is kept (its rules too); what shows is its keys plus what its rules match here today.
    layoutRef.current = payload
    const keys = shownKeys(payload)
    activeColumnsRef.current = keys
    setActive(next)
    paint(true, restoreLocks && payload.v === 3 ? payload.lockedColumns : undefined)
    gridState.markDirty()
  }, [shownKeys, paint, gridState])
  /** An explicit column choice stops a filter's narrowing: the columns follow what was asked for last. */
  const stopNarrowing = useCallback(() => { narrowRef.current = false; setNarrowState(false) }, [])
  const presetPayload = useCallback((preset: GridViewPreset) => columnsViewPayload(resolvePreset(preset, addressable, alwaysColumns).columns.filter((k) => attributeKeys.has(k))), [addressable, alwaysColumns, attributeKeys])
  const applyPreset = useCallback((preset: GridViewPreset) => {
    const all = preset.id === ALL_VIEW_ID
    gridState.markActive(null)
    stopNarrowing()
    activate(all ? { kind: 'all' } : { kind: 'preset', id: preset.id, label: preset.label }, all ? columnsViewPayload(landingKeys) : presetPayload(preset), false)
    remember(all ? { kind: 'all' } : { kind: 'preset', id: preset.id })
  }, [gridState, stopNarrowing, activate, landingKeys, presetPayload, remember])
  /**
   * 2026-09-26 — a named view restores what it saved besides its columns: widths, sort, row height.
   * Only an EXPLICIT apply (the menu, or landing on the default view) calls this; landing on the
   * working layout does not, so the widths the operator dragged since stay theirs. A width or sort for
   * a column this product type lacks is skipped, the same way a missing column is (`missing` above).
   */
  const applyDisplay = useCallback((display: ViewDisplay) => {
    if (display.density) setDensity(display.density)
    const api = apiRef.current
    if (!api || api.isDestroyed()) return
    const present = new Set(api.getColumnState().map((c) => c.colId))
    const widths = Object.entries(display.columnWidths ?? {}).flatMap(([key, width]) => toGrid([key]).filter((colId) => present.has(colId)).map((colId) => ({ colId, width })))
    if (widths.length) api.applyColumnState({ state: widths, applyOrder: false })
    if (display.sort) {
      // A sort names a FIELD; with languages split it sorts by the field's first language column.
      const sorted = display.sort.flatMap((s) => {
        const colId = toGrid([s.colId]).find((id) => present.has(id))
        return colId ? [{ colId, sort: s.sort }] : []
      })
      api.applyColumnState({ state: sorted.map((s, sortIndex) => ({ ...s, sortIndex })), defaultState: { sort: null }, applyOrder: false })
    }
  }, [apiRef, setDensity, toGrid])
  /** What a named save stores besides the columns — read from the grid as it is on screen now, per FIELD. */
  const captureDisplay = useCallback((): ViewDisplay => {
    const api = apiRef.current
    if (!api || api.isDestroyed()) return { density: densityRef.current }
    const state = api.getColumnState().filter((c) => c.colId === identityColumn || keyMap.toFields([c.colId]).some((k) => addressableSet.has(k)))
    const widths: Record<string, number> = {}
    for (const c of state) {
      const key = keyMap.toFields([c.colId])[0]
      if (typeof c.width === 'number' && c.width > 0 && widths[key] === undefined) widths[key] = Math.round(c.width)
    }
    const sorted = state.filter((c) => c.sort === 'asc' || c.sort === 'desc').sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0))
    const seen = new Set<string>()
    return {
      columnWidths: widths,
      sort: sorted.flatMap((c) => {
        const key = keyMap.toFields([c.colId])[0]
        if (seen.has(key)) return []
        seen.add(key)
        return [{ colId: key, sort: c.sort as 'asc' | 'desc' }]
      }),
      density: densityRef.current,
    }
  }, [apiRef, identityColumn, keyMap, addressableSet])
  const applySaved = useCallback((stored: ColumnsViewPayload, view: SavedGridView<TPage>) => {
    const payload = fieldPayload(stored)
    activate({ kind: 'saved', id: view.id, name: view.name, missing: payload.columns.filter((k) => !knownKeys.has(k)) }, payload)
    applyDisplay(viewDisplayOf(payload))
  }, [activate, applyDisplay, knownKeys])
  /* The views menu's pick (`useGridViews.apply` → here): apply, stop narrowing, remember. */
  applySavedRef.current = (payload, view) => {
    stopNarrowing()
    applySaved(payload, view)
    remember({ kind: 'saved', id: view.id })
  }
  const applyMyLayout = useCallback(() => {
    const layout = workingRef.current.surface === layoutSurface ? workingRef.current.layout : null
    if (!hasMyLayout(layout)) return
    gridState.markActive(null)
    stopNarrowing()
    activate({ kind: 'custom', count: countOf(layout) }, layout)
    remember({ kind: 'custom' })
  }, [layoutSurface, gridState, stopNarrowing, activate, countOf, remember])

  useEffect(() => {
    const api = apiRef.current
    if (landed || !api || api.isDestroyed() || !gridReady || !orderedKeys.length || !gridState.loaded || loadState.surface !== layoutSurface || !loadState.ready) return
    if (a.productType === undefined && !(landedScope === layoutSurface && layoutRef.current)) return
    const colIds = api.getColumnState().map((c) => c.colId)
    if (!toGrid(orderedKeys).some((k) => colIds.includes(k))) return
    const savedState = recoveryState ?? gridState.lastUsed?.gridState
    const arrangement = arrangementColumnState(savedState, colIds)
    if (arrangement.length) api.applyColumnState({ state: arrangement, applyOrder: false })
    // A failed read removes AG without unmounting this hook. Reapply the current view on retry,
    // including a narrowing filter, instead of leaving default columns under the old view label.
    if (landedScope === layoutSurface && layoutRef.current) {
      paint(true)
      setLandedGrid(api)
      return
    }
    const working = workingRef.current
    const pick = recalledPick(layoutSurface) ?? pickOf(working.record?.filters)
    const typeView = productTypeDefaultView(gridState.views, productTypeCode)
    const dv = gridState.defaultView
    const choice = chooseLanding({
      pick,
      presetIds: views.presets.map((p) => p.id),
      savedIds: gridState.views.filter((v) => isColumnsViewPayload(v.payload)).map((v) => v.id),
      myLayout: hasMyLayout(working.layout),
      typeDefaultId: typeView?.id ?? null,
      defaultId: dv && isColumnsViewPayload(dv.payload) ? dv.id : null,
    })
    if (choice.kind === 'saved') {
      const view = gridState.views.find((v) => v.id === choice.id)!
      applySaved(view.payload as ColumnsViewPayload, view)
      gridState.markActive(view.id)
    } else if (choice.kind === 'custom' && hasMyLayout(working.layout)) {
      const layout = working.layout
      // A layout stored before picks were remembered may be a named view's copy (a named save wrote both).
      const named = pick ? null : gridState.views.find((v) => isColumnsViewPayload(v.payload) && JSON.stringify(fieldPayload(v.payload)) === JSON.stringify(layout))
      activate(named ? { kind: 'saved', id: named.id, name: named.name, missing: layout.columns.filter((k) => !knownKeys.has(k)) } : { kind: 'custom', count: countOf(layout) }, layout)
      gridState.markActive(named?.id ?? null)
    } else if (choice.kind === 'preset') {
      const preset = views.presets.find((p) => p.id === choice.id)!
      activate({ kind: 'preset', id: preset.id, label: preset.label }, presetPayload(preset), false)
      gridState.markActive(null)
    } else {
      activate({ kind: 'all' }, columnsViewPayload(landingKeys), false)
      gridState.markActive(null)
    }
    setLandedScope(layoutSurface)
    setLandedGrid(api)
  }, [recoveryState, landedScope, paint, landed, apiRef, gridReady, orderedKeys, landingKeys, gridState, loadState, layoutSurface, toGrid, activate, applySaved, knownKeys, countOf, presetPayload, views.presets, productTypeCode, a.productType])

  /* The column set moved under a landed sheet. A new FIELD set (another product type, a schema refresh) re-resolves
     the active view; a new GRID set with the same fields (languages switched, progress columns arrived) repaints it. */
  const fieldSignature = JSON.stringify(orderedKeys)
  const gridSignature = JSON.stringify(columns.map((c) => c.key))
  const lastSignature = useRef({ field: fieldSignature, grid: gridSignature })
  useEffect(() => {
    if (!landed) return
    const last = lastSignature.current
    if (last.field === fieldSignature && last.grid === gridSignature) return
    lastSignature.current = { field: fieldSignature, grid: gridSignature }
    if (active.kind === 'all') { activate(active, columnsViewPayload(landingKeys), false); return }
    if (active.kind === 'preset') {
      const preset = views.presets.find((p) => p.id === active.id)
      if (preset) activate(active, presetPayload(preset), false)
      else activate({ kind: 'all' }, columnsViewPayload(landingKeys), false)
      return
    }
    const payload = layoutRef.current
    if (payload) activate(active.kind === 'saved' ? { ...active, missing: payload.columns.filter((k) => !knownKeys.has(k)) } : { kind: 'custom', count: countOf(payload) }, payload, false)
  }, [landed, fieldSignature, gridSignature, active, activate, landingKeys, views.presets, presetPayload, knownKeys, countOf])

  useEffect(() => {
    if (!landed || !gridState.loaded || active.kind !== 'saved') return
    const acknowledged = gridState.activeId && gridState.activeId !== active.id ? gridState.views.find((v) => v.id === gridState.activeId) : null
    if (acknowledged) { setActive({ ...active, id: acknowledged.id, name: acknowledged.name }); return }
    const still = gridState.views.find((v) => v.id === active.id)
    // The view on screen was deleted: go back to All attributes, rather than call its columns "My layout".
    if (!still) {
      const all = views.presets.find((p) => p.id === ALL_VIEW_ID)
      if (all) applyPreset(all)
      else setActive({ kind: 'custom', count: activeColumnsRef.current.filter((k) => attributeKeys.has(k)).length })
    } else if (still.name !== active.name) setActive({ ...active, name: still.name })
  }, [landed, gridState.loaded, gridState.views, gridState.activeId, active, attributeKeys, views.presets, applyPreset])

  /* A NEW filter narrows by default (D1 = A); its counts changing repaints without touching the switch. */
  const chipId = activeChip?.id ?? null
  useEffect(() => {
    narrowRef.current = true
    setNarrowState(true)
  }, [chipId])
  useEffect(() => {
    if (!landed) return
    paint(false)
    // A filter changes membership only, preserving the chosen layout's order and pins.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChip, narrowToMatches, landed])
  const setNarrowToMatches = useCallback((on: boolean) => { narrowRef.current = on; setNarrowState(on) }, [])

  const visibleAttributeKeys = useCallback(() => {
    const api = apiRef.current
    return (!api || api.isDestroyed() ? toGrid(activeColumnsRef.current) : api.getColumnState().filter((s) => !s.hide).map((s) => s.colId)).filter((k) => gridAttributeKeys.has(k))
  }, [apiRef, toGrid, gridAttributeKeys])
  const currentPreferences = useCallback(() => {
    const previous = preferencesFromLayout(layoutRef.current, specs)
    const api = apiRef.current
    if (!api || api.isDestroyed()) return previous
    const raw = columnStateToPrefs(api.getColumnState(), previous, prefsBridge)
    const fromGrid = { ...raw, visibleColumns: keyMap.toFields(raw.visibleColumns), lockedColumns: raw.lockedColumns && keyMap.toFields(raw.lockedColumns) }
    const unavailable = (keys: readonly string[]) => keys.filter((k) => !addressableSet.has(k))
    // A narrowing filter is temporary: opening Customise edits the view underneath it.
    const narrowed = narrowedKeys() !== null
    const underneath = activeColumnsRef.current.filter((k) => k !== identityColumn && !alwaysColumns.includes(k))
    return {
      ...fromGrid,
      visibleColumns: narrowed ? [...underneath, ...unavailable(previous.visibleColumns)] : [...fromGrid.visibleColumns, ...unavailable(previous.visibleColumns)],
      lockedColumns: [...(fromGrid.lockedColumns ?? []), ...unavailable(previous.lockedColumns ?? [])],
      columnOrder: mergeVisibleColumnOrder(previous.columnOrder ?? [], (narrowed ? underneath : fromGrid.visibleColumns).filter((key) => knownKeys.has(key) && !fromGrid.lockedColumns?.includes(key))),
    }
  }, [specs, apiRef, prefsBridge, keyMap, addressableSet, narrowedKeys, identityColumn, alwaysColumns, knownKeys])
  const currentPayload = useCallback((): ColumnsViewPayload => layoutFromPreferences(specs, currentPreferences(), alwaysColumns), [specs, currentPreferences, alwaysColumns])

  const persistDraft = useCallback(async (value: PreferencesValue, named?: { name: string; view?: SavedGridView<TPage> }) => {
    if (saving.current) throw new Error('A layout save is already in progress')
    const working = workingRef.current
    if (scopeRef.current !== layoutSurface || working.surface !== layoutSurface || !working.ready) throw new Error('Load your saved layout before saving. Use Reload saved layout to retry.')
    /* A NAMED view keeps everything on screen (2026-09-26): widths, sort and row height ride with its
       columns. My layout stays columns-only — its widths follow the browser. */
    const payload: ColumnsViewPayload = { ...layoutFromPreferences(specs, value, alwaysColumns), ...(named ? captureDisplay() : {}) }
    /* SHEET-VIEWS step 5 — a NAMED view also stores what it follows: every fully ticked group, and the
       Required / Has gaps rule when that preset (or the view itself) offers it and all its columns stay ticked. */
    if (named) {
      const current = activeRef.current
      const offered = [...viewRulesOf(named.view?.payload), ...(current.kind === 'preset' && PRESET_RULES[current.id] ? [PRESET_RULES[current.id]] : [])]
      const rules = viewRulesFor(value, specs, ruleFactsRef.current, offered)
      if (rules.length) payload.rules = rules
    }
    saving.current = true
    try {
      if (named) {
        const saved = await gridState.saveRecord(named.name, { id: named.view?.id, isDefault: named.view?.isDefault, expectedUpdatedAt: named.view?.updatedAt, payload })
        if (scopeRef.current !== layoutSurface) return saved.id
        activate({ kind: 'saved', id: saved.id, name: named.name, missing: payload.columns.filter((k) => !knownKeys.has(k)) }, payload)
        gridState.markActive(saved.id)
        remember({ kind: 'saved', id: saved.id })
        return saved.id
      }
      await writeWorking(() => withPick(payload, { kind: 'custom' }), { throwOnError: true })
      if (scopeRef.current !== layoutSurface) return null
      rememberPick(layoutSurface, { kind: 'custom' })
      activate({ kind: 'custom', count: countOf(payload) }, payload)
      gridState.markActive(null)
      return null
    } finally { saving.current = false }
  }, [layoutSurface, specs, alwaysColumns, captureDisplay, gridState, activate, knownKeys, remember, writeWorking, countOf])
  const savePreferences = useCallback(async (value: PreferencesValue) => { await persistDraft(value) }, [persistDraft])
  const savePreferencesAs = useCallback(async (name: string, value: PreferencesValue) => (await persistDraft(value, { name }))!, [persistDraft])
  const updatePreferences = useCallback(async (view: SavedGridView<TPage>, value: PreferencesValue) => { await persistDraft(value, { name: view.name, view }) }, [persistDraft])
  const saveCurrentAs = useCallback((name: string) => savePreferencesAs(name, currentPreferences()), [savePreferencesAs, currentPreferences])
  const updateView = useCallback((view: SavedGridView<TPage>) => updatePreferences(view, currentPreferences()), [updatePreferences, currentPreferences])
  const reloadSavedPreferences = useCallback(async () => {
    const { layout } = await fetchLayout()
    await gridState.refresh()
    if (scopeRef.current !== layoutSurface) throw new Error('The sheet scope changed. Reopen Customise in the current scope.')
    setMemoryError(null)
    const payload = hasMyLayout(layout) ? layout : columnsViewPayload(landingKeys)
    activate(hasMyLayout(layout) ? { kind: 'custom', count: countOf(layout) } : { kind: 'all' }, payload)
    gridState.markActive(null)
    return preferencesFromLayout(payload, specs)
  }, [fetchLayout, gridState, layoutSurface, landingKeys, activate, countOf, specs])

  const describeView = useCallback((view: SavedGridView<TPage>) => {
    if (!isColumnsViewPayload(view.payload)) return view.payload ? { note: 'Saved in an older format — open it to convert' } : { note: 'Holds no columns' }
    const payload = fieldPayload(view.payload)
    const missing = payload.columns.filter((k) => !knownKeys.has(k))
    const legacy = view.legacyShared ? 'Shared legacy template; saving creates your personal copy.' : ''
    // SHEET-VIEWS step 5 — say what a rule view follows, so a column that joined by itself is no surprise.
    const follows = describeViewRules(viewRulesOf(payload), specs, preferencesFromLayout(payload, specs))
    if (!missing.length) return legacy || follows ? { note: [follows, legacy].filter(Boolean).join(' · ') } : null
    return {
      note: [follows, `${missing.length} of ${payload.columns.length} not on this product type: ${missing.slice(0, 4).join(', ')}${missing.length > 4 ? ', …' : ''}`].filter(Boolean).join(' · '),
      title: [legacy, missing.join(', ')].filter(Boolean).join(' '),
    }
  }, [knownKeys, specs])
  const viewColumnCount = useCallback((view: SavedGridView<TPage>) => {
    if (!isColumnsViewPayload(view.payload)) return null
    const payload = fieldPayload(view.payload)
    return withViewRules(payload, specs, preferencesFromLayout(payload, specs), ruleFactsRef.current).columns.filter((k) => attributeKeys.has(k)).length
  }, [specs, attributeKeys])
  const myLayout = useMemo(() => {
    const w = workingRef.current
    return w.surface === layoutSurface && hasMyLayout(w.layout) ? { count: countOf(w.layout) } : null
    // `workingVersion` is the signal that `workingRef` changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workingVersion, layoutSurface, countOf])
  /* The Columns trigger's number is the SAME number the menu prints beside the item that is on. */
  const activeCount = useMemo(() => {
    if (active.kind === 'all') return views.presets.find((p) => p.id === ALL_VIEW_ID)?.columns.length ?? null
    if (active.kind === 'preset') return views.presets.find((p) => p.id === active.id)?.columns.length ?? null
    if (active.kind === 'saved') {
      const view = gridState.views.find((v) => v.id === active.id)
      return view ? viewColumnCount(view) : null
    }
    return active.count
  }, [active, views.presets, gridState.views, viewColumnCount])
  const ownActiveView = active.kind === 'saved' ? gridState.views.find((v) => v.id === active.id && isOwnView(v as SavedGridView<unknown>)) ?? null : null
  return {
    gridState, initialState: recoveryState ?? gridState.initialState, captureGridState,
    presets: views.presets, viewsSource: views.source, active,
    activePresetId: active.kind === 'all' ? ALL_VIEW_ID : active.kind === 'preset' ? active.id : null,
    emptyLabel: MY_LAYOUT_LABEL,
    activeViewName: active.kind === 'saved' ? active.name : null,
    activeCount, ownActiveView, myLayout, applyMyLayout, narrowToMatches, setNarrowToMatches,
    landed, loadError: loadError ?? (memoryError?.surface === layoutSurface ? memoryError.message : null) ?? gridState.loadError,
    orderedKeys: gridOrderedKeys, preferenceColumns: specs, alwaysColumns, allColumnKeys, gridKeysOf: keyMap.gridKeysOf,
    applyPreset, currentPreferences, currentPayload, savePreferences, savePreferencesAs,
    updatePreferences, reloadSavedPreferences, saveCurrentAs, updateView, describeView, visibleAttributeKeys,
    density, setDensity, productType, viewColumnCount,
  }
}
