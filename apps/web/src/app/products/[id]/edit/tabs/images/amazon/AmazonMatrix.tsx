'use client'

// IM.4 — Amazon Color × Slot matrix.
// Each row = one color group (or "All Colors"). Each column = one Amazon slot.
// Cells are drop targets accepting drags from MasterPanel or desktop files.
// Column headers are also drop targets for column-fill operations.

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Link2, MoreHorizontal, Plus, Lock } from 'lucide-react'
import { classifyBulk } from './bulkSelection'
import { PLATFORM_RULES } from '@nexus/shared/image-validation'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import type { AmazonSlot, AmazonMarketplace, CellDisplay, VariantGroup } from './useAmazonImages'
import { ALL_SLOTS, SLOT_LABELS } from './useAmazonImages'

const AMAZON_MIN_DIM = PLATFORM_RULES.AMAZON.minDimensionPx

interface MatrixProps {
  variantGroups: VariantGroup[]
  activeMarketplace: AmazonMarketplace
  activeAxis: string
  resolveCell: (groupValue: string | null, slot: AmazonSlot) => CellDisplay | null
  onCellClick: (groupValue: string | null, slot: AmazonSlot) => void
  onCellLightbox?: (groupValue: string | null, slot: AmazonSlot, cell: CellDisplay) => void
  onCellDrop: (groupValue: string | null, slot: AmazonSlot, url: string, sourceId?: string) => void
  onColumnHeaderDrop: (slot: AmazonSlot, url: string, sourceId?: string) => void
  onPublishRow: (groupValue: string) => void
  onCopyRow: (groupValue: string, toMarketplace: string) => void
  /** CM.6 — copy the SELECTED cells (individual images) to the same cell in other markets. */
  onCopyCellsToMarkets?: (cells: Array<{ group: string | null; slot: AmazonSlot }>) => void
  /** BE — bulk-edit mode: show checkboxes + the bulk action bar. */
  bulkMode?: boolean
  /** BE — stage deletion of these listing-image rows. */
  onBulkDelete?: (cells: Array<{ group: string | null; slot: AmazonSlot }>) => void
  /** BE — lock / unlock these listing-image rows on the server. */
  onBulkLock?: (listingImageIds: string[], locked: boolean) => void
  /** BE.5 — promote a single selected image to the MAIN slot. */
  onBulkSetMain?: (cell: { group: string | null; slot: string }) => void
  /** BE.5 — clear market overrides (delete rows → fall back to the shared image). */
  onBulkClearOverride?: (listingImageIds: string[]) => void
  /** BE.6 — fill empty slots from the master gallery. */
  onBulkFill?: () => void
  /** BE — bulk upload: pair picked files with the selected cells (fill / replace). */
  onBulkUpload?: (files: File[], cells: Array<{ group: string | null; slot: AmazonSlot }>) => void
  /** MM.5 — visible slot-columns in display order; defaults to all. */
  visibleSlots?: AmazonSlot[]
  onClearRow: (groupValue: string) => void
  onCellFileDrop: (groupValue: string | null, slot: AmazonSlot, file: File) => void
  /** IE.11 — Active status filter from the MatrixFilterBar. Defaults
   *  to 'all' so existing call sites that don't pass it still type-
   *  check while the filter substrate is being wired up. */
  cellStatusFilter?: 'all' | 'empty' | 'inherited' | 'override' | 'flagged'
  /** IE.17 — Revert a single override cell back to its inherited /
   *  master-fallback state. Hover affordance on cells with
   *  origin='own'; the cascade re-renders to the parent scope. */
  onCellRevert?: (groupValue: string | null, slot: AmazonSlot) => void
  /** IA.9 — Move an image between matrix cells via drag. Source cell
   *  contributes its url + origin + listingImageId so the handler can
   *  pick move (delete source) vs copy (leave source inherited). */
  onCellMove?: (
    from: { groupValue: string | null; slot: AmazonSlot; url: string; origin: 'own' | 'inherited'; listingImageId?: string },
    to: { groupValue: string | null; slot: AmazonSlot },
  ) => void
  /** IA.17 — Multi-image drop from a master-gallery multi-drag. Fans
   *  the items across the target slot + next free slots in slot
   *  order (MAIN, PT01..PT08, SWCH). AmazonPanel implements the
   *  fan-out. */
  onCellMultiDrop?: (
    groupValue: string | null,
    startSlot: AmazonSlot,
    items: Array<{ url: string; id?: string }>,
  ) => void
}

// ── Slot cell ──────────────────────────────────────────────────────────

interface SlotCellProps {
  cell: CellDisplay | null
  slot: AmazonSlot
  rowLabel: string
  isFocused: boolean
  cellRef: (el: HTMLDivElement | null) => void
  onDrop: (url: string, sourceId?: string) => void
  /** Picker (assign/replace) — fires for empty cells and the hover "Change" overlay on filled cells. */
  onClick: () => void
  /** Lightbox preview — fires for plain click on a filled cell. */
  onLightbox?: () => void
  onKeyDown: (e: React.KeyboardEvent) => void
  onFocus: () => void
  onFileDrop?: (file: File) => void
  /** IE.17 — Revert this cell to its inherited / master-fallback state. */
  onRevert?: () => void
  /** IA.9 — Receive an internal cell-to-cell move payload. */
  onCellMoveDrop?: (payload: {
    groupValue: string | null
    slot: AmazonSlot
    url: string
    origin: 'own' | 'inherited'
    listingImageId?: string
  }) => void
  /** IA.9 — Identifier the cell stamps onto its dataTransfer payload
   *  so the drop target knows which cell it's coming from. */
  selfGroupValue: string | null
  /** IA.17 — Multi-payload drop. The cell forwards the parsed list
   *  up to AmazonMatrix which fans across slots. */
  onMultiDrop?: (items: Array<{ url: string; id?: string }>) => void
}

function SlotCell({
  cell,
  slot,
  rowLabel,
  isFocused,
  cellRef,
  onDrop,
  onClick,
  onLightbox,
  onKeyDown,
  onFocus,
  onFileDrop,
  onRevert,
  onCellMoveDrop,
  selfGroupValue,
  onMultiDrop,
}: SlotCellProps) {
  const [isOver, setIsOver] = useState(false)
  const isMain = slot === 'MAIN'

  function handleDragOver(e: React.DragEvent) {
    if (
      e.dataTransfer.types.includes('application/nexus-image-set') ||
      e.dataTransfer.types.includes('application/nexus-matrix-cell') ||
      e.dataTransfer.types.includes('application/nexus-image-url') ||
      e.dataTransfer.types.includes('Files')
    ) {
      e.preventDefault()
      setIsOver(true)
    }
  }

  function handleDragLeave() { setIsOver(false) }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    setIsOver(false)
    // IA.17 — Multi-image set from a master-gallery multi-drag.
    // Check before the single-image keys; if the set is present and
    // has 2+ items, fan into slots starting at this cell.
    const setPayload = e.dataTransfer.getData('application/nexus-image-set')
    if (setPayload && onMultiDrop) {
      try {
        const items = JSON.parse(setPayload) as Array<{ url: string; id?: string }>
        if (Array.isArray(items) && items.length > 1) {
          onMultiDrop(items)
          return
        }
      } catch { /* fall through */ }
    }
    // IA.9 — Internal cell-to-cell drop. Check this first so the
    // outer onDrop (which assumes an external source) doesn't fire
    // when the drag came from another matrix cell.
    const matrixPayload = e.dataTransfer.getData('application/nexus-matrix-cell')
    if (matrixPayload && onCellMoveDrop) {
      try {
        const parsed = JSON.parse(matrixPayload) as {
          groupValue: string | null
          slot: AmazonSlot
          url: string
          origin: 'own' | 'inherited'
          listingImageId?: string
        }
        // Drop on the same cell = no-op.
        if (parsed.groupValue === selfGroupValue && parsed.slot === slot) return
        onCellMoveDrop(parsed)
        return
      } catch { /* malformed payload — fall through to URL/file handling */ }
    }
    const url = e.dataTransfer.getData('application/nexus-image-url')
    const sourceId = e.dataTransfer.getData('application/nexus-image-id') || undefined
    if (url) { onDrop(url, sourceId); return }
    const files = Array.from(e.dataTransfer.files)
    if (files.length && onFileDrop) { onFileDrop(files[0]); return }
  }

  // IA.9 — Filled cells become drag sources. Carries the cell's
  // coords + origin in a custom dataTransfer key so the drop target
  // knows it's an internal move (and what to do with the source).
  function handleDragStart(e: React.DragEvent) {
    if (!cell) return
    const payload = JSON.stringify({
      groupValue: selfGroupValue,
      slot,
      url: cell.url,
      origin: cell.origin,
      listingImageId: cell.listingImageId,
    })
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('application/nexus-matrix-cell', payload)
    // IA.16 — Custom drag preview using the cell's own <img> at its
    // current rendered size. Browser default snapshots the entire
    // cell wrapper (badges, drag handles) which is noisy.
    const imgEl = e.currentTarget.querySelector('img') as HTMLImageElement | null
    if (imgEl) {
      e.dataTransfer.setDragImage(imgEl, imgEl.width / 2, imgEl.height / 2)
    }
  }

  const ariaLabel = `${rowLabel}, ${SLOT_LABELS[slot]}: ${
    cell
      ? cell.fromMaster
        ? 'inherited from master gallery'
        : cell.origin === 'inherited' ? 'inherited image' : 'image set'
      : 'empty, click or drop to assign'
  }`

  function handleKey(e: React.KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      // Filled cell + lightbox wired → preview; empty or no lightbox → picker.
      if (cell && onLightbox) onLightbox()
      else onClick()
      return
    }
    onKeyDown(e)
  }

  return (
    <div
      ref={cellRef}
      role="gridcell"
      aria-label={ariaLabel}
      tabIndex={isFocused ? 0 : -1}
      onKeyDown={handleKey}
      onFocus={onFocus}
      className={cn(
        'relative w-[72px] h-[72px] rounded-lg border-2 transition-all flex-shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
        // IA.16 — animated pulse ring on drop hover so the operator sees
        // exactly which cell will catch the drop. transition-all already
        // smooths the colour change; the ring + scale make the target
        // unambiguous in a dense matrix.
        isOver
          ? 'border-blue-400 bg-blue-50 dark:bg-blue-950/30 ring-2 ring-blue-300 dark:ring-blue-600 ring-offset-1 scale-[1.04] animate-pulse'
          : 'border-transparent',
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {cell ? (
        <div
          draggable={!!onCellMoveDrop /* gate on the move handler being wired */}
          onDragStart={handleDragStart}
          className={cn(
          'w-full h-full rounded-lg overflow-hidden relative group cursor-pointer',
          // IE.3 — master-fallback cells get a dashed border so the
          // operator sees at a glance "this is just the master gallery
          // showing through; drop a variant image to override."
          cell.fromMaster
            ? 'border-2 border-dashed border-slate-300 dark:border-slate-600 opacity-75'
            : cell.origin === 'inherited'
              ? 'border opacity-60 border-slate-200 dark:border-slate-700'
              : 'border border-slate-300 dark:border-slate-600',
          cell.isPending && 'ring-2 ring-amber-400 ring-offset-1',
          // IR.2.6 / IR.5.2 — red outline when image is below the
          // shared per-channel min (PLATFORM_RULES.AMAZON.minDimensionPx).
          cell.width != null && cell.width < AMAZON_MIN_DIM && 'outline outline-2 outline-red-500/70',
        )}
          title={cell.width != null && cell.width < AMAZON_MIN_DIM
            ? `${cell.width}×${cell.height ?? '?'} — below Amazon ${AMAZON_MIN_DIM} px minimum`
            : undefined}
          onClick={() => (onLightbox ?? onClick)()}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={cell.url} alt="" draggable={false} className="w-full h-full object-contain bg-white" loading="lazy" decoding="async" />

          {/* Slot label */}
          <div className="absolute top-0.5 right-0.5 text-[8px] font-mono bg-black/50 text-white rounded px-0.5 leading-tight">
            {slot}
          </div>

          {/* Inherited badge — chain-link for master-fallback,
              ∀ glyph for All-Markets / All-Colors inheritance. */}
          {cell.origin === 'inherited' && (
            cell.fromMaster ? (
              <div
                className="absolute bottom-0.5 right-0.5 bg-slate-700/70 text-white rounded p-0.5 leading-none"
                title="Inherited from master gallery — drop an image to override"
              >
                <Link2 className="w-2.5 h-2.5" />
              </div>
            ) : (
              <div
                className="absolute bottom-0.5 right-0.5 text-[8px] bg-slate-700/60 text-white rounded px-0.5 leading-tight"
                title="Inherited from All Markets"
              >
                ∀
              </div>
            )
          )}

          {/* Pending dot */}
          {cell.isPending && (
            <div className="absolute top-0.5 left-0.5 w-2 h-2 rounded-full bg-amber-400 border border-white" title="Unsaved change" />
          )}

          {/* MAIN: white bg check */}
          {isMain && (
            <div className={cn(
              'absolute bottom-0.5 left-0.5 text-[9px] font-mono leading-tight',
              cell.hasWhiteBackground === true ? 'text-emerald-400' : 'text-red-400',
            )} title={cell.hasWhiteBackground ? 'White background ✓' : 'White background required'}>
              ⚪
            </div>
          )}

          {/* Publish status */}
          {cell.publishStatus === 'PUBLISHED' && (
            <div className="absolute top-0.5 left-0.5 w-1.5 h-1.5 rounded-full bg-emerald-400" title="Published" />
          )}
          {cell.publishStatus === 'ERROR' && (
            <div className="absolute top-0.5 left-0.5 w-1.5 h-1.5 rounded-full bg-red-400" title={cell.publishError ?? 'Error'} />
          )}

          {/* Hover overlay — explicit picker trigger so plain click can open lightbox */}
          <button
            type="button"
            tabIndex={-1}
            onClick={(e) => { e.stopPropagation(); onClick() }}
            aria-label="Replace image"
            className="absolute inset-x-0 bottom-0 h-6 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-white text-[10px] font-medium pointer-events-none group-hover:pointer-events-auto"
          >
            Change
          </button>

          {/* IE.17 — Revert affordance. Only for explicit overrides
              at this exact scope (origin='own'). Inherited cells +
              master fallbacks already show their parent — nothing
              to revert from. */}
          {cell.origin === 'own' && onRevert && (
            <button
              type="button"
              tabIndex={-1}
              onClick={(e) => { e.stopPropagation(); onRevert() }}
              aria-label="Revert override"
              title="Revert to inherited / master image"
              className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-slate-800/80 text-white opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center hover:bg-slate-900 leading-none text-[10px]"
            >
              ↺
            </button>
          )}
        </div>
      ) : (
        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          className="w-full h-full border-2 border-dashed border-slate-200 dark:border-slate-700 rounded-lg flex items-center justify-center text-slate-300 dark:text-slate-600 hover:border-blue-400 dark:hover:border-blue-500 hover:text-blue-400 transition-all"
          onClick={onClick}
        >
          <Plus className="w-4 h-4" />
        </button>
      )}
    </div>
  )
}

// ── Column header (also a drop target) ────────────────────────────────

function ColumnHeader({
  slot,
  onHeaderDrop,
}: {
  slot: AmazonSlot
  onHeaderDrop: (slot: AmazonSlot, url: string, sourceId?: string) => void
}) {
  const [isOver, setIsOver] = useState(false)

  function handleDragOver(e: React.DragEvent) {
    if (e.dataTransfer.types.includes('application/nexus-image-url')) {
      e.preventDefault()
      setIsOver(true)
    }
  }

  return (
    <div
      className={cn(
        'w-[72px] flex-shrink-0 text-center py-1.5 px-1 rounded-lg transition-colors',
        isOver ? 'bg-blue-100 dark:bg-blue-900/30' : '',
        slot === 'MAIN' ? 'text-blue-600 dark:text-blue-400 font-semibold' : 'text-slate-500 dark:text-slate-400',
      )}
      title={`${SLOT_LABELS[slot]} — drag image here to fill entire column`}
      onDragOver={handleDragOver}
      onDragLeave={() => setIsOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setIsOver(false)
        const url = e.dataTransfer.getData('application/nexus-image-url')
        const sourceId = e.dataTransfer.getData('application/nexus-image-id') || undefined
        if (url) onHeaderDrop(slot, url, sourceId)
      }}
    >
      <div className="text-[11px] font-mono leading-none">{slot}</div>
      {slot === 'SWCH' && <div className="text-[9px] text-slate-400 mt-0.5">Swatch</div>}
    </div>
  )
}

// ── Row actions menu ──────────────────────────────────────────────────

function RowMenu({
  displayAsin,
  displaySku,
  onPublish,
  onCopyToDE,
  onCopyToIT,
  onClear,
}: {
  groupValue: string
  displayAsin: string | null
  displaySku: string
  onPublish: () => void
  onCopyToDE: () => void
  onCopyToIT: () => void
  onClear: () => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative flex-shrink-0">
      <button
        type="button"
        onClick={() => setOpen((p) => !p)}
        className="p-1 rounded text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
      >
        <MoreHorizontal className="w-4 h-4" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-7 z-30 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl py-1 min-w-[180px] text-sm">
            {displayAsin && (
              <button className="w-full text-left px-3 py-1.5 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700" onClick={() => { setOpen(false); onPublish() }}>
                Publish by ASIN ({displayAsin.slice(0, 8)}…)
              </button>
            )}
            <button className="w-full text-left px-3 py-1.5 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700" onClick={() => { setOpen(false); onPublish() }}>
              Publish by SKU ({displaySku})
            </button>
            <div className="h-px bg-slate-100 dark:bg-slate-700 my-1" />
            <button className="w-full text-left px-3 py-1.5 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700" onClick={() => { setOpen(false); onCopyToIT() }}>
              Copy → Amazon IT
            </button>
            <button className="w-full text-left px-3 py-1.5 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700" onClick={() => { setOpen(false); onCopyToDE() }}>
              Copy → Amazon DE
            </button>
            <div className="h-px bg-slate-100 dark:bg-slate-700 my-1" />
            <button className="w-full text-left px-3 py-1.5 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/20" onClick={() => { setOpen(false); onClear() }}>
              Clear all slots
            </button>
          </div>
        </>
      )}
    </div>
  )
}

// ── Matrix ──────────────────────────────────────────────────────────────

export default function AmazonMatrix({
  variantGroups,
  activeMarketplace,
  activeAxis,
  resolveCell,
  onCellClick,
  onCellLightbox,
  onCellDrop,
  onColumnHeaderDrop,
  onPublishRow,
  onCopyRow,
  onCopyCellsToMarkets,
  bulkMode,
  onBulkDelete,
  onBulkLock,
  onBulkSetMain,
  onBulkClearOverride,
  onBulkFill,
  onBulkUpload,
  visibleSlots,
  onClearRow,
  onCellFileDrop,
  onCellRevert,
  onCellMove,
  onCellMultiDrop,
  cellStatusFilter = 'all',
}: MatrixProps) {
  // IE.11 — Match a cell against the active status filter. Empty
  // cell = `cell === null`. Inherited = master fallback (`fromMaster`)
  // OR scope inheritance (`origin === 'inherited'`). Override =
  // explicit row at this scope (`origin === 'own'`). Mismatched
  // cells get a low-opacity wrapper so the grid structure stays
  // intact while the operator's eye is drawn to matches.
  function cellMatchesStatus(cell: CellDisplay | null): boolean {
    if (cellStatusFilter === 'all') return true
    if (cellStatusFilter === 'empty') return cell === null
    if (cellStatusFilter === 'inherited') return cell !== null && (!!cell.fromMaster || cell.origin === 'inherited')
    if (cellStatusFilter === 'override') return cell !== null && cell.origin === 'own'
    return true
  }
  // Track column fill confirmation popover
  const [pendingColumnFill, setPendingColumnFill] = useState<{
    slot: AmazonSlot; url: string; sourceId?: string
  } | null>(null)

  // Roving tabindex for keyboard navigation across cells.
  const [focusedCell, setFocusedCell] = useState<{ row: number; col: number }>({ row: 0, col: 0 })
  const cellRefs = useRef<Map<string, HTMLDivElement | null>>(new Map())

  function handleColumnHeaderDrop(slot: AmazonSlot, url: string, sourceId?: string) {
    setPendingColumnFill({ slot, url, sourceId })
  }

  function confirmColumnFill() {
    if (!pendingColumnFill) return
    onColumnHeaderDrop(pendingColumnFill.slot, pendingColumnFill.url, pendingColumnFill.sourceId)
    setPendingColumnFill(null)
  }

  const [selectedCells, setSelectedCells] = useState<Map<string, { group: string | null; slot: AmazonSlot }>>(new Map())
  const bulkUploadRef = useRef<HTMLInputElement>(null)
  const cellKey = (group: string | null, slot: string) => `${group ?? '__ALL__'}::${slot}`
  const toggleCellSelect = useCallback((group: string | null, slot: AmazonSlot) => {
    setSelectedCells((prev) => {
      const n = new Map(prev)
      const k = `${group ?? '__ALL__'}::${slot}`
      if (n.has(k)) n.delete(k)
      else n.set(k, { group, slot })
      return n
    })
  }, [])
  const toggleCells = useCallback((cells: Array<{ group: string | null; slot: string }>, select: boolean) => {
    setSelectedCells((prev) => {
      const n = new Map(prev)
      for (const c of cells) {
        const k = `${c.group ?? '__ALL__'}::${c.slot}`
        if (select) n.set(k, { group: c.group, slot: c.slot as AmazonSlot })
        else n.delete(k)
      }
      return n
    })
  }, [])

  const rows: Array<{ groupValue: string | null; label: string; sublabel: string; asin: string | null; sku: string }> = [
    ...variantGroups.map((g) => ({
      groupValue: g.groupValue,
      label: g.groupValue,
      sublabel: `${g.variants.length} variant${g.variants.length !== 1 ? 's' : ''}`,
      asin: g.displayAsin,
      sku: g.displaySku,
    })),
    { groupValue: null, label: 'All Colors', sublabel: 'Shared / platform-wide', asin: null, sku: '' },
  ]

  const rowCount = rows.length
  // MM.5 — render only the operator's chosen slot-columns, in their order.
  const slots: AmazonSlot[] = visibleSlots && visibleSlots.length > 0 ? visibleSlots : [...ALL_SLOTS]
  const colCount = slots.length

  // BE — resolve the current selection into a bulk-action breakdown.
  const resolvedSel = [...selectedCells.values()].map((c) => {
    const cd = resolveCell(c.group, c.slot)
    return { group: c.group, slot: c.slot, url: cd?.url, listingImageId: cd?.listingImageId, locked: cd?.locked, origin: cd?.origin }
  })
  const bulk = classifyBulk(resolvedSel, activeMarketplace === 'ALL')
  const allGridCells = rows.flatMap((r) => slots.map((slot) => ({ group: r.groupValue, slot })))
  const allGridChecked = allGridCells.length > 0 && allGridCells.every((c) => selectedCells.has(cellKey(c.group, c.slot)))

  // Clamp the focused cell when the row/col count changes (variant axis swap).
  useEffect(() => {
    setFocusedCell((prev) => ({
      row: Math.min(prev.row, Math.max(0, rowCount - 1)),
      col: Math.min(prev.col, Math.max(0, colCount - 1)),
    }))
  }, [rowCount, colCount])

  const handleCellKeyDown = useCallback((row: number, col: number) => (e: React.KeyboardEvent) => {
    let nextRow = row
    let nextCol = col
    switch (e.key) {
      case 'ArrowLeft':  nextCol = Math.max(0, col - 1); break
      case 'ArrowRight': nextCol = Math.min(colCount - 1, col + 1); break
      case 'ArrowUp':    nextRow = Math.max(0, row - 1); break
      case 'ArrowDown':  nextRow = Math.min(rowCount - 1, row + 1); break
      case 'Home':       nextCol = 0; break
      case 'End':        nextCol = colCount - 1; break
      default: return
    }
    if (nextRow === row && nextCol === col) return
    e.preventDefault()
    setFocusedCell({ row: nextRow, col: nextCol })
    const next = cellRefs.current.get(`${nextRow}-${nextCol}`)
    next?.focus()
  }, [rowCount, colCount])

  return (
    <div>
      {/* Column fill confirmation popover */}
      {pendingColumnFill && (
        <div className="mb-3 p-3 bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-xl flex items-center gap-3 text-sm">
          <div className="flex-1 text-blue-800 dark:text-blue-200">
            Fill <span className="font-mono font-semibold">{pendingColumnFill.slot}</span> column with this image?
          </div>
          <Button size="sm" onClick={confirmColumnFill}>
            Empty slots only
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setPendingColumnFill(null)} className="text-slate-500">
            Cancel
          </Button>
        </div>
      )}

      {/* BE — bulk action bar (persistent while in select mode) */}
      {bulkMode && (
        <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-xl border border-orange-200 dark:border-orange-900/50 bg-orange-50/70 dark:bg-orange-950/20 px-3 py-2 text-sm">
          <span className="font-medium text-slate-700 dark:text-slate-200">
            {bulk.imageCount > 0 ? `${bulk.imageCount} image${bulk.imageCount === 1 ? '' : 's'} selected` : 'Select images'}
          </span>
          {bulk.lockedIds.length > 0 && <span className="text-xs text-amber-600 dark:text-amber-400">· {bulk.lockedIds.length} locked</span>}
          {bulk.empty.length > 0 && <span className="text-xs text-slate-400">· {bulk.empty.length} empty</span>}
          {/* quick selects */}
          <span className="text-slate-300 dark:text-slate-600">|</span>
          <button type="button" onClick={() => toggleCells(allGridCells.filter((c) => !resolveCell(c.group, c.slot as AmazonSlot)?.url), true)} className="text-xs text-slate-500 dark:text-slate-400 underline-offset-2 hover:underline">empties</button>
          <button type="button" onClick={() => toggleCells(allGridCells, true)} className="text-xs text-slate-500 dark:text-slate-400 underline-offset-2 hover:underline">all</button>
          <div className="flex-1" />
          {onCopyCellsToMarkets && bulk.filled.length > 0 && (
            <Button size="sm" variant="secondary" onClick={() => { onCopyCellsToMarkets(bulk.filled.map((c) => ({ group: c.group, slot: c.slot as AmazonSlot }))); setSelectedCells(new Map()) }}>
              Copy → markets
            </Button>
          )}
          {onBulkSetMain && bulk.filled.length === 1 && bulk.filled[0]!.slot !== 'MAIN' && (
            <Button size="sm" variant="ghost" onClick={() => { onBulkSetMain({ group: bulk.filled[0]!.group, slot: bulk.filled[0]!.slot }); setSelectedCells(new Map()) }}>
              Set as MAIN
            </Button>
          )}
          {onBulkFill && bulk.empty.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => { onBulkFill(); setSelectedCells(new Map()) }}>
              Fill from gallery
            </Button>
          )}
          {onBulkUpload && selectedCells.size > 0 && (
            <Button size="sm" variant="ghost" onClick={() => bulkUploadRef.current?.click()}>
              Upload to selected
            </Button>
          )}
          {onBulkLock && bulk.lockableIds.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => { onBulkLock(bulk.lockableIds, true); setSelectedCells(new Map()) }}>
              Lock
            </Button>
          )}
          {onBulkLock && bulk.lockedIds.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => { onBulkLock(bulk.lockedIds, false); setSelectedCells(new Map()) }}>
              Unlock
            </Button>
          )}
          {onBulkClearOverride && bulk.overrideIds.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                if (!window.confirm(`Reset ${bulk.overrideIds.length} image${bulk.overrideIds.length === 1 ? '' : 's'} to the All-Markets image?\nStaged — Save, then Publish.`)) return
                onBulkClearOverride(bulk.overrideIds)
                setSelectedCells(new Map())
              }}
            >
              Reset to shared
            </Button>
          )}
          {onBulkDelete && bulk.filled.some((c) => !c.locked) && (
            <Button
              size="sm"
              variant="danger"
              onClick={() => {
                const cells = bulk.filled.filter((c) => !c.locked).map((c) => ({ group: c.group, slot: c.slot as AmazonSlot }))
                const warn =
                  `Delete ${cells.length} image${cells.length === 1 ? '' : 's'}? ` +
                  `The slot${cells.length === 1 ? '' : 's'} will be emptied here and removed from Amazon on Publish.` +
                  (bulk.lockedIds.length ? `\n${bulk.lockedIds.length} locked image(s) skipped.` : '') +
                  `\nStaged — Save, then Publish.`
                if (!window.confirm(warn)) return
                onBulkDelete(cells)
                setSelectedCells(new Map())
              }}
            >
              Delete ({bulk.filled.filter((c) => !c.locked).length})
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setSelectedCells(new Map())} className="text-slate-500">Clear</Button>
          <input
            ref={bulkUploadRef}
            type="file"
            accept="image/*"
            multiple
            className="sr-only"
            onChange={(e) => {
              const files = e.target.files ? [...e.target.files] : []
              const cells = [...selectedCells.values()].map((c) => ({ group: c.group, slot: c.slot }))
              if (files.length && cells.length) onBulkUpload?.(files, cells)
              setSelectedCells(new Map())
              if (bulkUploadRef.current) bulkUploadRef.current.value = ''
            }}
          />
        </div>
      )}

      {/* Scrollable matrix */}
      <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-700">
        <div
          role="grid"
          aria-label={`Amazon image matrix grouped by ${activeAxis}${activeMarketplace !== 'ALL' ? `, ${activeMarketplace} marketplace` : ''}`}
          aria-rowcount={rowCount + 1}
          aria-colcount={colCount + 2}
          className="min-w-max"
        >
          {/* Header row */}
          <div
            role="row"
            aria-rowindex={1}
            className="flex items-center gap-2 px-4 py-2 bg-slate-50 dark:bg-slate-800/95 border-b border-slate-200 dark:border-slate-700 sticky top-0 z-10"
          >
            {/* Row label column header — sticky-left so it stays visible while scrolling slots */}
            <div
              role="columnheader"
              aria-colindex={1}
              className="w-44 flex-shrink-0 text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide sticky left-0 z-20 bg-slate-50 dark:bg-slate-800 shadow-[2px_0_4px_rgba(0,0,0,0.04)] dark:shadow-[2px_0_4px_rgba(0,0,0,0.3)]"
            >
              {bulkMode && (
                <input
                  type="checkbox"
                  checked={allGridChecked}
                  onChange={(e) => toggleCells(allGridCells, e.target.checked)}
                  title="Select all"
                  className="mr-1.5 cursor-pointer accent-orange-600 align-middle"
                />
              )}
              {activeAxis}{activeMarketplace !== 'ALL' ? ` / ${activeMarketplace}` : ''}
            </div>
            {/* Slot column headers — each is a drag target */}
            {slots.map((slot, i) => (
              <div key={slot} role="columnheader" aria-colindex={i + 2} className="flex flex-col items-center">
                {bulkMode && (
                  <input
                    type="checkbox"
                    checked={rows.every((r) => selectedCells.has(cellKey(r.groupValue, slot)))}
                    onChange={(e) => toggleCells(rows.map((r) => ({ group: r.groupValue, slot })), e.target.checked)}
                    title="Select whole column"
                    className="mb-0.5 cursor-pointer accent-orange-600"
                  />
                )}
                <ColumnHeader
                  slot={slot}
                  onHeaderDrop={handleColumnHeaderDrop}
                />
              </div>
            ))}
            {/* Actions column header */}
            <div role="columnheader" aria-colindex={colCount + 2} aria-label="Row actions" className="w-8 flex-shrink-0" />
          </div>

          {/* Data rows */}
          {rows.map(({ groupValue, label, sublabel, asin, sku }, rowIdx) => {
            const isAllColors = groupValue === null
            const rowLabel = isAllColors ? 'All Colors' : label
            return (
              <div
                key={groupValue ?? '__all_colors__'}
                role="row"
                aria-rowindex={rowIdx + 2}
                className={cn(
                  'flex items-center gap-2 px-4 py-2 border-b border-slate-100 dark:border-slate-800 last:border-0',
                  isAllColors ? 'bg-slate-50/50 dark:bg-slate-800/20' : 'bg-white dark:bg-slate-900',
                )}
              >
                {/* Row label (rowheader) — sticky-left, opaque bg to cover scrolling slots beneath */}
                <div
                  role="rowheader"
                  aria-colindex={1}
                  className={cn(
                    'w-44 flex-shrink-0 min-w-0 sticky left-0 z-10 shadow-[2px_0_4px_rgba(0,0,0,0.04)] dark:shadow-[2px_0_4px_rgba(0,0,0,0.3)]',
                    isAllColors
                      ? 'bg-slate-50 dark:bg-slate-800'
                      : 'bg-white dark:bg-slate-900',
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    {bulkMode && (
                      <input
                        type="checkbox"
                        checked={slots.every((s) => selectedCells.has(cellKey(groupValue, s)))}
                        onChange={(e) => toggleCells(slots.map((s) => ({ group: groupValue, slot: s })), e.target.checked)}
                        title="Select whole row"
                        className="cursor-pointer accent-orange-600 flex-shrink-0"
                      />
                    )}
                    {isAllColors ? (
                      <span className="text-xs font-medium text-slate-500 dark:text-slate-400 italic">All Colors</span>
                    ) : (
                      <span className="text-sm font-medium text-slate-800 dark:text-slate-200 truncate">{label}</span>
                    )}
                  </div>
                  <div className="text-[11px] font-mono text-slate-400 dark:text-slate-500 truncate mt-0.5">
                    {isAllColors ? 'Shared slots' : sublabel}
                  </div>
                  {/* MAIN validation */}
                  {!isAllColors && !resolveCell(groupValue, 'MAIN') && (
                    <div className="flex items-center gap-1 mt-1">
                      <AlertTriangle className="w-3 h-3 text-red-400" />
                      <span className="text-[10px] text-red-500">No MAIN</span>
                    </div>
                  )}
                </div>

                {/* Slot cells */}
                {slots.map((slot, colIdx) => {
                  const cell = resolveCell(groupValue, slot)
                  const dim = !cellMatchesStatus(cell)
                  return (
                    <div
                      key={slot}
                      className={cn('relative', dim ? 'opacity-25 transition-opacity' : 'transition-opacity')}
                      aria-hidden={dim}
                    >
                      {bulkMode && (
                        <input
                          type="checkbox"
                          checked={selectedCells.has(cellKey(groupValue, slot))}
                          onChange={() => toggleCellSelect(groupValue, slot)}
                          onClick={(e) => e.stopPropagation()}
                          title="Select image"
                          className="absolute top-1 left-1 z-20 cursor-pointer accent-orange-600"
                        />
                      )}
                      {cell?.locked && (
                        <span
                          title="Locked — protected from bulk delete"
                          className="absolute top-1 right-1 z-20 rounded bg-amber-500/90 p-0.5 text-white shadow"
                        >
                          <Lock className="w-3 h-3" />
                        </span>
                      )}
                      <SlotCell
                        cell={cell}
                        slot={slot}
                        rowLabel={rowLabel}
                        isFocused={focusedCell.row === rowIdx && focusedCell.col === colIdx}
                        cellRef={(el) => {
                          const key = `${rowIdx}-${colIdx}`
                          if (el) cellRefs.current.set(key, el)
                          else cellRefs.current.delete(key)
                        }}
                        selfGroupValue={groupValue}
                        onDrop={(url, sourceId) => onCellDrop(groupValue, slot, url, sourceId)}
                        onClick={() => onCellClick(groupValue, slot)}
                        onLightbox={cell && onCellLightbox
                          ? () => onCellLightbox(groupValue, slot, cell)
                          : undefined}
                        onKeyDown={handleCellKeyDown(rowIdx, colIdx)}
                        onFocus={() => setFocusedCell({ row: rowIdx, col: colIdx })}
                        onFileDrop={(file) => onCellFileDrop(groupValue, slot, file)}
                        onRevert={onCellRevert ? () => onCellRevert(groupValue, slot) : undefined}
                        onCellMoveDrop={onCellMove
                          ? (from) => onCellMove(from, { groupValue, slot })
                          : undefined}
                        onMultiDrop={onCellMultiDrop
                          ? (items) => onCellMultiDrop(groupValue, slot, items)
                          : undefined}
                      />
                    </div>
                  )
                })}

                {/* Row actions */}
                <div
                  role="gridcell"
                  aria-colindex={colCount + 2}
                  className="w-8 flex-shrink-0 flex items-center justify-center"
                >
                  {!isAllColors && (
                    <RowMenu
                      groupValue={groupValue}
                      displayAsin={asin}
                      displaySku={sku}
                      onPublish={() => onPublishRow(groupValue)}
                      onCopyToDE={() => onCopyRow(groupValue, 'DE')}
                      onCopyToIT={() => onCopyRow(groupValue, 'IT')}
                      onClear={() => onClearRow(groupValue)}
                    />
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Legend */}
      <div className="mt-2 flex items-center gap-4 text-[11px] text-slate-400 dark:text-slate-500 px-1">
        <div className="flex items-center gap-1">
          <div className="w-3 h-3 border border-slate-300 rounded" />
          Own image
        </div>
        <div className="flex items-center gap-1">
          <div className="w-3 h-3 border border-slate-200 rounded opacity-60" />
          Inherited (∀)
        </div>
        <div className="flex items-center gap-1">
          <div className="w-2 h-2 rounded-full bg-amber-400" />
          Unsaved
        </div>
        <div className="flex items-center gap-1">
          <div className="w-2 h-2 rounded-full bg-emerald-400" />
          Published
        </div>
        <span>Drag image from master gallery to any cell or column header</span>
      </div>
    </div>
  )
}
