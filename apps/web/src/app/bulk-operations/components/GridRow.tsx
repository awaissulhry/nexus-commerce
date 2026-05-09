// Memoised row + selection / fill overlays + skeleton row used inside
// the virtualised body of the bulk-ops grid.

import { memo, useMemo } from 'react'
import { flexRender } from '@tanstack/react-table'
import type { Row } from '@tanstack/react-table'
import { cn } from '@/lib/utils'
import { isAggregatableField, type HierarchyRow } from '../lib/hierarchy'
import {
  columnTonesRef,
  hierarchyCtxRef,
  selectCtxRef,
} from '../lib/refs'
import {
  ROW_HEIGHT,
  type BulkProduct,
  type Rect,
} from '../lib/types'

// Selection is rendered as TWO absolutely-positioned overlays in the
// virtualized body (see SelectionOverlays below): one thin border for
// the range and one thick border for the active cell. That keeps the
// cells themselves entirely unaware of selection state, so changing
// the selection re-renders only those overlays — not every visible
// row. The cell wrapper just owns the click handler.
export const TableRow = memo(
  function TableRow({
    row,
    rowIdx,
    top,
    findMatchSig,
  }: {
    row: Row<BulkProduct>
    rowIdx: number
    top: number
    /** Bumped when the visible-column set OR sizes change; forces a
     *  re-render so body cells track header widths during a drag. */
    columnsKey: string
    /**
     * W3.3 — comma-separated colIdx list of cells in THIS row that
     * currently match the Find / Replace query (or empty string).
     * Including it as a prop busts the memo when the operator types
     * in the find bar so the amber highlight repaints; the parent
     * builds it from findMatchKeys before the render so each row
     * only sees a tiny string change when its row actually has
     * matches.
     */
    findMatchSig?: string
  }) {
    const hier = (row.original as Partial<HierarchyRow>)._hier
    const isAggregateRow =
      hierarchyCtxRef.current.mode === 'hierarchy' &&
      hier?.level === 0 &&
      hier?.hasChildren
    // W3.3 — parse the per-row find-match signature once per render
    // (cheap, comma-separated string). Each cell looks up its colIdx
    // here in O(1) — no need to re-walk findMatchKeys for every cell
    // and no string parse per cell.
    const matchCols = useMemo(() => {
      if (!findMatchSig) return null
      const s = new Set<number>()
      for (const part of findMatchSig.split(',')) {
        const n = parseInt(part, 10)
        if (!Number.isNaN(n)) s.add(n)
      }
      return s
    }, [findMatchSig])
    return (
      <div
        className="absolute left-0 right-0 flex border-b border-slate-100"
        style={{
          height: ROW_HEIGHT,
          transform: `translateY(${top}px)`,
          willChange: 'transform',
        }}
      >
        {row.getVisibleCells().map((cell, colIdx) => {
          const fieldId = (cell.column.columnDef.meta as any)?.fieldDef
            ?.id as string | undefined
          const isParentAggregateCell =
            isAggregateRow &&
            fieldId !== undefined &&
            isAggregatableField(fieldId)
          const selectable = !isParentAggregateCell
          // W.5 — visually demote read-only cells. The Lock icon on the
          // header already flags this; cell tinting reinforces it row-
          // by-row so the user doesn't double-click into a column that
          // refuses edits.
          const fieldDef = (cell.column.columnDef.meta as
            | { fieldDef?: { editable: boolean } }
            | undefined)?.fieldDef
          const isReadOnlyCell = fieldDef ? !fieldDef.editable : false
          // JJ — per-group cell tint + thicker border at group edges,
          // mirroring the per-product editor's TONE_BY_GROUP look.
          // System columns (sku / __actions) opt out of the tint so
          // their sticky white background stays opaque against the
          // tinted scrolling cells underneath.
          const tone = columnTonesRef.current.get(cell.column.id)
          const isSystemCol =
            cell.column.id === 'sku' || cell.column.id === '__actions'
          // W3.3 — Find / Replace match highlight. matchCols comes
          // from the parsed `findMatchSig` prop the parent computed
          // for this row; bound to the row's memo so the highlight
          // repaints as the operator types into the find bar.
          const isFindMatch = matchCols?.has(colIdx) ?? false
          return (
            <div
              key={cell.id}
              data-row-idx={rowIdx}
              data-col-idx={colIdx}
              onMouseDown={
                selectable
                  ? (e) => {
                      if (e.button !== 0) return
                      // Shift+click extends and must not enter edit
                      // mode; let plain click bubble so EditableCell
                      // still goes into edit on the same gesture.
                      if (e.shiftKey) {
                        e.preventDefault()
                        e.stopPropagation()
                      }
                      selectCtxRef.current.select(rowIdx, colIdx, e.shiftKey)
                      // Step 2: arm the document-level drag handlers
                      // for rectangle selection.
                      if (!e.shiftKey) {
                        selectCtxRef.current.beginDrag(rowIdx, colIdx)
                      }
                    }
                  : undefined
              }
              className={cn(
                'overflow-hidden relative select-none',
                tone && !isSystemCol
                  ? cn(
                      tone.cell,
                      tone.isGroupEdge
                        ? 'border-r-2 border-slate-200'
                        : 'border-r border-slate-100/60',
                    )
                  : 'border-r border-slate-100/60 last:border-r-0',
                isReadOnlyCell && 'bg-slate-50/40',
                selectable && 'hover:bg-slate-50',
                // W3.3 — Find / Replace match tint. Inset amber ring +
                // soft fill so the cell stands out without blocking
                // the dirty (yellow) / cascade (orange) / error (red)
                // signals that win at the EditableCell layer.
                isFindMatch &&
                  'ring-1 ring-inset ring-amber-400 bg-amber-50/60',
                // W.6 — frozen left/right columns. Opaque bg so cells
                // scrolling underneath don't bleed through.
                cell.column.id === 'sku' &&
                  'sticky left-0 z-[5] bg-white',
                cell.column.id === '__actions' &&
                  'sticky right-0 z-[5] bg-white',
              )}
              style={{ width: cell.column.getSize(), flexShrink: 0 }}
            >
              {flexRender(cell.column.columnDef.cell, cell.getContext())}
            </div>
          )
        })}
      </div>
    )
  },
  (prev, next) =>
    prev.row.original === next.row.original &&
    prev.rowIdx === next.rowIdx &&
    prev.top === next.top &&
    (prev as any).columnsKey === (next as any).columnsKey &&
    // W3.3 — bust the memo when the find-match signature for THIS
    // row changes; otherwise the highlight overlay would only repaint
    // when some other prop changed (selection, value, …).
    prev.findMatchSig === next.findMatchSig,
)

// Three absolutely-positioned overlays that draw the selection on
// top of the table body — single-element renders, no per-cell
// re-paints. The fill handle (when no fill drag is in progress) is a
// small interactive square at the bottom-right corner of the range.
export function SelectionOverlays({
  rangeRect,
  activeRect,
  fillRect,
  isFilling,
}: {
  rangeRect: Rect | null
  activeRect: Rect | null
  fillRect: Rect | null
  isFilling: boolean
}) {
  return (
    <>
      {rangeRect && (
        <div
          className="absolute pointer-events-none border border-blue-400 bg-blue-50/40 z-10"
          style={rangeRect}
        />
      )}
      {activeRect && (
        <div
          className="absolute pointer-events-none border-2 border-blue-600 z-20"
          style={activeRect}
        />
      )}
      {fillRect && (
        <>
          <div
            className="absolute pointer-events-none border-2 border-dashed border-blue-500 bg-blue-100/30 z-20"
            style={fillRect}
          />
          {/* TECH_DEBT #26 — affordance hint while drag-fill is in
              flight. Anchored to the top-right of the extension rect so
              it follows the dashed preview as it grows. Two cancel
              paths, both surfaced. */}
          <div
            className="absolute pointer-events-none z-30 bg-slate-900 text-white text-xs font-medium px-1.5 py-0.5 rounded shadow"
            style={{
              top: Math.max(0, fillRect.top - 22),
              left: fillRect.left + fillRect.width - 110,
            }}
          >
            <kbd className="font-mono">Esc</kbd> or right-click to cancel
          </div>
        </>
      )}
      {/* Fill handle — a 8×8 blue square at the bottom-right of the
       *  selection range. Hidden while a fill drag is in progress so
       *  it doesn't visually fight the dashed extension preview. */}
      {rangeRect && !isFilling && (
        <div
          data-fill-handle
          className="absolute w-2 h-2 bg-blue-600 border border-white cursor-crosshair z-30"
          style={{
            left: rangeRect.left + rangeRect.width - 4,
            top: rangeRect.top + rangeRect.height - 4,
          }}
          onMouseDown={(e) => {
            e.preventDefault()
            e.stopPropagation()
            selectCtxRef.current.beginFill()
          }}
        />
      )}
    </>
  )
}

export function SkeletonRow({ top, colCount }: { top: number; colCount: number }) {
  return (
    <div
      className="absolute left-0 right-0 flex border-b border-slate-100 animate-pulse"
      style={{ height: ROW_HEIGHT, transform: `translateY(${top}px)` }}
    >
      {Array.from({ length: colCount }).map((_, i) => (
        <div
          key={i}
          className="flex items-center px-3"
          style={{ width: 120, flexShrink: 0 }}
        >
          <div className="h-3 bg-slate-200 rounded w-3/4" />
        </div>
      ))}
    </div>
  )
}
