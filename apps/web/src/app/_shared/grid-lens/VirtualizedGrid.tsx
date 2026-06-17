'use client'

/**
 * G.0 — shared VirtualizedGrid.
 *
 * Generic virtualized data grid extracted from products/_components/GridView.tsx.
 * Product-specific logic (ProductCell, RowContextMenu, DraggableHandle,
 * DroppableRowOverlay, IT_TERMS) stays in GridView.tsx.
 *
 * This component handles:
 *   - Column resize (CSS variable approach, zero React re-renders during drag)
 *   - TanStack Virtual row virtualisation
 *   - Column sort headers with aria-sort
 *   - Right-click context menu state + positioning (consumers inject content via renderRowContextMenu)
 *   - Checkbox select-all header
 *   - Expand/collapse chevron column
 *   - Optional star/tag button column (only when onTagEdit is provided)
 *   - Optional drag handle column (only when renderDragHandle is provided)
 *   - Flat row list from parents + expanded children + loading/empty placeholders
 *   - SearchContext + RiskFlaggedContext providers (exported for consumers)
 *
 * Consumers inject product-specific content via:
 *   renderCell      — cell renderer per (row, colKey, isChild)
 *   renderRowContextMenu — context menu content (grid handles positioning wrapper)
 *   onTagEdit       — if provided, renders the star column
 *   renderDragHandle — if provided, renders the drag handle column cells
 *   renderDropOverlay — if provided, renders the droppable overlay on parent rows
 */

import {
  createContext,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronRight, Star } from 'lucide-react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Card } from '@/components/ui/Card'
import { useTranslations } from '@/lib/i18n/use-translations'
import {
  type Density,
  DENSITY_ROW_HEIGHT,
} from '@/lib/products/theme'
import type { GridLensColumn, GridLensRow } from './types'

// ── Contexts ────────────────────────────────────────────────────────────────
// E.14 — search-term highlighting context. Grid publishes the debounced URL
// search term here; cells consume it via useContext to wrap matches in <mark>.
// Context (not prop) so the search term doesn't thread through 4 levels of
// props + bust memo on every input change.
export const SearchContext = createContext<string>('')

// R7.2 — flagged-SKU context. Cells read it to render the "high return rate"
// badge. Same context-not-prop reasoning as SearchContext.
export const RiskFlaggedContext = createContext<Set<string>>(new Set())

// PG.3 — active density context. VirtualizedGrid is the single owner of
// the Density value (passed in via the `density` prop from the workspace
// toolbar); cells like ProductIdentityCell + ThumbImage consume it to
// scale their thumbnail size + placeholder icon. Comfortable is the
// default so cells outside a VirtualizedGrid (e.g. drawer, future
// previews) render with the historical 40 px thumb.
export const DensityContext = createContext<Density>('comfortable')

// ── FlatRow ─────────────────────────────────────────────────────────────────
type FlatRow<T extends GridLensRow> =
  | { kind: 'parent'; product: T }
  | { kind: 'child'; product: T; parentId: string }
  | { kind: 'loading'; parentId: string }
  | { kind: 'empty'; parentId: string; childCount: number }

// ── Props ────────────────────────────────────────────────────────────────────
export interface VirtualizedGridProps<T extends GridLensRow> {
  rows: T[]
  visible: GridLensColumn[]
  density: Density
  cellPad: string
  selected: Set<string>
  toggleSelect: (id: string, shiftKey: boolean) => void
  toggleSelectAll: () => void
  allSelected: boolean
  sortBy: string
  onSort: (key: string) => void
  /** Maps col.key → sortBy param. Columns absent from this map are non-sortable. */
  sortKeys?: Record<string, string>
  expandedParents: Set<string>
  childrenByParent: Record<string, T[]>
  loadingChildren: Set<string>
  onToggleExpand: (parentId: string) => void
  focusedRowId: string | null
  searchTerm: string
  riskFlaggedSkus: Set<string>
  draggable?: boolean
  stagedIds?: Set<string>
  activeId?: string | null
  /** Namespace for localStorage (e.g. 'products', 'listings'). */
  storageKey: string
  /** Cell renderer. Called for every visible column × every data row. */
  renderCell: (row: T, colKey: string, isChild: boolean) => React.ReactNode
  /** Context menu content. Grid handles the fixed-positioned wrapper + dismiss logic. */
  renderRowContextMenu?: (row: T, onClose: () => void) => React.ReactNode
  /** If provided, the star/tag column is rendered with this handler. */
  onTagEdit?: (id: string) => void
  /** Drag handle cell renderer. Only called when draggable=true. */
  renderDragHandle?: (row: T, rowBg: string) => React.ReactNode
  /** Droppable overlay rendered on parent rows. Only called when draggable=true. */
  renderDropOverlay?: (row: T) => React.ReactNode
  /**
   * When false, the 24 px chevron column is hidden entirely (header + rows).
   * Set to false on surfaces that have no parent/child expansion (e.g. /listings).
   * Defaults to true so /products keeps its expand/collapse behaviour unchanged.
   */
  showExpandColumn?: boolean
  /**
   * PG.6 — Freeze the leading column group (drag + checkbox + expand +
   * star + first locked content column) on horizontal scroll. Matches
   * Amazon Manage Products. Default true; /products operator can flip
   * off via the Preferences modal (PG.5). Other workspaces inherit the
   * default for free.
   */
  stickyLeft?: boolean
  /**
   * PG.6 — Freeze the trailing locked column ("actions") on the right
   * during horizontal scroll. Same Amazon parity + Preferences-driven
   * shape as stickyLeft.
   */
  stickyRight?: boolean
}

// PG.6 — Cell widths for the conditional leading utility columns.
// Mirror the literals already used in the header + GridRow render
// (kept inline before for inline-style brevity; lifted here so the
// sticky-left offset math reads as one source of truth).
const LEAD_DRAG_W = 28
const LEAD_CHECKBOX_W = 32
const LEAD_EXPAND_W = 24
const LEAD_STAR_W = 22

/** Cumulative `left` px offset for every sticky-left cell, given which
 *  conditional leading columns are mounted. The product column lands
 *  after the utility group at the sum of every mounted width. */
function leadingLeftOffsets(args: {
  draggable: boolean
  showExpandColumn: boolean
  hasStar: boolean
}) {
  const dragW = args.draggable ? LEAD_DRAG_W : 0
  const expandW = args.showExpandColumn ? LEAD_EXPAND_W : 0
  const starW = args.hasStar ? LEAD_STAR_W : 0
  return {
    drag: 0,
    checkbox: dragW,
    expand: dragW + LEAD_CHECKBOX_W,
    star: dragW + LEAD_CHECKBOX_W + expandW,
    /** Offset for the first locked content column (`product`). */
    firstContent: dragW + LEAD_CHECKBOX_W + expandW + starW,
  }
}

// PG.6 — z-index layers for sticky cells. The header row already uses
// z-10; sticky body cells stack at z-1 to sit above non-sticky body
// peers but below the header. Header cells that are ALSO sticky-left
// /right inherit the header's z-10 and bump to z-20 so they remain
// above body sticky cells when scrolling diagonally.
const STICKY_BODY_Z = 'z-[1]'
const STICKY_HEADER_CORNER_Z = 'z-20'

// PG.6 — Edge shadow on the right of the sticky-left group and left of
// the sticky-right cell. Always rendered (subtle 1 px tint that acts as
// a divider even when not scrolled); a `box-shadow` larger than 1 px
// would distract on the resting state. inset:0 / right:-1 / left:-1
// places the strip just outside the cell so it never overlaps content.
const STICKY_LEFT_EDGE_SHADOW =
  "after:content-[''] after:absolute after:top-0 after:right-[-1px] after:bottom-0 after:w-px after:bg-slate-200 dark:after:bg-slate-700 after:pointer-events-none"
const STICKY_RIGHT_EDGE_SHADOW =
  "before:content-[''] before:absolute before:top-0 before:left-[-1px] before:bottom-0 before:w-px before:bg-slate-200 dark:before:bg-slate-700 before:pointer-events-none"

const EMPTY_SET = new Set<never>()

// ── Main component ───────────────────────────────────────────────────────────
export function VirtualizedGrid<T extends GridLensRow>({
  rows,
  visible,
  density,
  cellPad,
  selected,
  toggleSelect,
  toggleSelectAll,
  allSelected,
  sortBy,
  onSort,
  sortKeys: sortKeysProp,
  expandedParents,
  childrenByParent,
  loadingChildren,
  onToggleExpand,
  focusedRowId,
  searchTerm,
  riskFlaggedSkus,
  draggable = false,
  stagedIds,
  activeId = null,
  storageKey,
  renderCell,
  renderRowContextMenu,
  onTagEdit,
  renderDragHandle,
  renderDropOverlay,
  showExpandColumn = true,
  stickyLeft = true,
  stickyRight = true,
}: VirtualizedGridProps<T>): React.ReactElement {
  const _stagedIds = stagedIds ?? (EMPTY_SET as Set<string>)
  const { t } = useTranslations()
  const sortKeys = sortKeysProp ?? {}

  // PG.6 — Precompute the cumulative `left` offset for each sticky-left
  // cell once per render. Drag/checkbox/expand/star are conditional on
  // their callbacks; the offsets shift when those columns aren't
  // mounted, which is exactly the contract leadingLeftOffsets covers.
  const stickyLeftOffsets = useMemo(
    () =>
      leadingLeftOffsets({
        draggable: !!draggable,
        showExpandColumn,
        hasStar: !!onTagEdit,
      }),
    [draggable, showExpandColumn, onTagEdit],
  )

  // PG.6 — Which content column counts as "first" / "last" for the
  // sticky toggles. Today these are the locked leading + trailing keys
  // ('product' + 'actions' on /products); fall back to the visible
  // array bookends if the workspace didn't lock anything.
  const firstStickyKey = useMemo(() => {
    const leadingLocked = visible.find((c) => c.locked && c.key === 'product')
    return leadingLocked?.key ?? visible[0]?.key ?? null
  }, [visible])
  const lastStickyKey = useMemo(() => {
    const trailingLocked = visible.find((c) => c.locked && c.key === 'actions')
    return trailingLocked?.key ?? visible[visible.length - 1]?.key ?? null
  }, [visible])

  // ── Flat row list ──────────────────────────────────────────────────────────
  const flatRows: FlatRow<T>[] = useMemo(() => {
    const result: FlatRow<T>[] = []
    for (const p of rows) {
      result.push({ kind: 'parent', product: p })
      if (!expandedParents.has(p.id)) continue
      if (loadingChildren.has(p.id)) {
        result.push({ kind: 'loading', parentId: p.id })
        continue
      }
      const kids = childrenByParent[p.id] ?? []
      if (kids.length === 0) {
        result.push({
          kind: 'empty',
          parentId: p.id,
          childCount: p.childCount ?? 0,
        })
        continue
      }
      for (const k of kids) {
        result.push({ kind: 'child', product: k, parentId: p.id })
      }
    }
    return result
  }, [rows, expandedParents, childrenByParent, loadingChildren])

  // ── Column resize ──────────────────────────────────────────────────────────
  // E.12 — per-column width overrides hydrated from localStorage on mount,
  // persisted on commit. The live drag updates a CSS custom property directly
  // on the table root via tableRootRef — zero React re-renders per pixel.
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(
    () => {
      if (typeof window === 'undefined') return {}
      try {
        const raw = window.localStorage.getItem(`${storageKey}.columnWidths`)
        return raw ? JSON.parse(raw) : {}
      } catch {
        return {}
      }
    },
  )
  useEffect(() => {
    try {
      window.localStorage.setItem(
        `${storageKey}.columnWidths`,
        JSON.stringify(columnWidths),
      )
    } catch {
      /* ignore quota errors */
    }
  }, [columnWidths, storageKey])

  // P.3 — listen for view-applied widths and replace state.
  useEffect(() => {
    const onApplyWidths = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { widths?: Record<string, number> }
        | undefined
      if (detail?.widths && typeof detail.widths === 'object') {
        setColumnWidths(detail.widths)
      }
    }
    window.addEventListener('nexus:apply-column-widths', onApplyWidths)
    return () =>
      window.removeEventListener('nexus:apply-column-widths', onApplyWidths)
  }, [])

  const colWidth = useCallback(
    (key: string, fallback?: number) => columnWidths[key] ?? fallback ?? 100,
    [columnWidths],
  )

  const tableRootRef = useRef<HTMLDivElement>(null)
  const cssVarStyle = useMemo(() => {
    const style: Record<string, string> = {}
    for (const c of visible) {
      // PG.6/PG.8 hotfix — clamp LOCKED columns (product, actions) to
      // at least their schema-default width. Operators can grow them
      // via the resize handle, but the stored value can never go
      // below the default — that's the "minimum width needed to
      // render the cluster without cropping". Pre-hotfix a stale
      // 140 px stored for `actions` survived the 180 px schema bump
      // and clipped the Eye+Copy+Edit+▾ cluster on every reload.
      const schemaW = c.width ?? 100
      const stored = colWidth(c.key, schemaW)
      const w = c.locked ? Math.max(stored, schemaW) : stored
      style[`--col-${c.key}-width`] = `${w}px`
    }
    return style as React.CSSProperties
  }, [visible, colWidth])

  // Total table width = [drag(28)] + checkbox(32) + [chevron(24)] + [star(22)] + sum(col widths)
  // PG.6/PG.8 hotfix — mirror the locked-min clamp from cssVarStyle so
  // totalWidth doesn't under-report and let the cluster overflow past
  // the table's minWidth.
  const totalWidth = useMemo(
    () =>
      (draggable ? 28 : 0) +
      32 +
      (showExpandColumn ? 24 : 0) +
      (onTagEdit ? 22 : 0) +
      visible.reduce((acc, c) => {
        const schemaW = c.width ?? 100
        const stored = colWidth(c.key, schemaW)
        return acc + (c.locked ? Math.max(stored, schemaW) : stored)
      }, 0),
    [visible, colWidth, draggable, onTagEdit, showExpandColumn],
  )

  // ── Context menu ───────────────────────────────────────────────────────────
  // E.9 — right-click context menu state. null means closed.
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    row: T
  } | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!contextMenu) return
    const onAway = (e: Event) => {
      if (menuRef.current?.contains(e.target as Node)) return
      setContextMenu(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null)
    }
    document.addEventListener('mousedown', onAway)
    document.addEventListener('keydown', onKey)
    document.addEventListener('scroll', onAway, true)
    return () => {
      document.removeEventListener('mousedown', onAway)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('scroll', onAway, true)
    }
  }, [contextMenu])

  const onRowContextMenu = useCallback(
    (e: React.MouseEvent, row: T) => {
      e.preventDefault()
      setContextMenu({ x: e.clientX, y: e.clientY, row })
    },
    [],
  )

  // ── Virtualizer ─────────────────────────────────────────────────────────────
  const containerRef = useRef<HTMLDivElement>(null)
  const rowVirtualizer = useVirtualizer({
    count: flatRows.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => DENSITY_ROW_HEIGHT[density],
    overscan: 12,
    getItemKey: (index) => {
      const r = flatRows[index]
      if (!r) return index
      if (r.kind === 'parent') return `p:${r.product.id}`
      if (r.kind === 'child') return `c:${r.product.id}`
      if (r.kind === 'loading') return `l:${r.parentId}`
      return `e:${r.parentId}`
    },
  })

  // E.10 — keep J/K-focused row in view.
  useEffect(() => {
    if (!focusedRowId) return
    const idx = flatRows.findIndex(
      (r) =>
        (r.kind === 'parent' || r.kind === 'child') &&
        r.product.id === focusedRowId,
    )
    if (idx >= 0) {
      rowVirtualizer.scrollToIndex(idx, { align: 'auto' })
    }
  }, [focusedRowId, flatRows, rowVirtualizer])

  return (
    <SearchContext.Provider value={searchTerm}>
      <RiskFlaggedContext.Provider value={riskFlaggedSkus}>
        <DensityContext.Provider value={density}>
        <Card noPadding>
          <div
            ref={containerRef}
            className="overflow-auto relative"
            style={{ maxHeight: '75vh' }}
          >
            <div
              ref={tableRootRef}
              style={{ minWidth: totalWidth, ...cssVarStyle }}
            >
              {/* ── Header ───────────────────────────────────────────── */}
              <div
                className="flex border-b border-default bg-slate-50 sticky top-0 z-10"
                role="row"
              >
                {draggable && (
                  <div
                    className={`px-1 py-2${stickyLeft ? ` sticky ${STICKY_HEADER_CORNER_Z} bg-slate-50 dark:bg-slate-800` : ''}`}
                    style={{
                      width: 28,
                      minWidth: 28,
                      ...(stickyLeft ? { left: stickyLeftOffsets.drag } : null),
                    }}
                    role="columnheader"
                    aria-label="Drag"
                  />
                )}
                <div
                  className={`px-3 py-2 flex items-center${stickyLeft ? ` sticky ${STICKY_HEADER_CORNER_Z} bg-slate-50 dark:bg-slate-800` : ''}`}
                  style={{
                    width: 32,
                    minWidth: 32,
                    ...(stickyLeft ? { left: stickyLeftOffsets.checkbox } : null),
                  }}
                  role="columnheader"
                >
                  {/* U.34 — custom checkbox button */}
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={allSelected}
                    aria-label={
                      allSelected ? 'Deselect all rows' : 'Select all rows'
                    }
                    onClick={toggleSelectAll}
                    className={`w-4 h-4 rounded border-2 flex-shrink-0 inline-flex items-center justify-center cursor-pointer transition-colors ${
                      allSelected
                        ? 'bg-blue-600 border-blue-600 text-white'
                        : 'border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 hover:border-slate-400 dark:hover:border-slate-500'
                    }`}
                  >
                    {allSelected && <Check className="w-3 h-3" strokeWidth={3} />}
                  </button>
                </div>
                {showExpandColumn && (
                  <div
                    className={`px-1 py-2${stickyLeft ? ` sticky ${STICKY_HEADER_CORNER_Z} bg-slate-50 dark:bg-slate-800` : ''}`}
                    style={{
                      width: 24,
                      minWidth: 24,
                      ...(stickyLeft ? { left: stickyLeftOffsets.expand } : null),
                    }}
                    role="columnheader"
                    aria-label={t('products.grid.expandVariants')}
                  />
                )}
                {onTagEdit && (
                  <div
                    className={`px-0.5 py-2${stickyLeft ? ` sticky ${STICKY_HEADER_CORNER_Z} bg-slate-50 dark:bg-slate-800` : ''}`}
                    style={{
                      width: 22,
                      minWidth: 22,
                      ...(stickyLeft ? { left: stickyLeftOffsets.star } : null),
                    }}
                    role="columnheader"
                    aria-label="Star"
                  />
                )}
                {visible.map((col) => {
                  const sortable =
                    col.key !== 'thumb' &&
                    col.key !== 'actions' &&
                    !!sortKeys[col.key]
                  const isActive =
                    sortable &&
                    sortBy.startsWith(sortKeys[col.key].replace(/-asc$|-desc$/, ''))
                  const sortDir: 'ascending' | 'descending' | 'none' =
                    !sortable
                      ? 'none'
                      : !isActive
                        ? 'none'
                        : sortBy.endsWith('-asc')
                          ? 'ascending'
                          : 'descending'
                  // PG.6 — fold sticky-left/right onto the locked
                  // bookend headers. firstStickyKey takes the leading
                  // group's last offset; lastStickyKey pins right:0.
                  const isStickyLeftCol = stickyLeft && col.key === firstStickyKey
                  const isStickyRightCol = stickyRight && col.key === lastStickyKey
                  const stickyHeaderCls = isStickyLeftCol
                    ? ` sticky ${STICKY_HEADER_CORNER_Z} bg-slate-50 dark:bg-slate-800 ${STICKY_LEFT_EDGE_SHADOW}`
                    : isStickyRightCol
                      ? ` sticky ${STICKY_HEADER_CORNER_Z} bg-slate-50 dark:bg-slate-800 ${STICKY_RIGHT_EDGE_SHADOW}`
                      : ''
                  const stickyHeaderStyle: React.CSSProperties = isStickyLeftCol
                    ? { left: stickyLeftOffsets.firstContent }
                    : isStickyRightCol
                      ? { right: 0 }
                      : {}
                  return (
                    <div
                      key={col.key}
                      role="columnheader"
                      aria-sort={sortable ? sortDir : undefined}
                      tabIndex={sortable ? 0 : undefined}
                      onKeyDown={(e) => {
                        if (!sortable) return
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          onSort(sortKeys[col.key])
                        }
                      }}
                      className={`relative px-3 py-2 text-xs font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300 text-left flex items-start group/sort ${sortable ? 'cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-300 focus:bg-slate-100' : ''}${stickyHeaderCls}`}
                      style={{
                        width: `var(--col-${col.key}-width)`,
                        minWidth: `var(--col-${col.key}-width)`,
                        ...stickyHeaderStyle,
                      }}
                      onClick={() => {
                        if (sortable) onSort(sortKeys[col.key])
                      }}
                    >
                      <span className="flex flex-col items-start gap-0">
                        <span className="inline-flex items-center gap-1">
                          {col.labelKey ? t(col.labelKey) : col.label}
                          {/* PG.10 — sort arrow visibility.
                              Active sort: full-opacity ↑/↓.
                              Sortable but inactive: ↕ persistent at
                              30% so every sortable column advertises
                              itself at rest (Salesforce/Airtable
                              density). Bumps to full on hover.
                              Pre-PG.10 the ↕ was opacity-0 → 100 on
                              hover; operators had to know-or-guess
                              which columns sorted. */}
                          {isActive ? (
                            <span className="text-tertiary" aria-hidden="true">
                              {sortDir === 'ascending' ? '↑' : '↓'}
                            </span>
                          ) : sortable ? (
                            <span className="text-slate-300 dark:text-slate-600 opacity-30 group-hover/sort:opacity-100 transition-opacity" aria-hidden="true">
                              ↕
                            </span>
                          ) : null}
                        </span>
                        {col.subLabel && density !== 'compact' && (
                          // PG.10 — at compact density the row is 44 px;
                          // the two-line header collides with the cell
                          // baseline. Hide the subLabel hint in compact
                          // mode; keep it in comfortable + spacious where
                          // there's vertical room.
                          <span className="text-[10px] font-normal normal-case tracking-normal text-tertiary dark:text-slate-500 leading-none mt-0.5">
                            {col.subLabel}
                          </span>
                        )}
                      </span>
                      {/* E.12 — resize handle */}
                      <ColumnResizeHandle
                        columnKey={col.key}
                        fallbackWidth={col.width ?? 100}
                        tableRootRef={tableRootRef}
                        onCommit={(w) =>
                          setColumnWidths((prev) => ({
                            ...prev,
                            [col.key]: w,
                          }))
                        }
                      />
                    </div>
                  )
                })}
              </div>

              {/* ── Body ─────────────────────────────────────────────── */}
              <div
                role="rowgroup"
                style={{
                  height: `${rowVirtualizer.getTotalSize()}px`,
                  position: 'relative',
                }}
              >
                {rowVirtualizer.getVirtualItems().map((vRow) => {
                  const row = flatRows[vRow.index]
                  if (!row) return null
                  const productId =
                    row.kind === 'parent' || row.kind === 'child'
                      ? row.product.id
                      : null
                  const isSelected = productId ? selected.has(productId) : false
                  const isExpanded = productId
                    ? expandedParents.has(productId)
                    : false
                  const isFocused = productId
                    ? focusedRowId === productId
                    : false
                  const rowData =
                    row.kind === 'parent' || row.kind === 'child'
                      ? row.product
                      : null
                  return (
                    <div
                      key={vRow.key}
                      data-index={vRow.index}
                      ref={rowVirtualizer.measureElement}
                      role="row"
                      className={`border-b border-subtle flex${draggable ? ' relative' : ''}`}
                      onContextMenu={
                        rowData
                          ? (e) => onRowContextMenu(e, rowData)
                          : undefined
                      }
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        transform: `translateY(${vRow.start}px)`,
                      }}
                    >
                      {row.kind === 'parent' && (
                        <>
                          <GridRow<T>
                            product={row.product}
                            isChild={false}
                            isSelected={isSelected}
                            isExpanded={isExpanded}
                            isFocused={isFocused}
                            visible={visible}
                            cellPad={cellPad}
                            onToggleSelect={toggleSelect}
                            onToggleExpand={onToggleExpand}
                            onTagEdit={onTagEdit}
                            isDraggable={draggable}
                            isStaged={_stagedIds.has(row.product.id)}
                            isActivelyDragged={activeId === row.product.id}
                            renderCell={renderCell}
                            renderDragHandle={renderDragHandle}
                            showExpandColumn={showExpandColumn}
                            stickyLeft={stickyLeft}
                            stickyRight={stickyRight}
                            stickyLeftOffsets={stickyLeftOffsets}
                            firstStickyKey={firstStickyKey}
                            lastStickyKey={lastStickyKey}
                          />
                          {draggable && renderDropOverlay?.(row.product)}
                        </>
                      )}
                      {row.kind === 'child' && (
                        <GridRow<T>
                          product={row.product}
                          isChild={true}
                          isSelected={isSelected}
                          isExpanded={isExpanded}
                          isFocused={isFocused}
                          visible={visible}
                          cellPad={cellPad}
                          onToggleSelect={toggleSelect}
                          onToggleExpand={onToggleExpand}
                          onTagEdit={onTagEdit}
                          isDraggable={draggable}
                          isStaged={_stagedIds.has(row.product.id)}
                          isActivelyDragged={activeId === row.product.id}
                          renderCell={renderCell}
                          renderDragHandle={renderDragHandle}
                          showExpandColumn={showExpandColumn}
                          stickyLeft={stickyLeft}
                          stickyRight={stickyRight}
                          stickyLeftOffsets={stickyLeftOffsets}
                          firstStickyKey={firstStickyKey}
                          lastStickyKey={lastStickyKey}
                        />
                      )}
                      {row.kind === 'loading' && (
                        <div
                          className="bg-slate-50/60 dark:bg-slate-800/40 px-3 py-2 text-base text-slate-500 dark:text-slate-400 italic flex-1"
                          role="cell"
                        >
                          {t('products.grid.loadingVariants')}
                        </div>
                      )}
                      {row.kind === 'empty' && (
                        <div
                          className="bg-slate-50/60 dark:bg-slate-800/40 px-3 py-2 text-base text-slate-500 dark:text-slate-400 italic flex-1"
                          role="cell"
                        >
                          {row.childCount > 0
                            ? 'Reloading variants…'
                            : 'No variants found.'}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          </div>

          {/* ── Context menu portal ──────────────────────────────────── */}
          {contextMenu && renderRowContextMenu && (() => {
            // E.9 — clamp position to viewport so the menu doesn't render
            // off-screen when right-clicked near the right or bottom edge.
            const W = 240
            const H = 340
            const adjX = Math.min(contextMenu.x, window.innerWidth - W - 8)
            const adjY = Math.min(contextMenu.y, window.innerHeight - H - 8)
            return createPortal(
              <div
                ref={menuRef}
                role="menu"
                onContextMenu={(e) => e.preventDefault()}
                style={{ left: adjX, top: adjY }}
                className="fixed z-50 w-60 bg-white border border-default rounded-md shadow-xl p-1 dark:bg-slate-900 dark:border-slate-800 animate-fade-in"
              >
                {renderRowContextMenu(contextMenu.row, () => setContextMenu(null))}
              </div>,
              document.body,
            )
          })()}
        </Card>
        </DensityContext.Provider>
      </RiskFlaggedContext.Provider>
    </SearchContext.Provider>
  )
}

// ── GridRow ─────────────────────────────────────────────────────────────────
// Generic memo'd row component. Replaces ProductRow in the shared grid.
// Uses a non-generic inner component wrapped by a typed outer to preserve memo.

interface GridRowProps<T extends GridLensRow> {
  product: T
  isChild: boolean
  isSelected: boolean
  isExpanded: boolean
  isFocused: boolean
  visible: GridLensColumn[]
  cellPad: string
  onToggleSelect: (id: string, shiftKey: boolean) => void
  onToggleExpand: (parentId: string) => void
  onTagEdit?: (id: string) => void
  isDraggable?: boolean
  isStaged?: boolean
  isActivelyDragged?: boolean
  renderCell: (row: T, colKey: string, isChild: boolean) => React.ReactNode
  renderDragHandle?: (row: T, rowBg: string) => React.ReactNode
  showExpandColumn?: boolean
  /** PG.6 — sticky toggles + precomputed cumulative offsets. The parent
   *  memoises both so React.memo on GridRowInner stays effective; if we
   *  computed inside the row, every render would create a new offsets
   *  object and bust the shallow compare. */
  stickyLeft?: boolean
  stickyRight?: boolean
  stickyLeftOffsets?: ReturnType<typeof leadingLeftOffsets>
  firstStickyKey?: string | null
  lastStickyKey?: string | null
}

// Inner component is memo'd but uses `any` for T to satisfy React.memo
// (generics + memo don't compose directly in TypeScript without a cast).
// The outer typed wrapper GridRow<T> preserves call-site type safety.
const GridRowInner = memo(function GridRowInner({
  product,
  isChild,
  isSelected,
  isExpanded,
  isFocused,
  visible,
  cellPad,
  onToggleSelect,
  onToggleExpand,
  onTagEdit,
  isDraggable = false,
  isStaged = false,
  isActivelyDragged = false,
  renderCell,
  renderDragHandle,
  showExpandColumn = true,
  stickyLeft = true,
  stickyRight = true,
  stickyLeftOffsets,
  firstStickyKey = null,
  lastStickyKey = null,
}: GridRowProps<any>) {
  const { t } = useTranslations()
  const childCount = product.childCount ?? 0
  const canExpand = !isChild && product.isParent && childCount > 0
  const focusRing = isFocused ? 'ring-2 ring-inset ring-blue-500' : ''
  const offsets = stickyLeftOffsets ?? leadingLeftOffsets({
    draggable: !!isDraggable,
    showExpandColumn,
    hasStar: !!onTagEdit,
  })

  // W5.3 — Conditional row formatting.
  const stateTint = (() => {
    if (isSelected) return ''
    if ((product as any).status === 'INACTIVE')
      return 'bg-slate-100/50 dark:bg-slate-900/60'
    if ((product as any).status === 'DRAFT')
      return 'bg-amber-50/40 dark:bg-amber-950/20'
    if ((product as any).status === 'ACTIVE' && (product as any).totalStock === 0)
      return 'bg-rose-50/40 dark:bg-rose-950/20'
    return ''
  })()

  const stagedTint =
    isStaged && !isSelected ? 'bg-teal-50/60 dark:bg-teal-950/25' : ''

  const rowBg = isActivelyDragged
    ? 'opacity-40'
    : isChild
      ? isSelected
        ? `bg-blue-50/40 ${focusRing}`
        : `${stagedTint || stateTint || 'bg-slate-50/40'} hover:bg-slate-100/60 ${focusRing}`
      : isSelected
        ? `bg-blue-50/30 ${focusRing}`
        : `${stagedTint || stateTint} hover:bg-slate-50 dark:hover:bg-slate-900 ${focusRing}`

  // PG.6 — sticky body-cell modifier helpers. Each leading utility
  // cell gets the same sticky/left/z-index treatment when stickyLeft
  // is on; otherwise renders unchanged. Background is supplied by the
  // existing rowBg template so sticky cells visually match the rest
  // of the row.
  const stickyLeftCls = stickyLeft ? `sticky ${STICKY_BODY_Z}` : ''
  const stickyStyle = (offset: number): React.CSSProperties =>
    stickyLeft ? { left: offset } : {}
  return (
    <>
      {isDraggable && renderDragHandle?.(product, rowBg)}
      <div
        className={`px-3 py-2 flex items-center ${rowBg} ${stickyLeftCls}`}
        style={{ width: 32, minWidth: 32, ...stickyStyle(offsets.checkbox) }}
        role="cell"
      >
        {/* U.34 — custom checkbox */}
        <button
          type="button"
          role="checkbox"
          aria-checked={isSelected}
          aria-label={isSelected ? 'Deselect row' : 'Select row'}
          onClick={(e) => {
            e.preventDefault()
            onToggleSelect(product.id, e.shiftKey)
          }}
          onKeyDown={(e) => {
            if (e.key === ' ') {
              e.preventDefault()
              onToggleSelect(product.id, e.shiftKey)
            }
          }}
          className={`w-4 h-4 rounded border-2 flex-shrink-0 inline-flex items-center justify-center cursor-pointer transition-colors ${
            isSelected
              ? 'bg-blue-600 border-blue-600 text-white'
              : 'border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 hover:border-slate-400 dark:hover:border-slate-500'
          }`}
        >
          {isSelected && <Check className="w-3 h-3" strokeWidth={3} />}
        </button>
      </div>
      {showExpandColumn && <div
        className={`px-1 py-2 flex items-center ${rowBg} ${stickyLeftCls}`}
        style={{ width: 24, minWidth: 24, ...stickyStyle(offsets.expand) }}
        role="cell"
      >
        {canExpand ? (
          <button
            type="button"
            onClick={() => onToggleExpand(product.id)}
            aria-expanded={isExpanded}
            aria-label={
              isExpanded
                ? t('products.grid.collapseVariantsAria', { sku: (product as any).sku ?? product.id })
                : t('products.grid.expandVariantsAria', {
                    sku: (product as any).sku ?? product.id,
                    count: childCount,
                  })
            }
            title={t(
              childCount === 1
                ? 'products.mobile.variants.one'
                : 'products.mobile.variants.other',
              { count: childCount },
            )}
            className="h-5 w-5 inline-flex items-center justify-center rounded hover:bg-slate-200 text-slate-500 hover:text-slate-900"
          >
            <ChevronRight
              size={14}
              className={`transition-transform duration-150 ${isExpanded ? 'rotate-90' : ''}`}
            />
          </button>
        ) : isChild ? (
          <span className="block h-4 w-4 ml-1 border-l-2 border-b-2 border-slate-300 rounded-bl" />
        ) : null}
      </div>}
      {/* AM.1 — ★ star slot (only when onTagEdit is provided) */}
      {onTagEdit && (
        <div
          className={`px-0.5 py-2 flex items-center justify-center ${rowBg} ${stickyLeftCls}`}
          style={{ width: 22, minWidth: 22, ...stickyStyle(offsets.star) }}
          role="cell"
        >
          <button
            type="button"
            onClick={() => onTagEdit(product.id)}
            aria-label="Star / tag product"
            title="Star / tag product"
            className="text-slate-300 hover:text-amber-400 dark:text-slate-600 dark:hover:text-amber-400 transition-colors"
          >
            <Star size={12} />
          </button>
        </div>
      )}
      {visible.map((col) => {
        // PG.6 — fold sticky-left/right onto the locked bookend cells.
        // firstStickyKey pins after the leading utility group at the
        // computed offset; lastStickyKey pins right:0.
        const isStickyLeftCol = stickyLeft && col.key === firstStickyKey
        const isStickyRightCol = stickyRight && col.key === lastStickyKey
        const stickyCellCls = isStickyLeftCol
          ? `sticky ${STICKY_BODY_Z} ${STICKY_LEFT_EDGE_SHADOW}`
          : isStickyRightCol
            ? `sticky ${STICKY_BODY_Z} ${STICKY_RIGHT_EDGE_SHADOW}`
            : ''
        const stickyCellStyle: React.CSSProperties = isStickyLeftCol
          ? { left: offsets.firstContent }
          : isStickyRightCol
            ? { right: 0 }
            : {}
        return (
          <div
            key={col.key}
            role="cell"
            className={`${cellPad} flex items-center ${rowBg} overflow-hidden ${stickyCellCls}`}
            style={{
              width: `var(--col-${col.key}-width)`,
              minWidth: `var(--col-${col.key}-width)`,
              ...stickyCellStyle,
            }}
          >
            {renderCell(product, col.key, isChild)}
          </div>
        )
      })}
    </>
  )
})

// Typed wrapper — preserves generics at call sites.
function GridRow<T extends GridLensRow>(props: GridRowProps<T>) {
  return <GridRowInner {...(props as GridRowProps<any>)} />
}

// ── ColumnResizeHandle ───────────────────────────────────────────────────────
// E.12 — column resize handle. Sits absolute-right on each header cell.
// mouseDown captures starting clientX + starting width; document-level
// listeners track mousemove (updates CSS variable directly, zero React
// updates) and mouseUp (commits final width via onCommit).
export function ColumnResizeHandle({
  columnKey,
  fallbackWidth,
  tableRootRef,
  onCommit,
}: {
  columnKey: string
  fallbackWidth: number
  tableRootRef: React.RefObject<HTMLDivElement | null>
  onCommit: (width: number) => void
}) {
  const { t } = useTranslations()
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)
  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const root = tableRootRef.current
      if (!root) return
      const computed = parseFloat(
        getComputedStyle(root).getPropertyValue(`--col-${columnKey}-width`),
      )
      const startW = Number.isFinite(computed) ? computed : fallbackWidth
      dragRef.current = { startX: e.clientX, startW }
      const onMove = (ev: MouseEvent) => {
        const ctx = dragRef.current
        if (!ctx) return
        const delta = ev.clientX - ctx.startX
        const next = Math.max(60, Math.min(600, ctx.startW + delta))
        root.style.setProperty(`--col-${columnKey}-width`, `${next}px`)
      }
      const onUp = () => {
        const ctx = dragRef.current
        dragRef.current = null
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        if (!ctx) return
        const finalComputed = parseFloat(
          getComputedStyle(root).getPropertyValue(`--col-${columnKey}-width`),
        )
        if (Number.isFinite(finalComputed)) onCommit(finalComputed)
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [columnKey, fallbackWidth, tableRootRef, onCommit],
  )
  return (
    <div
      onMouseDown={onMouseDown}
      onClick={(e) => e.stopPropagation()}
      role="separator"
      aria-label={t('products.grid.resizeAria', { column: columnKey })}
      title={t('products.grid.resizeAria', { column: columnKey })}
      className="absolute top-0 right-0 h-full w-1 cursor-col-resize hover:bg-blue-400 active:bg-blue-500 transition-colors"
    />
  )
}
