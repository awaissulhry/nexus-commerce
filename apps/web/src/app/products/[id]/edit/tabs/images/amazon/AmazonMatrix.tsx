'use client'

// IM.4 — Amazon Color × Slot matrix.
// Each row = one color group (or "All Colors"). Each column = one Amazon slot.
// Cells are drop targets accepting drags from MasterPanel or desktop files.
// Column headers are also drop targets for column-fill operations.

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, MoreHorizontal, Plus } from 'lucide-react'
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
  onClearRow: (groupValue: string) => void
  onCellFileDrop: (groupValue: string | null, slot: AmazonSlot, file: File) => void
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
}: SlotCellProps) {
  const [isOver, setIsOver] = useState(false)
  const isMain = slot === 'MAIN'

  function handleDragOver(e: React.DragEvent) {
    if (e.dataTransfer.types.includes('application/nexus-image-url') || e.dataTransfer.types.includes('Files')) {
      e.preventDefault()
      setIsOver(true)
    }
  }

  function handleDragLeave() { setIsOver(false) }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    setIsOver(false)
    const url = e.dataTransfer.getData('application/nexus-image-url')
    const sourceId = e.dataTransfer.getData('application/nexus-image-id') || undefined
    if (url) { onDrop(url, sourceId); return }
    const files = Array.from(e.dataTransfer.files)
    if (files.length && onFileDrop) { onFileDrop(files[0]); return }
  }

  const ariaLabel = `${rowLabel}, ${SLOT_LABELS[slot]}: ${
    cell
      ? cell.origin === 'inherited' ? 'inherited image' : 'image set'
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
        isOver ? 'border-blue-400 bg-blue-50 dark:bg-blue-950/30' : 'border-transparent',
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {cell ? (
        <div className={cn(
          'w-full h-full rounded-lg border overflow-hidden relative group cursor-pointer',
          cell.origin === 'inherited' ? 'opacity-60 border-slate-200 dark:border-slate-700' : 'border-slate-300 dark:border-slate-600',
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
          <img src={cell.url} alt="" className="w-full h-full object-contain bg-white" loading="lazy" />

          {/* Slot label */}
          <div className="absolute top-0.5 right-0.5 text-[8px] font-mono bg-black/50 text-white rounded px-0.5 leading-tight">
            {slot}
          </div>

          {/* Inherited badge */}
          {cell.origin === 'inherited' && (
            <div className="absolute bottom-0.5 right-0.5 text-[8px] bg-slate-700/60 text-white rounded px-0.5 leading-tight" title="Inherited from All Markets">
              ∀
            </div>
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
  onClearRow,
  onCellFileDrop,
}: MatrixProps) {
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
  const colCount = ALL_SLOTS.length

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
              {activeAxis}{activeMarketplace !== 'ALL' ? ` / ${activeMarketplace}` : ''}
            </div>
            {/* Slot column headers — each is a drag target */}
            {ALL_SLOTS.map((slot, i) => (
              <div key={slot} role="columnheader" aria-colindex={i + 2}>
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
                {ALL_SLOTS.map((slot, colIdx) => {
                  const cell = resolveCell(groupValue, slot)
                  return (
                    <SlotCell
                      key={slot}
                      cell={cell}
                      slot={slot}
                      rowLabel={rowLabel}
                      isFocused={focusedCell.row === rowIdx && focusedCell.col === colIdx}
                      cellRef={(el) => {
                        const key = `${rowIdx}-${colIdx}`
                        if (el) cellRefs.current.set(key, el)
                        else cellRefs.current.delete(key)
                      }}
                      onDrop={(url, sourceId) => onCellDrop(groupValue, slot, url, sourceId)}
                      onClick={() => onCellClick(groupValue, slot)}
                      onLightbox={cell && onCellLightbox
                        ? () => onCellLightbox(groupValue, slot, cell)
                        : undefined}
                      onKeyDown={handleCellKeyDown(rowIdx, colIdx)}
                      onFocus={() => setFocusedCell({ row: rowIdx, col: colIdx })}
                      onFileDrop={(file) => onCellFileDrop(groupValue, slot, file)}
                    />
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
