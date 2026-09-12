'use client'

/**
 * PES.7 — dragging a picture from one matrix cell to another.
 *
 * Pointer-drag is the PRIMARY model (spike ruling #12): it was the only one whose round trip
 * completed under measurement, and HTML5 drag is kept for desktop FILE drops alone.
 *
 * 🔴 The drag feedback is applied by TOGGLING CLASSES ON DOM NODES, not by React state, and that is
 * deliberate rather than lazy. A pointermove fires dozens of times a second; routing each one
 * through state would re-render the matrix, and re-rendering the matrix rebuilds `columnDefs` —
 * which is the AG column-model churn the spike identified as the thing to avoid. The grid stays
 * completely still during a drag; only two class names move.
 *
 * The listeners live on `window` for the duration of a drag so a pointer that leaves the grid, or
 * is released over the page chrome, still ends the session — a drag that can be orphaned by moving
 * fast is worse than no drag.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react'

export interface TileCoord { rowId: string; colId: string }

const DRAG_THRESHOLD_PX = 5
const SOURCE_CLASS = 'nds-media-drag-source'
const TARGET_CLASS = 'nds-media-drag-target'

/** The AG cell under a viewport point, as (rowId, colId). */
function cellAt(x: number, y: number): { coord: TileCoord; el: HTMLElement } | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null
  const cell = el?.closest<HTMLElement>('.ag-cell[col-id]')
  if (!cell) return null
  const colId = cell.getAttribute('col-id')
  const rowId = cell.closest<HTMLElement>('.ag-row')?.getAttribute('row-id')
  if (!colId || !rowId || colId === 'bucket') return null
  return { coord: { rowId, colId }, el: cell }
}

export function useTileDrag(args: {
  /** True when this cell holds a picture that can be dragged. */
  canDragFrom(coord: TileCoord): boolean
  onDrop(from: TileCoord, to: TileCoord): void
}) {
  const { canDragFrom, onDrop } = args
  const session = useRef<{
    from: TileCoord
    startX: number
    startY: number
    dragging: boolean
    sourceEl: HTMLElement | null
    targetEl: HTMLElement | null
  } | null>(null)

  const clearMarks = useCallback(() => {
    const s = session.current
    s?.sourceEl?.classList.remove(SOURCE_CLASS)
    s?.targetEl?.classList.remove(TARGET_CLASS)
  }, [])

  const onPointerDown = useCallback((rowId: string, colId: string, e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return
    const from = { rowId, colId }
    if (!canDragFrom(from)) return
    session.current = {
      from, startX: e.clientX, startY: e.clientY, dragging: false,
      sourceEl: (e.currentTarget as HTMLElement).closest<HTMLElement>('.ag-cell[col-id]'),
      targetEl: null,
    }
  }, [canDragFrom])

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const s = session.current
      if (!s) return
      if (!s.dragging) {
        if (Math.hypot(e.clientX - s.startX, e.clientY - s.startY) < DRAG_THRESHOLD_PX) return
        s.dragging = true
        s.sourceEl?.classList.add(SOURCE_CLASS)
      }
      const hit = cellAt(e.clientX, e.clientY)
      const next = hit && (hit.coord.rowId !== s.from.rowId || hit.coord.colId !== s.from.colId)
        ? hit.el : null
      if (next === s.targetEl) return
      s.targetEl?.classList.remove(TARGET_CLASS)
      s.targetEl = next
      s.targetEl?.classList.add(TARGET_CLASS)
    }

    const up = (e: PointerEvent) => {
      const s = session.current
      if (!s) return
      const wasDragging = s.dragging
      const hit = wasDragging ? cellAt(e.clientX, e.clientY) : null
      clearMarks()
      session.current = null
      // A press that never passed the threshold is a click, not a drag — leave it to the cell's own
      // handlers so double-click still opens the picker.
      if (!wasDragging || !hit) return
      if (hit.coord.rowId === s.from.rowId && hit.coord.colId === s.from.colId) return
      onDrop(s.from, hit.coord)
    }

    // `pointercancel` matters: a browser gesture can end a drag without a pointerup, and without
    // this the source tile would stay dimmed forever.
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [clearMarks, onDrop])

  // Memoised: a fresh object here breaks any consumer that correctly lists it as a
  // dependency — the memo never caches, and reads as though it does (PES ruling #156).
  return useMemo(() => ({ onPointerDown }), [onPointerDown])
}
