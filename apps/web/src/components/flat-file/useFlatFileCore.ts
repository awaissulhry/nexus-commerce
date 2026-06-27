'use client'

/**
 * useFlatFileCore — generic shared state hook for flat-file editors.
 *
 * Extracts ALL state that is duplicated between AmazonFlatFileClient and
 * EbayFlatFileClient into a single reusable hook. Neither channel-specific
 * logic nor channel-specific types live here — they are supplied by the
 * caller via generics and options.
 *
 * Task 5 of the flat-file shared editor rebuild.
 */

import { useState, useCallback, useRef, useMemo } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { BaseRow, FlatFileColumnGroup, SortLevel, ConditionalRule, ValidationIssue } from './FlatFileGrid.types'
import type { GenericFFFilterState } from '@/app/products/_shared/flat-file-filter.types'

const MAX_HISTORY = 50

// ── Options ────────────────────────────────────────────────────────────────

export interface UseFlatFileCoreOptions<TRow extends BaseRow, TFilterDims> {
  /** localStorage namespace — all persisted keys are prefixed with this. */
  storageKey: string
  /** Initial data rows (without ghost rows). */
  initialRows: TRow[]
  /** Factory that produces a blank ghost/new row. */
  makeBlankRow: () => TRow
  /** Minimum trailing ghost rows to pad to (default: 8). */
  minGhostRows?: number
  /**
   * Column group definitions supplied by the caller. These are NEVER hardcoded
   * in this hook — they are derived from the channel template API response for
   * the current market+productType combination. The hook only manages
   * visibility/reorder STATE on top of whatever groups come in here.
   */
  initialGroups: FlatFileColumnGroup[]
  /** Channel-specific initial filter state. */
  initialFilter: GenericFFFilterState<TFilterDims>
  /** Optional validation function; called on every non-ghost row change. */
  validate?: (rows: TRow[]) => ValidationIssue[]
}

// ── Return type ────────────────────────────────────────────────────────────

export interface UseFlatFileCoreReturn<TRow extends BaseRow, TFilterDims> {
  // ── Rows ───────────────────────────────────────────────────────────────
  rows: TRow[]
  setRows: Dispatch<SetStateAction<TRow[]>>
  /** Update a single cell value, marks the row dirty and pushes a history snapshot. */
  updateCell: (rowId: string, colId: string, value: unknown) => void
  /** Non-ghost rows only. */
  realRows: TRow[]
  /** Real rows that have unsaved changes. */
  dirtyRows: TRow[]
  hasDirty: boolean

  // ── Undo / Redo ────────────────────────────────────────────────────────
  pushSnapshot: (snap: TRow[]) => void
  canUndo: boolean
  canRedo: boolean
  handleUndo: () => void
  handleRedo: () => void

  // ── Sort ───────────────────────────────────────────────────────────────
  sortConfig: SortLevel[]
  /** Raw state setter — does NOT write to localStorage. */
  setSortConfig: Dispatch<SetStateAction<SortLevel[]>>
  /** Persist and update sort levels. */
  persistSort: (next: SortLevel[]) => void
  sortPanelOpen: boolean
  setSortPanelOpen: Dispatch<SetStateAction<boolean>>

  // ── Conditional formatting ─────────────────────────────────────────────
  cfRules: ConditionalRule[]
  /** Raw state setter — does NOT write to localStorage. */
  setCfRules: Dispatch<SetStateAction<ConditionalRule[]>>
  /** Persist and update CF rules. */
  persistCfRules: (next: ConditionalRule[]) => void
  conditionalOpen: boolean
  setConditionalOpen: Dispatch<SetStateAction<boolean>>

  // ── Filter ─────────────────────────────────────────────────────────────
  ffFilter: GenericFFFilterState<TFilterDims>
  setFfFilter: Dispatch<SetStateAction<GenericFFFilterState<TFilterDims>>>
  filterOpen: boolean
  setFilterOpen: Dispatch<SetStateAction<boolean>>

  // ── Smart paste ────────────────────────────────────────────────────────
  smartPasteEnabled: boolean
  toggleSmartPaste: () => void

  // ── Row images ─────────────────────────────────────────────────────────
  showRowImages: boolean
  rowImageSize: 24 | 32 | 48 | 64 | 96
  toggleRowImages: () => void
  changeImageSize: (sz: 24 | 32 | 48 | 64 | 96) => void

  // ── Column groups ──────────────────────────────────────────────────────
  /**
   * Active column groups — caller-supplied definitions, updated whenever the
   * template API response changes (market or productType switch). The hook
   * NEVER defines group names/structure; it only stores what the caller sets.
   */
  columnGroups: FlatFileColumnGroup[]
  setColumnGroups: Dispatch<SetStateAction<FlatFileColumnGroup[]>>
  /** IDs of groups the operator has collapsed. */
  closedGroups: Set<string>
  /** Persisted display order of group IDs (empty = natural order from template). */
  groupOrder: string[]
  applyGroupSettings: (nextClosed: Set<string>, nextOrder: string[]) => void
  columnsOpen: boolean
  setColumnsOpen: Dispatch<SetStateAction<boolean>>

  // ── Panel open states ──────────────────────────────────────────────────
  findReplaceOpen: boolean
  setFindReplaceOpen: Dispatch<SetStateAction<boolean>>
  validationOpen: boolean
  setValidationOpen: Dispatch<SetStateAction<boolean>>
  aiPanelOpen: boolean
  setAiPanelOpen: Dispatch<SetStateAction<boolean>>
  aiModalOpen: boolean
  setAiModalOpen: Dispatch<SetStateAction<boolean>>

  // ── Selection ──────────────────────────────────────────────────────────
  selectedRows: Set<string>
  setSelectedRows: Dispatch<SetStateAction<Set<string>>>

  // ── Validation results ─────────────────────────────────────────────────
  validationIssues: ValidationIssue[]
  validationErrorCount: number
  validationWarnCount: number
}

// ── Hook ───────────────────────────────────────────────────────────────────

export function useFlatFileCore<TRow extends BaseRow, TFilterDims>({
  storageKey,
  initialRows,
  makeBlankRow,
  minGhostRows = 8,
  initialGroups,
  initialFilter,
  validate,
}: UseFlatFileCoreOptions<TRow, TFilterDims>): UseFlatFileCoreReturn<TRow, TFilterDims> {

  // ── Rows ──────────────────────────────────────────────────────────────
  const [rows, setRows] = useState<TRow[]>(() => {
    const ghosts = Array.from({ length: minGhostRows }, () =>
      ({ ...makeBlankRow(), _ghost: true, _dirty: false, _isNew: false }),
    )
    return [...initialRows, ...ghosts]
  })

  // ── Undo / Redo ───────────────────────────────────────────────────────
  const historyRef = useRef<TRow[][]>([])
  const futureRef = useRef<TRow[][]>([])
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)

  const pushSnapshot = useCallback((snap: TRow[]) => {
    historyRef.current = [...historyRef.current.slice(-(MAX_HISTORY - 1)), snap]
    futureRef.current = []
    setCanUndo(true)
    setCanRedo(false)
  }, [])

  const updateCell = useCallback((rowId: string, colId: string, value: unknown) => {
    setRows((prev) => {
      pushSnapshot(prev)
      return prev.map((r) =>
        r._rowId === rowId ? { ...r, [colId]: value, _dirty: true, _ghost: false } : r,
      )
    })
  }, [pushSnapshot])

  const handleUndo = useCallback(() => {
    const snap = historyRef.current.pop()
    if (!snap) return
    setRows((cur) => { futureRef.current.push(cur); return snap })
    setCanUndo(historyRef.current.length > 0)
    setCanRedo(true)
  }, [])

  const handleRedo = useCallback(() => {
    const snap = futureRef.current.pop()
    if (!snap) return
    setRows((cur) => { historyRef.current.push(cur); return snap })
    setCanUndo(true)
    setCanRedo(futureRef.current.length > 0)
  }, [])

  // ── Sort ──────────────────────────────────────────────────────────────
  const [sortConfig, setSortConfig] = useState<SortLevel[]>(() => {
    try { return JSON.parse(localStorage.getItem(`${storageKey}-sort`) ?? '[]') as SortLevel[] } catch { return [] }
  })
  const persistSort = useCallback((next: SortLevel[]) => {
    setSortConfig(next)
    try { localStorage.setItem(`${storageKey}-sort`, JSON.stringify(next)) } catch { /* ignore */ }
  }, [storageKey])
  const [sortPanelOpen, setSortPanelOpen] = useState(false)

  // ── Conditional formatting ─────────────────────────────────────────────
  const [cfRules, setCfRules] = useState<ConditionalRule[]>(() => {
    try { return JSON.parse(localStorage.getItem(`${storageKey}-cf-rules`) ?? '[]') as ConditionalRule[] } catch { return [] }
  })
  const persistCfRules = useCallback((next: ConditionalRule[]) => {
    setCfRules(next)
    try { localStorage.setItem(`${storageKey}-cf-rules`, JSON.stringify(next)) } catch { /* ignore */ }
  }, [storageKey])
  const [conditionalOpen, setConditionalOpen] = useState(false)

  // ── Filter ────────────────────────────────────────────────────────────
  const [ffFilter, setFfFilter] = useState<GenericFFFilterState<TFilterDims>>(initialFilter)
  const [filterOpen, setFilterOpen] = useState(false)

  // ── Smart paste ───────────────────────────────────────────────────────
  const [smartPasteEnabled, setSmartPasteEnabled] = useState(() => {
    try { return localStorage.getItem(`${storageKey}-smart-paste`) === '1' } catch { return false }
  })
  const toggleSmartPaste = useCallback(() => {
    setSmartPasteEnabled((v) => {
      const next = !v
      try { localStorage.setItem(`${storageKey}-smart-paste`, next ? '1' : '0') } catch { /* ignore */ }
      return next
    })
  }, [storageKey])

  // ── Row images ────────────────────────────────────────────────────────
  const [showRowImages, setShowRowImages] = useState(() => {
    try { return localStorage.getItem(`${storageKey}-show-images`) === '1' } catch { return false }
  })
  const [rowImageSize, setRowImageSize] = useState<24 | 32 | 48 | 64 | 96>(() => {
    try { return (parseInt(localStorage.getItem(`${storageKey}-image-size`) ?? '48', 10) || 48) as 24 | 32 | 48 | 64 | 96 } catch { return 48 }
  })
  const toggleRowImages = useCallback(() => {
    setShowRowImages((v) => {
      const next = !v
      try { localStorage.setItem(`${storageKey}-show-images`, next ? '1' : '0') } catch { /* ignore */ }
      return next
    })
  }, [storageKey])
  const changeImageSize = useCallback((sz: 24 | 32 | 48 | 64 | 96) => {
    setRowImageSize(sz)
    try { localStorage.setItem(`${storageKey}-image-size`, String(sz)) } catch { /* ignore */ }
  }, [storageKey])

  // ── Column groups ─────────────────────────────────────────────────────
  // The caller owns the group DEFINITIONS (derived from the template API for
  // the current market+productType). This hook only manages the runtime state
  // so callers can call setColumnGroups when the market or product type changes.
  const [columnGroups, setColumnGroups] = useState<FlatFileColumnGroup[]>(initialGroups)

  // ── Column group visibility / order ───────────────────────────────────
  const [closedGroups, setClosedGroups] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(`${storageKey}-closed-groups`) ?? '[]') as string[]) } catch { return new Set() }
  })
  const [groupOrder, setGroupOrder] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(`${storageKey}-group-order`) ?? '[]') as string[] } catch { return [] }
  })
  const applyGroupSettings = useCallback((nextClosed: Set<string>, nextOrder: string[]) => {
    setClosedGroups(nextClosed)
    setGroupOrder(nextOrder)
    try {
      localStorage.setItem(`${storageKey}-closed-groups`, JSON.stringify([...nextClosed]))
      localStorage.setItem(`${storageKey}-group-order`, JSON.stringify(nextOrder))
    } catch { /* ignore */ }
  }, [storageKey])
  const [columnsOpen, setColumnsOpen] = useState(false)

  // ── Panel open states ─────────────────────────────────────────────────
  const [findReplaceOpen, setFindReplaceOpen] = useState(false)
  const [validationOpen, setValidationOpen] = useState(false)
  const [aiPanelOpen, setAiPanelOpen] = useState(false)
  const [aiModalOpen, setAiModalOpen] = useState(false)

  // ── Selection ─────────────────────────────────────────────────────────
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set())

  // ── Derived / validation ──────────────────────────────────────────────
  const realRows = useMemo(() => rows.filter((r) => !r._ghost), [rows])

  const validationIssues = useMemo(
    () => (validate ? validate(realRows as TRow[]) : []),
    [validate, realRows],
  )
  const validationErrorCount = useMemo(
    () => validationIssues.filter((i) => i.level === 'error').length,
    [validationIssues],
  )
  const validationWarnCount = useMemo(
    () => validationIssues.filter((i) => i.level === 'warn').length,
    [validationIssues],
  )

  const dirtyRows = useMemo(() => realRows.filter((r) => r._dirty || r._isNew), [realRows])
  const hasDirty = dirtyRows.length > 0

  return {
    rows, setRows, updateCell, realRows, dirtyRows, hasDirty, pushSnapshot,
    canUndo, canRedo, handleUndo, handleRedo,
    sortConfig, setSortConfig, persistSort, sortPanelOpen, setSortPanelOpen,
    cfRules, setCfRules, persistCfRules, conditionalOpen, setConditionalOpen,
    ffFilter, setFfFilter, filterOpen, setFilterOpen,
    smartPasteEnabled, toggleSmartPaste,
    showRowImages, rowImageSize, toggleRowImages, changeImageSize,
    columnGroups, setColumnGroups,
    closedGroups, groupOrder, applyGroupSettings,
    columnsOpen, setColumnsOpen,
    findReplaceOpen, setFindReplaceOpen,
    validationOpen, setValidationOpen,
    aiPanelOpen, setAiPanelOpen,
    aiModalOpen, setAiModalOpen,
    selectedRows, setSelectedRows,
    validationIssues, validationErrorCount, validationWarnCount,
  }
}
