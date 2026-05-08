'use client'

/**
 * P.1f — extracted from ProductsWorkspace.tsx as part of the
 * file-decomposition sweep. The biggest single piece of the
 * workspace by far, coupling-wise: TanStack-virtual table rows,
 * the per-cell switch renderer, drag-resize column handles, and the
 * right-click context menu all live together because they share the
 * memo + context boundary.
 *
 * Public surface:
 *   - VirtualizedGrid — the only export consumed externally (by
 *     GridLens in ProductsWorkspace.tsx). Accepts the products + a
 *     bag of selection / expand / sort callbacks plus `searchTerm`
 *     and `riskFlaggedSkus` for cell-level highlight + risk badges.
 *
 * File-local (not exported):
 *   - FlatRow type + flatRows construction
 *   - ColumnResizeHandle (E.12)
 *   - RowContextMenu (E.9)
 *   - ProductRow (memo'd)
 *   - ProductCell (memo'd, big switch by column key)
 *   - RiskBadge + Highlight helpers
 *   - SearchContext + RiskFlaggedContext (consumed only by
 *     ProductCell + RiskBadge, both file-local)
 *   - IT_TERMS glossary lookup used by the productType cell
 *
 * The contexts are wrapped *inside* VirtualizedGrid (not the
 * workspace) so the workspace doesn't need to know they exist. The
 * providers cover only the rendered grid — the rest of the page
 * (header, filter bar, lens tabs) doesn't pay the re-render cost
 * when the search term changes.
 */

import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import Link from 'next/link'
import {
  AlertCircle,
  ChevronRight,
  CheckCircle2,
  Copy,
  Eye,
  EyeOff,
  ExternalLink,
  Image as ImageIcon,
  Layers,
  Sparkles,
  X,
  XCircle,
} from 'lucide-react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { InlineEditTrigger } from '@/components/ui/InlineEditTrigger'
import { useToast } from '@/components/ui/Toast'
import { getBackendUrl } from '@/lib/backend-url'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'
import {
  type Density,
  DENSITY_ROW_HEIGHT,
} from '@/lib/products/theme'
import type { ProductRow as ProductRowType } from '../_types'
import type { ColumnDef } from '../_columns'

// Italian terminology lookup — falls back to English when not in the
// glossary. Mirrored from packages/database seed data for the brand
// glossary.
const IT_TERMS: Record<string, string> = {
  OUTERWEAR: 'Giacca',
  PANTS: 'Pantaloni',
  HELMET: 'Casco',
  BOOTS: 'Stivali',
  PROTECTIVE: 'Protezioni',
  GLOVES: 'Guanti',
  BAG: 'Borsa',
}

// E.14 — search-term highlighting context. VirtualizedGrid publishes
// the debounced URL search term here; cells consume it via useContext
// to wrap matches in <mark>. Context (not prop) so the search term
// doesn't have to thread through 4 levels of props + bust memo on
// every input change. Search updates are already debounced 250ms,
// so re-renders are bounded.
const SearchContext = createContext<string>('')

// R7.2 — flagged-SKU context. ProductCell reads it to render the
// "high return rate" badge on the SKU cell when the product's SKU is
// in the set. Same context-not-prop reasoning as SearchContext:
// avoids busting the cell's memo when the set is otherwise stable
// across the workspace lifetime.
const RiskFlaggedContext = createContext<Set<string>>(new Set())

type FlatRow =
  | { kind: 'parent'; product: ProductRowType }
  | { kind: 'child'; product: ProductRowType; parentId: string }
  | { kind: 'loading'; parentId: string }
  | { kind: 'empty'; parentId: string; childCount: number }

interface VirtualizedGridProps {
  products: ProductRowType[]
  visible: ColumnDef[]
  density: Density
  cellPad: string
  selected: Set<string>
  toggleSelect: (id: string, shiftKey: boolean) => void
  toggleSelectAll: () => void
  allSelected: boolean
  sortBy: string
  onSort: (key: string) => void
  expandedParents: Set<string>
  childrenByParent: Record<string, ProductRowType[]>
  loadingChildren: Set<string>
  onToggleExpand: (parentId: string) => void
  onTagEdit: (id: string) => void
  onChanged: () => void
  focusedRowId: string | null
  /** E.14 — debounced search term, for SKU + name <mark> highlighting. */
  searchTerm: string
  /** R7.2 — set of flagged SKUs (>2σ above productType return-rate mean). */
  riskFlaggedSkus: Set<string>
}

export function VirtualizedGrid({
  products,
  visible,
  density,
  cellPad,
  selected,
  toggleSelect,
  toggleSelectAll,
  allSelected,
  sortBy,
  onSort,
  expandedParents,
  childrenByParent,
  loadingChildren,
  onToggleExpand,
  onTagEdit,
  onChanged,
  focusedRowId,
  searchTerm,
  riskFlaggedSkus,
}: VirtualizedGridProps) {
  // Build the flat row list. Order: each parent followed by its
  // expanded children (or a loading/empty placeholder). Memo deps
  // cover everything that can change row identity.
  const flatRows: FlatRow[] = useMemo(() => {
    const rows: FlatRow[] = []
    for (const p of products) {
      rows.push({ kind: 'parent', product: p })
      if (!expandedParents.has(p.id)) continue
      if (loadingChildren.has(p.id)) {
        rows.push({ kind: 'loading', parentId: p.id })
        continue
      }
      const kids = childrenByParent[p.id] ?? []
      if (kids.length === 0) {
        rows.push({
          kind: 'empty',
          parentId: p.id,
          childCount: p.childCount ?? 0,
        })
        continue
      }
      for (const k of kids) {
        rows.push({ kind: 'child', product: k, parentId: p.id })
      }
    }
    return rows
  }, [products, expandedParents, childrenByParent, loadingChildren])

  // E.12 — column resize. Per-column overrides hydrated from
  // localStorage on mount, persisted on commit. The width state is
  // ONLY committed on mouseUp; the live drag updates a CSS custom
  // property directly on the table root via tableRootRef so no React
  // re-render fires per pixel of drag (the cells reference
  // `var(--col-<key>-width)` which updates live).
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(
    () => {
      if (typeof window === 'undefined') return {}
      try {
        const raw = window.localStorage.getItem('products.columnWidths')
        return raw ? JSON.parse(raw) : {}
      } catch {
        return {}
      }
    },
  )
  useEffect(() => {
    try {
      window.localStorage.setItem(
        'products.columnWidths',
        JSON.stringify(columnWidths),
      )
    } catch {
      /* ignore quota errors */
    }
  }, [columnWidths])
  // P.3 — listen for view-applied widths and replace state. Triggered
  // by SavedViewsButton's onApply when the view carries _columnWidths.
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
  // CSS variables for every visible column; cells reference these via
  // `var(--col-<key>-width)`. Set as inline style on the table root
  // so the cascade picks them up everywhere underneath.
  const tableRootRef = useRef<HTMLDivElement>(null)
  const cssVarStyle = useMemo(() => {
    const style: Record<string, string> = {}
    for (const c of visible) {
      style[`--col-${c.key}-width`] = `${colWidth(c.key, c.width)}px`
    }
    return style as React.CSSProperties
  }, [visible, colWidth])
  // Total table width = checkbox(32) + chevron(24) + sum(effective
  // widths). Used for both header + body min-width so horizontal
  // overflow works correctly inside the scroll container.
  const totalWidth = useMemo(
    () =>
      32 +
      24 +
      visible.reduce((acc, c) => acc + colWidth(c.key, c.width), 0),
    [visible, colWidth],
  )

  // E.9 — right-click context menu state. Tracks the click position
  // (so the menu pops where the cursor was) and which product was
  // right-clicked. null means closed. Document-level listeners close
  // it on outside click + Escape; the menu itself stops propagation.
  const [contextMenu, setContextMenu] = useState<
    { x: number; y: number; product: ProductRowType } | null
  >(null)
  useEffect(() => {
    if (!contextMenu) return
    const onAway = () => setContextMenu(null)
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
    (e: React.MouseEvent, product: ProductRowType) => {
      e.preventDefault()
      setContextMenu({ x: e.clientX, y: e.clientY, product })
    },
    [],
  )

  const containerRef = useRef<HTMLDivElement>(null)
  const rowVirtualizer = useVirtualizer({
    count: flatRows.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => DENSITY_ROW_HEIGHT[density],
    overscan: 12,
    // Stable keys so toggling expand doesn't re-mount unrelated rows.
    getItemKey: (index) => {
      const r = flatRows[index]
      if (!r) return index
      if (r.kind === 'parent') return `p:${r.product.id}`
      if (r.kind === 'child') return `c:${r.product.id}`
      if (r.kind === 'loading') return `l:${r.parentId}`
      return `e:${r.parentId}`
    },
  })

  // E.10 — keep the J/K-focused row in view. Find its flat-row index
  // then ask the virtualizer to scroll it within the viewport.
  // align: 'auto' avoids unnecessary scrolling when the row is
  // already visible.
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

  const sortKeys: Record<string, string> = {
    sku: 'sku',
    name: 'name',
    price: 'price-asc',
    stock: 'stock-asc',
    updated: 'updated',
  }
  const totalCols = 2 + visible.length

  return (
    <SearchContext.Provider value={searchTerm}>
      <RiskFlaggedContext.Provider value={riskFlaggedSkus}>
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
              {/* Header — sticky, flex-aligned to the same column widths
                  as the body rows. */}
              <div
                className="flex border-b border-slate-200 bg-slate-50 sticky top-0 z-10"
                role="row"
              >
                <div
                  className="px-3 py-2 flex items-center"
                  style={{ width: 32, minWidth: 32 }}
                  role="columnheader"
                >
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleSelectAll}
                  />
                </div>
                <div
                  className="px-1 py-2"
                  style={{ width: 24, minWidth: 24 }}
                  role="columnheader"
                  aria-label="Expand variants"
                />
                {visible.map((col) => {
                  const sortable =
                    col.key !== 'thumb' &&
                    col.key !== 'actions' &&
                    !!sortKeys[col.key]
                  // P.20 — aria-sort surfaces the current sort state to
                  // screen readers. We track ascending/descending only
                  // for price + stock (the other sort keys are
                  // direction-implicit per the sortKeys map). Defaults
                  // to 'none' for sortable columns the user hasn't
                  // touched, 'ascending' / 'descending' for the active
                  // one based on sortBy suffix.
                  const isActive =
                    (col.key === 'sku' && sortBy === 'sku') ||
                    (col.key === 'name' && sortBy === 'name') ||
                    (col.key === 'price' && sortBy.startsWith('price')) ||
                    (col.key === 'stock' && sortBy.startsWith('stock')) ||
                    (col.key === 'updated' && sortBy === 'updated')
                  const sortDir: 'ascending' | 'descending' | 'none' =
                    !sortable
                      ? 'none'
                      : !isActive
                        ? 'none'
                        : sortBy.endsWith('-asc')
                          ? 'ascending'
                          : 'descending'
                  return (
                    <div
                      key={col.key}
                      role="columnheader"
                      aria-sort={sortable ? sortDir : undefined}
                      // P.20 — keyboard sortability. tabIndex=0 makes
                      // the header focusable; Enter / Space trigger the
                      // sort the same way a click does.
                      tabIndex={sortable ? 0 : undefined}
                      onKeyDown={(e) => {
                        if (!sortable) return
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          onSort(sortKeys[col.key])
                        }
                      }}
                      className={`relative px-3 py-2 text-sm font-semibold uppercase tracking-wider text-slate-700 text-left flex items-center group/sort ${sortable ? 'cursor-pointer hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-300 focus:bg-slate-100' : ''}`}
                      style={{
                        width: `var(--col-${col.key}-width)`,
                        minWidth: `var(--col-${col.key}-width)`,
                      }}
                      onClick={() => {
                        if (sortable) onSort(sortKeys[col.key])
                      }}
                    >
                      <span className="inline-flex items-center gap-1">
                        {col.label}
                        {isActive ? (
                          <span
                            className="text-slate-400"
                            aria-hidden="true"
                          >
                            {sortDir === 'ascending' ? '↑' : '↓'}
                          </span>
                        ) : sortable ? (
                          // E.16 — show ↕ on hover for sortable columns
                          // that aren't currently the active sort.
                          // Telegraphs sortability without cluttering
                          // the resting state.
                          <span
                            className="text-slate-300 opacity-0 group-hover/sort:opacity-100 transition-opacity"
                            aria-hidden="true"
                          >
                            ↕
                          </span>
                        ) : null}
                      </span>
                      {/* E.12 — resize handle. Mouse-down captures
                          starting width + clientX, then mousemove
                          updates the CSS variable directly on the
                          table root (zero React re-renders during
                          drag). mouseUp commits to state +
                          localStorage. */}
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

              {/* Body — relative spacer of total height, virtualized rows
                  absolute-positioned within. */}
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
                  // E.1 — pre-compute per-row booleans so React.memo can
                  // skip re-renders for rows whose selection /
                  // expansion didn't change.
                  const productId =
                    row.kind === 'parent' || row.kind === 'child'
                      ? row.product.id
                      : null
                  const isSelected = productId
                    ? selected.has(productId)
                    : false
                  const isExpanded = productId
                    ? expandedParents.has(productId)
                    : false
                  const isFocused = productId
                    ? focusedRowId === productId
                    : false
                  const productForMenu =
                    row.kind === 'parent' || row.kind === 'child'
                      ? row.product
                      : null
                  return (
                    <div
                      key={vRow.key}
                      data-index={vRow.index}
                      ref={rowVirtualizer.measureElement}
                      role="row"
                      className="border-b border-slate-100 flex"
                      onContextMenu={
                        productForMenu
                          ? (e) => onRowContextMenu(e, productForMenu)
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
                        <ProductRow
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
                          onChanged={onChanged}
                        />
                      )}
                      {row.kind === 'child' && (
                        <ProductRow
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
                          onChanged={onChanged}
                        />
                      )}
                      {row.kind === 'loading' && (
                        <div
                          className="bg-slate-50/60 px-3 py-2 text-base text-slate-500 italic flex-1"
                          role="cell"
                          aria-colspan={totalCols}
                        >
                          Loading variants…
                        </div>
                      )}
                      {row.kind === 'empty' && (
                        <div
                          className="bg-slate-50/60 px-3 py-2 text-base text-slate-500 italic flex-1"
                          role="cell"
                          aria-colspan={totalCols}
                        >
                          No variants found
                          {row.childCount > 0
                            ? ' (fetch failed — try collapsing and re-opening)'
                            : ''}
                          .
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
          {contextMenu && (
            <RowContextMenu
              x={contextMenu.x}
              y={contextMenu.y}
              product={contextMenu.product}
              onClose={() => setContextMenu(null)}
              onChanged={onChanged}
            />
          )}
        </Card>
      </RiskFlaggedContext.Provider>
    </SearchContext.Provider>
  )
}

// E.12 — column resize handle. Sits absolute-right on each header
// cell. mouseDown captures starting clientX + starting width;
// document-level listeners track mousemove (updates the CSS variable
// directly via tableRootRef — zero React updates during drag) and
// mouseUp (commits the final width to state + localStorage via
// onCommit, then removes the listeners).
//
// Width is clamped to [60, 600]. The handle visually disappears when
// not hovered/dragged so headers stay clean; expands to a 4-px-wide
// hit zone via padding.
function ColumnResizeHandle({
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
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)
  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const root = tableRootRef.current
      if (!root) return
      // Read the current rendered width — covers both saved overrides
      // and the default (since the CSS variable is set on the root).
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
        // Direct DOM mutation — no React state update during drag.
        // Cells inherit the new width via CSS variable cascade.
        root.style.setProperty(`--col-${columnKey}-width`, `${next}px`)
      }
      const onUp = () => {
        const ctx = dragRef.current
        dragRef.current = null
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        if (!ctx) return
        // Commit the final value (read from the CSS var which is the
        // source of truth post-drag) so totalWidth updates + the new
        // width persists in localStorage.
        const finalComputed = parseFloat(
          getComputedStyle(root).getPropertyValue(
            `--col-${columnKey}-width`,
          ),
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
      aria-label={`Resize ${columnKey} column`}
      title={`Resize ${columnKey}`}
      className="absolute top-0 right-0 h-full w-1 cursor-col-resize hover:bg-blue-400 active:bg-blue-500 transition-colors"
    />
  )
}

// E.9 — right-click context menu for a product row. Pops at the
// click position; closes on outside-click, Escape, or scroll. Actions
// are scoped to a single product (the right-clicked one) — bulk
// actions stay in the bottom-rising bulk action bar. Status flips
// and duplicate hit the existing bulk-status / bulk-duplicate
// endpoints with a one-element productIds array.
function RowContextMenu({
  x,
  y,
  product,
  onClose,
  onChanged,
}: {
  x: number
  y: number
  product: ProductRowType
  onClose: () => void
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  // Clamp position to viewport so the menu doesn't render off-screen
  // when right-clicked near the right or bottom edge. 240×340 = the
  // menu's max footprint (8 items + gutters + label header).
  const W = 240
  const H = 340
  const adjX = Math.min(x, window.innerWidth - W - 8)
  const adjY = Math.min(y, window.innerHeight - H - 8)
  const flip = async (status: 'ACTIVE' | 'DRAFT' | 'INACTIVE') => {
    setBusy(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/products/bulk-status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productIds: [product.id], status }),
      })
      if (!res.ok) throw new Error((await res.json()).error)
      emitInvalidation({
        type: 'product.updated',
        meta: {
          productIds: [product.id],
          source: 'row-context-menu',
          status,
        },
      })
      onChanged()
    } finally {
      setBusy(false)
      onClose()
    }
  }
  const duplicate = async () => {
    setBusy(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/bulk-duplicate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ productIds: [product.id] }),
        },
      )
      if (!res.ok) throw new Error((await res.json()).error)
      emitInvalidation({
        type: 'product.created',
        meta: {
          sourceProductIds: [product.id],
          source: 'row-context-menu',
        },
      })
      onChanged()
    } finally {
      setBusy(false)
      onClose()
    }
  }
  const item = (
    icon: React.ReactNode,
    label: string,
    onClick: () => void,
    disabled = false,
  ) => (
    <button
      type="button"
      disabled={disabled || busy}
      onClick={(e) => {
        e.stopPropagation()
        if (disabled || busy) return
        onClick()
      }}
      className="w-full flex items-center gap-2 h-8 px-2.5 text-base text-left rounded text-slate-700 hover:bg-slate-100 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent dark:text-slate-200 dark:hover:bg-slate-800"
    >
      <span
        className="text-slate-500 dark:text-slate-400"
        aria-hidden="true"
      >
        {icon}
      </span>
      <span className="flex-1">{label}</span>
    </button>
  )
  // Stop the menu's own mousedown from triggering the outside-click
  // close handler; click-outside still works for clicks elsewhere.
  return (
    <div
      role="menu"
      aria-label={`Actions for ${product.sku}`}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      style={{ left: adjX, top: adjY }}
      className="fixed z-50 w-60 bg-white border border-slate-200 rounded-md shadow-xl p-1 dark:bg-slate-900 dark:border-slate-800 animate-fade-in"
    >
      <div className="px-2.5 py-1.5 text-xs uppercase tracking-wider text-slate-500 font-semibold border-b border-slate-100 mb-1 truncate dark:text-slate-400 dark:border-slate-800">
        {product.sku}
      </div>
      {item(<Eye size={14} />, 'Open in drawer', () => {
        window.dispatchEvent(
          new CustomEvent('nexus:open-product-drawer', {
            detail: { productId: product.id },
          }),
        )
        onClose()
      })}
      {item(<ExternalLink size={14} />, 'Open edit page', () => {
        window.location.href = `/products/${product.id}/edit`
      })}
      {item(<Sparkles size={14} />, 'Open list wizard', () => {
        window.location.href = `/products/${product.id}/list-wizard`
      })}
      <div className="my-1 border-t border-slate-100 dark:border-slate-800" />
      {product.status !== 'ACTIVE' &&
        item(<CheckCircle2 size={14} />, 'Activate', () => flip('ACTIVE'))}
      {product.status !== 'DRAFT' &&
        item(<EyeOff size={14} />, 'Set to draft', () => flip('DRAFT'))}
      {product.status !== 'INACTIVE' &&
        item(<XCircle size={14} />, 'Set to inactive', () =>
          flip('INACTIVE'),
        )}
      <div className="my-1 border-t border-slate-100 dark:border-slate-800" />
      {item(<Copy size={14} />, 'Duplicate', duplicate)}
    </div>
  )
}

/**
 * Renders one product row's cells (checkbox + chevron + visible
 * columns). Used by both parent and child rows; child rows get a
 * tinted background + tree-line glyph in the chevron column.
 *
 * E.1 — ProductRow as a memoized component. Was previously
 * `renderProductRow({...})` returning a Fragment, which meant every
 * parent re-render (including every keystroke in the search box)
 * re-ran the full row render for every visible virtualized row.
 *
 * Memoization needs *boolean* per-row props (isSelected, isExpanded)
 * rather than the parent's Sets — otherwise React.memo's shallow
 * compare sees a new Set ref on every selection change and re-renders
 * every row anyway. The caller (VirtualizedGrid) computes these
 * booleans once per visible row, so a single selection change
 * re-renders exactly two rows (old + new).
 */
const ProductRow = memo(function ProductRow({
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
  onChanged,
}: {
  product: ProductRowType
  isChild: boolean
  isSelected: boolean
  isExpanded: boolean
  isFocused: boolean
  visible: ColumnDef[]
  cellPad: string
  onToggleSelect: (id: string, shiftKey: boolean) => void
  onToggleExpand: (parentId: string) => void
  onTagEdit: (id: string) => void
  onChanged: () => void
}) {
  const childCount = product.childCount ?? 0
  const canExpand = !isChild && product.isParent && childCount > 0
  // E.10 — focus ring (ring-2 ring-blue-500) applied to every cell of
  // the J/K-focused row. inset-ring prevents the ring from offsetting
  // the row position; combined with bg, gives the Linear-style glow.
  const focusRing = isFocused ? 'ring-2 ring-inset ring-blue-500' : ''
  const rowBg = isChild
    ? isSelected
      ? `bg-blue-50/40 ${focusRing}`
      : `bg-slate-50/40 hover:bg-slate-100/60 ${focusRing}`
    : isSelected
      ? `bg-blue-50/30 ${focusRing}`
      : `hover:bg-slate-50 ${focusRing}`
  return (
    <>
      <div
        className={`px-3 py-2 flex items-center ${rowBg}`}
        style={{ width: 32, minWidth: 32 }}
        role="cell"
      >
        <input
          type="checkbox"
          checked={isSelected}
          // E.7 — onClick (not onChange) so we can capture shiftKey
          // from the mouse event for range-select. preventDefault
          // stops the native toggle; the parent's setSelected runs
          // through onToggleSelect and the next render reflects.
          // onChange is no-op'd to satisfy React's controlled-input
          // contract without firing a redundant toggle.
          onChange={() => {}}
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
        />
      </div>
      <div
        className={`px-1 py-2 flex items-center ${rowBg}`}
        style={{ width: 24, minWidth: 24 }}
        role="cell"
      >
        {canExpand ? (
          <button
            type="button"
            onClick={() => onToggleExpand(product.id)}
            aria-expanded={isExpanded}
            aria-label={
              isExpanded
                ? `Collapse variants of ${product.sku}`
                : `Expand variants of ${product.sku} (${childCount})`
            }
            title={`${childCount} variant${childCount === 1 ? '' : 's'}`}
            // E.22 — single ChevronRight that rotates 90° on expand
            // (was: swap between ChevronRight + ChevronDown). One
            // element, smooth transform, no jitter on toggle.
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
      </div>
      {visible.map((col) => (
        <div
          key={col.key}
          role="cell"
          className={`${cellPad} flex items-center ${rowBg} overflow-hidden`}
          // E.12 — CSS variables drive width so column resize updates
          // every cell live without a React re-render.
          style={{
            width: `var(--col-${col.key}-width)`,
            minWidth: `var(--col-${col.key}-width)`,
          }}
        >
          <ProductCell
            col={col.key}
            product={product}
            onTagEdit={onTagEdit}
            onChanged={onChanged}
          />
        </div>
      ))}
    </>
  )
})

// R7.2 — small inline badge surfaced on flagged SKUs. Click jumps to
// the returns analytics page where the operator sees the bucket math
// (rate vs mean, σ above) and decides whether to act on the listing
// (size chart, photos, copy).
function RiskBadge({ sku }: { sku: string }) {
  const flagged = useContext(RiskFlaggedContext)
  if (!flagged.has(sku)) return null
  return (
    <Link
      href="/fulfillment/returns/analytics"
      className="inline-flex items-center gap-0.5 text-[10px] font-semibold uppercase tracking-wider px-1 py-0.5 bg-rose-50 text-rose-700 border border-rose-200 rounded hover:bg-rose-100"
      title="High return rate (>2σ above productType mean) — click for analytics"
    >
      ↩ HI
    </Link>
  )
}

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query || !text) return <>{text}</>
  // Case-insensitive split on the query. Escape regex metachars so
  // operators searching for SKUs with `.`, `[`, `(`, etc. don't blow
  // up the regex. Matches stay in the result array as odd-indexed
  // entries when split() includes a capturing group.
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(${escaped})`, 'ig')
  const parts = text.split(re)
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark
            key={i}
            className="bg-yellow-100 text-slate-900 rounded-sm px-0.5"
          >
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  )
}

// F.5 — type-aware inline editor. Eight cells (name, status, price,
// stock, threshold, brand, productType, fulfillment) used to each
// own a ~25-line switch branch with the same editing/draft/blur/
// keyboard pattern. EDITABLE_FIELDS centralises the per-field
// metadata; <EditableCell> renders editor + display from that meta.
//
// Adding a new editable column = one entry in EDITABLE_FIELDS plus a
// case <name> in the ProductCell switch. No more copy-pasted input
// blocks per field.

interface FieldMeta {
  /** PATCH /api/products/:id field name in the request body. */
  apiField:
    | 'name'
    | 'status'
    | 'basePrice'
    | 'totalStock'
    | 'lowStockThreshold'
    | 'brand'
    | 'productType'
    | 'fulfillmentMethod'
  editor: 'text' | 'number' | 'select'
  /** Number-editor step + min. */
  step?: number
  min?: number
  /** Select-editor options (rendered as <option value="">label</option>). */
  options?: Array<{ value: string; label: string }>
  /**
   * Selects commit on change (operator picks one and the value writes
   * immediately). Text + number editors commit on blur or Enter.
   */
  commitOnChange?: boolean
  /** Tailwind classes for the <input>/<select>. Drives width + size + alignment. */
  inputClassName: string
  /** InlineEditTrigger label (read aloud by screen readers). */
  triggerLabel: string
  triggerAlign?: 'left' | 'right'
  triggerSize?: 'sm' | 'md'
  triggerHideIcon?: ((product: ProductRowType) => boolean) | boolean
  triggerWrapClass?: string
  /** Marks the cell as empty so InlineEditTrigger renders the dotted hint. */
  isEmpty?: (product: ProductRowType) => boolean
  /** Initial draft string when entering edit mode. */
  draftOf: (product: ProductRowType) => string
  /** Display rendered when not editing — receives the product + active search query. */
  display: (product: ProductRowType, searchQuery: string) => React.ReactNode
}

const EDITABLE_FIELDS: Record<string, FieldMeta> = {
  name: {
    apiField: 'name',
    editor: 'text',
    inputClassName:
      'w-full h-7 px-1.5 text-md border border-blue-300 rounded',
    triggerLabel: 'name',
    triggerAlign: 'left',
    draftOf: (p) => p.name ?? '',
    display: (p, q) => (
      <span className="text-md text-slate-900">
        <Highlight text={p.name} query={q} />
        {p.isParent && (
          <Layers size={10} className="inline ml-1 text-slate-400" />
        )}
      </span>
    ),
  },
  status: {
    apiField: 'status',
    editor: 'select',
    options: [
      { value: 'ACTIVE', label: 'ACTIVE' },
      { value: 'DRAFT', label: 'DRAFT' },
      { value: 'INACTIVE', label: 'INACTIVE' },
    ],
    commitOnChange: true,
    inputClassName: 'h-6 px-1 text-sm border border-blue-300 rounded',
    triggerLabel: 'status',
    triggerSize: 'sm',
    triggerHideIcon: true,
    triggerWrapClass: 'w-auto',
    draftOf: (p) => p.status,
    display: (p) => <StatusBadge status={p.status} size="sm" />,
  },
  price: {
    apiField: 'basePrice',
    editor: 'number',
    step: 0.01,
    inputClassName:
      'w-20 h-7 px-1.5 text-md text-right tabular-nums border border-blue-300 rounded',
    triggerLabel: 'base price',
    triggerAlign: 'right',
    draftOf: (p) => String(p.basePrice ?? ''),
    display: (p) => (
      <span className="tabular-nums">€{p.basePrice.toFixed(2)}</span>
    ),
  },
  stock: {
    apiField: 'totalStock',
    editor: 'number',
    min: 0,
    inputClassName:
      'w-16 h-7 px-1.5 text-md text-right tabular-nums border border-blue-300 rounded',
    triggerLabel: 'total stock',
    triggerAlign: 'right',
    draftOf: (p) => String(p.totalStock ?? ''),
    display: (p) => {
      const tone =
        p.totalStock === 0
          ? 'text-rose-600'
          : p.totalStock <= p.lowStockThreshold
            ? 'text-amber-600'
            : 'text-slate-900'
      return (
        <span className={`tabular-nums font-semibold ${tone}`}>
          {p.totalStock}
        </span>
      )
    },
  },
  threshold: {
    apiField: 'lowStockThreshold',
    editor: 'number',
    min: 0,
    inputClassName:
      'w-16 h-7 px-1.5 text-md text-right tabular-nums border border-blue-300 rounded',
    triggerLabel: 'low-stock threshold',
    triggerAlign: 'right',
    draftOf: (p) => String(p.lowStockThreshold ?? ''),
    display: (p) => (
      <span className="tabular-nums text-slate-500">
        {p.lowStockThreshold}
      </span>
    ),
  },
  brand: {
    // P.7 — brand is inline-editable. Free-text; datalist suggestions
    // deferred — the filter sidebar already shows the existing brand
    // list so operators have visibility when they want to stay
    // consistent.
    apiField: 'brand',
    editor: 'text',
    inputClassName:
      'w-full h-7 px-1.5 text-base border border-blue-300 rounded',
    triggerLabel: 'brand',
    triggerAlign: 'left',
    isEmpty: (p) => !p.brand,
    draftOf: (p) => p.brand ?? '',
    display: (p) => (
      <span className="text-base text-slate-700">
        {p.brand ?? 'Add brand'}
      </span>
    ),
  },
  productType: {
    // P.7 — productType is inline-editable. The displayed label uses
    // the IT_TERMS glossary lookup; the input edits the raw English/
    // canonical key so saves go to the right value regardless of the
    // displayed translation.
    apiField: 'productType',
    editor: 'text',
    inputClassName:
      'w-full h-7 px-1.5 text-sm border border-blue-300 rounded',
    triggerLabel: 'product type',
    triggerAlign: 'left',
    triggerSize: 'sm',
    isEmpty: (p) => !p.productType,
    draftOf: (p) => p.productType ?? '',
    display: (p) => (
      <span className="text-sm text-slate-700">
        {p.productType
          ? (IT_TERMS[p.productType] ?? p.productType)
          : 'Add type'}
      </span>
    ),
  },
  fulfillment: {
    apiField: 'fulfillmentMethod',
    editor: 'select',
    options: [
      { value: '', label: '—' },
      { value: 'FBA', label: 'FBA' },
      { value: 'FBM', label: 'FBM' },
    ],
    commitOnChange: true,
    inputClassName: 'h-6 px-1 text-sm border border-blue-300 rounded',
    triggerLabel: 'fulfillment method',
    triggerSize: 'sm',
    triggerHideIcon: (p) => !!p.fulfillmentMethod,
    triggerWrapClass: 'w-auto',
    isEmpty: (p) => !p.fulfillmentMethod,
    draftOf: (p) => p.fulfillmentMethod ?? '',
    display: (p) =>
      p.fulfillmentMethod ? (
        <Badge
          variant={p.fulfillmentMethod === 'FBA' ? 'warning' : 'info'}
          size="sm"
        >
          {p.fulfillmentMethod}
        </Badge>
      ) : (
        <span className="text-sm">Set FBA/FBM</span>
      ),
  },
}

/**
 * One unified inline-edit cell. Renders the editor (input or select)
 * when in edit mode, an InlineEditTrigger wrapping the display
 * otherwise. Owns its own editing/draft/cellError state so per-cell
 * edits don't leak across rows or columns.
 *
 * The PATCH itself goes through P.7's If-Match optimistic-concurrency
 * flow — version conflicts surface as an inline rose banner under the
 * cell + a refresh trigger; transport / 5xx errors surface the same
 * way without auto-refresh.
 */
function EditableCell({
  field,
  product,
  onChanged,
}: {
  field: string
  product: ProductRowType
  onChanged: () => void
}) {
  const meta = EDITABLE_FIELDS[field]
  const searchQuery = useContext(SearchContext)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<string>('')
  const [cellError, setCellError] = useState<string | null>(null)

  if (!meta) return null

  const startEdit = () => {
    setDraft(meta.draftOf(product))
    setEditing(true)
    setCellError(null)
  }

  const commit = async (rawValue?: string) => {
    const value = (rawValue ?? draft).trim()
    setEditing(false)
    // Empty values are dropped for required fields; for optional
    // (brand, productType, fulfillmentMethod, name) we send null /
    // empty string so clears go through.
    const isOptionalText =
      meta.apiField === 'brand' ||
      meta.apiField === 'productType' ||
      meta.apiField === 'fulfillmentMethod' ||
      meta.apiField === 'name'
    if (value === '' && !isOptionalText) return

    const body: Record<string, any> = {}
    if (meta.editor === 'number') {
      body[meta.apiField] = Number(value)
    } else if (
      meta.apiField === 'brand' ||
      meta.apiField === 'productType' ||
      meta.apiField === 'fulfillmentMethod'
    ) {
      // Optional string — empty becomes null so the cell can be cleared.
      body[meta.apiField] = value || null
    } else {
      body[meta.apiField] = value
    }

    try {
      // P.7 — If-Match optimistic-concurrency.
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      }
      if (typeof product.version === 'number')
        headers['If-Match'] = String(product.version)
      const res = await fetch(
        `${getBackendUrl()}/api/products/${product.id}`,
        {
          method: 'PATCH',
          headers,
          body: JSON.stringify(body),
        },
      )
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}))
        if (res.status === 409 && errJson?.code === 'VERSION_CONFLICT') {
          setCellError(
            `Another change landed first (version ${errJson.currentVersion ?? '?'}) — refreshing.`,
          )
          onChanged()
          return
        }
        throw new Error(errJson?.error ?? `Update failed (${res.status})`)
      }
      // basePrice + totalStock cascade to ChannelListing — broadcast
      // both invalidations so /listings + /bulk-operations refresh.
      const cascadesToListings =
        meta.apiField === 'basePrice' || meta.apiField === 'totalStock'
      emitInvalidation({
        type: 'product.updated',
        id: product.id,
        fields: [field],
        meta: { source: 'products-inline-edit' },
      })
      if (cascadesToListings) {
        emitInvalidation({
          type: 'listing.updated',
          meta: {
            productIds: [product.id],
            source: 'products-inline-edit',
            field,
          },
        })
      }
      setCellError(null)
      onChanged()
    } catch (e: any) {
      setCellError(e instanceof Error ? e.message : String(e))
    }
  }

  const errorBanner = cellError ? (
    <div className="mt-0.5 inline-flex items-start gap-1 px-1.5 py-0.5 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded max-w-full">
      <AlertCircle size={10} className="mt-0.5 flex-shrink-0" />
      <span className="truncate" title={cellError}>
        {cellError}
      </span>
      <button
        onClick={() => setCellError(null)}
        className="hover:bg-rose-100 rounded px-0.5"
        aria-label="Dismiss error"
      >
        <X size={10} />
      </button>
    </div>
  ) : null

  if (editing) {
    if (meta.editor === 'select') {
      return (
        <>
          <select
            autoFocus
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
              if (meta.commitOnChange) commit(e.target.value)
            }}
            onBlur={() => setEditing(false)}
            className={meta.inputClassName}
          >
            {meta.options?.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {errorBanner}
        </>
      )
    }
    return (
      <>
        <input
          autoFocus
          type={meta.editor === 'number' ? 'number' : 'text'}
          step={meta.step}
          min={meta.min}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => commit()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') setEditing(false)
          }}
          className={meta.inputClassName}
        />
        {errorBanner}
      </>
    )
  }

  const hideIcon =
    typeof meta.triggerHideIcon === 'function'
      ? meta.triggerHideIcon(product)
      : meta.triggerHideIcon
  return (
    <>
      <InlineEditTrigger
        onClick={startEdit}
        label={meta.triggerLabel}
        align={meta.triggerAlign}
        size={meta.triggerSize}
        hideIcon={hideIcon}
        empty={meta.isEmpty?.(product)}
        className={meta.triggerWrapClass}
      >
        {meta.display(product, searchQuery)}
      </InlineEditTrigger>
      {errorBanner}
    </>
  )
}

// E.1 — memo'd so a row that didn't change skips its 9-column
// re-render. onTagEdit + onChanged come from useCallback'd refs in
// the workspace, so they're stable across renders.
const ProductCell = memo(function ProductCell({
  col,
  product,
  onTagEdit,
  onChanged,
}: {
  col: string
  product: ProductRowType
  onTagEdit: (id: string) => void
  onChanged: () => void
}) {
  // F.5 — inline-edit state + the PATCH commit logic now live inside
  // <EditableCell>. ProductCell only routes the col key + product into
  // the right cell. The 8 editable columns share a single multi-case
  // dispatch; read-only cells keep their bespoke renderers.
  const searchQuery = useContext(SearchContext)
  // U.22 — inline tag-remove now surfaces failures via toast instead
  // of swallowing the error. useToast returns a stable object so the
  // hook call doesn't bust ProductCell's React.memo.
  const { toast } = useToast()
  const p = product

  switch (col) {
    case 'thumb':
      return p.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={p.imageUrl}
          alt=""
          className="w-10 h-10 rounded object-cover bg-slate-100"
        />
      ) : (
        <div className="w-10 h-10 rounded bg-slate-100 flex items-center justify-center text-slate-400">
          <ImageIcon size={14} />
        </div>
      )
    case 'sku':
      return (
        <div className="inline-flex items-center gap-1.5 min-w-0">
          <Link
            href={`/products/${p.id}/edit`}
            className="text-base font-mono text-slate-700 hover:text-blue-600 truncate"
          >
            <Highlight text={p.sku} query={searchQuery} />
          </Link>
          {/* R7.2 — high-return-rate badge. */}
          <RiskBadge sku={p.sku} />
        </div>
      )
    // F.5 — eight editable columns share one EditableCell. Per-field
    // editor type, options, and display logic live in EDITABLE_FIELDS.
    case 'name':
    case 'status':
    case 'price':
    case 'stock':
    case 'threshold':
    case 'brand':
    case 'productType':
    case 'fulfillment':
      return <EditableCell field={col} product={p} onChanged={onChanged} />
    case 'coverage': {
      // F8 — surface ALL canonical channels per row, not just the ones
      // already listed. Missing channels render as a gray "+"
      // placeholder that deep-links into the listing wizard with that
      // channel pre-selected.
      const ALL_CHANNELS = [
        'AMAZON',
        'EBAY',
        'SHOPIFY',
        'WOOCOMMERCE',
        'ETSY',
      ] as const
      const covered = p.coverage ?? {}
      const coveredCount = Object.keys(covered).length
      return (
        <div className="flex items-center gap-1 flex-wrap">
          <span
            className="text-xs text-slate-400 mr-0.5 tabular-nums"
            title={`${coveredCount} of ${ALL_CHANNELS.length} channels listed`}
          >
            {coveredCount}/{ALL_CHANNELS.length}
          </span>
          {ALL_CHANNELS.map((ch) => {
            const c = covered[ch]
            if (c) {
              const tone =
                c.error > 0
                  ? 'border-rose-300 bg-rose-50 text-rose-700'
                  : c.live > 0
                    ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                    : c.draft > 0
                      ? 'border-slate-200 bg-slate-50 text-slate-600'
                      : 'border-slate-200 bg-white text-slate-400'
              return (
                <Link
                  key={ch}
                  href={`/listings/${ch.toLowerCase()}?search=${encodeURIComponent(p.sku)}`}
                  title={`${ch}: ${c.live} live, ${c.draft} draft, ${c.error} error / ${c.total} total`}
                  className={`inline-flex items-center gap-1 px-1.5 h-5 text-xs font-mono border rounded ${tone} hover:opacity-80`}
                >
                  {ch.slice(0, 3)}
                  <span className="opacity-60">{c.total}</span>
                </Link>
              )
            }
            return (
              <Link
                key={ch}
                href={`/products/${p.id}/list-wizard?channel=${ch}`}
                title={`Not listed on ${ch} — click to start a listing`}
                className="inline-flex items-center gap-0.5 px-1.5 h-5 text-xs font-mono border border-dashed border-slate-300 bg-white text-slate-400 rounded hover:border-blue-300 hover:text-blue-600 hover:bg-blue-50"
              >
                {ch.slice(0, 3)}
                <span className="text-xs leading-none">+</span>
              </Link>
            )
          })}
        </div>
      )
    }
    case 'tags': {
      // E.17 — inline tag remove + overflow indicator.
      const tags = p.tags ?? []
      const visibleTags = tags.slice(0, 3)
      const overflow = tags.length - visibleTags.length
      const removeTag = async (tagId: string) => {
        try {
          const res = await fetch(
            `${getBackendUrl()}/api/products/bulk-tag`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                productIds: [p.id],
                tagIds: [tagId],
                mode: 'remove',
              }),
            },
          )
          if (!res.ok) {
            const j = await res.json().catch(() => ({}))
            throw new Error(j.error ?? `HTTP ${res.status}`)
          }
          emitInvalidation({
            type: 'product.updated',
            meta: { productIds: [p.id], source: 'inline-tag-remove' },
          })
          onChanged()
        } catch (e) {
          // U.22 — toast the failure so the operator gets a signal;
          // the next refetch will restore the row's tag list anyway.
          toast.error(
            `Remove tag failed: ${e instanceof Error ? e.message : String(e)}`,
          )
        }
      }
      return (
        <div className="flex items-center gap-1 flex-wrap">
          {visibleTags.map((t) => (
            <span
              key={t.id}
              className="group/tag inline-flex items-center gap-0.5 px-1.5 py-0.5 text-xs rounded"
              style={{
                background: t.color ? `${t.color}20` : '#f1f5f9',
                color: t.color ?? '#64748b',
              }}
            >
              {t.name}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  void removeTag(t.id)
                }}
                aria-label={`Remove tag ${t.name}`}
                // U.22 — was `opacity-0 group-hover/tag:opacity-100` which
                // hid the affordance entirely on touch devices (no hover).
                // Always visible on mobile/tablet (where ops happens by
                // touch); hover-reveal stays on desktop (sm: with @media
                // hover guard would be ideal but breakpoint-based is fine
                // for our usage where mobile + touch overlap heavily).
                className="opacity-60 sm:opacity-0 sm:group-hover/tag:opacity-100 inline-flex items-center justify-center w-3 h-3 rounded-full hover:bg-rose-100 hover:text-rose-700 transition-opacity"
              >
                <X size={10} />
              </button>
            </span>
          ))}
          {overflow > 0 && (
            <button
              type="button"
              onClick={() => onTagEdit(p.id)}
              title={tags
                .slice(3)
                .map((t) => t.name)
                .join(', ')}
              className="inline-flex items-center px-1.5 py-0.5 text-xs rounded bg-slate-100 text-slate-600 hover:bg-slate-200"
            >
              +{overflow} more
            </button>
          )}
          <button
            onClick={() => onTagEdit(p.id)}
            aria-label="Edit tags"
            title="Edit tags"
            // U.22 — was `h-4 w-4 min-h-11 min-w-11 sm:min-h-0 sm:min-w-0`
            // which collapsed the desktop hit zone to 4×4 (visible icon
            // mismatched click area). Desktop now uses h-5/w-5; mobile
            // expands to 44×44 via the standard pattern.
            className="min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 sm:h-5 sm:w-5 inline-flex items-center justify-center text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded text-xs"
          >
            +
          </button>
        </div>
      )
    }
    case 'photos': {
      const tone =
        p.photoCount === 0
          ? 'text-rose-600'
          : p.photoCount < 3
            ? 'text-amber-600'
            : 'text-emerald-600'
      return (
        <span className={`text-base tabular-nums font-semibold ${tone}`}>
          {p.photoCount}
        </span>
      )
    }
    case 'variants':
      return (
        <span className="text-base tabular-nums text-slate-600">
          {p.variantCount}
        </span>
      )
    case 'completeness': {
      // F.2 — completeness % from 6 dimensions.
      const checks: Array<[string, boolean]> = [
        [
          'name',
          !!(
            p.name &&
            p.name.trim().length > 0 &&
            p.name !== 'Untitled product'
          ),
        ],
        ['brand', !!p.brand],
        ['type', !!p.productType],
        ['photos', p.photoCount > 0],
        ['channels', p.channelCount > 0],
        ['tags', (p.tags?.length ?? 0) > 0],
      ]
      const passed = checks.filter(([, ok]) => ok).length
      const score = Math.round((passed / checks.length) * 100)
      const missing = checks.filter(([, ok]) => !ok).map(([k]) => k)
      const tone =
        score >= 80
          ? 'bg-emerald-500'
          : score >= 50
            ? 'bg-amber-500'
            : 'bg-rose-500'
      const textTone =
        score >= 80
          ? 'text-emerald-700'
          : score >= 50
            ? 'text-amber-700'
            : 'text-rose-700'
      return (
        <div
          className="flex items-center gap-2 w-full"
          title={
            missing.length === 0
              ? 'All quality checks pass'
              : `Missing: ${missing.join(', ')}`
          }
        >
          <span
            className={`text-sm tabular-nums font-semibold ${textTone}`}
          >
            {score}%
          </span>
          <div className="flex-1 h-1.5 bg-slate-100 rounded overflow-hidden">
            <div
              className={`h-full ${tone}`}
              style={{ width: `${score}%` }}
            />
          </div>
        </div>
      )
    }
    case 'updated':
      return (
        <span className="text-sm text-slate-500">
          {new Date(p.updatedAt).toLocaleDateString('en-GB', {
            day: 'numeric',
            month: 'short',
          })}
        </span>
      )
    case 'actions':
      return (
        <div className="flex items-center gap-1 justify-end">
          {/* F1 — "View" opens the drawer. */}
          <button
            type="button"
            onClick={() => {
              window.dispatchEvent(
                new CustomEvent('nexus:open-product-drawer', {
                  detail: { productId: p.id },
                }),
              )
            }}
            className="h-6 px-2 text-sm text-slate-600 hover:text-blue-600 hover:bg-blue-50 rounded"
            title="Quick view (Esc closes)"
          >
            View
          </button>
          <Link
            href={`/products/${p.id}/list-wizard`}
            className="h-6 px-2 text-sm text-slate-600 hover:text-emerald-600 hover:bg-emerald-50 rounded"
          >
            List
          </Link>
        </div>
      )
    default:
      return null
  }
})
