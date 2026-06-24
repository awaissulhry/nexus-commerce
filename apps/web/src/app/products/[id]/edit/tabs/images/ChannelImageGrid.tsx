'use client'

// Channel-agnostic image grid — the shared container behind the Amazon images
// matrix, generalized so eBay (and later Shopify) render the SAME component.
//
//   • Rows    = a variant group (e.g. a colour) + an optional "shared" row.
//   • Columns = channel-defined: Amazon → named slots (MAIN/PT01…/SWCH);
//               eBay → photo positions (1, 2, 3…).
//   • Cell    = one image at (row, column), with pick / drop / drag-reorder.
//
// The channel supplies `columns`, `resolveCell` and the handlers; the grid owns
// the layout, cells, drag-drop plumbing and keyboard navigation. Update this one
// file and every channel that renders it gets the change.

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Link2, Plus, Star } from 'lucide-react'
import { cn } from '@/lib/utils'

// ── Public types ─────────────────────────────────────────────────────────────

export interface ImageGridColumn {
  /** Stable key passed back to resolveCell / handlers (slot name or position). */
  key: string
  /** Short header label (e.g. 'MAIN', 'PT01', '1', '2'). */
  label: string
  /** Optional second line under the header (e.g. 'Swatch', 'Main'). */
  sublabel?: string
  /** The primary/search image column (Amazon MAIN, eBay position 1). */
  isPrimary?: boolean
}

export interface ImageGridRow {
  /** Group value (e.g. a colour). `null` = the shared / all row. */
  key: string | null
  /** Row label (e.g. the colour). */
  label: string
  /** Optional second line (e.g. "9 variants"). */
  sublabel?: string
}

export interface GridCellDisplay {
  url: string
  /** Own image at this exact scope vs inherited from a parent scope. */
  origin?: 'own' | 'inherited'
  /** Unsaved local edit. */
  isPending?: boolean
  /** Showing through from the master gallery (dashed border + chain badge). */
  fromMaster?: boolean
  publishStatus?: string
  publishError?: string | null
  width?: number | null
  height?: number | null
  listingImageId?: string
}

export interface ChannelImageGridProps {
  rows: ImageGridRow[]
  columns: ImageGridColumn[]
  /** Resolve the image at a (rowKey, columnKey) cell, or null if empty. */
  resolveCell: (rowKey: string | null, columnKey: string) => GridCellDisplay | null
  /** Open the picker / replace flow for a cell. */
  onCellClick: (rowKey: string | null, columnKey: string) => void
  /** Assign a dropped master-image URL to a cell. */
  onCellDrop?: (rowKey: string | null, columnKey: string, url: string, sourceId?: string) => void
  /** Drop an OS file onto a cell. */
  onCellFileDrop?: (rowKey: string | null, columnKey: string, file: File) => void
  /** Move an image from one cell to another (drag-reorder). */
  onCellMove?: (
    from: { rowKey: string | null; columnKey: string; url: string },
    to: { rowKey: string | null; columnKey: string },
  ) => void
  /** Remove the image in a cell. */
  onCellRemove?: (rowKey: string | null, columnKey: string) => void
  /** Promote a cell's image to the row's primary/lead (the "Main" shown first).
   *  Opt-in: the "set as main" affordance only appears when this is provided, so
   *  channels that don't want it (e.g. Amazon's fixed named slots) are unchanged. */
  onSetPrimary?: (rowKey: string | null, columnKey: string) => void
  /** Below-minimum-dimension warning threshold (px). */
  minDimensionPx?: number
  /** Accessible grid label. */
  ariaLabel?: string
  /** Row-label column header text (e.g. "Color"). */
  rowHeaderLabel?: string
}

// ── Cell ─────────────────────────────────────────────────────────────────────

interface CellProps {
  cell: GridCellDisplay | null
  column: ImageGridColumn
  rowLabel: string
  rowKey: string | null
  isFocused: boolean
  cellRef: (el: HTMLDivElement | null) => void
  minDimensionPx?: number
  onClick: () => void
  onKeyDown: (e: React.KeyboardEvent) => void
  onFocus: () => void
  onDrop?: (url: string, sourceId?: string) => void
  onFileDrop?: (file: File) => void
  onMoveDrop?: (payload: { rowKey: string | null; columnKey: string; url: string }) => void
  onRemove?: () => void
  /** Promote this filled, non-primary cell to the row's primary/lead (Main). */
  onSetPrimary?: () => void
  /** True when this cell sits in the primary (Main / position-1) column. */
  isPrimaryColumn?: boolean
  /** Plain-click / Enter on a filled cell → enlarge (preview). Replace stays on
   *  the hover "Change" button. */
  onEnlarge?: () => void
}

function ImageCell({
  cell, column, rowLabel, rowKey, isFocused, cellRef, minDimensionPx,
  onClick, onKeyDown, onFocus, onDrop, onFileDrop, onMoveDrop, onRemove, onSetPrimary, isPrimaryColumn, onEnlarge,
}: CellProps) {
  const [isOver, setIsOver] = useState(false)
  const tooSmall = cell?.width != null && minDimensionPx != null && cell.width < minDimensionPx

  function handleDragOver(e: React.DragEvent) {
    if (
      e.dataTransfer.types.includes('application/nexus-grid-cell') ||
      e.dataTransfer.types.includes('application/nexus-image-url') ||
      e.dataTransfer.types.includes('Files')
    ) {
      e.preventDefault()
      setIsOver(true)
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    setIsOver(false)
    // Internal cell-to-cell move (drag-reorder) takes priority.
    const movePayload = e.dataTransfer.getData('application/nexus-grid-cell')
    if (movePayload && onMoveDrop) {
      try {
        const parsed = JSON.parse(movePayload) as { rowKey: string | null; columnKey: string; url: string }
        if (parsed.rowKey === rowKey && parsed.columnKey === column.key) return // same cell, no-op
        onMoveDrop(parsed)
        return
      } catch { /* fall through */ }
    }
    const url = e.dataTransfer.getData('application/nexus-image-url')
    const sourceId = e.dataTransfer.getData('application/nexus-image-id') || undefined
    if (url && onDrop) { onDrop(url, sourceId); return }
    const files = Array.from(e.dataTransfer.files)
    if (files.length && onFileDrop) { onFileDrop(files[0]); return }
  }

  function handleDragStart(e: React.DragEvent) {
    if (!cell) return
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('application/nexus-grid-cell', JSON.stringify({ rowKey, columnKey: column.key, url: cell.url }))
    const imgEl = e.currentTarget.querySelector('img') as HTMLImageElement | null
    if (imgEl) e.dataTransfer.setDragImage(imgEl, imgEl.width / 2, imgEl.height / 2)
  }

  const ariaLabel = `${rowLabel}, ${column.label}: ${
    cell ? (cell.fromMaster ? 'inherited from master gallery' : cell.origin === 'inherited' ? 'inherited image' : 'image') : 'empty, click or drop to assign'
  }`

  return (
    <div
      ref={cellRef}
      role="gridcell"
      aria-label={ariaLabel}
      tabIndex={isFocused ? 0 : -1}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (cell && onEnlarge) onEnlarge(); else onClick(); return }
        onKeyDown(e)
      }}
      onFocus={onFocus}
      onDragOver={handleDragOver}
      onDragLeave={() => setIsOver(false)}
      onDrop={handleDrop}
      className={cn(
        'relative w-[72px] h-[72px] rounded-lg border-2 transition-all flex-shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
        isOver
          ? 'border-blue-400 bg-blue-50 dark:bg-blue-950/30 ring-2 ring-blue-300 dark:ring-blue-600 ring-offset-1 scale-[1.04]'
          : 'border-transparent',
      )}
    >
      {cell ? (
        <div
          draggable={!!onMoveDrop}
          onDragStart={handleDragStart}
          onClick={onEnlarge ?? onClick}
          title={tooSmall ? `${cell.width}×${cell.height ?? '?'} — below ${minDimensionPx} px minimum` : undefined}
          className={cn(
            'w-full h-full rounded-lg overflow-hidden relative group cursor-pointer',
            cell.fromMaster
              ? 'border-2 border-dashed border-slate-300 dark:border-slate-600 opacity-75'
              : cell.origin === 'inherited'
                ? 'border opacity-60 border-default dark:border-slate-700'
                : 'border border-slate-300 dark:border-slate-600',
            cell.isPending && 'ring-2 ring-amber-400 ring-offset-1',
            tooSmall && 'outline outline-2 outline-red-500/70',
          )}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={cell.url} alt="" draggable={false} className="w-full h-full object-contain bg-white" loading="lazy" decoding="async" />

          {/* Column label (yields to the "set as main" star on hover) */}
          <div className={cn('absolute top-0.5 right-0.5 text-[8px] font-mono bg-black/50 text-white rounded px-0.5 leading-tight transition-opacity', onSetPrimary && 'group-hover:opacity-0')}>
            {column.label}
          </div>

          {/* Main (lead) indicator — the photo buyers see first for this row.
              Rests at top-left; fades on hover so the × remove sits in its place. */}
          {isPrimaryColumn && (
            <div className="absolute top-0.5 left-0.5 transition-opacity group-hover:opacity-0 pointer-events-none" title="Main photo — shown first">
              <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400 drop-shadow-[0_1px_1px_rgba(0,0,0,0.45)]" />
            </div>
          )}

          {/* Set as main — promote a non-primary photo to the row's lead. */}
          {onSetPrimary && (
            <button
              type="button"
              tabIndex={-1}
              onClick={(e) => { e.stopPropagation(); onSetPrimary() }}
              aria-label="Set as main photo"
              title="Set as main photo"
              className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-amber-500 text-white opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center hover:bg-amber-600 leading-none"
            >
              <Star className="w-2.5 h-2.5" />
            </button>
          )}

          {/* Inherited / master-fallback badge */}
          {cell.origin === 'inherited' && (
            cell.fromMaster ? (
              <div className="absolute bottom-0.5 right-0.5 bg-slate-700/70 text-white rounded p-0.5 leading-none" title="Inherited from master gallery — drop an image to override">
                <Link2 className="w-2.5 h-2.5" />
              </div>
            ) : (
              <div className="absolute bottom-0.5 right-0.5 text-[8px] bg-slate-700/60 text-white rounded px-0.5 leading-tight" title="Inherited">∀</div>
            )
          )}

          {/* Pending dot */}
          {cell.isPending && (
            <div className="absolute top-0.5 left-0.5 w-2 h-2 rounded-full bg-amber-400 border border-white" title="Unsaved change" />
          )}

          {/* Publish status */}
          {cell.publishStatus === 'PUBLISHED' && (
            <div className="absolute top-0.5 left-0.5 w-1.5 h-1.5 rounded-full bg-emerald-400" title="Published" />
          )}
          {cell.publishStatus === 'ERROR' && (
            <div className="absolute top-0.5 left-0.5 w-1.5 h-1.5 rounded-full bg-red-400" title={cell.publishError ?? 'Error'} />
          )}

          {/* Hover overlay — Change */}
          <button
            type="button"
            tabIndex={-1}
            onClick={(e) => { e.stopPropagation(); onClick() }}
            aria-label="Replace image"
            className="absolute inset-x-0 bottom-0 h-6 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-white text-[10px] font-medium pointer-events-none group-hover:pointer-events-auto"
          >
            Change
          </button>

          {/* Remove */}
          {onRemove && cell.origin !== 'inherited' && !cell.fromMaster && (
            <button
              type="button"
              tabIndex={-1}
              onClick={(e) => { e.stopPropagation(); onRemove() }}
              aria-label={`Remove ${column.label} image`}
              className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-red-500 text-white opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center hover:bg-red-600 leading-none text-[10px]"
            >
              ×
            </button>
          )}
        </div>
      ) : (
        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          className="w-full h-full border-2 border-dashed border-default dark:border-slate-700 rounded-lg flex items-center justify-center text-slate-300 dark:text-slate-600 hover:border-blue-400 dark:hover:border-blue-500 hover:text-blue-400 transition-all"
          onClick={onClick}
        >
          <Plus className="w-4 h-4" />
        </button>
      )}
    </div>
  )
}

// ── Grid ─────────────────────────────────────────────────────────────────────

export default function ChannelImageGrid({
  rows, columns, resolveCell, onCellClick, onCellDrop, onCellFileDrop,
  onCellMove, onCellRemove, onSetPrimary, minDimensionPx, ariaLabel, rowHeaderLabel,
}: ChannelImageGridProps) {
  const rowCount = rows.length
  const colCount = columns.length

  // Roving tabindex keyboard navigation.
  const [focused, setFocused] = useState<{ row: number; col: number }>({ row: 0, col: 0 })
  const cellRefs = useRef<Map<string, HTMLDivElement | null>>(new Map())
  // Click / Enter on a filled cell → full-screen preview (so you can read size
  // charts and confirm exactly which image it is before publishing).
  const [enlarged, setEnlarged] = useState<string | null>(null)

  useEffect(() => {
    setFocused((p) => ({ row: Math.min(p.row, Math.max(0, rowCount - 1)), col: Math.min(p.col, Math.max(0, colCount - 1)) }))
  }, [rowCount, colCount])

  const handleKey = useCallback((row: number, col: number) => (e: React.KeyboardEvent) => {
    let r = row, c = col
    switch (e.key) {
      case 'ArrowLeft':  c = Math.max(0, col - 1); break
      case 'ArrowRight': c = Math.min(colCount - 1, col + 1); break
      case 'ArrowUp':    r = Math.max(0, row - 1); break
      case 'ArrowDown':  r = Math.min(rowCount - 1, row + 1); break
      case 'Home':       c = 0; break
      case 'End':        c = colCount - 1; break
      default: return
    }
    if (r === row && c === col) return
    e.preventDefault()
    setFocused({ row: r, col: c })
    cellRefs.current.get(`${r}-${c}`)?.focus()
  }, [rowCount, colCount])

  return (
    <>
    <div className="overflow-x-auto rounded-xl border border-default dark:border-slate-700">
      <div
        role="grid"
        aria-label={ariaLabel ?? 'Image grid'}
        aria-rowcount={rowCount + 1}
        aria-colcount={colCount + 1}
        className="min-w-max"
      >
        {/* Header row */}
        <div role="row" aria-rowindex={1} className="flex items-center gap-2 px-4 py-2 bg-slate-50 dark:bg-slate-800/95 border-b border-default dark:border-slate-700 sticky top-0 z-10">
          <div role="columnheader" aria-colindex={1} className="w-44 flex-shrink-0 text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide sticky left-0 z-20 bg-slate-50 dark:bg-slate-800 shadow-[2px_0_4px_rgba(0,0,0,0.04)] dark:shadow-[2px_0_4px_rgba(0,0,0,0.3)]">
            {rowHeaderLabel ?? ''}
          </div>
          {columns.map((col, i) => (
            <div
              key={col.key}
              role="columnheader"
              aria-colindex={i + 2}
              className={cn('w-[72px] flex-shrink-0 text-center py-1.5 px-1', col.isPrimary ? 'text-blue-600 dark:text-blue-400 font-semibold' : 'text-slate-500 dark:text-slate-400')}
            >
              <div className="text-[11px] font-mono leading-none">{col.label}</div>
              {col.sublabel && <div className="text-[9px] text-tertiary mt-0.5">{col.sublabel}</div>}
            </div>
          ))}
        </div>

        {/* Data rows */}
        {rows.map((row, rowIdx) => {
          const isShared = row.key === null
          return (
            <div
              key={row.key ?? '__shared__'}
              role="row"
              aria-rowindex={rowIdx + 2}
              className={cn('flex items-center gap-2 px-4 py-2 border-b border-subtle dark:border-slate-800 last:border-0', isShared ? 'bg-slate-50/50 dark:bg-slate-800/20' : 'bg-white dark:bg-slate-900')}
            >
              {/* Row label (sticky-left) */}
              <div
                role="rowheader"
                aria-colindex={1}
                className={cn('w-44 flex-shrink-0 min-w-0 sticky left-0 z-10 shadow-[2px_0_4px_rgba(0,0,0,0.04)] dark:shadow-[2px_0_4px_rgba(0,0,0,0.3)]', isShared ? 'bg-slate-50 dark:bg-slate-800' : 'bg-white dark:bg-slate-900')}
              >
                <span className={cn('truncate', isShared ? 'text-xs font-medium text-slate-500 dark:text-slate-400 italic' : 'text-sm font-medium text-slate-800 dark:text-slate-200')}>
                  {row.label}
                </span>
                {row.sublabel && <div className="text-[11px] font-mono text-tertiary dark:text-slate-500 truncate mt-0.5">{row.sublabel}</div>}
                {/* Primary-image (position 1 / MAIN) validation */}
                {!isShared && columns[0] && !resolveCell(row.key, columns[0].key) && (
                  <div className="flex items-center gap-1 mt-1">
                    <AlertTriangle className="w-3 h-3 text-red-400" />
                    <span className="text-[10px] text-red-500">No {columns[0].label}</span>
                  </div>
                )}
              </div>

              {/* Cells */}
              {columns.map((col, colIdx) => {
                const cell = resolveCell(row.key, col.key)
                return (
                  <ImageCell
                    key={col.key}
                    cell={cell}
                    column={col}
                    rowKey={row.key}
                    rowLabel={row.label}
                    isFocused={focused.row === rowIdx && focused.col === colIdx}
                    cellRef={(el) => { const k = `${rowIdx}-${colIdx}`; if (el) cellRefs.current.set(k, el); else cellRefs.current.delete(k) }}
                    minDimensionPx={minDimensionPx}
                    onClick={() => onCellClick(row.key, col.key)}
                    onKeyDown={handleKey(rowIdx, colIdx)}
                    onFocus={() => setFocused({ row: rowIdx, col: colIdx })}
                    onDrop={onCellDrop ? (url, sourceId) => onCellDrop(row.key, col.key, url, sourceId) : undefined}
                    onFileDrop={onCellFileDrop ? (file) => onCellFileDrop(row.key, col.key, file) : undefined}
                    onMoveDrop={onCellMove ? (from) => onCellMove(from, { rowKey: row.key, columnKey: col.key }) : undefined}
                    onRemove={onCellRemove && cell ? () => onCellRemove(row.key, col.key) : undefined}
                    onSetPrimary={onSetPrimary && cell && !col.isPrimary ? () => onSetPrimary(row.key, col.key) : undefined}
                    isPrimaryColumn={col.isPrimary ?? false}
                    onEnlarge={cell ? () => setEnlarged(cell.url) : undefined}
                  />
                )
              })}
            </div>
          )
        })}
      </div>
    </div>

    {/* Enlarge preview — click a filled cell to read the full image (size charts,
        market-specific art) before committing it. */}
    {enlarged && (
      <div
        className="fixed inset-0 z-[300] flex items-center justify-center bg-black/80 p-6 sm:p-10 cursor-zoom-out"
        role="dialog"
        aria-label="Enlarged image preview"
        onClick={() => setEnlarged(null)}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={enlarged} alt="" className="max-w-full max-h-full object-contain rounded-lg shadow-2xl" />
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setEnlarged(null) }}
          aria-label="Close preview"
          className="absolute top-4 right-4 w-9 h-9 rounded-full bg-white/15 hover:bg-white/30 text-white flex items-center justify-center text-xl leading-none"
        >
          ×
        </button>
      </div>
    )}
    </>
  )
}
