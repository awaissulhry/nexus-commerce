'use client'

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnSizingState,
} from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import { produce } from 'immer'
import {
  Lock,
  Redo2,
  RotateCcw,
  Search,
  Undo2,
  Upload,
  WifiOff,
  Wand2,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { getBackendUrl } from '@/lib/backend-url'
import { editHandlers, editKey } from './EditableCell'
import PreviewChangesModal from './PreviewChangesModal'
import UploadModal from './UploadModal'
import BulkOperationModal from './BulkOperationModal'
import FilterDropdown from './components/FilterDropdown'
import PastePreviewModal, {
  type PasteCell,
  type PasteError,
  type PastePreview,
} from './PastePreviewModal'
import CascadeChoiceModal from './components/CascadeChoiceModal'
import ColumnSelector, { type FieldDef } from './components/ColumnSelector'
import MarketplaceSelector, {
  MarketplaceContextBanner,
  type MarketplaceContext,
  type MarketplaceOption,
} from './components/MarketplaceSelector'
import {
  loadAllViews,
  saveUserView,
  deleteUserView,
  isDefaultView,
  setActiveViewId,
  getActiveViewId,
  DEFAULT_VIEWS,
  type SavedView,
} from './lib/saved-views'
import {
  buildHierarchy,
  loadDisplayMode,
  saveDisplayMode,
  loadExpandedParents,
  saveExpandedParents,
  type DisplayMode,
} from './lib/hierarchy'
import {
  isDimFieldId,
  isWeightFieldId,
  parseDimension,
  parseWeight,
} from './lib/unit-parsing'
import { cn } from '@/lib/utils'

// ── T.1 — extracted modules ──────────────────────────────────────
//
// The bulky helpers + small components moved out of this file when
// it was decomposed in T.1. Behaviour unchanged — the imports below
// alias them back into the names the main component used.

import {
  ROW_HEIGHT,
  HEADER_HEIGHT,
  type BulkProduct,
  type CellChange,
  type CascadeModalState,
  type ApiError,
  type SaveStatus,
  type SelectionState,
  type FilterState,
  type HistoryDelta,
  type HistoryEntry,
  type FillState,
  type SelectionMetrics,
} from './lib/types'
import {
  editCtxRef,
  hierarchyCtxRef,
  selectCtxRef,
  hasMarketplaceContextRef,
} from './lib/refs'
import { buildColumnFromField } from './lib/grid-columns'
import {
  computeFillExtension,
  computeFillValue,
} from './lib/fill-helpers'
import {
  toTsvCell,
  parseTsv,
  coercePasteValue,
  looselyEqual,
} from './lib/tsv-helpers'
import {
  TableRow,
  SelectionOverlays,
  SkeletonRow,
} from './components/GridRow'
import { StatusBar } from './components/StatusBar'
import {
  DisplayModeToggle,
  ExpandCollapseControls,
} from './components/DisplayControls'

// Re-export BulkProduct so any sibling file (modals, cells, etc.) that
// used to import it from this file still finds it here.
export type { BulkProduct } from './lib/types'

export default function BulkOperationsClient() {
  const [products, setProducts] = useState<BulkProduct[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [fetchMs, setFetchMs] = useState<number | null>(null)

  const [changes, setChanges] = useState<Map<string, CellChange>>(new Map())
  const [cellErrors, setCellErrors] = useState<Map<string, string>>(new Map())
  const [resetKeys, setResetKeys] = useState<Map<string, number>>(new Map())
  const [cascadeModal, setCascadeModal] = useState<CascadeModalState | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [bulkOpModalOpen, setBulkOpModalOpen] = useState(false)
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ kind: 'idle' })
  const [online, setOnline] = useState(true)

  // ── Dynamic columns state ───────────────────────────────────────────
  const [allFields, setAllFields] = useState<FieldDef[]>([])
  const [enabledChannels, setEnabledChannels] = useState<string[]>([])
  const [enabledProductTypes, setEnabledProductTypes] = useState<string[]>([])
  const [savedViews, setSavedViews] = useState<SavedView[]>(() => [...DEFAULT_VIEWS])
  const [activeViewIdState, setActiveViewIdState] = useState<string>(
    DEFAULT_VIEWS[0].id
  )
  const [visibleColumnIds, setVisibleColumnIds] = useState<string[]>(
    DEFAULT_VIEWS[0].columnIds
  )

  // ── Hierarchy display state ──────────────────────────────────────
  const [displayMode, setDisplayMode] = useState<DisplayMode>('flat')

  // ── D.6: search + filter state ─────────────────────────────────
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearch(searchQuery), 150)
    return () => window.clearTimeout(t)
  }, [searchQuery])
  const [filterState, setFilterState] = useState<FilterState>({
    status: [],
    channels: [],
    stockLevel: 'all',
  })
  const activeFilterCount =
    filterState.status.length +
    filterState.channels.length +
    (filterState.stockLevel !== 'all' ? 1 : 0)
  const resetFilters = useCallback(
    () =>
      setFilterState({ status: [], channels: [], stockLevel: 'all' }),
    [],
  )
  const [filterOpen, setFilterOpen] = useState(false)
  const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set())

  // ── D.3d / R.1: marketplace targets (multi-select) ──────────────
  // R.1 — promoted from a singular MarketplaceContext to an array so
  // channel-field edits can fan out to N marketplaces in one save.
  // The first entry acts as the "primary" — drives the table-view
  // hydration query (?channel=&marketplace=) since the grid still
  // renders one listing's worth of data per row. Edits broadcast to
  // every entry in `marketplaceTargets`.
  const [marketplaceTargets, setMarketplaceTargets] = useState<
    MarketplaceContext[]
  >([])
  const primaryContext: MarketplaceContext | null = marketplaceTargets[0] ?? null
  const [marketplaceOptions, setMarketplaceOptions] = useState<MarketplaceOption[]>([])

  // ── Column resize state (Step 1.5) ─────────────────────────────
  // TanStack v8 stores user-dragged widths as a {[colId]: width} map.
  // We persist it to localStorage so widths survive reloads.
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>(() => {
    if (typeof window === 'undefined') return {}
    try {
      const raw = window.localStorage.getItem('nexus_bulkops_column_widths')
      return raw ? (JSON.parse(raw) as ColumnSizingState) : {}
    } catch {
      return {}
    }
  })
  useEffect(() => {
    try {
      window.localStorage.setItem(
        'nexus_bulkops_column_widths',
        JSON.stringify(columnSizing),
      )
    } catch {
      /* localStorage may be disabled — non-critical */
    }
  }, [columnSizing])
  const resetColumnWidths = useCallback(() => setColumnSizing({}), [])

  // ── Step 1 selection state ──────────────────────────────────────
  const [selection, setSelection] = useState<SelectionState>({
    anchor: null,
    active: null,
  })
  // Mirror selection in a ref so the global keydown listener can read
  // the latest value without re-attaching the document handler each
  // time selection changes.
  const selectionRef = useRef<SelectionState>(selection)
  selectionRef.current = selection

  const select = useCallback(
    (rowIdx: number, colIdx: number, shift: boolean) => {
      // Step 3.5: edit-on-click is covered by onDoubleClick on the
      // EditableCell — within ~500ms the browser groups the second
      // click as a dblclick. Beyond that window, two clicks are
      // intentional re-selection (no edit). So plain click is
      // selection-only here.
      setSelection((s) =>
        shift && s.anchor
          ? { anchor: s.anchor, active: { rowIdx, colIdx } }
          : {
              anchor: { rowIdx, colIdx },
              active: { rowIdx, colIdx },
            },
      )
    },
    [],
  )
  selectCtxRef.current.select = select

  // ── Step 2: click + drag rectangle ─────────────────────────────
  // The drag implementation lives in refs so we don't pay re-render
  // cost on every mousemove. Active updates flow through setSelection
  // (and only the overlays re-render — see SelectionOverlays).
  const dragStateRef = useRef<{
    rafId: number | null
    pendingX: number
    pendingY: number
    didMove: boolean
    startRow: number
    startCol: number
  } | null>(null)
  const beginDrag = useCallback((startRow: number, startCol: number) => {
    dragStateRef.current = {
      rafId: null,
      pendingX: 0,
      pendingY: 0,
      didMove: false,
      startRow,
      startCol,
    }

    const flush = () => {
      const s = dragStateRef.current
      if (!s) return
      s.rafId = null
      const el = document.elementFromPoint(s.pendingX, s.pendingY) as
        | HTMLElement
        | null
      if (!el) return
      const cellEl = el.closest('[data-row-idx]') as HTMLElement | null
      if (!cellEl) return
      const r = parseInt(cellEl.getAttribute('data-row-idx') ?? '', 10)
      const c = parseInt(cellEl.getAttribute('data-col-idx') ?? '', 10)
      if (Number.isNaN(r) || Number.isNaN(c)) return
      if (r !== s.startRow || c !== s.startCol) s.didMove = true
      setSelection((prev) =>
        prev.anchor
          ? { anchor: prev.anchor, active: { rowIdx: r, colIdx: c } }
          : prev,
      )
    }

    const onMove = (e: MouseEvent) => {
      const s = dragStateRef.current
      if (!s) return
      s.pendingX = e.clientX
      s.pendingY = e.clientY
      // Coalesce on rAF — caps work at ~60fps regardless of how fast
      // the mouse moves.
      if (s.rafId === null) {
        s.rafId = requestAnimationFrame(flush)
      }
    }

    const onUp = () => {
      const s = dragStateRef.current
      if (s?.rafId !== null && s?.rafId !== undefined) {
        cancelAnimationFrame(s.rafId)
      }
      const didMove = !!s?.didMove
      dragStateRef.current = null
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      // If the drag actually moved across cells, suppress the click
      // that follows so EditableCell at the drop target doesn't enter
      // edit mode for what was clearly a select-rectangle gesture.
      if (didMove) {
        const onClickOnce = (ce: MouseEvent) => {
          ce.stopPropagation()
          ce.preventDefault()
          document.removeEventListener('click', onClickOnce, true)
        }
        document.addEventListener('click', onClickOnce, true)
      }
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [])
  selectCtxRef.current.beginDrag = beginDrag
  const rangeBounds = useMemo(() => {
    if (!selection.anchor || !selection.active) return null
    return {
      minRow: Math.min(selection.anchor.rowIdx, selection.active.rowIdx),
      maxRow: Math.max(selection.anchor.rowIdx, selection.active.rowIdx),
      minCol: Math.min(selection.anchor.colIdx, selection.active.colIdx),
      maxCol: Math.max(selection.anchor.colIdx, selection.active.colIdx),
    }
  }, [selection])
  const rangeBoundsRef = useRef(rangeBounds)
  rangeBoundsRef.current = rangeBounds

  // ── Step 5: drag-fill state ────────────────────────────────────
  const [fillState, setFillState] = useState<FillState | null>(null)

  const selectedCellCount = useMemo(() => {
    if (!rangeBounds) return 0
    return (
      (rangeBounds.maxRow - rangeBounds.minRow + 1) *
      (rangeBounds.maxCol - rangeBounds.minCol + 1)
    )
  }, [rangeBounds])

  // Hydrate localStorage state on mount
  useEffect(() => {
    setSavedViews(loadAllViews())
    const id = getActiveViewId()
    setActiveViewIdState(id)
    const view =
      loadAllViews().find((v) => v.id === id) ?? DEFAULT_VIEWS[0]
    setVisibleColumnIds(view.columnIds)
    if (view.channels) setEnabledChannels(view.channels)
    if (view.productTypes) setEnabledProductTypes(view.productTypes)
    setDisplayMode(loadDisplayMode())
    setExpandedParents(loadExpandedParents())
    const onChange = () => setSavedViews(loadAllViews())
    window.addEventListener('nexus:views-changed', onChange)
    return () => window.removeEventListener('nexus:views-changed', onChange)
  }, [])

  // Persist hierarchy state when it changes (separate effect — runs
  // after hydrate + every user-driven update).
  useEffect(() => {
    saveDisplayMode(displayMode)
  }, [displayMode])
  useEffect(() => {
    saveExpandedParents(expandedParents)
  }, [expandedParents])

  const toggleExpanded = useCallback((parentId: string) => {
    setExpandedParents((prev) => {
      const next = new Set(prev)
      if (next.has(parentId)) next.delete(parentId)
      else next.add(parentId)
      return next
    })
  }, [])

  // Push hierarchy ctx into the module ref so cell renderers see it
  hierarchyCtxRef.current = { mode: displayMode, onToggle: toggleExpanded }

  // Push marketplace presence into the module ref so channel-field
  // cell renderers can show "Select marketplace" placeholder when
  // context is missing.
  hasMarketplaceContextRef.current = marketplaceTargets.length > 0

  // Refs for stable callbacks
  const productsRef = useRef(products)
  const changesRef = useRef(changes)
  const allFieldsRef = useRef<FieldDef[]>([])
  useEffect(() => {
    productsRef.current = products
  }, [products])
  useEffect(() => {
    changesRef.current = changes
  }, [changes])

  // Online / offline
  useEffect(() => {
    if (typeof navigator !== 'undefined') setOnline(navigator.onLine)
    const onOnline = () => setOnline(true)
    const onOffline = () => setOnline(false)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [])

  // ── D.6.3: undo / redo history ──────────────────────────────────
  // Capped at 50 entries to bound memory; truncates forward history
  // when the user edits after undoing (standard Excel/Sheets feel).
  const HISTORY_LIMIT = 50
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  // Suppresses re-recording while undo/redo is in flight.
  const isUndoingRef = useRef(false)
  const pushHistoryEntry = useCallback((entry: HistoryEntry) => {
    setHistory((prev) => {
      const next = prev.slice(0, historyIndexRef.current + 1)
      next.push(entry)
      const trimmed =
        next.length > HISTORY_LIMIT
          ? next.slice(next.length - HISTORY_LIMIT)
          : next
      historyIndexRef.current = trimmed.length - 1
      setHistoryIndex(trimmed.length - 1)
      return trimmed
    })
  }, [])
  const historyIndexRef = useRef(historyIndex)
  useEffect(() => {
    historyIndexRef.current = historyIndex
  }, [historyIndex])

  /** Add or update an entry in the changesMap. Drops the entry when the
   * new value matches the original (revert). Updates cascade tracking
   * + clears stale cell errors. Common code path used by both direct
   * commits and the cascade modal's "Apply" handler. */
  const writeChange = useCallback(
    (
      rowId: string,
      columnId: string,
      newValue: unknown,
      cascade: boolean,
      /** D.6.3: when supplied, the delta is appended here instead of
       *  pushing a new history entry. The caller pushes one combined
       *  entry after the batch finishes (paste, drag-fill, etc.). */
      historyBatch?: HistoryDelta[],
    ) => {
      const key = `${rowId}:${columnId}`
      const product = productsRef.current.find((p) => p.id === rowId)
      if (!product) return
      const oldValue = (product as unknown as Record<string, unknown>)[columnId]

      // Compute before/after snapshots for the history delta.
      const before = changesRef.current.get(key) ?? null
      const after: CellChange | null = looselyEqual(newValue, oldValue)
        ? null
        : {
            rowId,
            columnId,
            oldValue,
            newValue,
            cascade,
            timestamp: Date.now(),
          }
      // No-op edits (clean → clean with same value) shouldn't pollute
      // the history stack.
      const isNoOp =
        (before === null && after === null) ||
        (before !== null &&
          after !== null &&
          looselyEqual(before.newValue, after.newValue) &&
          before.cascade === after.cascade)

      setChanges((prev) => {
        const next = new Map(prev)
        if (after === null) {
          next.delete(key)
        } else {
          next.set(key, after)
        }
        return next
      })

      setCellErrors((prev) => {
        if (!prev.has(key)) return prev
        const next = new Map(prev)
        next.delete(key)
        return next
      })

      setSaveStatus((prev) =>
        prev.kind === 'saving' ? prev : { kind: 'dirty' }
      )

      if (!isUndoingRef.current && !isNoOp) {
        const delta: HistoryDelta = {
          rowId,
          columnId,
          before,
          after,
        }
        if (historyBatch) {
          historyBatch.push(delta)
        } else {
          pushHistoryEntry({ cells: [delta], timestamp: Date.now() })
        }
      }
    },
    [pushHistoryEntry]
  )

  // Apply a history entry in either direction. For each cell delta,
  // either set the changes-map entry directly (dirty target value) or
  // delete it and bump resetKey so EditableCell snaps back to its
  // server-side initialValue. isUndoingRef suppresses re-recording.
  const applyEntryDirection = useCallback(
    (entry: HistoryEntry, direction: 'undo' | 'redo') => {
      isUndoingRef.current = true
      try {
        setChanges((prev) => {
          const next = new Map(prev)
          for (const d of entry.cells) {
            const k = `${d.rowId}:${d.columnId}`
            const target = direction === 'undo' ? d.before : d.after
            if (target === null) next.delete(k)
            else next.set(k, target)
          }
          return next
        })
        for (const d of entry.cells) {
          const k = `${d.rowId}:${d.columnId}`
          const target = direction === 'undo' ? d.before : d.after
          const handle = editHandlers.get(k)
          if (target === null) {
            setResetKeys((prev) => {
              const next = new Map(prev)
              next.set(k, (next.get(k) ?? 0) + 1)
              return next
            })
          } else if (handle) {
            handle.applyValue(target.newValue)
          }
        }
        setSaveStatus((prev) =>
          prev.kind === 'saving' ? prev : { kind: 'dirty' },
        )
      } finally {
        isUndoingRef.current = false
      }
    },
    [],
  )
  const undo = useCallback(() => {
    const idx = historyIndexRef.current
    if (idx < 0) return
    applyEntryDirection(history[idx], 'undo')
    historyIndexRef.current = idx - 1
    setHistoryIndex(idx - 1)
  }, [history, applyEntryDirection])
  const redo = useCallback(() => {
    const idx = historyIndexRef.current
    if (idx >= history.length - 1) return
    applyEntryDirection(history[idx + 1], 'redo')
    historyIndexRef.current = idx + 1
    setHistoryIndex(idx + 1)
  }, [history, applyEntryDirection])
  // Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.key.toLowerCase() !== 'z') return
      const ae = document.activeElement as HTMLElement | null
      if (
        ae &&
        (ae.tagName === 'INPUT' ||
          ae.tagName === 'TEXTAREA' ||
          ae.isContentEditable)
      ) {
        // Let the input element handle its own native undo.
        return
      }
      e.preventDefault()
      if (e.shiftKey) redo()
      else undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo])
  const canUndo = historyIndex >= 0
  const canRedo = historyIndex < history.length - 1

  // Cascade-aware commit. Decides whether to write directly or open
  // the choice modal. Modal appears only when:
  //   - hierarchy or grouped display mode
  //   - target row has children (is a master with kids)
  //   - the cell isn't an aggregate (those aren't editable on parents)
  const handleCommit = useCallback(
    (rowId: string, columnId: string, newValue: unknown) => {
      const product = productsRef.current.find((p) => p.id === rowId)
      if (!product) return

      // D.3j: weight + dim cells render as text inputs ("5kg", "60cm",
      // "5,5"). Smart-parse here and route to the value column + the
      // unit column when the user typed a unit suffix. We bypass the
      // cascade modal for these — the unit change is a side effect
      // tied to the value, not a separate user-initiated edit.
      if (
        typeof newValue === 'string' &&
        (isWeightFieldId(columnId) || isDimFieldId(columnId))
      ) {
        const parsed = isWeightFieldId(columnId)
          ? parseWeight(newValue)
          : parseDimension(newValue)
        if (!parsed) {
          // Surface as a cell error — the typed text is invalid.
          const k = `${rowId}:${columnId}`
          setCellErrors((prev) => {
            const next = new Map(prev)
            next.set(
              k,
              isWeightFieldId(columnId)
                ? 'Invalid weight — try "5", "5kg" or "5.5 lb"'
                : 'Invalid dimension — try "60", "60cm" or "23.6in"',
            )
            return next
          })
          return
        }
        writeChange(rowId, columnId, parsed.value, false)
        if (parsed.unit) {
          const unitField = isWeightFieldId(columnId) ? 'weightUnit' : 'dimUnit'
          const currentUnit = (product as unknown as Record<string, unknown>)[
            unitField
          ]
          if (currentUnit !== parsed.unit) {
            writeChange(rowId, unitField, parsed.unit, false)
          }
        }
        return
      }

      const oldValue = (product as unknown as Record<string, unknown>)[columnId]

      // Quick path: revert. No modal even on parent rows.
      if (looselyEqual(newValue, oldValue)) {
        writeChange(rowId, columnId, newValue, false)
        return
      }

      const inHierarchyMode =
        displayMode === 'hierarchy' || displayMode === 'grouped'
      if (!inHierarchyMode) {
        writeChange(rowId, columnId, newValue, false)
        return
      }

      // Find children of this product
      const children = productsRef.current.filter(
        (p) => p.parentId === rowId
      )
      if (children.length === 0) {
        // Standalone or child row — no cascade choice needed
        writeChange(rowId, columnId, newValue, false)
        return
      }

      // Open modal — don't commit yet
      const fieldDef = allFieldsRef.current.find((f) => f.id === columnId)
      setCascadeModal({
        rowId,
        columnId,
        oldValue,
        newValue,
        parentSku: product.sku,
        fieldLabel: fieldDef?.label ?? columnId,
        children: children.map((c) => ({ id: c.id, sku: c.sku })),
      })
    },
    [displayMode, writeChange]
  )

  // Cascade modal handlers
  const handleCascadeApply = useCallback(
    (cascade: boolean) => {
      const m = cascadeModal
      if (!m) return
      writeChange(m.rowId, m.columnId, m.newValue, cascade)
      setCascadeModal(null)
    },
    [cascadeModal, writeChange]
  )

  const handleCascadeCancel = useCallback(() => {
    const m = cascadeModal
    if (!m) return
    // Force the cell to revert its draftValue to initialValue by bumping
    // its resetKey. The EditableCell's useEffect picks up the change.
    const key = `${m.rowId}:${m.columnId}`
    setResetKeys((prev) => {
      const next = new Map(prev)
      next.set(key, (next.get(key) ?? 0) + 1)
      return next
    })
    setCascadeModal(null)
  }, [cascadeModal])

  // Push the latest commit handler + per-cell maps into the module ref
  // so cell renderers see them. cascadeKeys derives from changesMap.
  const cascadeKeys = useMemo(() => {
    const s = new Set<string>()
    for (const [k, v] of changes) {
      if (v.cascade) s.add(k)
    }
    return s
  }, [changes])
  // Step 3.5: stable wrapper that EditableCell receives as
  // onCommitNavigate. The actual navigation function (moveSelection)
  // is defined further down in this component, so we forward through
  // a ref. The wrapper identity is stable forever, so passing it as a
  // prop never busts EditableCell's memo.
  const commitNavigateRef = useRef<(dRow: number, dCol: number) => void>(
    () => {},
  )
  const onCommitNavigate = useCallback((dRow: number, dCol: number) => {
    commitNavigateRef.current(dRow, dCol)
  }, [])

  editCtxRef.current = {
    onCommit: handleCommit,
    cellErrors,
    resetKeys,
    cascadeKeys,
    onCommitNavigate,
  }
  allFieldsRef.current = allFields

  // ── Save flow ──────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    const currentChanges = changesRef.current
    if (currentChanges.size === 0) return
    if (saveStatus.kind === 'saving') return

    setSaveStatus({ kind: 'saving' })
    setCellErrors(new Map())

    const changesArray = Array.from(currentChanges.values()).map((c) => ({
      id: c.rowId,
      field: c.columnId,
      value: c.newValue,
      cascade: c.cascade,
    }))

    // R.1 — body carries `marketplaceContexts` (plural) so the backend
    // can fan out channel-field upserts to every selected target.
    // `marketplaceContext` (singular) is kept as the first entry for
    // backwards compatibility with any older API code paths.
    const body: any = { changes: changesArray }
    if (marketplaceTargets.length > 0) {
      body.marketplaceContexts = marketplaceTargets
      body.marketplaceContext = marketplaceTargets[0]
    }

    try {
      const res = await fetch(`${getBackendUrl()}/api/products/bulk`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      const result = (await res.json().catch(() => ({}))) as {
        success?: boolean
        updated?: number
        errors?: ApiError[]
        error?: string
        message?: string
      }

      if (!res.ok) {
        setSaveStatus({
          kind: 'error',
          message: result.error ?? result.message ?? `HTTP ${res.status}`,
        })
        if (Array.isArray(result.errors)) {
          const map = new Map<string, string>()
          for (const e of result.errors) {
            map.set(`${e.id}:${e.field}`, e.error)
          }
          setCellErrors(map)
        }
        return
      }

      const errs: ApiError[] = result.errors ?? []
      const failedKeys = new Set(errs.map((e) => `${e.id}:${e.field}`))
      const succeededChanges = changesArray.filter(
        (c) => !failedKeys.has(`${c.id}:${c.field}`)
      )

      if (succeededChanges.length > 0) {
        setProducts((prev) =>
          produce(prev, (draft) => {
            for (const c of succeededChanges) {
              const product = draft.find((p) => p.id === c.id)
              if (!product) continue
              if (c.field.startsWith('amazon_') || c.field.startsWith('ebay_')) {
                // Channel field — value lives under _channelListing.<stripped>
                const stripped = c.field.replace(/^(amazon|ebay)_/, '')
                if (!(product as any)._channelListing) {
                  ;(product as any)._channelListing = {
                    title: null,
                    description: null,
                    price: null,
                    quantity: null,
                    listingStatus: 'DRAFT',
                  }
                }
                ;((product as any)._channelListing as Record<string, unknown>)[stripped] = c.value
              } else if (c.field.startsWith('attr_')) {
                // Category-attribute field — merge into categoryAttributes
                // mirroring the backend's atomic jsonb || merge.
                const stripped = c.field.replace(/^attr_/, '')
                if (!product.categoryAttributes) {
                  product.categoryAttributes = {}
                }
                ;(product.categoryAttributes as Record<string, unknown>)[stripped] = c.value
              } else {
                ;(product as unknown as Record<string, unknown>)[c.field] = c.value
              }
            }
          })
        )
      }

      setChanges((prev) => {
        if (succeededChanges.length === 0) return prev
        const next = new Map(prev)
        for (const c of succeededChanges) {
          next.delete(`${c.id}:${c.field}`)
        }
        return next
      })

      // D.3j: weight + dim cells edit-mode held the user's raw text
      // ("5kg") but the canonical post-save value is the plain number
      // (5). Bump resetKey for those cells so EditableCell resets its
      // local draft to the new initialValue and isDirty clears.
      if (succeededChanges.length > 0) {
        const reseedFields = new Set([
          'weightValue',
          'dimLength',
          'dimWidth',
          'dimHeight',
        ])
        const reseed = succeededChanges.filter((c) =>
          reseedFields.has(c.field),
        )
        if (reseed.length > 0) {
          setResetKeys((prev) => {
            const next = new Map(prev)
            for (const c of reseed) {
              const k = `${c.id}:${c.field}`
              next.set(k, (next.get(k) ?? 0) + 1)
            }
            return next
          })
        }
      }

      if (errs.length > 0) {
        const map = new Map<string, string>()
        for (const e of errs) {
          map.set(`${e.id}:${e.field}`, e.error)
        }
        setCellErrors(map)
        setSaveStatus({
          kind: 'partial',
          saved: succeededChanges.length,
          failed: errs.length,
        })
      } else {
        setSaveStatus({
          kind: 'saved',
          count: succeededChanges.length,
          at: Date.now(),
        })
        setTimeout(() => {
          setSaveStatus((s) => (s.kind === 'saved' ? { kind: 'idle' } : s))
        }, 3000)
      }
      // D.6.3: changes successfully sent to the backend can no longer
      // be undone via the local history stack — clear it so the
      // toolbar buttons disable and Cmd+Z is a no-op until the user
      // makes new edits.
      if (succeededChanges.length > 0) {
        setHistory([])
        setHistoryIndex(-1)
        historyIndexRef.current = -1
      }
    } catch (err: any) {
      setSaveStatus({ kind: 'error', message: err?.message ?? String(err) })
    }
  }, [saveStatus.kind, marketplaceTargets])

  // Cmd/Ctrl+S
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        handleSave()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleSave])

  // ── Step 3: copy flash state ────────────────────────────────────
  // The copy listener itself is registered further down (after the
  // table is declared) — this state lives up here so the StatusBar
  // and the copyCtxRef both see it.
  const [copyFlash, setCopyFlash] = useState<{
    count: number
    at: number
  } | null>(null)

  // ── Initial fetch (products + fields + marketplaces in parallel) ──
  useEffect(() => {
    let cancelled = false
    const start = performance.now()
    const backend = getBackendUrl()
    Promise.all([
      fetch(`${backend}/api/products/bulk-fetch`, { cache: 'no-store' }).then(
        async (res) => {
          if (!res.ok) throw new Error(`products: HTTP ${res.status}`)
          return res.json()
        }
      ),
      fetch(`${backend}/api/pim/fields`, { cache: 'no-store' }).then(
        async (res) => {
          if (!res.ok) throw new Error(`fields: HTTP ${res.status}`)
          return res.json()
        }
      ),
      fetch(`${backend}/api/marketplaces/grouped`, { cache: 'no-store' }).then(
        async (res) => (res.ok ? res.json() : {})
      ),
    ])
      .then(([productsData, fieldsData, marketplacesData]) => {
        if (cancelled) return
        setProducts(
          Array.isArray(productsData.products) ? productsData.products : []
        )
        setAllFields(Array.isArray(fieldsData.fields) ? fieldsData.fields : [])
        // Flatten marketplaces grouped object → flat options for the
        // selector, scoped to channels we care about.
        const opts: MarketplaceOption[] = []
        for (const ch of ['AMAZON', 'EBAY'] as const) {
          const list = (marketplacesData?.[ch] ?? []) as Array<any>
          for (const m of list) {
            opts.push({
              channel: ch,
              code: m.code,
              name: m.name,
              currency: m.currency,
              language: m.language,
            })
          }
        }
        setMarketplaceOptions(opts)
        setFetchMs(Math.round(performance.now() - start))
      })
      .catch((err) => {
        if (cancelled) return
        setError(err?.message ?? String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Refetch products when the primary target changes — bulk-fetch
  // hydrates _channelListing for ONE (channel, marketplace) per row,
  // so the table view always reflects the first selected target.
  // Edits still fan out to every target via marketplaceContexts.
  const reloadProducts = useCallback(() => {
    const params = new URLSearchParams()
    if (primaryContext) {
      params.set('channel', primaryContext.channel)
      params.set('marketplace', primaryContext.marketplace)
    }
    const qs = params.toString()
    return fetch(
      `${getBackendUrl()}/api/products/bulk-fetch${qs ? `?${qs}` : ''}`,
      { cache: 'no-store' },
    )
      .then(async (res) => (res.ok ? res.json() : { products: [] }))
      .then((data) => {
        setProducts(Array.isArray(data.products) ? data.products : [])
      })
      .catch(() => {})
  }, [primaryContext?.channel, primaryContext?.marketplace])
  useEffect(() => {
    reloadProducts()
  }, [reloadProducts])

  // T.2 — productTypes seen in the loaded products. Drives the fields
  // fetch so every visible product's required + optional schema
  // attributes land as columns automatically — without the user
  // having to enable channels / productTypes manually first.
  // enabledProductTypes (user-controlled) still drives column visibility,
  // not what's fetched.
  const productTypesInData = useMemo(() => {
    const set = new Set<string>()
    for (const p of products) {
      const t = (p.productType ?? '').trim()
      if (t) set.add(t)
    }
    return Array.from(set).sort()
  }, [products])

  // Refetch fields when channels/productTypes/marketplace change.
  // D.3g: passing `marketplace` lets the backend pull live category
  // attributes from cached Amazon schemas (CategorySchema). Without
  // it we get the static fallback set only.
  // T.2 — always include AMAZON in channels and productTypesInData in
  // productTypes so the dynamic-fields branch in field-registry runs
  // and surfaces every cached schema attribute as an attr_* column.
  // Defaults to 'IT' when no marketplace target is set (Xavia primary
  // market) so dynamic fields still resolve out of the box.
  useEffect(() => {
    const params = new URLSearchParams()
    const channels = new Set<string>(enabledChannels)
    if (productTypesInData.length > 0) channels.add('AMAZON')
    if (channels.size > 0) params.set('channels', Array.from(channels).join(','))
    // Union of user-enabled types + types actually in the data.
    const typeUnion = Array.from(
      new Set([...enabledProductTypes, ...productTypesInData]),
    )
    if (typeUnion.length > 0) params.set('productTypes', typeUnion.join(','))
    params.set(
      'marketplace',
      primaryContext?.marketplace ?? 'IT',
    )
    const qs = params.toString()
    const url = `${getBackendUrl()}/api/pim/fields${qs ? `?${qs}` : ''}`

    let cancelled = false
    fetch(url, { cache: 'no-store' })
      .then(async (res) => (res.ok ? res.json() : { fields: [] }))
      .then((data) => {
        if (cancelled) return
        setAllFields(Array.isArray(data.fields) ? data.fields : [])
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [
    enabledChannels,
    enabledProductTypes,
    productTypesInData,
    primaryContext?.marketplace,
  ])

  // ── Build columns dynamically from registry + visibility ──────────
  const fieldsById = useMemo(() => {
    const m = new Map<string, FieldDef>()
    for (const f of allFields) m.set(f.id, f)
    return m
  }, [allFields])

  const dynamicColumns = useMemo<ColumnDef<BulkProduct>[]>(() => {
    const out: ColumnDef<BulkProduct>[] = []
    for (const id of visibleColumnIds) {
      const field = fieldsById.get(id)
      if (!field) continue
      out.push(buildColumnFromField(field))
    }
    return out
  }, [visibleColumnIds, fieldsById])

  // Bumped whenever the column set actually changes; passed to TableRow
  // so memoized rows know to re-render on column changes. We use a
  // stable string key — when it changes, the memo comparator sees a
  // different value and re-runs.
  // Include columnSizing in the fingerprint so a header drag also
  // re-renders TableRow (whose memo comparator otherwise sees no
  // change in props and keeps the body cells at the old widths).
  const columnsKey = useMemo(
    () => `${visibleColumnIds.join('|')}#${JSON.stringify(columnSizing)}`,
    [visibleColumnIds, columnSizing],
  )

  const tableMinWidth = useMemo(
    () => dynamicColumns.reduce((sum, c) => sum + (c.size ?? 120), 0),
    [dynamicColumns]
  )

  // ── D.6: Search + filter ─────────────────────────────────────────
  // Search runs against the raw products array first, then we feed
  // the filtered set into the existing hierarchy builder. This means
  // a parent whose children all get filtered out simply vanishes
  // from hierarchy view — same as filtering in any spreadsheet.
  const filteredProducts = useMemo(() => {
    let pool = products
    if (filterState.status.length > 0) {
      const statuses = new Set(filterState.status)
      pool = pool.filter((p) => statuses.has(p.status))
    }
    if (filterState.channels.length > 0) {
      const channels = new Set(filterState.channels)
      pool = pool.filter((p) =>
        (p.syncChannels ?? []).some((c) => channels.has(c)),
      )
    }
    if (filterState.stockLevel !== 'all') {
      pool = pool.filter((p) => {
        const stock = p.totalStock ?? 0
        if (filterState.stockLevel === 'out') return stock === 0
        if (filterState.stockLevel === 'low') return stock > 0 && stock <= 5
        if (filterState.stockLevel === 'in') return stock > 0
        return true
      })
    }
    const q = debouncedSearch.trim().toLowerCase()
    if (q) {
      pool = pool.filter((p) => {
        if (p.sku?.toLowerCase().includes(q)) return true
        if (p.name?.toLowerCase().includes(q)) return true
        if (p.brand?.toLowerCase().includes(q)) return true
        return false
      })
    }
    return pool
  }, [products, debouncedSearch, filterState])

  // Build display rows based on mode
  const displayRows = useMemo(() => {
    if (displayMode !== 'hierarchy') return filteredProducts
    return buildHierarchy(filteredProducts, expandedParents)
  }, [filteredProducts, displayMode, expandedParents])

  const table = useReactTable({
    data: displayRows as BulkProduct[],
    columns: dynamicColumns,
    getCoreRowModel: getCoreRowModel(),
    // Stable row id keyed off the product id (NOT row position).
    // Without this, collapsing a parent in hierarchy mode shrinks
    // the visible-rows array and React reconciles by position —
    // <TableRow key="3"> at position 3 maps to a different product
    // after the collapse, but its child EditableCell components
    // keep their draftValue state, leaking the previous row's
    // SKU / title into the new one with a yellow dirty tint.
    getRowId: (row) => row.id,
    enableColumnResizing: true,
    columnResizeMode: 'onChange',
    state: { columnSizing },
    onColumnSizingChange: setColumnSizing,
    defaultColumn: { minSize: 60, maxSize: 600 },
  })

  const rows = table.getRowModel().rows

  // Mirror table on a ref so the keydown / requestEdit paths read
  // the latest visible-leaf-columns + row model without depending on
  // a particular render's closure.
  const tableRef = useRef(table)
  tableRef.current = table

  // ── Step 3.5: imperative edit + global keyboard nav ─────────────
  // Resolve a (rowIdx, colIdx) selection coord to its real row+column
  // ids and dispatch the edit handler that the EditableCell at those
  // coords registered. Read-only / parent-aggregate cells silently
  // skip — they won't have a registered handler.
  const requestEditAt = useCallback(
    (rowIdx: number, colIdx: number, prefill?: string) => {
      const tbl = tableRef.current
      const row = tbl.getRowModel().rows[rowIdx]
      const col = tbl.getVisibleLeafColumns()[colIdx]
      if (!row || !col) return
      const handle = editHandlers.get(editKey(row.original.id, col.id))
      handle?.enterEdit(prefill)
    },
    [],
  )
  // Move/extend selection by a delta, clamped to the data bounds.
  // Used by Tab / Shift+Tab / arrow keys.
  const moveSelection = useCallback(
    (dRow: number, dCol: number, extend: boolean) => {
      const tbl = tableRef.current
      const rowCount = tbl.getRowModel().rows.length
      const colCount = tbl.getVisibleLeafColumns().length
      if (rowCount === 0 || colCount === 0) return
      setSelection((curr) => {
        const baseAnchor = curr.anchor ?? { rowIdx: 0, colIdx: 0 }
        const baseActive = curr.active ?? baseAnchor
        const nextActive = {
          rowIdx: Math.min(
            Math.max(baseActive.rowIdx + dRow, 0),
            rowCount - 1,
          ),
          colIdx: Math.min(
            Math.max(baseActive.colIdx + dCol, 0),
            colCount - 1,
          ),
        }
        return extend
          ? { anchor: baseAnchor, active: nextActive }
          : { anchor: nextActive, active: nextActive }
      })
    },
    [],
  )
  // Wire the forward ref now that moveSelection exists. EditableCell
  // calls this on Enter / Tab inside the input — Excel semantics:
  // commit + move selection.
  commitNavigateRef.current = (dRow, dCol) => moveSelection(dRow, dCol, false)

  // ── Step 5: drag-fill (Excel autofill) ──────────────────────────
  // The handle on the bottom-right of the selection rectangle starts
  // a fill drag. As the cursor moves we update fillState.target; on
  // mouseup we compute the extension, generate fill values per the
  // detected pattern (linear numeric or cyclic), apply via writeChange
  // + applyValue, and expand the selection over the source + filled
  // region. Escape cancels mid-drag with no changes.
  const commitFill = useCallback(
    (state: FillState) => {
      const ext = computeFillExtension(state.source, state.target)
      if (!ext) return
      const tbl = tableRef.current
      const tableRows = tbl.getRowModel().rows
      const cols = tbl.getVisibleLeafColumns()
      const allFields = allFieldsRef.current
      let appliedAny = false
      // D.6.3: drag-fill is one user action — collect deltas into a
      // single history entry so Cmd+Z reverts the whole fill.
      const batch: HistoryDelta[] = []
      for (let r = ext.minRow; r <= ext.maxRow; r++) {
        const row = tableRows[r]
        if (!row) continue
        for (let c = ext.minCol; c <= ext.maxCol; c++) {
          const col = cols[c]
          if (!col) continue
          const fieldDef = allFields.find((f) => f.id === col.id)
          if (!fieldDef?.editable) continue
          const v = computeFillValue(state.source, ext, {
            rowIdx: r,
            colIdx: c,
          }, tableRows, cols)
          if (v === undefined) continue
          editHandlers
            .get(editKey(row.original.id, col.id))
            ?.applyValue(v)
          writeChange(row.original.id, col.id, v, false, batch)
          appliedAny = true
        }
      }
      if (batch.length > 0) {
        pushHistoryEntry({ cells: batch, timestamp: Date.now() })
      }
      if (appliedAny) {
        setSelection({
          anchor: {
            rowIdx: Math.min(state.source.minRow, ext.minRow),
            colIdx: Math.min(state.source.minCol, ext.minCol),
          },
          active: {
            rowIdx: Math.max(state.source.maxRow, ext.maxRow),
            colIdx: Math.max(state.source.maxCol, ext.maxCol),
          },
        })
      }
    },
    [writeChange, pushHistoryEntry],
  )

  // Clear every editable cell inside the current selection range.
  // Mirrors commitFill's batch-write pattern so a multi-cell delete
  // is a single history entry (Cmd+Z reverts the whole clear).
  // Falls back gracefully on a 1×1 selection — that's just the active
  // cell.
  const clearSelectionRange = useCallback(() => {
    const rb = rangeBoundsRef.current
    if (!rb) return false
    const tbl = tableRef.current
    const tableRows = tbl.getRowModel().rows
    const cols = tbl.getVisibleLeafColumns()
    const allFields = allFieldsRef.current
    const batch: HistoryDelta[] = []
    let appliedAny = false
    for (let r = rb.minRow; r <= rb.maxRow; r++) {
      const row = tableRows[r]
      if (!row) continue
      for (let c = rb.minCol; c <= rb.maxCol; c++) {
        const col = cols[c]
        if (!col) continue
        const fieldDef = allFields.find((f) => f.id === col.id)
        if (!fieldDef?.editable) continue
        editHandlers
          .get(editKey(row.original.id, col.id))
          ?.applyValue('')
        writeChange(row.original.id, col.id, '', false, batch)
        appliedAny = true
      }
    }
    if (batch.length > 0) {
      pushHistoryEntry({ cells: batch, timestamp: Date.now() })
    }
    return appliedAny
  }, [writeChange, pushHistoryEntry])

  const beginFill = useCallback(() => {
    const rb = rangeBoundsRef.current
    if (!rb) return
    setFillState({
      source: { ...rb },
      target: { rowIdx: rb.maxRow, colIdx: rb.maxCol },
    })
    const local = { rafId: null as number | null, x: 0, y: 0 }
    const flush = () => {
      local.rafId = null
      const el = document.elementFromPoint(local.x, local.y) as
        | HTMLElement
        | null
      if (!el) return
      const cellEl = el.closest('[data-row-idx]') as HTMLElement | null
      if (!cellEl) return
      const r = parseInt(cellEl.getAttribute('data-row-idx') ?? '', 10)
      const c = parseInt(cellEl.getAttribute('data-col-idx') ?? '', 10)
      if (Number.isNaN(r) || Number.isNaN(c)) return
      setFillState((curr) =>
        curr ? { ...curr, target: { rowIdx: r, colIdx: c } } : curr,
      )
    }
    const teardown = () => {
      if (local.rafId !== null) cancelAnimationFrame(local.rafId)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.removeEventListener('keydown', onKey)
    }
    const onMove = (e: MouseEvent) => {
      local.x = e.clientX
      local.y = e.clientY
      if (local.rafId === null) {
        local.rafId = requestAnimationFrame(flush)
      }
    }
    const onUp = () => {
      teardown()
      // Read the latest fillState off the setter so we always commit
      // the final target, not whatever stale value the handler closure
      // captured.
      setFillState((curr) => {
        if (curr) commitFill(curr)
        return null
      })
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        teardown()
        setFillState(null)
      }
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.addEventListener('keydown', onKey)
  }, [commitFill])
  selectCtxRef.current.beginFill = beginFill
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const sel = selectionRef.current
      if (!sel.active) return
      const ae = document.activeElement as HTMLElement | null
      // While editing or typing in a real input/search, let the
      // browser handle the key naturally — EditableCell's input has
      // its own keydown for Enter/Escape/Tab.
      if (
        ae &&
        (ae.tagName === 'INPUT' ||
          ae.tagName === 'TEXTAREA' ||
          ae.isContentEditable)
      ) {
        return
      }
      // Don't swallow modifier-key chords (Cmd+S, Cmd+C, …).
      if (e.metaKey || e.ctrlKey || e.altKey) return

      const key = e.key
      if (key === 'F2' || key === 'Enter') {
        e.preventDefault()
        requestEditAt(sel.active.rowIdx, sel.active.colIdx)
        return
      }
      if (key === 'Escape') {
        e.preventDefault()
        setSelection({ anchor: null, active: null })
        return
      }
      if (key === 'Tab') {
        e.preventDefault()
        moveSelection(0, e.shiftKey ? -1 : 1, false)
        return
      }
      if (key === 'ArrowUp') {
        e.preventDefault()
        moveSelection(-1, 0, e.shiftKey)
        return
      }
      if (key === 'ArrowDown') {
        e.preventDefault()
        moveSelection(1, 0, e.shiftKey)
        return
      }
      if (key === 'ArrowLeft') {
        e.preventDefault()
        moveSelection(0, -1, e.shiftKey)
        return
      }
      if (key === 'ArrowRight') {
        e.preventDefault()
        moveSelection(0, 1, e.shiftKey)
        return
      }
      // Type-to-edit: any single printable character starts a fresh
      // edit on the active cell with the typed character as the new
      // value. Skip control keys (length > 1) and pure whitespace
      // chords.
      if (key.length === 1) {
        e.preventDefault()
        requestEditAt(sel.active.rowIdx, sel.active.colIdx, key)
        return
      }
      if (key === 'Backspace' || key === 'Delete') {
        e.preventDefault()
        // Multi-cell delete: clears every editable cell in the range
        // as one batch history entry. Single-cell selection still
        // works (1×1 range). If the range produced no edits (all
        // cells read-only), fall back to the original active-cell
        // edit-mode-with-empty-string so the user gets feedback.
        const cleared = clearSelectionRange()
        if (!cleared) {
          requestEditAt(sel.active.rowIdx, sel.active.colIdx, '')
        }
        return
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [moveSelection, requestEditAt, clearSelectionRange])

  // ── Step 3: copy selection as TSV ────────────────────────────────
  // The handler is registered once on document; it pulls the latest
  // selection + table refs from copyCtxRef so we don't re-attach the
  // listener every time selection changes.
  const copyCtxRef = useRef<{
    bounds: typeof rangeBounds
    table: typeof table
  }>({ bounds: rangeBounds, table })
  copyCtxRef.current.bounds = rangeBounds
  copyCtxRef.current.table = table
  useEffect(() => {
    const onCopy = (e: ClipboardEvent) => {
      const bounds = copyCtxRef.current.bounds
      if (!bounds) return
      // Don't intercept native copy when the user is editing or
      // selected text inside a regular input/textarea.
      const ae = document.activeElement as HTMLElement | null
      if (ae) {
        const tag = ae.tagName
        if (
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          ae.isContentEditable
        ) {
          return
        }
      }
      const tbl = copyCtxRef.current.table
      const tableRows = tbl.getRowModel().rows
      const cols = tbl.getVisibleLeafColumns()
      const tsvRows: string[] = []
      for (let r = bounds.minRow; r <= bounds.maxRow; r++) {
        const row = tableRows[r]
        if (!row) continue
        const cells: string[] = []
        for (let c = bounds.minCol; c <= bounds.maxCol; c++) {
          const col = cols[c]
          if (!col) {
            cells.push('')
            continue
          }
          let v: unknown
          try {
            v = row.getValue(col.id)
          } catch {
            v = undefined
          }
          cells.push(toTsvCell(v))
        }
        tsvRows.push(cells.join('\t'))
      }
      const tsv = tsvRows.join('\n')
      e.clipboardData?.setData('text/plain', tsv)
      e.preventDefault()
      const count =
        (bounds.maxRow - bounds.minRow + 1) *
        (bounds.maxCol - bounds.minCol + 1)
      const at = Date.now()
      setCopyFlash({ count, at })
      // Auto-clear after 2s, but only if no newer copy has happened.
      window.setTimeout(() => {
        setCopyFlash((curr) => (curr && curr.at === at ? null : curr))
      }, 2000)
    }
    document.addEventListener('copy', onCopy)
    return () => document.removeEventListener('copy', onCopy)
  }, [])

  // ── Step 4: paste from clipboard with preview ────────────────────
  // The paste handler reads from the same refs as copy. It builds a
  // "plan" (cells that will change) + "errors" (cells skipped due to
  // read-only / type mismatch / out-of-bounds) and shows the modal
  // before any state mutation. Apply commits via writeChange and uses
  // editHandlers.applyValue to set the visible cells' draftValue so
  // they immediately render with the dirty (yellow) tint.
  const [pastePreview, setPastePreview] = useState<PastePreview | null>(null)
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const sel = selectionRef.current
      if (!sel.active) return
      const ae = document.activeElement as HTMLElement | null
      if (
        ae &&
        (ae.tagName === 'INPUT' ||
          ae.tagName === 'TEXTAREA' ||
          ae.isContentEditable)
      ) {
        return
      }
      const text = e.clipboardData?.getData('text/plain') ?? ''
      if (!text) return

      const sourceGrid = parseTsv(text)
      if (sourceGrid.length === 0) return
      e.preventDefault()

      const tbl = tableRef.current
      const tableRows = tbl.getRowModel().rows
      const visibleCols = tbl.getVisibleLeafColumns()
      const startRow = sel.active.rowIdx
      const startCol = sel.active.colIdx

      // 1×1 source + multi-cell selection → fill the entire range
      // with the single value (Excel behaviour).
      const isSingleSource =
        sourceGrid.length === 1 && sourceGrid[0].length === 1
      const rangeRows = rangeBounds
        ? rangeBounds.maxRow - rangeBounds.minRow + 1
        : 1
      const rangeCols = rangeBounds
        ? rangeBounds.maxCol - rangeBounds.minCol + 1
        : 1
      const fillRange =
        isSingleSource && rangeBounds && (rangeRows > 1 || rangeCols > 1)
      const sourceRows = fillRange ? rangeRows : sourceGrid.length
      const sourceCols = fillRange
        ? rangeCols
        : Math.max(...sourceGrid.map((r) => r.length))
      const anchorRow = fillRange ? rangeBounds!.minRow : startRow
      const anchorCol = fillRange ? rangeBounds!.minCol : startCol

      const plan: PasteCell[] = []
      const errors: PasteError[] = []
      for (let dr = 0; dr < sourceRows; dr++) {
        const targetRow = anchorRow + dr
        if (targetRow >= tableRows.length) break
        const row = tableRows[targetRow]
        if (!row) continue
        for (let dc = 0; dc < sourceCols; dc++) {
          const targetCol = anchorCol + dc
          if (targetCol >= visibleCols.length) break
          const col = visibleCols[targetCol]
          if (!col) continue
          const fieldDef = allFieldsRef.current.find((f) => f.id === col.id)
          const sku = row.original.sku ?? ''
          const fieldLabel = fieldDef?.label ?? col.id
          if (!fieldDef?.editable) {
            errors.push({
              rowIdx: targetRow,
              colIdx: targetCol,
              sku,
              fieldLabel,
              reason: 'Read-only',
            })
            continue
          }
          const sourceR = fillRange ? 0 : dr
          const sourceC = fillRange ? 0 : dc
          const raw = sourceGrid[sourceR]?.[sourceC] ?? ''
          const coerced = coercePasteValue(raw, fieldDef)
          if (coerced.error) {
            errors.push({
              rowIdx: targetRow,
              colIdx: targetCol,
              sku,
              fieldLabel,
              reason: coerced.error,
            })
            continue
          }
          let oldValue: unknown
          try {
            oldValue = row.getValue(col.id)
          } catch {
            oldValue = undefined
          }
          // Skip no-op cells from the changes plan but still flow
          // through so applying expands the selection over them.
          plan.push({
            rowIdx: targetRow,
            colIdx: targetCol,
            rowId: row.original.id,
            columnId: col.id,
            oldValue,
            newValue: coerced.value,
            sku,
            fieldLabel,
          })
        }
      }
      if (plan.length === 0 && errors.length === 0) return
      setPastePreview({ plan, errors })
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [rangeBounds])

  const applyPaste = useCallback(() => {
    setPastePreview((curr) => {
      if (!curr) return null
      // Apply each cell: bump the visible cell's draftValue (yellow
      // tint) AND register the change in the changes Map. Cells that
      // were virtualised out at paste time won't have a registered
      // applyValue handler — the changes Map still picks them up so
      // a save flushes them, but they won't show yellow until the
      // user scrolls back. Tracked in TECH_DEBT.
      let minR = Infinity,
        maxR = -Infinity,
        minC = Infinity,
        maxC = -Infinity
      // D.6.3: paste is one user action — collect every per-cell
      // delta into a single history entry so Cmd+Z reverts the
      // whole paste in one go.
      const batch: HistoryDelta[] = []
      for (const c of curr.plan) {
        editHandlers.get(editKey(c.rowId, c.columnId))?.applyValue(c.newValue)
        writeChange(c.rowId, c.columnId, c.newValue, false, batch)
        if (c.rowIdx < minR) minR = c.rowIdx
        if (c.rowIdx > maxR) maxR = c.rowIdx
        if (c.colIdx < minC) minC = c.colIdx
        if (c.colIdx > maxC) maxC = c.colIdx
      }
      if (batch.length > 0) {
        pushHistoryEntry({ cells: batch, timestamp: Date.now() })
      }
      // Expand the selection over the pasted region so the user can
      // see what just changed. Falls back to current selection if no
      // changes were applied (e.g., pure errors).
      if (curr.plan.length > 0) {
        setSelection({
          anchor: { rowIdx: minR, colIdx: minC },
          active: { rowIdx: maxR, colIdx: maxC },
        })
      }
      return null
    })
  }, [writeChange, pushHistoryEntry])
  const cancelPaste = useCallback(() => setPastePreview(null), [])

  const containerRef = useRef<HTMLDivElement>(null)
  const rowVirtualizer = useVirtualizer({
    count: loading ? 20 : rows.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  })

  // NOT memoized: TanStack's table object is stable across renders by
  // design (it mutates internally). A useMemo([table]) dep would
  // capture an empty headers array on first render (before dynamicColumns
  // is populated) and never recompute. Calling getHeaderGroups() each
  // render is cheap — TanStack returns the cached internal structure.
  const headerCells = table.getHeaderGroups()[0]?.headers ?? []
  const totalSize = rowVirtualizer.getTotalSize()
  const pendingCount = changes.size

  // ── Selection overlay geometry ─────────────────────────────────
  // Compute the (left, width) of every visible column once per render
  // so the selection overlays know where to draw. Cheap — just walks
  // the visible-leaf-columns array.
  const visibleLeafCols = table.getVisibleLeafColumns()
  const colLefts: number[] = []
  {
    let acc = 0
    for (const col of visibleLeafCols) {
      colLefts.push(acc)
      acc += col.getSize()
    }
  }
  const rangeRect = (() => {
    if (!rangeBounds) return null
    const left = colLefts[rangeBounds.minCol] ?? 0
    let width = 0
    for (let i = rangeBounds.minCol; i <= rangeBounds.maxCol; i++) {
      width += visibleLeafCols[i]?.getSize() ?? 0
    }
    return {
      top: rangeBounds.minRow * ROW_HEIGHT,
      left,
      width,
      height:
        (rangeBounds.maxRow - rangeBounds.minRow + 1) * ROW_HEIGHT,
    }
  })()
  const activeRect = (() => {
    if (!selection.active) return null
    const a = selection.active
    return {
      top: a.rowIdx * ROW_HEIGHT,
      left: colLefts[a.colIdx] ?? 0,
      width: visibleLeafCols[a.colIdx]?.getSize() ?? 0,
      height: ROW_HEIGHT,
    }
  })()
  const fillRect = (() => {
    if (!fillState) return null
    const ext = computeFillExtension(fillState.source, fillState.target)
    if (!ext) return null
    const left = colLefts[ext.minCol] ?? 0
    let width = 0
    for (let i = ext.minCol; i <= ext.maxCol; i++) {
      width += visibleLeafCols[i]?.getSize() ?? 0
    }
    return {
      top: ext.minRow * ROW_HEIGHT,
      left,
      width,
      height: (ext.maxRow - ext.minRow + 1) * ROW_HEIGHT,
    }
  })()

  // ── Step 6: status-bar metrics ─────────────────────────────────
  // For numeric ranges, compute Sum/Avg/Min/Max alongside the cell
  // count. Skip the heavy iteration above 1000 cells — the count
  // alone is enough for huge selections, and recomputing on every
  // mousemove during a drag would become noticeable.
  const selectionMetrics = useMemo<SelectionMetrics | null>(() => {
    if (!rangeBounds) return null
    const count =
      (rangeBounds.maxRow - rangeBounds.minRow + 1) *
      (rangeBounds.maxCol - rangeBounds.minCol + 1)
    if (count > 1000) {
      return { count, isLarge: true }
    }
    const tableRows = table.getRowModel().rows
    const cols = visibleLeafCols
    let sum = 0
    let min = Infinity
    let max = -Infinity
    let numericCount = 0
    for (let r = rangeBounds.minRow; r <= rangeBounds.maxRow; r++) {
      const row = tableRows[r]
      if (!row) continue
      for (let c = rangeBounds.minCol; c <= rangeBounds.maxCol; c++) {
        const col = cols[c]
        if (!col) continue
        let v: unknown
        try {
          v = row.getValue(col.id)
        } catch {
          continue
        }
        if (typeof v === 'number' && Number.isFinite(v)) {
          sum += v
          if (v < min) min = v
          if (v > max) max = v
          numericCount++
        }
      }
    }
    if (numericCount === 0) {
      return { count, numericCount: 0 }
    }
    return {
      count,
      numericCount,
      sum,
      avg: sum / numericCount,
      min,
      max,
    }
  }, [rangeBounds, table, visibleLeafCols])

  // D.3d: track which visible columns are channel-prefixed AND
  // whether any pending change targets one. Used to drive the banner
  // and the marketplace-selector pulse animation.
  const channelFieldsVisible = useMemo(() => {
    return visibleColumnIds.some((id) => {
      const f = fieldsById.get(id)
      return !!f?.channel
    })
  }, [visibleColumnIds, fieldsById])

  const pendingChannelChanges = useMemo(() => {
    let n = 0
    for (const [, c] of changes) {
      if (c.columnId.startsWith('amazon_') || c.columnId.startsWith('ebay_')) n++
    }
    return n
  }, [changes])

  const showContextBanner =
    channelFieldsVisible && marketplaceTargets.length === 0

  const hasUnsavablePendingChanges =
    marketplaceTargets.length === 0 && pendingChannelChanges > 0

  const saveLabel =
    saveStatus.kind === 'saving'
      ? 'Saving…'
      : pendingCount === 0
      ? 'No changes'
      : `Save ${pendingCount} change${pendingCount === 1 ? '' : 's'}`

  // ── View handlers ────────────────────────────────────────────────
  const handleSelectView = useCallback(
    (id: string) => {
      const view = savedViews.find((v) => v.id === id)
      if (!view) return
      setActiveViewIdState(id)
      setActiveViewId(id)
      setVisibleColumnIds(view.columnIds)
      setEnabledChannels(view.channels ?? [])
      setEnabledProductTypes(view.productTypes ?? [])
    },
    [savedViews]
  )

  const handleSaveAsView = useCallback(
    (name: string) => {
      const id = `user_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
      const view = saveUserView({
        id,
        name,
        columnIds: visibleColumnIds,
        channels: enabledChannels,
        productTypes: enabledProductTypes,
      })
      setSavedViews(loadAllViews())
      setActiveViewIdState(view.id)
      setActiveViewId(view.id)
    },
    [visibleColumnIds, enabledChannels, enabledProductTypes]
  )

  const handleDeleteView = useCallback(
    (id: string) => {
      if (isDefaultView(id)) return
      deleteUserView(id)
      setSavedViews(loadAllViews())
      if (activeViewIdState === id) {
        handleSelectView(DEFAULT_VIEWS[0].id)
      }
    },
    [activeViewIdState, handleSelectView]
  )

  return (
    <div className="flex-1 min-h-0 px-6 pb-6 flex flex-col">
      {!online && (
        <div className="flex-shrink-0 mb-3 flex items-center gap-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-md text-[12px] text-amber-800">
          <WifiOff className="w-3.5 h-3.5 flex-shrink-0" />
          <span>You're offline. Changes are kept locally and will save when you reconnect.</span>
        </div>
      )}

      <MarketplaceContextBanner
        visible={showContextBanner}
        pendingChannelChanges={pendingChannelChanges}
      />

      {/* Two-row toolbar.
          Row 1: scope (mode/expand/search/filter) on the left,
                 marketplace + write actions (Bulk apply / Upload /
                 Preview / Save) on the right — Save is always visible
                 without horizontal scrolling at any reasonable width.
          Row 2: secondary tools (undo/redo, columns, reset widths)
                 on the left, status text on the right.

          `relative z-30` is load-bearing: the table container below
          uses `contain: strict` which creates its own stacking context.
          Without an explicit stacking context here, popovers in the
          toolbar (Filter / Marketplace / Cols) render UNDER the table
          even though they are at z-30 internally. Elevating the whole
          toolbar wrapper above the table's SC keeps the popovers
          visually on top whenever they expand downward over the grid. */}
      <div className="flex-shrink-0 mb-3 flex flex-col gap-1.5 px-1 pb-2 border-b border-slate-200 bg-white relative z-30">
        {/* ── Row 1 — primary scope + write actions ─────────────────── */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* Left: scope */}
          <div className="flex items-center gap-2 flex-shrink-0">
            <DisplayModeToggle mode={displayMode} onChange={setDisplayMode} />
            {displayMode === 'hierarchy' && (
              <ExpandCollapseControls
                products={products}
                expandedParents={expandedParents}
                onChange={setExpandedParents}
              />
            )}

            <div className="w-px h-5 bg-slate-200" aria-hidden="true" />

            <div className="relative flex items-center">
              <Search className="absolute left-2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search SKU, name, brand…"
                className="h-7 pl-7 pr-7 text-[12px] border border-slate-200 rounded-md w-40 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="absolute right-1.5 text-slate-400 hover:text-slate-700"
                  aria-label="Clear search"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
            <FilterDropdown
              open={filterOpen}
              onOpenChange={setFilterOpen}
              value={filterState}
              onChange={setFilterState}
              onReset={resetFilters}
              activeCount={activeFilterCount}
            />
          </div>

          {/* Right: marketplace + write actions */}
          <div className="flex items-center gap-2 flex-shrink-0 ml-auto">
            <MarketplaceSelector
              value={marketplaceTargets}
              onChange={setMarketplaceTargets}
              options={marketplaceOptions}
              pulse={showContextBanner}
            />

            <div className="w-px h-5 bg-slate-200" aria-hidden="true" />

            <Button
              variant="secondary"
              size="sm"
              onClick={() => setBulkOpModalOpen(true)}
              title="Apply price / stock / status / attribute changes to a scoped subset of products"
            >
              <Wand2 className="w-3.5 h-3.5 mr-1.5" />
              Bulk apply
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setUploadOpen(true)}
            >
              <Upload className="w-3.5 h-3.5 mr-1.5" />
              Upload
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={pendingCount === 0}
              onClick={() => setPreviewOpen(true)}
            >
              Preview
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={
                pendingCount === 0 ||
                saveStatus.kind === 'saving' ||
                !online ||
                hasUnsavablePendingChanges
              }
              loading={saveStatus.kind === 'saving'}
              onClick={handleSave}
              title={
                hasUnsavablePendingChanges
                  ? `${pendingChannelChanges} channel change${
                      pendingChannelChanges === 1 ? '' : 's'
                    } need a marketplace context to save`
                  : undefined
              }
            >
              {saveLabel}
            </Button>
          </div>
        </div>

        {/* ── Row 2 — secondary tools + status ──────────────────────── */}
        <div className="flex items-center gap-2 flex-wrap text-[11px]">
          {/* Left: history. */}
          <div className="flex items-center gap-2 flex-shrink-0">
            <div className="flex items-center gap-0.5 border border-slate-200 rounded-md">
              <button
                type="button"
                onClick={undo}
                disabled={!canUndo}
                title="Undo (⌘Z)"
                aria-label="Undo"
                className="h-7 px-1.5 text-slate-600 hover:bg-slate-100 hover:text-slate-900 disabled:opacity-30 disabled:cursor-default rounded-l-md"
              >
                <Undo2 className="w-3.5 h-3.5" />
              </button>
              <div className="w-px h-4 bg-slate-200" />
              <button
                type="button"
                onClick={redo}
                disabled={!canRedo}
                title="Redo (⌘⇧Z)"
                aria-label="Redo"
                className="h-7 px-1.5 text-slate-600 hover:bg-slate-100 hover:text-slate-900 disabled:opacity-30 disabled:cursor-default rounded-r-md"
              >
                <Redo2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Middle: status, fills available space. */}
          <div className="flex-1 min-w-0 text-slate-500 tabular-nums truncate">
            {loading
              ? 'Loading…'
              : filteredProducts.length === products.length
              ? `${products.length.toLocaleString()} rows · ${visibleColumnIds.length}/${allFields.length} cols · ⌘S to save`
              : `${filteredProducts.length.toLocaleString()} of ${products.length.toLocaleString()} rows · ${visibleColumnIds.length}/${allFields.length} cols · ⌘S to save`}
          </div>

          {/* Right: view tools. */}
          <div className="flex items-center gap-2 flex-shrink-0">
            {/* T.2 — surface every dynamic schema attribute (attr_*)
             *  for the productTypes seen in the loaded data. One-shot
             *  append; user can hide individual ones via Cols. */}
            {(() => {
              const attrInData = allFields.filter(
                (f) =>
                  f.id.startsWith('attr_') &&
                  !visibleColumnIds.includes(f.id),
              )
              if (attrInData.length === 0) return null
              return (
                <button
                  type="button"
                  onClick={() =>
                    setVisibleColumnIds((prev) => [
                      ...prev,
                      ...attrInData.map((f) => f.id),
                    ])
                  }
                  title="Add every schema-driven category attribute (attr_*) for the loaded productTypes as columns"
                  className="inline-flex items-center gap-1 h-7 px-2 text-[11px] font-medium text-blue-700 border border-blue-200 rounded-md hover:bg-blue-50"
                >
                  + {attrInData.length} schema field
                  {attrInData.length === 1 ? '' : 's'}
                </button>
              )
            })()}
            <ColumnSelector
              allFields={allFields}
              visibleColumnIds={visibleColumnIds}
              onVisibleChange={setVisibleColumnIds}
              enabledChannels={enabledChannels}
              onEnabledChannelsChange={setEnabledChannels}
              enabledProductTypes={enabledProductTypes}
              onEnabledProductTypesChange={setEnabledProductTypes}
              views={savedViews}
              activeViewId={activeViewIdState}
              onSelectView={handleSelectView}
              onSaveAsView={handleSaveAsView}
              onDeleteView={handleDeleteView}
            />
            {Object.keys(columnSizing).length > 0 && (
              <button
                type="button"
                onClick={resetColumnWidths}
                title="Reset column widths to defaults"
                className="inline-flex items-center gap-1 h-7 px-2 text-slate-600 border border-slate-200 rounded-md hover:bg-slate-50 hover:text-slate-900"
              >
                <RotateCcw className="w-3 h-3" />
                Reset widths
              </button>
            )}
          </div>
        </div>
      </div>

      <div
        ref={containerRef}
        className="flex-1 min-h-0 overflow-auto bg-white border border-slate-200 rounded-lg select-none"
        style={{ contain: 'strict' }}
      >
        <div
          className="sticky top-0 z-20 bg-slate-50 border-b border-slate-200 flex"
          style={{ height: HEADER_HEIGHT, minWidth: tableMinWidth }}
        >
          {headerCells.map((header) => {
            const fieldDef = (header.column.columnDef.meta as
              | { fieldDef?: FieldDef }
              | undefined)?.fieldDef
            const isReadOnly = fieldDef && !fieldDef.editable
            const isResizing = header.column.getIsResizing()
            return (
              <div
                key={header.id}
                className="relative flex items-center gap-1 px-3 border-r border-slate-200/70 last:border-r-0 text-[11px] font-semibold text-slate-700 uppercase tracking-wider"
                style={{ width: header.getSize(), flexShrink: 0 }}
                title={fieldDef?.helpText}
              >
                <span className="truncate">
                  {flexRender(
                    header.column.columnDef.header,
                    header.getContext()
                  )}
                </span>
                {isReadOnly && (
                  <Lock
                    className="w-2.5 h-2.5 text-slate-400 flex-shrink-0"
                    aria-label="Read-only"
                  />
                )}
                {/* Resize handle — sits on the right border. Calls
                 *  TanStack's getResizeHandler to track mousedown and
                 *  drive column.size via the columnSizing state. */}
                <div
                  onMouseDown={header.getResizeHandler()}
                  onTouchStart={header.getResizeHandler()}
                  onClick={(e) => e.stopPropagation()}
                  className={cn(
                    'absolute top-0 bottom-0 w-1.5 cursor-col-resize select-none touch-none',
                    'right-0 -mr-[3px] z-10',
                    isResizing
                      ? 'bg-blue-500'
                      : 'bg-transparent hover:bg-blue-500/60',
                  )}
                />
              </div>
            )
          })}
        </div>

        <div className="relative" style={{ height: totalSize, minWidth: tableMinWidth }}>
          {rowVirtualizer.getVirtualItems().map((vRow) => {
            if (loading)
              return (
                <SkeletonRow
                  key={vRow.key}
                  top={vRow.start}
                  colCount={dynamicColumns.length || 7}
                />
              )
            const row = rows[vRow.index]
            return (
              <TableRow
                key={row.id}
                row={row}
                rowIdx={vRow.index}
                top={vRow.start}
                columnsKey={columnsKey}
              />
            )
          })}
          <SelectionOverlays
            rangeRect={rangeRect}
            activeRect={activeRect}
            fillRect={fillRect}
            isFilling={fillState !== null}
          />
        </div>

        {error && (
          <div className="absolute inset-0 flex items-center justify-center bg-white/90">
            <div className="text-[13px] text-red-700 bg-red-50 border border-red-200 rounded-md px-4 py-2">
              Failed to load: {error}
            </div>
          </div>
        )}
      </div>

      <StatusBar
        status={saveStatus}
        pendingCount={pendingCount}
        fetchMs={fetchMs}
        loading={loading}
        selectedCellCount={selectedCellCount}
        selectionMetrics={selectionMetrics}
        copyFlashCount={copyFlash?.count ?? null}
      />

      <PreviewChangesModal
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        changes={changes}
        products={products}
      />

      <PastePreviewModal
        preview={pastePreview}
        onCancel={cancelPaste}
        onApply={applyPaste}
      />

      <UploadModal
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onApplied={() => {
          // Refetch products so the grid reflects the saved changes.
          // Selection + pending edits are local state and unaffected.
          reloadProducts()
        }}
      />

      <BulkOperationModal
        open={bulkOpModalOpen}
        onClose={() => {
          setBulkOpModalOpen(false)
          // Refresh the grid in case the bulk apply changed visible
          // rows (price/stock/status/attribute updates).
          reloadProducts()
        }}
        marketplaceTargets={marketplaceTargets}
        visibleProductIds={products.map((p) => p.id)}
        currentFilters={(() => {
          // Map the grid's filterState (status[]/channels[]/stockLevel)
          // to ScopeFilters. Imperfect but covers the common case.
          // Channels intentionally not mapped — Product.syncChannels[]
          // ≠ ChannelListing.marketplace; would need channel-to-marketplace
          // resolution that's not worth the lift for v1.
          const scope: {
            status?: 'DRAFT' | 'ACTIVE' | 'INACTIVE'
            stockMin?: number
            stockMax?: number
          } = {}
          if (filterState.status.length === 1) {
            scope.status = filterState.status[0] as
              | 'DRAFT'
              | 'ACTIVE'
              | 'INACTIVE'
          }
          if (filterState.stockLevel === 'in') scope.stockMin = 1
          else if (filterState.stockLevel === 'low') {
            scope.stockMin = 1
            scope.stockMax = 5
          } else if (filterState.stockLevel === 'out') scope.stockMax = 0
          return scope
        })()}
      />

      <CascadeChoiceModal
        open={cascadeModal !== null}
        fieldLabel={cascadeModal?.fieldLabel ?? ''}
        oldValue={cascadeModal?.oldValue}
        newValue={cascadeModal?.newValue}
        parentSku={cascadeModal?.parentSku ?? ''}
        children={cascadeModal?.children ?? []}
        onApply={handleCascadeApply}
        onCancel={handleCascadeCancel}
      />
    </div>
  )
}
