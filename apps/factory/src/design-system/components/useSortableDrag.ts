'use client'

/**
 * useSortableDrag — a pointer drag that shows what will happen WHILE it happens.
 *
 * Owner, 2026-09-28, on the media pickers: "the ui and ux of drag and drop has to be improved". The old reorder
 * (`usePointerReorder`) gave no feedback until the pointer was released. With this hook:
 *   - the WHOLE item is the handle (a grip is still there for the keyboard and as the sign), except its own buttons,
 *     links and fields, which keep their clicks;
 *   - past `DRAG_THRESHOLD_PX` the item LIFTS (`data-sort-state="lifted"`) and follows the pointer;
 *   - `list`: the other items SLIDE to open the gap where it will land; `wrap` (chips over several lines): the target
 *     chip shows an insertion mark before or after it;
 *   - Esc cancels and puts everything back; a drag never also fires a click;
 *   - near the top or bottom of a scrolling container the container scrolls, and the geometry follows the scroll;
 *   - it works with touch and pen (pointer events, `touch-action: none` on items in CSS).
 * Keyboard reorder stays the caller's (the grip's ↑ ↓ / a chip's Alt + arrows), with its spoken position.
 *
 * The geometry is `lib/sortable.ts` (tested there). Rects are measured once, when the drag starts: the items move by
 * transform only, so the layout under them does not change until the drop.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent } from 'react'

import { AUTO_SCROLL_EDGE_PX, DRAG_THRESHOLD_PX, autoScrollDelta, listDropIndex, listShift, listStep, wrapDropIndex, type SortRect } from '../lib/sortable'

export interface SortableDragOptions {
  /** `list`: one column (or row) that slides. `wrap`: items that flow onto several lines (chips). */
  layout?: 'list' | 'wrap'
  /** The list axis; ignored by `wrap`. */
  axis?: 'x' | 'y'
  disabled?: boolean
  onMove: (from: number, to: number) => void
  /** Called when a drag lifts and when it ends, for a spoken status line. */
  onDragState?: (state: { from: number; to: number } | null) => void
}

interface Session {
  from: number
  pointerId: number
  startX: number
  startY: number
  rects: SortRect[]
  step: number
  scroller: HTMLElement | null
  scrollStart: number
  active: boolean
}

export interface SortableDragState { from: number; to: number; dx: number; dy: number; side: 'before' | 'after' | null }

/** Elements that keep their own pointer: a press on them never starts a drag (the grip opts back in). */
const OWN_POINTER = 'button, a[href], input, textarea, select, [contenteditable="true"], [role="button"], [role="checkbox"]'

function scrollerOf(el: HTMLElement | null): HTMLElement | null {
  for (let node = el?.parentElement ?? null; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node
  }
  return null
}

export function useSortableDrag({ layout = 'list', axis = 'y', disabled = false, onMove, onDragState }: SortableDragOptions) {
  const listRef = useRef<HTMLElement | null>(null)
  const session = useRef<Session | null>(null)
  const suppressClick = useRef(false)
  const [drag, setDrag] = useState<SortableDragState | null>(null)
  const dragRef = useRef<SortableDragState | null>(null)
  dragRef.current = drag

  const items = () => Array.from(listRef.current?.querySelectorAll<HTMLElement>(':scope > [data-nds-sort-item]') ?? [])

  const end = useCallback((commit: boolean) => {
    const s = session.current
    const d = dragRef.current
    session.current = null
    setDrag(null)
    if (s?.active) {
      onDragState?.(null)
      if (commit && d && d.to !== d.from) onMove(d.from, d.to)
    }
  }, [onMove, onDragState])

  /* Esc cancels a drag in progress, wherever focus is. */
  useEffect(() => {
    if (!drag) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      suppressClick.current = true
      end(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [drag, end])

  const update = (event: ReactPointerEvent<HTMLElement>, s: Session) => {
    const scrolled = s.scroller ? s.scroller.scrollTop - s.scrollStart : 0
    const dx = event.clientX - s.startX
    const dy = event.clientY - s.startY + scrolled
    const self = s.rects[s.from]
    let to = s.from
    let side: SortableDragState['side'] = null
    if (layout === 'wrap') {
      ;({ to, side } = wrapDropIndex(s.rects, s.from, { x: event.clientX, y: event.clientY + scrolled }))
    } else {
      const center = axis === 'y' ? self.top + self.height / 2 + dy : self.left + self.width / 2 + dx
      to = listDropIndex(s.rects, s.from, center, axis)
    }
    const next = { from: s.from, to, dx, dy, side }
    const prev = dragRef.current
    if (!prev || prev.to !== next.to) onDragState?.({ from: next.from, to: next.to })
    setDrag(next)
    if (s.scroller) {
      const box = s.scroller.getBoundingClientRect()
      const delta = autoScrollDelta(event.clientY, box.top, box.bottom, AUTO_SCROLL_EDGE_PX)
      if (delta) s.scroller.scrollTop += delta
    }
  }

  const itemProps = (index: number) => {
    const d = drag
    let transform: string | undefined
    let state: 'lifted' | 'shifted' | undefined
    let mark: 'before' | 'after' | undefined
    if (d) {
      if (index === d.from) {
        transform = layout === 'wrap' ? `translate3d(${d.dx}px, ${d.dy}px, 0)` : axis === 'y' ? `translate3d(0, ${d.dy}px, 0)` : `translate3d(${d.dx}px, 0, 0)`
        state = 'lifted'
      } else if (layout === 'list') {
        const shift = listShift(index, d.from, d.to, session.current?.step ?? 0)
        if (shift) { transform = axis === 'y' ? `translate3d(0, ${shift}px, 0)` : `translate3d(${shift}px, 0, 0)`; state = 'shifted' }
      } else if (index === d.to && d.side) {
        mark = d.side
      }
    }
    return {
      'data-nds-sort-item': '',
      'data-sort-state': state,
      'data-sort-mark': mark,
      style: transform ? ({ transform } as CSSProperties) : undefined,
      onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
        if (disabled || event.button !== 0 || session.current) return
        const target = event.target as HTMLElement
        const own = target.closest(OWN_POINTER)
        if (own && !own.closest('[data-nds-sort-handle]') && event.currentTarget.contains(own)) return
        const nodes = items()
        const rects = nodes.map(n => { const r = n.getBoundingClientRect(); return { top: r.top, left: r.left, width: r.width, height: r.height } })
        const scroller = scrollerOf(listRef.current)
        session.current = {
          from: index, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, rects,
          step: listStep(rects, index, axis), scroller, scrollStart: scroller?.scrollTop ?? 0, active: false,
        }
        suppressClick.current = false
      },
      onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
        const s = session.current
        if (!s || s.pointerId !== event.pointerId) return
        if (!s.active) {
          if (Math.hypot(event.clientX - s.startX, event.clientY - s.startY) <= DRAG_THRESHOLD_PX) return
          s.active = true
          suppressClick.current = true
          event.currentTarget.setPointerCapture(event.pointerId)
          /* A text selection started by the press would follow the drag across the page. */
          window.getSelection()?.removeAllRanges()
        }
        event.preventDefault()
        update(event, s)
      },
      onPointerUp: (event: ReactPointerEvent<HTMLElement>) => {
        const s = session.current
        if (!s || s.pointerId !== event.pointerId) return
        end(s.active)
      },
      onPointerCancel: () => { if (session.current) end(false) },
      /* Capture lost mid-drag (the item left the page, the window lost focus): put everything back rather than guess. */
      onLostPointerCapture: () => { if (session.current?.active) end(false) },
      onClickCapture: (event: ReactMouseEvent<HTMLElement>) => {
        if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); suppressClick.current = false }
      },
    }
  }

  return { listRef, drag, itemProps }
}
