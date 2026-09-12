'use client'

/**
 * VP.3 — the SHARED-PRODUCT Variants surface (spec §3, canvas artboard 1).
 *
 *     [ AXES  ⠿ Colore [2 values] × ⠿ Taglia [10 values]  + Add axis │ 20 of 20 … ]   40px
 *     [ 21 rows · 1 parent · 20 variants   Find…   chips   Customise Export Import ⋯ ] 40px
 *     [ PRODUCT              │ AXES            │ CHANNEL PROJECTIONS              ]   30px
 *     [ ☐ │ Product          │ Colore │ Taglia │ Amazon · IT │ eBay · IT │ …      ]   28px
 *     [ … 36px rows … ]
 *     [ 21 rows · 20 variants                                                   ? ]   36px
 *
 * ## What this file composes, and what it refuses to re-implement
 *
 * The ROWS, the COLUMNS and the WRITE are the master sheet's: `useMasterSheet` supplies the family's
 * rows on this market, the `SheetWriter` that owns every cell's `expectedVersion` round trip, and
 * the `CellSaveTracker` that carries a refusal's reason back to the cell. An axis edit here goes
 * down the same path as the same edit on Information, including the 409 → repaint + refetch, because
 * it IS that path — not a copy of it (ruling #11: a lane-built `saveCell()` has a live 409 bug where
 * the second edit to a row is refused by its own first save).
 *
 * The FAMILY VERBS are the registry's (`familyActions` → `useFamilyVerbs`), in the toolbar's one ⋯
 * and in `Add variant ▾`, so a verb cannot be offered here and refused on the sheet.
 *
 * What is genuinely this page's: the family band, the row ORDER (axis-value order, not SKU), the
 * three chips, and the channel projection columns.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'next/navigation'
import { AlertTriangle } from 'lucide-react'

import { Banner, useToast, type MenuItemDef } from '@/design-system/components'
import { Button, InfoTip, Pill } from '@/design-system/primitives'
import { PreferencesModal, type PreferencesColumnSpec, type PreferencesValue } from '@/design-system/patterns'
import {
  actionContextMenu,
  actionMenuItems,
  GridSheet,
  GridSheetStatus,
  gridSelection,
  columnStateToPrefs,
  prefsToColumnState,
  NexusGrid,
  SHEET_GRID_OPTIONS,
  useActionPress,
  useGridLifetime,
  writeGate,
  gridGeometry,
  type ColDef,
  type GridApi,
  type GridReadyEvent,
} from '@/design-system/grid'
import { useAuth } from '@/lib/auth/AuthProvider'

import { useRegisterViewChip, useSaveReporter, useStudioScope, useViewChips } from '../../contracts'
import { SHEET_STATE_OVERLAYS, sheetEmptyState } from '../../sheet/sheetGridStates'
import { SheetLoadError } from '../../sheet/SheetLoadError'
import { useVariantTransfer } from '../../import/VariantTransfer'
import { SheetToolbar } from '../../sheet/SheetToolbar'
import { familyActions } from '../../sheet/master/familyActions'
import { familyOps } from '../../sheet/master/familyOps'
import { FamilySelectionBar } from '../../sheet/master/FamilySelectionBar'
import { useFamilyVerbs } from '../../sheet/master/FamilyBar'
import { useFamilyProductPicker } from '../../sheet/master/FamilyProductPicker'
import { useFamily } from '../../sheet/master/useFamily'
import { useMasterSheet } from '../../sheet/master/useMasterSheet'
import { useReferenceNames } from '../../sheet/useReferenceNames'
import type { NewVariationDraft } from '../../sheet/master/addVariation'
import type { StudioRow } from '../../sheet/master/types'

import { axisSummary, combinationCoverage, orderByAxisValues, type AxisSummary } from './coverage'
import { axisColumnsFor, buildVariantColumns, identityLine, IDENTITY_COL } from './columns'
import { excludedSomewhere, mergeAxisValues } from './projections'
import { liveSource } from '../channel/source'
import { FamilyBand } from './FamilyBand'
import { GenerateCombinationsDialog } from './GenerateCombinationsDialog'
import { ManageAxesDialog, saveAxisOrder } from './ManageAxesDialog'
import { useFamilyProjections } from './useFamilyProjections'
import styles from './family.module.css'

/** §1.5, verbatim — the ONE reason this page may omit the views trigger. */
const ABSENT_VIEWS = [
  { control: 'views' as const, reason: 'This page has a fixed column set: product, axes and channel projections.' },
]

export function FamilyVariants() {
  const params = useParams<{ id: string }>()
  const { market, locale } = useStudioScope()
  const productId = typeof params?.id === 'string' ? params.id : Array.isArray(params?.id) ? params.id[0] : ''

  if (!productId) return <div style={{ padding: 24 }}>No product in the route.</div>
  /* The frame resolves both from the marketplace table; before it answers there is no coordinate to
     read, and a family fetched against a guessed market would show another catalogue's listings. */
  if (!market || !locale) return <div style={{ padding: 24 }} className="nds-cell-muted">Waiting for the market…</div>
  return <FamilyVariantsSurface key={`${productId}:${market}:${locale}`} productId={productId} market={market} locale={locale} />
}

function FamilyVariantsSurface({ productId, market, locale }: { productId: string; market: string; locale: string }) {
  const { getApi: getGridApi, bind: bindGridApi, onGridPreDestroyed: releaseGrid } = useGridLifetime<GridApi<StudioRow>>()
  const reporter = useSaveReporter()
  const { has, status: authStatus } = useAuth()
  const toast = useToast()

  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null)
  const onWriteStart = useCallback((id: string, rowId: string) => reporter.pending(id, rowId), [reporter])
  const onWriteEnd = useCallback((id: string, ok: boolean, msg?: string, rowId?: string) => reporter.resolved(id, ok, msg, rowId), [reporter])
  /* The ONLY writer of the save clock (#705): `onSettled` fires for every settled batch, refusals
     included, so stamping it unconditionally writes a false time over a refused write. */
  const afterWrite = useRef<() => void>(() => {})
  const onSettled = useCallback(({ ok, savedAt }: { rowId: string; ok: boolean; savedAt: string }) => { if (ok) { setLastSavedAt(savedAt); afterWrite.current() } }, [])

  const { sheet: loadedSheet, loading, error, contractProblems, reload, writer, tracker, conflicts, bindGrid } = useMasterSheet({
    productId, market, locale, onWriteStart, onWriteEnd, onSettled,
  })
  const sheet = useReferenceNames(loadedSheet, 'MASTER', market)
  const familyQuery = useFamily(productId)
  const projectionsQuery = useFamilyProjections(productId, market, locale)

  /* ── the axes, and the rows they describe ──────────────────────────────────────────────── */

  /**
   * 🔴 The family read is the FIRST source of the axes, and on the real catalogue it is the only one
   * that answers. Measured on GALE-JACKET, 2026-09-11, against the running API:
   *
   *   `/studio/family`  axes `Colore` · `Taglia`; every child carries `{Colore:'Nero',Taglia:'3XL'}`
   *   `/studio/sheet`   `family.variationAxes` = `['Colore','Taglia']` — the same NAMES …
   *                     … but 235 columns with no `Colore` and no `Taglia` among them, case-
   *                     insensitively, `row.axisValues` = `{}` on all 21 rows, and the two columns
   *                     the server flags `axis: true` (`color` / `size`) hold `null` on 19 of 20
   *                     children.
   *
   * So an axis KEY is a key into `axisValues`, NOT a column id, and a page that read the sheet for
   * axis values would draw an empty AXES group beside a family that plainly varies by two. That is
   * why the order below is what it is; the sheet's own flags are the last resort, for a family whose
   * axes happen to be spelled like its columns.
   */
  const projections = projectionsQuery.projections
  const projectionsRef = useRef(projections)
  projectionsRef.current = projections

  /** The axis KEYS, before anything that depends on a row — the merge below needs them. */
  const axisKeys = useMemo(() => {
    return projections.axes.map(a => a.key)
  }, [projections.axes])

  /**
   * The sheet's rows, with the family read's axis values and face image merged in.
   *
   * A MERGE, not a replacement: identity, completeness, version and every cell stay the sheet's, so
   * the write path is untouched. Only `axisValues` and `imageUrl` are filled, and `mergeAxisValues`
   * owns the resolution — the two sources key that field differently, and my first, looser rule put
   * three wrong numbers on screen. Its docblock has the measurement.
   */
  const rows = useMemo<StudioRow[]>(() => {
    const base = sheet?.rows ?? []
    if (axisKeys.length === 0 && Object.keys(projections.images).length === 0) return base
    return base.map(row => {
      const axisValues = mergeAxisValues(axisKeys, projections.axisValues[row.id], row.axisValues)
      const mineImage = projections.images[row.id]
      /* The picture too, and for the same reason: the sheet contract does not carry `imageUrl` (its
         own type says so), while the family read carries a real CDN url and whether it is the
         parent's. The sheet's own answer still wins if it ever has one. */
      const imageUrl = row.imageUrl ?? mineImage?.url ?? null
      const imageInherited = row.imageUrl ? row.imageInherited : mineImage?.inherited
      return { ...row, axisValues, imageUrl, imageInherited, axisValuesSuspect: projections.suspect?.[row.id] ?? [] }
    })
  }, [sheet, axisKeys, projections.axisValues, projections.images, projections.suspect])
  const rowsRef = useRef<StudioRow[]>(rows)
  rowsRef.current = rows

  /**
   * The axis SUMMARY — label, values, counts, and the stored key that pairs it to a column.
   *
   * 🔴 The values are counted from the ROWS; the server's `axes[].values` supplies only the ORDER.
   * That list is now an operator-arranged order stored on the parent listing (`valueOrder.source:
   * 'stored'`, from `EBAY:IT`) and it deliberately carries codes no child uses — `XXS` is in it while
   * both "XXS" variants store `XS`. Counting membership from the list would put a tenth value on the
   * chip and a nineteenth combination in the sentence, neither of which exists on this family. Order
   * from the server, membership from the rows: the band then cannot disagree with the grid under it.
   */
  const axes = useMemo<AxisSummary[]>(() => {
    const stated = new Map(projections.axes.map(a => [a.key, a]))
    const columns = sheet?.columns ?? []
    return axisKeys.map(key => {
      const server = stated.get(key)
      const want = [(server?.storedKey ?? key).toLowerCase(), key.toLowerCase()]
      const column = columns.find(c => want.includes(c.key.toLowerCase()))
      return { valueOrder: server?.valueOrder, ...axisSummary(
        {
          key,
          label: server?.label ?? column?.label ?? key,
          storedKey: server?.storedKey,
          options: server?.values ?? column?.options,
          optionLabels: column?.optionLabels,
        },
        rows,
      ) }
    })
  }, [axisKeys, projections.axes, sheet, rows])
  const axesRef = useRef<AxisSummary[]>(axes)
  axesRef.current = axes

  /** The sheet column that STORES each axis, paired through the server's own `storedKey`. */
  const axisColumns = useMemo(() => axisColumnsFor(sheet?.columns ?? [], axes), [sheet, axes])

  /**
   * Axes with no sheet column at all — a real gap, reported once in a banner.
   *
   * 🔴 NOT the same as "cannot be edited here", which is true of every axis on this family for a
   * different and stronger reason (see `columns.tsx`). On GALE-JACKET this list is EMPTY: `Colore`
   * and `Taglia` do have columns, `color` and `size`. I had this banner firing on both of them for
   * an hour on a wrong inference, which is why the two ideas are now separate.
   */
  const coverage = useMemo(() => combinationCoverage(axes, rows), [axes, rows])

  /* ── rows: parent first, then axis-value order (§3.3) ───────────────────────────────────── */

  const ordered = useMemo(() => orderByAxisValues(rows, axes), [rows, axes])
  const childIds = useMemo(() => rows.filter(r => !r.isParent).map(r => r.id), [rows])

  /* ── the three chips (§3.2) ─────────────────────────────────────────────────────────────── */

  const chipBar = useViewChips()

  const excluded = useMemo(() => excludedSomewhere(projections, childIds), [projections, childIds])
  const missingAxisSkus = coverage.incomplete
  const missingAxisIds = useMemo(
    () => rows.filter(r => !r.isParent && missingAxisSkus.includes(r.sku)).map(r => r.id),
    [rows, missingAxisSkus],
  )
  const duplicateIds = useMemo(() => {
    const skus = new Set(coverage.duplicates.flat())
    return rows.filter(r => skus.has(r.sku)).map(r => r.id)
  }, [rows, coverage.duplicates])

  const cellsFor = useCallback((ids: readonly string[], keys: readonly string[]) => {
    const byRow: Record<string, string[]> = {}
    for (const id of ids) byRow[id] = [...keys]
    return { byRow }
  }, [])

  /* 🔴 `count: null` until the read that would answer has answered — `0` would say "counted, none"
     on the strength of not having counted (the ViewChip contract's own rule). */
  useRegisterViewChip(
    'excluded-somewhere',
    useMemo(
      () => ({
        id: 'excluded-somewhere',
        label: 'Excluded somewhere',
        noun: 'variants',
        count: projectionsQuery.loading || projectionsQuery.error ? null : excluded.length,
        hideWhenZero: false,
        note: projectionsQuery.error ? `The channel projections could not be read: ${projectionsQuery.error}` : 'Variants left out of at least one connected channel',
        cells: cellsFor(excluded, projections.channels.map(c => `proj:${c.key}`)),
      }),
      [excluded, projections.channels, projectionsQuery.loading, projectionsQuery.error, cellsFor],
    ),
  )
  useRegisterViewChip(
    'missing-axis-values',
    useMemo(
      () => ({
        id: 'missing-axis-values',
        label: 'Missing axis values',
        noun: 'variants',
        count: loading ? null : missingAxisIds.length,
        hideWhenZero: false,
        note: 'Variants with at least one empty axis cell — they belong to no combination',
        cells: cellsFor(missingAxisIds, axisKeys),
      }),
      [loading, missingAxisIds, axisKeys, cellsFor],
    ),
  )
  useRegisterViewChip(
    'duplicate-combinations',
    useMemo(
      () => ({
        id: 'duplicate-combinations',
        label: 'Duplicate combinations',
        noun: 'combinations',
        count: loading ? null : coverage.duplicates.length,
        hideWhenZero: false,
        note: 'Variants sharing one combination of axis values',
        cells: cellsFor(duplicateIds, axisKeys),
      }),
      [loading, duplicateIds, axisKeys, cellsFor],
    ),
  )

  /* ── search + chip narrowing ────────────────────────────────────────────────────────────── */

  const [search, setSearch] = useState('')
  const visibleRows = useMemo(() => {
    const chipRows = chipBar.active?.cells.byRow
    const needle = search.trim().toLowerCase()
    return ordered.filter(row => {
      if (chipRows && !(row.id in chipRows)) return false
      if (!needle) return true
      const line = identityLine(row, axesRef.current)
      return `${row.sku} ${row.name ?? ''} ${line}`.toLowerCase().includes(needle)
    })
  }, [ordered, chipBar.active, search, axes])

  /* ── the family verbs, from the registry ────────────────────────────────────────────────── */

  const [newVariation, setNewVariation] = useState<NewVariationDraft | null>(null)
  const familyProductPicker = useFamilyProductPicker(productId)
  const canPim = has('pim.manage')
  const canSync = has('channels.sync')
  const canEdit = has('products.edit')
  const onFamilyChangedRef = useRef<() => void>(() => {})
  const rowPress = useActionPress<StudioRow>(() => onFamilyChangedRef.current())
  const famActions = useMemo(
    () =>
      familyActions({
        family: familyQuery.family,
        ops: familyOps,
        can: (p) => (p === 'pim.manage' ? canPim : p === 'channels.sync' ? canSync : p === 'products.edit' ? canEdit : has(p)),
        authStatus,
        pickProduct: familyProductPicker.pick,
        pending: newVariation ? { newVariation } : undefined,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `has` re-identifies every render; the
    // three booleans above are what actually change.
    [familyQuery.family, canPim, canSync, canEdit, authStatus, newVariation, familyProductPicker.pick],
  )
  const rowMenuRef = useRef<(row: StudioRow) => MenuItemDef[]>(() => [])
  rowMenuRef.current = useMemo(
    () => actionMenuItems<StudioRow>({ actions: famActions, onSelect: (action, rs) => void rowPress.press(action, rs), isRecord: (r) => !!r?.id }),
    [famActions, rowPress.press],
  )
  const contextMenuRef = useRef(
    actionContextMenu<StudioRow>({ actions: famActions, onSelect: (action, rs) => void rowPress.press(action, rs), isRecord: (r) => !!r?.id }),
  )
  contextMenuRef.current = useMemo(
    () => actionContextMenu<StudioRow>({ actions: famActions, onSelect: (action, rs) => void rowPress.press(action, rs), isRecord: (r) => !!r?.id }),
    [famActions, rowPress.press],
  )
  /* The identity AG receives is built once and reads the current builder at right-click time — a new
     `getContextMenuItems` identity is harmless for the column model but the wrapper costs nothing. */
  const stableContextMenu = useCallback((p: Parameters<typeof contextMenuRef.current>[0]) => contextMenuRef.current(p), [])

  const onFamilyChanged = useCallback(() => {
    familyQuery.reload()
    projectionsQuery.reload()
    reload()
  }, [familyQuery, projectionsQuery, reload])
  const transfer = useVariantTransfer({ productId, market, locale }, onFamilyChanged)
  onFamilyChangedRef.current = onFamilyChanged
  afterWrite.current = projectionsQuery.reload

  const familyVerbs = useFamilyVerbs({
    family: familyQuery.family,
    actions: famActions,
    error: familyQuery.error,
    onRetry: familyQuery.reload,
    onDone: onFamilyChanged,
    onCollectVariation: setNewVariation,
  })

  /* ── the writer's counters, so the strip is the truth ───────────────────────────────────── */

  const [pending, setPending] = useState(0)
  const [refused, setRefused] = useState(0)
  useEffect(() => {
    const sync = () => {
      setPending(writer.pending)
      let r = 0
      for (const row of rowsRef.current) {
        for (const key of axisKeys) if (tracker.get(row.id, key)?.state === 'refused') r++
      }
      setRefused(r)
    }
    return writer.subscribe(sync)
  }, [writer, tracker, axisKeys])

  /* ── the grid ───────────────────────────────────────────────────────────────────────────── */

  const [selected, setSelected] = useState(0)
  const [selectedRows, setSelectedRows] = useState<StudioRow[]>([])
  const [prefs, setPrefs] = useState<PreferencesValue | null>(null)
  const [prefsOpen, setPrefsOpen] = useState(false)

  const setIncluded = useCallback(async (row: StudioRow, channel: import('./projections').ProjectionChannel, included: boolean) => {
    if (!channel.accountId) { toast.toast('Choose a channel account before changing inclusion.', 'danger'); return }
    const source = liveSource({ productId, channel: channel.channel, market: channel.market, accountId: channel.accountId, aliasKey: '', locale })
    const ticket = `variant-inclusion:${channel.key}:${row.id}`
    reporter.pending(ticket, row.id)
    try {
      const current = await source.read(new AbortController().signal)
      const result = await source.setIncluded(current.version, [{ id: row.id, included }])
      if (!result.ok) throw new Error(result.reason)
      reporter.resolved(ticket, true, undefined, row.id)
      onFamilyChanged()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      reporter.resolved(ticket, false, message, row.id); toast.toast(message, 'danger')
    }
  }, [productId, locale, reporter, toast, onFamilyChanged])

  const columnDefs = useMemo(
    () =>
      buildVariantColumns({
        columns: sheet?.columns ?? [],
        tracker,
        locale,
        market,
        axes,
        projectionsRef,
        axesRef,
        rowMenuRef,
        /* §5.4 HELD: no `setIncluded`, so the tick renders, shows the state and refuses with the
           reason above. The column also stays non-editable, so AG's fill cannot carry inclusion. */
        write: { setIncluded },
      }),
    [sheet?.columns, tracker, locale, market, axes, projections.channels, setIncluded],
  )
  const defaultColDef = useMemo<ColDef<StudioRow>>(() => ({ sortable: true, resizable: true }), [])
  /* 🔴 Memoised, not inline. An inline literal is a new identity on every render and AG re-runs its
     whole column model for each one (GDS decision 12; `scripts/check-grid-option-identity.mjs`
     caught this one for me rather than a review). */
  const rowSelection = useMemo(() => gridSelection<StudioRow>(), [])
  const getRowId = useCallback((p: { data: StudioRow }) => p.data.id, [])

  const onGridReady = useCallback((e: GridReadyEvent<StudioRow>) => {
    bindGridApi(e.api)
    bindGrid(e.api)
  }, [bindGridApi, bindGrid])
  const onGridPreDestroyed = useCallback((e: { api: GridApi<StudioRow> }) => { releaseGrid(e); bindGrid(null) }, [releaseGrid, bindGrid])

  const onSelectionChanged = useCallback((e: { api: GridApi<StudioRow> }) => {
    const rs = e.api.getSelectedNodes().map(n => n.data).filter((d): d is StudioRow => !!d)
    setSelectedRows(rs)
    setSelected(rs.length)
  }, [])

  const onCellValueChanged = useCallback(
    (e: { data: StudioRow; colDef: { colId?: string }; oldValue?: unknown; newValue: unknown; source?: string }) => {
      const colId = e.colDef.colId
      /* The sheet's own gate: no column, the grid setting its own data, or a change that changed
         nothing. The last one matters most here — AG's FILL fires this for every cell in the range
         whether or not the value moved, and each PATCH carries an `expectedVersion` that can lose a
         409 race against a real concurrent edit (#256). */
      if (!writeGate({ colId, source: e.source, selfInflicted: false, oldValue: e.oldValue, newValue: e.newValue }).write) return
      writer.set(e.data.id, colId!, e.newValue, { row: e.data })
      /* No save clock here (#705): the stamp comes from the writer's settle callback, gated on `ok`. */
    },
    [writer],
  )

  /* The same column-state adapter as the channel and Information sheets. */

  const preferenceColumns = useMemo<PreferencesColumnSpec[]>(
    () => [
      { key: IDENTITY_COL, label: 'Product', locked: true, group: 'Product' },
      ...axisColumns.map((column, i) => ({ key: column.key, label: axes[i]?.label ?? column.label, group: 'Axes' })),
      ...projections.channels.map(c => ({ key: `proj:${c.key}`, label: c.label, group: 'Channel projections' })),
    ],
    [axes, axisColumns, projections.channels],
  )
  const defaultPrefs = useMemo<PreferencesValue>(
    () => ({
      visibleColumns: preferenceColumns.map(c => c.key),
      lockedColumns: [],
      stickyFirstColumn: true,
      stickyLastColumn: false,
      pageSize: 0,
      sortBy: '',
      sortDir: 'asc',
    }),
    [preferenceColumns],
  )
  const bridge = useMemo(() => ({ columns: preferenceColumns.map(c => ({ key: c.key, locked: c.locked })) }), [preferenceColumns])
  const openCustomise = useCallback(() => {
    const api = getGridApi()
    if (!api) return
    setPrefs(current => columnStateToPrefs(api.getColumnState(), current ?? defaultPrefs, bridge))
    setPrefsOpen(true)
  }, [getGridApi, defaultPrefs, bridge])
  const applyPrefs = useCallback(async (next: PreferencesValue) => {
    const api = getGridApi()
    if (!api) return
    api.applyColumnState({ state: prefsToColumnState(next, bridge), applyOrder: true })
    setPrefs(next)
  }, [getGridApi, bridge])
  const columnDialog = useMemo(() => ({ customise: openCustomise, reset: () => {
    getGridApi()?.resetColumnState()
    setPrefs(defaultPrefs)
  } }), [openCustomise, getGridApi, defaultPrefs])

  /* ── dialogs ────────────────────────────────────────────────────────────────────────────── */

  const [axesDialog, setAxesDialog] = useState<null | 'list' | 'add'>(null)
  const [generateOpen, setGenerateOpen] = useState(false)
  const [axisSaving, setAxisSaving] = useState(false)
  const reorderAxes = useCallback(async (keys: string[]) => {
    if (axisSaving || projections.version === null) return
    setAxisSaving(true)
    const writeId = `variation-axes:${productId}:${Date.now()}`
    reporter.pending(writeId, `variation-axes:${productId}`)
    try {
      await saveAxisOrder(productId, market, projections.version ?? 0, keys)
      reporter.resolved(writeId, true); onFamilyChanged()
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      reporter.resolved(writeId, false, reason); toast.toast(reason, 'danger')
    } finally { setAxisSaving(false) }
  }, [axisSaving, projections.version, productId, market, reporter, onFamilyChanged, toast])
  const parent = useMemo(() => rows.find(r => r.isParent) ?? null, [rows])
  const planFamily = useMemo(
    () => ({
      parentSku: parent?.sku ?? sheet?.family.sku ?? '',
      children: rows.filter(r => !r.isParent).map(r => ({
        sku: r.sku,
        axisValues: Object.fromEntries(axes.map(a => [a.key, (r.axisValues?.[a.key] ?? null) as string | null])),
      })),
      knownSkus: rows.map(r => r.sku),
    }),
    [parent, sheet, rows, axes],
  )

  const total = rows.length
  const variants = rows.filter(r => !r.isParent).length
  const emptyState = useMemo(
    () => sheetEmptyState(total, () => { setSearch(''); chipBar.setActive(null) }, reload),
    [total, chipBar, reload],
  )

  return (
    <div className={styles.surface}>
      <FamilyBand
        axes={axes}
        coverage={coverage}
        loading={loading}
        disabled={loading || axisSaving || !!error || !canEdit}
        disabledReason={
          loading ? 'Still reading this family…'
            : axisSaving ? 'Saving axis order…'
            : error ? `This family could not be read: ${error}`
              : 'You do not have permission to change products (products.edit)'
        }
        onManageAxes={(focus) => setAxesDialog(focus)}
        onReorder={keys => void reorderAxes(keys)}
        onGenerate={() => setGenerateOpen(true)}
        verbs={familyVerbs.items}
        onGenerateItem={() => setGenerateOpen(true)}
      />
      <GridSheet
        toolbar={
          <SheetToolbar
            visible={visibleRows.length}
            total={total}
            selected={selected}
            /* §3.2's count, verbatim: `21 rows · 1 parent · 20 variants`. */
            descriptor={!loading && !error ? <span className="nds-cell-muted"> · {parent ? '1 parent' : 'no parent'} · {variants} {variants === 1 ? 'variant' : 'variants'}</span> : null}
            search={search}
            onSearch={setSearch}
            chips={chipBar.chips}
            activeChipId={chipBar.activeId}
            onChipToggle={chipBar.setActive}
            onCustomise={openCustomise}
            onExport={() => void transfer.download()}
            onImport={transfer.open}
            exportPurpose="editing"
            exportDisabled={!sheet || loading}
            onReload={onFamilyChanged}
            loading={loading}
            unavailable={!!error}
            overflow={familyVerbs.items}
            /* §1.5 — the ONE omission, and it costs a reason. Import is absent too: this page edits
               a family's structure, and the catalogue importer writes attributes by SKU, which is
               the sheet's job on Information. */
            absent={ABSENT_VIEWS}
            trailing={
              <>
                {/*
                  🔴 The SAME pill the sheet renders from the SAME `meta`, in the same words
                  (`MasterSheet.tsx:1788`). It was missing here entirely — `schemaMissing` and
                  `schemaAge` appeared nowhere in this lane — while this page prints a completeness
                  percentage on every row. Measured today on GALE-JACKET at IT/PL/DE the array is
                  empty, so nothing was wrong on screen; the defect is that a percentage would have
                  gone on being printed with no caveat the moment it stopped being empty, while
                  Information one tab away said "Setup incomplete" about the very same read.
                  A number whose basis could not be read must say so wherever it is shown.
                */}
                {sheet && (sheet.meta.schemaMissing.length > 0 || sheet.meta.schemaAge.length > 0) && (
                  <InfoTip
                    tip={
                      sheet.meta.schemaMissing.length > 0
                        ? `Attribute setup is incomplete: ${sheet.meta.schemaMissing.join(', ')}. The completeness percentages on these rows are computed over the attributes that COULD be read, so they are not a verdict on this product type. Choose a product family in Classification.`
                        : `Length caps and lists come from a schema last fetched ${sheet.meta.schemaAge.map(t => `${t.productType} ${t.fetchedAt.slice(0, 10)}`).join(', ')}.`
                    }
                  >
                    <Pill tone="warning" size="md">
                      <AlertTriangle size={11} /> {sheet.meta.schemaMissing.length > 0 ? 'Setup incomplete' : 'Cached requirements'}
                    </Pill>
                  </InfoTip>
                )}
    
                {familyVerbs.status}
              </>
            }
          />
        }
        footer={
          !loading && !error && (
            <>
              {rowPress.problem && <div className="nds-grid-footstrip" role="alert"><span className="nds-cell-stock-out">{rowPress.problem}</span></div>}
              {rowPress.confirmElement}
              {familyVerbs.dialogs}
              <FamilySelectionBar rows={selectedRows} actions={famActions} onClear={() => getGridApi()?.deselectAll()} onDone={onFamilyChanged} />
              <GridSheetStatus rows={visibleRows.length} selected={selected} pending={pending} refused={refused} saving={writer.busy} lastSavedAt={lastSavedAt}>
                <span className="nds-cell-muted">{variants} {variants === 1 ? 'variant' : 'variants'}</span>
                {conflicts.length > 0 && (
                  <Button size="sm" variant="link" onClick={reload}>
                    {conflicts.length} {conflicts.length === 1 ? 'row' : 'rows'} changed elsewhere — refresh
                  </Button>
                )}
              </GridSheetStatus>
            </>
          )
        }
      >
        {error ? (
          <SheetLoadError label="this family" onRetry={reload} />
        ) : (
          <>
            {contractProblems.length > 0 && (
              <Banner tone="warning" title="The family read did not match its contract">{contractProblems.join(' · ')}</Banner>
            )}
            {projectionsQuery.error && (
              <Banner tone="warning" title="The channel projections could not be read"
                action={<Button size="sm" onClick={projectionsQuery.reload}>Try again</Button>}>
                {projectionsQuery.error} — the axes below are still live; the channel columns are empty because nothing answered, not because this family is on no channel.
              </Banner>
            )}
            <NexusGrid<StudioRow>
              fill
              {...SHEET_GRID_OPTIONS}
              {...SHEET_STATE_OVERLAYS}
              noRowsOverlayComponentParams={emptyState}
              rows="media-line"
              /* The 30px strip above the header — the THREE groups of §3.3. */
              groupHeaderHeight={gridGeometry.stripH}
              getContextMenuItems={stableContextMenu}
              rowData={loading ? [] : visibleRows}
              columnDefs={columnDefs}
              defaultColDef={defaultColDef}
              getRowId={getRowId}
              rowSelection={rowSelection}
              onSelectionChanged={onSelectionChanged}
              onGridReady={onGridReady}
              onGridPreDestroyed={onGridPreDestroyed}
              onCellValueChanged={onCellValueChanged}
              loading={loading}
              columnDialog={columnDialog}
            />
          </>
        )}
      </GridSheet>

      {familyProductPicker.element}

      <ManageAxesDialog
        open={axesDialog !== null}
        productId={productId}
        market={market}
        focus={axesDialog ?? 'list'}
        onClose={() => setAxesDialog(null)}
        onChanged={onFamilyChanged}
      />

      {transfer.element}
      <GenerateCombinationsDialog
        open={generateOpen}
        parentSku={planFamily.parentSku}
        axes={axes}
        family={planFamily}
        onClose={() => setGenerateOpen(false)}
        productId={productId}
        version={projections.version ?? 0}
        onCreated={onFamilyChanged}
      />

      <PreferencesModal
        open={prefsOpen}
        onClose={() => setPrefsOpen(false)}
        value={prefs ?? defaultPrefs}
        onConfirm={applyPrefs}
        allColumns={preferenceColumns}
        defaultVisible={preferenceColumns.map(c => c.key)}
        pageSizeChoices={[]}
        sortFieldOptions={[]}
        showSticky={false}
        title="Customise columns"
        /* 🔴 Says what it is. This page declares a FIXED column set (§1.5, and the toolbar's absent
           views note says so), so there are no saved views to write into and this choice lasts as
           long as the page is open. Promising otherwise would be the quieter kind of dishonesty. */
        listHint="Choose the order, visibility and pinned columns. The arrangement lasts until you leave the page."
      />
    </div>
  )
}
